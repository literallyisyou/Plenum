// The Responses API path for the OpenAI models whose tool calls need it (GPT-6.2; DECISIONS item 199). OpenAI's Chat Completions takes
// GPT-6.2 but makes no tool calls for it, so a 6.2 request that carries tools goes to POST {baseUrl}/responses with stream: true instead.
// lib/openai-compat.mjs keeps the loop (the rounds and their limit, the spend cap, the tool runs and their cards, the pro-08 check, usage,
// onStop and Stop) and asks this file for the request shape and for one round at a time, so a chat, an agent, a /build coder and the tool
// test treat both endpoints alike.
//
//   usesResponses(provider, id)         true when a request to this model that carries tools must go through the Responses API
//   responsesInput(messages, images)    the conversation as Responses input items (text; the pictures in the newest user message)
//   responsesTool(tool)                 one Plenum tool ({ name, description, input_schema }) as a Responses function tool
//   responsesRound({ url, apiKey, label, body, signal, onActivity, provider, notice, retry })
//                                       one request and its streamed reply, with the same retries as a chat-completions round (lib/api-
//                                       retry.mjs: only before any of the reply came). Yields the text deltas and returns
//                                       { text, calls: [{ id, name, args }], aborted, usage, at, finish, model, responseId }
//
// The rounds of one reply are chained with previous_response_id, as the computer-use driver (lib/computer/openai.mjs) chains its requests:
// the next round sends only the tool results, with the instructions and the tools again (OpenAI does not carry instructions over). A reply
// that names no response id is continued by sending the whole input again with the calls and their results. The requests are stored by
// OpenAI the way the Responses API stores them by default, as the computer-use driver's are.
//
// Stream events read (OpenAI's Responses streaming reference): response.created, response.output_text.delta, response.refusal.delta,
// response.output_item.added and .done (function_call items), response.function_call_arguments.delta and .done, response.completed,
// response.incomplete (max_output_tokens is the output limit: finish 'length'), response.failed and error. Any other event is activity
// only. UNVERIFIED against the real API: this file was built against a stand-in server; only a real run can show the live events agree.
import { classify, errorFor, isBriefNetworkError, parseErrorBody, resetHintFromHeaders, waitFromHeaders } from './api-errors.mjs';
import { retryableStatus, withRetry } from './api-retry.mjs';
import { isGpt62 } from './gpt62.mjs';

export const usesResponses = (provider, id) => provider === 'openai' && isGpt62(id);

const plainText = content => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
  return '';
};

// The messages as input items: { role, content } with the text as a string. The pictures (if any) go in the newest user message after
// its text as input_image parts; that message is kept even with no text, so a picture sent alone still reaches the model.
export function responsesInput(messages = [], images = []) {
  const out = [];
  const lastUser = images.length ? messages.map(m => m?.role).lastIndexOf('user') : -1;
  messages.forEach((m, i) => {
    const text = plainText(m?.content);
    if (!text.trim() && i !== lastUser) return;
    const role = m?.role === 'assistant' ? 'assistant' : 'user';
    if (i === lastUser) {
      const pictures = images.map(image => ({ type: 'input_image', image_url: `data:${image.mime};base64,${image.data}` }));
      out.push({ role, content: [...(text.trim() ? [{ type: 'input_text', text }] : []), ...pictures] });
      return;
    }
    out.push({ role, content: text });
  });
  return out;
}

// strict is off: several Plenum tools have optional fields, which strict mode does not allow (as in lib/computer/openai.mjs).
export const responsesTool = t => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema, strict: false });

const reasonOf = err => err?.cause?.code ?? err?.message ?? 'unknown error';

function mayRetry(err, kind, waitMs, again) {
  err.retry = { kind, waitMs, rebuild: again };
  return err;
}

// A non-2xx answer, in the words every API path uses (lib/api-errors.mjs), never with the key or the request. A status that may pass by
// itself is marked for retry.
async function failure(res, label, apiKey, { provider, model } = {}) {
  const raw = await res.text().catch(() => '');
  const body = parseErrorBody(raw);
  const waited = waitFromHeaders(res.headers) ?? (body.retryAfter != null ? body.retryAfter * 1000 : null) ?? (res.status === 429 ? resetHintFromHeaders(res.headers) : null);
  const input = { status: res.status, type: body.type, code: body.code, message: body.message, provider, model, label, retryAfter: waited != null ? waited / 1000 : undefined };
  const found = classify({ ...input, apiKey });
  const err = errorFor(found, res.status);
  if (!found.retryable || !retryableStatus(res.status)) return err;
  const again = tries => classify({ ...input, message: found.detail, tries }).text;
  return mayRetry(err, found.kind, found.retryAfter != null ? found.retryAfter * 1000 : null, again);
}

function unreachable(err, label, signal) {
  const code = reasonOf(err);
  const again = tries => classify({ network: true, code, label, tries }).text;
  const out = new Error(again(1));
  out.kind = 'network';
  return isBriefNetworkError(err) && !signal?.aborted ? mayRetry(out, 'network', null, again) : out;
}

// An error the stream itself carried (an error event, or a response that failed). Retried only while nothing of the reply came.
function streamFailure(said, { label, provider, model, apiKey, started }) {
  const body = parseErrorBody({ error: said });
  const found = classify({ status: body.status, type: body.type, code: body.code, message: body.message, provider, model, label, apiKey });
  const why = found.detail || 'no reason given';
  const err = new Error(`${label} stopped with an error: ${why}${found.step ? `${/[.!?…]$/.test(why) ? '' : '.'} ${found.step}` : ''}`);
  err.kind = found.kind;
  if (started || !found.retryable) return err;
  const again = tries => `${err.message}${tries > 1 ? ` Plenum tried ${tries} times.` : ''}`;
  return mayRetry(err, found.kind, found.retryAfter != null ? found.retryAfter * 1000 : null, again);
}

const DONE = Symbol('done');
function readLine(line, label) {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (!text.startsWith('data:')) return null;
  const payload = text.slice(5).trim();
  if (!payload) return null;
  if (payload === '[DONE]') return DONE;
  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    throw new Error(`${label} sent a reply this app could not read.`);
  }
  return event && typeof event === 'object' ? event : null;
}

export async function* responsesRound({ url, apiKey, label, body, signal, onActivity, provider, notice, retry }) {
  const { sleep, random, tries } = retry ?? {};
  return yield* withRetry(() => attempt({ url, apiKey, label, body, signal, onActivity, provider }), { signal, label, notice, onWait: onActivity, sleep, random, tries });
}

async function* attempt({ url, apiKey, label, body, signal, onActivity, provider }) {
  const at = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
      // A redirect is refused rather than followed, so the key and the conversation are never sent to another host.
      redirect: 'error',
    });
  } catch (err) {
    if (signal?.aborted) return { text: '', calls: [], aborted: true };
    if (/redirect/i.test(String(err?.cause?.message ?? ''))) throw new Error(`${label} tried to redirect the request, so it was stopped. The key was not sent on.`);
    throw unreachable(err, label, signal);
  }
  if (!res.ok) {
    if (signal?.aborted) return { text: '', calls: [], aborted: true };
    throw await failure(res, label, apiKey, { provider, model: body.model });
  }
  if (!res.body) throw new Error(`${label} sent an empty reply.`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const who = { label, provider, model: body.model, apiKey };
  let buf = '';
  let text = '';
  let usage = null;
  let finish = null;
  let started = false;
  let model = '';
  let responseId = null;
  // The calls by their item id (fc_...), else by their place in the output, in the order they came. A call's arguments come in pieces;
  // the done events carry them whole.
  const calls = new Map();
  const keyOf = (id, index) => (typeof id === 'string' && id ? id : Number.isInteger(index) ? `@${index}` : calls.size ? [...calls.keys()].at(-1) : '@0');
  const callOf = (k, item = {}) => {
    if (!calls.has(k)) calls.set(k, { id: '', name: '', args: '' });
    const c = calls.get(k);
    if (item.call_id) c.id = String(item.call_id);
    if (item.name) c.name = String(item.name);
    return c;
  };
  const noteResponse = r => {
    if (!r || typeof r !== 'object') return;
    if (!model && typeof r.model === 'string' && r.model) model = r.model;
    if (!responseId && typeof r.id === 'string' && r.id) responseId = r.id;
    if (r.usage && typeof r.usage === 'object') usage = r.usage;
  };
  try {
    for (;;) {
      let got;
      try {
        got = await reader.read();
      } catch (err) {
        if (signal?.aborted) return { text, calls: [], aborted: true };
        if (started) {
          const shown = text.length ? `${text.length} character${text.length === 1 ? '' : 's'} of the reply` : 'the start of a tool call';
          throw new Error(`The connection to ${label} dropped after ${shown}. Send again to continue.`);
        }
        throw unreachable(err, label, signal);
      }
      const eof = got.done;
      try {
        onActivity?.();
      } catch {
        // A broken listener must not stop the reply.
      }
      buf += eof ? decoder.decode() : decoder.decode(got.value, { stream: true });
      if (eof && buf && !buf.endsWith('\n')) buf += '\n';
      let stop = false;
      let nl;
      while (!stop && (nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const ev = readLine(line, label);
        if (ev === DONE) {
          stop = true;
          break;
        }
        if (!ev) continue;
        switch (ev.type) {
          case 'response.created':
          case 'response.in_progress':
            noteResponse(ev.response);
            break;
          case 'response.output_text.delta':
          case 'response.refusal.delta':
            if (typeof ev.delta === 'string' && ev.delta) {
              started = true;
              text += ev.delta;
              yield ev.delta;
            }
            break;
          case 'response.output_item.added':
          case 'response.output_item.done':
            if (ev.item?.type === 'function_call') {
              started = true;
              const c = callOf(keyOf(ev.item.id, ev.output_index), ev.item);
              if (ev.type === 'response.output_item.done' && typeof ev.item.arguments === 'string') c.args = ev.item.arguments;
            }
            break;
          case 'response.function_call_arguments.delta':
            if (typeof ev.delta === 'string') {
              started = true;
              callOf(keyOf(ev.item_id, ev.output_index)).args += ev.delta;
            }
            break;
          case 'response.function_call_arguments.done':
            if (typeof ev.arguments === 'string') callOf(keyOf(ev.item_id, ev.output_index)).args = ev.arguments;
            break;
          case 'response.completed':
            noteResponse(ev.response);
            finish = 'stop';
            // A stream that sent no item events still names its calls in the finished response.
            (Array.isArray(ev.response?.output) ? ev.response.output : []).forEach((item, index) => {
              if (item?.type !== 'function_call' || [...calls.values()].some(c => c.id && c.id === item.call_id)) return;
              const c = callOf(keyOf(item.id, index), item);
              if (typeof item.arguments === 'string') c.args = item.arguments;
            });
            stop = true;
            break;
          case 'response.incomplete': {
            noteResponse(ev.response);
            const reason = ev.response?.incomplete_details?.reason;
            finish = reason === 'max_output_tokens' ? 'length' : typeof reason === 'string' && reason ? reason : 'incomplete';
            stop = true;
            break;
          }
          case 'response.failed':
            noteResponse(ev.response);
            throw streamFailure(ev.response?.error ?? { message: '' }, { ...who, started });
          case 'error':
            throw streamFailure(ev.error && typeof ev.error === 'object' ? ev.error : { code: ev.code, type: ev.code, message: ev.message ?? '' }, { ...who, started });
          default:
            break;
        }
        if (stop) break;
      }
      if (stop || eof) break;
    }
  } finally {
    // The body is closed even when the caller stops reading early, so no connection is left open.
    reader.cancel().catch(() => {});
  }
  return { text, calls: [...calls.values()], aborted: false, usage, at, finish, model, responseId };
}
