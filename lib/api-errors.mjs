import { apiProvider } from './api-providers.mjs';

// One place that turns a failed request to a model API into a kind and a plain sentence with a next step (DECISIONS: API failures).
// It is pure: no network, no state. It reads two error shapes, the OpenAI-compatible one { error: { message, type, code } } and the
// Anthropic one { type: 'error', error: { type, message } } (the SDK puts the status on err.status, the body on err.error and the
// headers on err.headers; classifyError reads those). The provider's own words are kept, cut short, with request ids dropped and the
// key (and anything that looks like a key) replaced by [key]. A key never appears in a text this file builds.

const MAX_NOTE = 300;

// Where to add credit. Fixed public pages, never read from a response, shown as text and never opened by the app.
const BILLING = {
  anthropic: 'https://console.anthropic.com/settings/billing',
  openai: 'https://platform.openai.com/settings/organization/billing',
  xai: 'https://console.x.ai',
  deepseek: 'https://platform.deepseek.com/top_up',
  mistral: 'https://console.mistral.ai/billing',
  googleai: 'https://aistudio.google.com/apikey',
  openrouter: 'https://openrouter.ai/credits',
};
export const billingUrl = provider => (Object.hasOwn(BILLING, provider) ? BILLING[provider] : '');

// The kinds that may pass by themselves, so a retry is worth making (lib/api-retry.mjs decides whether it is safe to).
const RETRYABLE = new Set(['rate-limit', 'overloaded', 'server', 'timeout', 'network']);

// Anything that looks like a secret key, for the case where the provider echoes one that is not the saved key.
const KEY_SHAPE = /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|xai-[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,})/g;

export function redactKey(text, apiKey) {
  let out = String(text ?? '');
  if (apiKey && String(apiKey).length >= 4) out = out.split(String(apiKey)).join('[key]');
  return out.replace(KEY_SHAPE, '[key]');
}

const cut = (text, n) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);

// The provider's sentence, tidy: no tags, no request id, one line, cut short, no key.
export function tidyDetail(raw, apiKey, max = MAX_NOTE) {
  let text = redactKey(String(raw ?? ''), apiKey).replace(/<[^>]*>/g, ' ');
  text = text
    .replace(/\s*Please include the request ID\b[^.]*\./gi, ' ')
    .replace(/\s*\(?\s*request[ _-]?id\b\s*[:=]?\s*[\w-]+\s*\)?/gi, ' ')
    .replace(/\breq_[A-Za-z0-9]{8,}\b/g, ' ');
  return cut(text.replace(/\s+/g, ' ').trim(), max);
}

const asText = v => (typeof v === 'string' ? v : v && typeof v === 'object' ? String(v.message ?? v.detail ?? '') : '');

// Seconds a provider asks for in its words: "try again in 2s", "retry in 34.5s", "Please retry after 20 seconds".
function secondsInWords(message) {
  const m = /\b(?:try again|retry)\b[^0-9]{0,16}(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)\b/i.exec(String(message ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit.startsWith('ms') || unit.startsWith('milli')) return n / 1000;
  if (unit.startsWith('m')) return n * 60;
  return n;
}

// Parses an error body (a string or an already parsed value) into { type, code, message, status, retryAfter }. Never throws.
export function parseErrorBody(body) {
  const out = { type: '', code: '', message: '', status: null, retryAfter: null };
  let value = body;
  if (typeof body === 'string') {
    try {
      value = JSON.parse(body);
    } catch {
      out.message = body;
      return out;
    }
  }
  if (Array.isArray(value)) value = value[0];
  if (!value || typeof value !== 'object') {
    out.message = typeof value === 'string' ? value : '';
    return out;
  }
  const inner = value.error && typeof value.error === 'object' ? value.error : null;
  const src = inner ?? value;
  out.message = asText(inner ?? value.error ?? value.message ?? value.detail ?? value);
  if (typeof src.type === 'string' && src.type !== 'error') out.type = src.type;
  else if (typeof src.status === 'string') out.type = src.status; // Google's "RESOURCE_EXHAUSTED"
  if (typeof src.code === 'string' || typeof src.code === 'number') out.code = String(src.code);
  if (Number.isInteger(src.code)) out.status = src.code;
  else if (Number.isInteger(src.status)) out.status = src.status;
  for (const d of Array.isArray(src.details) ? src.details : []) {
    const delay = /^(\d+(?:\.\d+)?)s$/.exec(String(d?.retryDelay ?? ''));
    if (delay) out.retryAfter = Number(delay[1]);
  }
  out.retryAfter ??= secondsInWords(out.message);
  return out;
}

const headerOf = (headers, name) => {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const hit = Object.keys(headers).find(k => k.toLowerCase() === name);
  return hit ? headers[hit] : null;
};

// "1s", "6m0s", "20ms", "1h2m3.5s" (the x-ratelimit-reset headers), or plain seconds. Milliseconds, or null.
function durationMs(text) {
  const s = String(text ?? '').trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * 1000;
  const m = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/.exec(s);
  if (!m || !s) return null;
  return (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000 + Number(m[4] ?? 0);
}

// How long the provider asks to wait, in milliseconds, from the response headers: retry-after-ms, else retry-after (seconds or an HTTP
// date). Null when it says nothing. `now` is for tests.
export function waitFromHeaders(headers, now = Date.now()) {
  const ms = headerOf(headers, 'retry-after-ms');
  if (ms != null && /^\d+(\.\d+)?$/.test(String(ms).trim())) return Math.max(0, Number(ms));
  const after = headerOf(headers, 'retry-after');
  if (after != null && String(after).trim() !== '') {
    const t = String(after).trim();
    if (/^\d+(\.\d+)?$/.test(t)) return Math.max(0, Number(t) * 1000);
    const date = Date.parse(t);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  return null;
}

// A weaker hint for a rate limit that names no wait: the smaller of the x-ratelimit-reset-* values, in milliseconds, or null. These
// headers say when the whole allowance is full again, which can be many minutes after a request would already pass (and some
// providers send them on every answer), so a value over a minute is not taken as a wait: it would stop a retry that would have worked.
const RESET_HINT_MAX_MS = 60_000;
export function resetHintFromHeaders(headers) {
  const resets = ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens', 'x-ratelimit-reset']
    .map(n => durationMs(headerOf(headers, n)))
    .filter(v => v != null && v <= RESET_HINT_MAX_MS);
  return resets.length ? Math.min(...resets) : null;
}

// "about 30 seconds", "about 5 minutes", "about 3 hours".
export function waitWords(seconds) {
  const s = Math.max(1, Math.round(seconds));
  if (s < 90) return `about ${s} second${s === 1 ? '' : 's'}`;
  const m = Math.round(s / 60);
  if (m < 60) return `about ${m} minutes`;
  const h = Math.round(m / 60);
  return `about ${h} hour${h === 1 ? '' : 's'}`;
}

const NETWORK_CODES = /^(ECONNRESET|ECONNABORTED|EPIPE|ETIMEDOUT|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|EAI_AGAIN)$/;
// A dropped or timed out connection is worth another try. A name that does not resolve and a refused connection are not.
export const isBriefNetworkError = err => {
  const code = String(err?.cause?.code ?? err?.code ?? '');
  return NETWORK_CODES.test(code) || (!code && /^terminated$/i.test(String(err?.message ?? '')));
};

const QUOTA_CODE = /insufficient_quota|billing_hard_limit|billing_not_active|insufficient_funds|payment_required|credit_balance|insufficient_balance|out_of_credit/i;
const QUOTA_WORDS = /credit balance is too low|insufficient (?:balance|funds|credits?|quota)|no (?:credits?|quota|balance) (?:left|remaining)|out of credits?|add (?:more )?credits?|purchase credits|exceeded your current quota|billing (?:hard )?limit|payment required|check your plan and billing/i;
const CONTEXT_WORDS = /context[ _]length|maximum context|context window|prompt is too long|too many tokens|input is too long|exceeds? the (?:model'?s? )?(?:maximum|context|limit)|reduce the length|request too large|string_above_max_length/i;
const FILTER = /content_filter|content_policy|refusal|safety/i;
const BAD_KEY_WORDS = /api key not valid|invalid api key|incorrect api key|invalid x-api-key|no api key|missing api key/i;
// A rate limit on the size of one request (tokens per minute): waiting does not help, a shorter chat does.
const TOO_LARGE_WORDS = /request too large|too large for/i;

// { status, type, code, message, provider, retryAfter, model, label, tries, apiKey, network } -> { kind, text, statement, step, detail, retryAfter, retryable }.
// text is the statement, the next step and the provider's own words; step is the next step alone ('' for kind 'other').
// status: the HTTP status, or null for a failure with none (a dropped connection, an error sent inside the stream).
// message, type, code: as the provider sent them. retryAfter: seconds the provider asked to wait, when it said. provider: the id in
// lib/api-providers.mjs (or 'anthropic'); label (optional) is the name shown to the person. model: the model asked for. tries: how many
// requests were made, for the closing sentence. network: a connection failure; code is then the reason shown in brackets.
export function classify(input = {}) {
  const { provider, model, tries, apiKey } = input;
  const parsed = input.body !== undefined ? parseErrorBody(input.body) : null;
  const status = Number.isInteger(input.status) ? input.status : (parsed?.status ?? null);
  const type = String(input.type ?? parsed?.type ?? '');
  const code = String(input.code ?? parsed?.code ?? '');
  const message = String(input.message ?? parsed?.message ?? '');
  const asked = Number.isFinite(input.retryAfter) ? input.retryAfter : (parsed?.retryAfter ?? secondsInWords(message));
  const label = input.label || apiProvider(provider)?.label || (provider === 'anthropic' ? 'Claude' : 'The provider');
  const detail = tidyDetail(message, apiKey);
  const said = detail ? ` The provider said: ${detail}` : '';
  const tried = tries > 1 ? ` Plenum tried ${tries} times.` : '';
  const text = String(`${type} ${code}`);
  let kind;
  let statement;
  let step;
  if (input.network) {
    kind = 'network';
    statement = `${label} could not be reached (${code || 'no reason given'}).${tried}`;
    step = 'Check the connection, then send again.';
  } else if (FILTER.test(type) || FILTER.test(code) || /content[ _]filter|content[ _]policy/i.test(message)) {
    kind = 'refusal';
    statement = `${label} declined to answer this (its content filter).`;
    step = 'Reword the request, or pick another model.';
  } else if (status === 402 || QUOTA_CODE.test(text) || (QUOTA_WORDS.test(message) && !(status === 429 && asked != null && !QUOTA_CODE.test(text)))) {
    kind = 'no-credit';
    const url = billingUrl(provider);
    statement = `${label} says this account has no credit or quota left${status ? ` (${status})` : ''}.`;
    step = `Add credit${url ? ` at ${url}` : ' in your account with the provider'}, then send again.`;
  } else if (status === 401 || /^(invalid_api_key|authentication_error)$/i.test(code) || /authentication_error/i.test(type) || ((status == null || status === 400 || status === 403) && BAD_KEY_WORDS.test(message))) {
    kind = 'auth';
    statement = `${label} rejected the key${status ? ` (${status})` : ''}.`;
    step = 'Open Accounts and save a valid key.';
  } else if (status === 403 || /permission_error|permission_denied/i.test(text)) {
    kind = 'forbidden';
    statement = `${label} refused the request (403). This key may not be allowed to use this model.`;
    step = `Check the key's permissions with ${label}, or pick another model.`;
  } else if (status === 413 || ((status == null || status === 400 || status === 422) && (CONTEXT_WORDS.test(message) || /context_length|string_above_max_length/i.test(code))) || (status === 429 && TOO_LARGE_WORDS.test(message))) {
    kind = 'context';
    statement = `This chat is longer than ${model || 'this model'} can read${status ? ` (${status})` : ''}.`;
    step = 'Use /compact to shorten it, or start a new thread, then send again.';
  } else if (status === 404 || /model_not_found|not_found_error|model_not_available/i.test(text) || (status === 400 && /model\b[^.]{0,60}(?:does not exist|not found|decommissioned|no longer|deprecated|retired)/i.test(message))) {
    kind = 'model-gone';
    statement = `${model ? `The model ${model}` : 'This model'} is no longer offered by ${label}, or this key cannot use it${status ? ` (${status})` : ''}.`;
    step = 'Pick another model in the model menu.';
  } else if (status === 429 || /rate_limit|resource_exhausted|too_many_requests/i.test(text) || (status == null && /rate limit|too many requests/i.test(message))) {
    kind = 'rate-limit';
    statement = `${label} is limiting requests right now${status ? ` (${status})` : ''}.${tried}`;
    step = asked != null ? `Wait ${waitWords(asked)}, then send again.` : 'Wait a minute, then send again.';
  } else if (status === 529 || status === 503 || /overloaded/i.test(text) || (status == null && /overloaded|capacity/i.test(message))) {
    kind = 'overloaded';
    statement = `${label} is overloaded right now${status ? ` (${status})` : ''}.${tried}`;
    step = 'Wait a few minutes, or pick another model, then send again.';
  } else if (status === 408) {
    kind = 'timeout';
    statement = `${label} took too long to answer (408).${tried}`;
    step = 'Send again.';
  } else if ((status >= 500 && status < 600) || status === 409 || status === 425) {
    kind = 'server';
    statement = `${label} had a problem on its own side (${status}).${tried}`;
    step = 'Wait a minute, then send again, or pick another model.';
  } else if (status === 400 || status === 422) {
    kind = 'bad-request';
    statement = `${label} could not use this request (${status}).`;
    step = 'Check the model and its settings, then send again.';
  } else {
    kind = 'other';
    statement = status ? `${label} returned an error (${status}).` : `${label} stopped with an error.`;
    step = '';
  }
  const words = `${statement} ${step}`;
  return { kind, text: `${words}${said}`.replace(/\s+/g, ' ').trim(), statement, step, detail, retryAfter: asked ?? null, retryable: RETRYABLE.has(kind) };
}

// The same for an error object: the OpenAI-compatible adapter builds its own flat input; this reads the Anthropic SDK's
// (err.status, err.error, err.headers, and a message that starts with "<status> {json}") and a plain network error.
export function classifyError(err, { provider = 'anthropic', model, tries, apiKey, label } = {}) {
  const status = Number.isInteger(err?.status) ? err.status : null;
  const lead = /^(\d{3})\s+([\s\S]*)$/.exec(String(err?.message ?? ''));
  const parsed = parseErrorBody(err?.error ?? (lead ? lead[2] : err?.message ?? ''));
  const wait = waitFromHeaders(err?.headers);
  const base = { provider, model, tries, apiKey, label, retryAfter: wait != null ? wait / 1000 : null };
  // The SDK's classes keep the name "Error", so the class name is read too.
  const named = `${err?.name ?? ''} ${err?.constructor?.name ?? ''}`;
  if (status == null && !lead && (isBriefNetworkError(err) || /\bAPIConnection(Timeout)?Error\b/.test(named) || /^(Connection error|Request timed out)\.?$/i.test(String(err?.message ?? '')))) {
    return classify({ ...base, network: true, code: String(err?.cause?.code ?? err?.code ?? 'connection dropped') });
  }
  return classify({ ...base, status: status ?? (lead ? Number(lead[1]) : null), type: parsed.type, code: parsed.code, message: parsed.message, retryAfter: wait != null ? wait / 1000 : (parsed.retryAfter ?? undefined) });
}

// An Error carrying the text, with .status and .kind for callers that read them.
export function errorFor(result, status = null) {
  const err = new Error(result.text);
  err.kind = result.kind;
  if (status != null) err.status = status;
  return err;
}
