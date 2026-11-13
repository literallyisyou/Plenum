import { apiProvider } from './api-providers.mjs';
import { classify, errorFor, isBriefNetworkError, parseErrorBody, resetHintFromHeaders, waitFromHeaders } from './api-errors.mjs';
import { retryableStatus, withRetry } from './api-retry.mjs';
import { imageSupport, mimeWords } from './capabilities.mjs';
import { pdfRefusal } from './attachments.mjs';
import { reportUsage, tokensFromChat } from './pricing.mjs';
import { SPEND_CAP_STOPPED, clip, describeCall, loadTools, runTool, toolsFor } from './tools.mjs';
import { clipModel, markStale } from './tool-trust.mjs';

// Adapter for the OpenAI-compatible providers in lib/api-providers.mjs (xAI, OpenAI, DeepSeek, Mistral and
// Google AI). Each one takes POST {baseUrl}/chat/completions with stream: true and answers with server-sent
// events. Its events and ctx.out bookkeeping match streamClaude in lib/providers.mjs, so the chat view treats
// the two alike.
// Token counts: the request asks for them with stream_options.include_usage, and the provider sends them in the last
// chunk before [DONE] (a chunk with no choices). Each round reports { at, input, cached, output } through onUsage.

// reasoning_effort goes out only to the providers and model ids listed here. UNVERIFIED: this table is written
// from the providers' docs as last known, not from a real call. Until a real call shows the field accepted and
// the mapping right, treat it as a guess. Anything not listed gets no reasoning_effort field, because a model
// that does not take the field answers with an error. xhigh and max fold into high, which these providers do
// not name, except for a model listed under exact: Gemini 4 Hydrogen takes xhigh (Google's docs, 12 Nov 2026; DECISIONS
// item 89), so xhigh and max go out as xhigh for it.
const REASONING_EFFORT = {
  openai: { models: /^(o\d|gpt-5)/, levels: { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' } },
  googleai: {
    models: /^gemini-(2\.5|3|4)/,
    levels: { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' },
    exact: [{ models: /^gemini-4-hydrogen/, levels: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' } }],
  },
};

// Same limit as MAX_STEPS in providers.mjs: at most this many model requests that ask for tools. An agent allows the steps of its
// type (ctx.maxRequests), at most MAX_AGENT_STEPS (the ceiling in lib/agents.mjs, not imported here).
const MAX_ROUNDS = 30;
const MAX_AGENT_STEPS = 500;
const MAX_RESULT = 24_000;
const MAX_NOTE = 300;
const DONE = Symbol('done');

// The reasoning_effort value for a provider, model and effort, or null when the field should be left out.
export function reasoningEffortFor(provider, id, effort) {
  if (!Object.hasOwn(REASONING_EFFORT, provider)) return null;
  const entry = REASONING_EFFORT[provider];
  if (!entry.models.test(String(id ?? ''))) return null;
  const level = String(effort ?? '').trim().toLowerCase();
  const levels = (entry.exact ?? []).find(e => e.models.test(String(id ?? '')))?.levels ?? entry.levels;
  return Object.hasOwn(levels, level) ? levels[level] : null;
}

// The conversation as plain role and content strings, with the system prompt first. Claude-style content
// blocks are reduced to their text, because tool blocks from another provider mean nothing to this one.
const plainText = content => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
  }
  return '';
};

// One image as a chat-completions content part. shape comes from lib/capabilities.mjs: 'object' is image_url { url } (OpenAI's form),
// 'string' is image_url as a plain string (Mistral's page). The bytes live only in this request.
export function imagePart(image, shape = 'object') {
  const url = `data:${image.mime};base64,${image.data}`;
  return { type: 'image_url', image_url: shape === 'string' ? url : { url } };
}

// The messages in chat-completions form. The images (if any) go in the last user message, after its text, as content parts; that message
// is kept even when it has no text, so a picture sent alone still reaches the model.
function chatMessages(system, messages, images = [], shape = 'object') {
  const out = [];
  if (String(system ?? '').trim()) out.push({ role: 'system', content: String(system) });
  const lastUser = images.length ? messages.map(m => m?.role).lastIndexOf('user') : -1;
  messages.forEach((m, i) => {
    const text = plainText(m?.content);
    if (!text.trim() && i !== lastUser) return;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (i === lastUser) {
      const parts = [...(text.trim() ? [{ type: 'text', text }] : []), ...images.map(image => imagePart(image, shape))];
      out.push({ role, content: parts });
      return;
    }
    out.push({ role, content: text });
  });
  return out;
}

// One tool definition in the chat-completions function format.
const chatTool = t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } });

// Tool arguments arrive as a JSON string. An empty string means no arguments.
function parseArguments(raw) {
  if (!String(raw ?? '').trim()) return {};
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tool arguments must be a JSON object.');
  return value;
}

// Which call a streamed tool_calls piece belongs to. Most providers send an index. Some send the id only on a
// call's first piece, and then later pieces with neither id nor index continue the call before them.
function slotFor(pending, piece) {
  if (Number.isInteger(piece.index)) return piece.index;
  if (piece.id) {
    const seen = pending.findIndex(p => p?.id === piece.id);
    return seen >= 0 ? seen : pending.length;
  }
  return Math.max(0, pending.length - 1);
}

// Reads one line of the event stream. Returns null for lines that carry no data (comments, event names, blank
// separators), DONE for the end marker, and otherwise the parsed chunk. The payload is never echoed in an error.
function readSseLine(line, label) {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (!text.startsWith('data:')) return null;
  const payload = text.slice(5).trim();
  if (!payload) return null;
  if (payload === '[DONE]') return DONE;
  let chunk;
  try {
    chunk = JSON.parse(payload);
  } catch {
    throw new Error(`${label} sent a reply this app could not read.`);
  }
  return chunk && typeof chunk === 'object' ? chunk : null;
}

// The finish_reason a chunk carries ('stop', 'length', 'tool_calls' and so on), or null when it carries none.
// 'length' means the reply hit the output limit (see streamOpenAICompat).
export function finishOf(chunk) {
  const reason = chunk?.choices?.[0]?.finish_reason;
  return typeof reason === 'string' && reason ? reason : null;
}

// The key never appears in an error, even when a provider echoes it back: every text goes through classify (lib/api-errors.mjs), which
// replaces the key, and anything shaped like a key, with [key].
const reasonOf = err => err?.cause?.code ?? err?.message ?? 'unknown error';

// An error that streamRound may make again (see lib/api-retry.mjs): it carries what the retry needs, never the key. again(tries)
// gives the closing message once the tries are used up, which says how many times Plenum tried.
function mayRetry(err, kind, waitMs, again) {
  err.retry = { kind, waitMs, rebuild: again };
  return err;
}

// Builds the error for a non-2xx answer. It says what happened and what to do (lib/api-errors.mjs), carries the provider's own message,
// never the request headers or the key. A status that may pass by itself (a brief rate limit, an overloaded server) is marked for retry.
async function failure(res, label, apiKey, { provider, model } = {}) {
  const raw = await res.text().catch(() => '');
  const body = parseErrorBody(raw);
  // The wait the provider asks for: its Retry-After header, else the wait its message names, else (for a rate limit) a short reset header.
  const waited = waitFromHeaders(res.headers) ?? (body.retryAfter != null ? body.retryAfter * 1000 : null) ?? (res.status === 429 ? resetHintFromHeaders(res.headers) : null);
  const input = { status: res.status, type: body.type, code: body.code, message: body.message, provider, model, label, retryAfter: waited != null ? waited / 1000 : undefined };
  const found = classify({ ...input, apiKey });
  const err = errorFor(found, res.status);
  if (!found.retryable || !retryableStatus(res.status)) return err;
  // The retry keeps the provider's words as already tidied, never the raw body.
  const again = tries => classify({ ...input, message: found.detail, tries }).text;
  return mayRetry(err, found.kind, found.retryAfter != null ? found.retryAfter * 1000 : null, again);
}

// The error for a connection that failed before any reply: a dropped or timed out connection may be tried again.
function unreachable(err, label, signal) {
  const code = reasonOf(err);
  const again = tries => classify({ network: true, code, label, tries }).text;
  const out = new Error(again(1));
  out.kind = 'network';
  return isBriefNetworkError(err) && !signal?.aborted ? mayRetry(out, 'network', null, again) : out;
}

// One request and its streamed reply. It yields the text deltas and returns what the model asked for:
// { text, calls: [{ id, name, args }], aborted, usage, at, finish }, where args is the raw JSON text as it arrived, usage is the
// provider's usage object (null when it sent none), at is when the request was sent and finish is the last finish_reason
// the stream gave (null when none).
// onActivity (optional) is called on every piece of the stream that arrives, reasoning included (see streamChat in lib/providers.mjs).
async function* streamRound({ url, apiKey, label, body, signal, onActivity, provider, notice, retry }) {
  const { sleep, random, tries } = retry ?? {};
  return yield* withRetry(() => roundAttempt({ url, apiKey, label, body, signal, onActivity, provider }), { signal, label, notice, onWait: onActivity, sleep, random, tries });
}

// One try of streamRound. It throws an error marked for retry only while nothing of the reply has been shown or parsed: `started` turns true
// at the first text or the first piece of a tool call, and from then on a failure is final (a second request would repeat text and could
// run a tool twice).
async function* roundAttempt({ url, apiKey, label, body, signal, onActivity, provider }) {
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
    if (/redirect/i.test(String(err?.cause?.message ?? ''))) {
      throw new Error(`${label} tried to redirect the request, so it was stopped. The key was not sent on.`);
    }
    throw unreachable(err, label, signal);
  }
  if (!res.ok) {
    if (signal?.aborted) return { text: '', calls: [], aborted: true };
    throw await failure(res, label, apiKey, { provider, model: body.model });
  }
  if (!res.body) throw new Error(`${label} sent an empty reply.`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let usage = null;
  let finish = null;
  let started = false;
  const pending = [];
  // The model the provider says answered: the first non-empty model name in a chunk (pro-08 compares it with the tested model).
  let model = '';
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
      // A network read can end in the middle of a line, so the bytes wait in buf until the newline arrives.
      buf += eof ? decoder.decode() : decoder.decode(got.value, { stream: true });
      if (eof && buf && !buf.endsWith('\n')) buf += '\n';
      let stop = false;
      let nl;
      while (!stop && (nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const chunk = readSseLine(line, label);
        if (chunk === DONE) {
          stop = true;
          break;
        }
        if (!chunk) continue;
        if (chunk.error) {
          const said = parseErrorBody({ error: chunk.error });
          const found = classify({ status: said.status, type: said.type, code: said.code, message: said.message, provider, model: body.model, label, apiKey });
          // The provider's words end with a full stop before the next step is added, so the two read as two sentences.
          const why = found.detail || 'no reason given';
          const err = new Error(`${label} stopped with an error: ${why}${found.step ? `${/[.!?…]$/.test(why) ? '' : '.'} ${found.step}` : ''}`);
          err.kind = found.kind;
          if (started || !found.retryable) throw err;
          const again = tries => `${err.message}${tries > 1 ? ` Plenum tried ${tries} times.` : ''}`;
          throw mayRetry(err, found.kind, found.retryAfter != null ? found.retryAfter * 1000 : null, again);
        }
        // Providers that count tokens send a usage object, either null on every chunk but the last or only on the last.
        if (chunk.usage && typeof chunk.usage === 'object') usage = chunk.usage;
        if (!model && typeof chunk.model === 'string' && chunk.model) model = chunk.model;
        finish = finishOf(chunk) ?? finish;
        const delta = chunk.choices?.[0]?.delta;
        if (typeof delta?.content === 'string' && delta.content) {
          started = true;
          text += delta.content;
          yield delta.content;
        }
        for (const piece of delta?.tool_calls ?? []) {
          if (!piece || typeof piece !== 'object') continue;
          started = true;
          const i = slotFor(pending, piece);
          pending[i] ??= { id: '', name: '', args: '' };
          if (piece.id) pending[i].id = String(piece.id);
          if (piece.function?.name) pending[i].name = String(piece.function.name);
          if (typeof piece.function?.arguments === 'string') pending[i].args += piece.function.arguments;
        }
      }
      if (stop || eof) break;
    }
  } finally {
    // The body is closed even when the caller stops reading early, so no connection is left open.
    reader.cancel().catch(() => {});
  }
  return { text, calls: pending.filter(Boolean), aborted: false, usage, at, finish, model };
}

// Runs one round's tool calls. Each call is announced first, then run; several delegate calls in one reply run
// in parallel, as they do in the Claude adapter, and the other calls keep their order.
async function runCalls(calls, ctx) {
  const items = calls.map(call => {
    let input = null;
    try {
      input = parseArguments(call.args);
    } catch {
      input = null;
    }
    return { ...call, input, argsText: input ? JSON.stringify(input) : '{}', summary: describeCall(call.name, input ?? {}) };
  });
  // The raw arguments go on the event only for a test that asks for them (lib/tool-test.mjs, recordArgs). A chat never gets them.
  for (const it of items) ctx.emit?.({ type: 'tool', id: it.id, name: it.name, summary: it.summary, ...(ctx.recordArgs ? { args: it.args } : {}) });
  const runOne = async it => {
    let res;
    if (!it.input) {
      res = {
        ok: false,
        summary: 'The arguments were not valid JSON.',
        output: 'Error: the arguments for this tool call were not a JSON object, so the tool did not run. Send the call again with valid JSON arguments.',
      };
    } else {
      try {
        res = await runTool(it.name, it.input, { ...ctx, parent: it.id });
      } catch (err) {
        res = { ok: false, summary: err.message, output: `Error: ${err.message}` };
      }
    }
    // A denial's summary is "Denied by user: " and the user's reason (at most 300 characters), so it gets room for both.
    const note = clip(res.summary ?? '', res.denied ? MAX_NOTE + 20 : MAX_NOTE);
    // A denial is marked denied, so the chat labels the step Denied and not Failed (C-5).
    const mark = res.denied ? { denied: true } : {};
    ctx.emit?.({ type: 'tool_result', id: it.id, ok: res.ok, summary: note, ...mark });
    ctx.out?.tools.push({ name: it.name, summary: it.summary, ok: res.ok, result: note, ...mark });
    return { id: it.id, name: it.name, argsText: it.argsText, content: clip(res.output ?? '', MAX_RESULT) };
  };
  const parallel = new Map(items.filter(it => it.name === 'delegate').map(it => [it.id, runOne(it)]));
  const results = [];
  for (const it of items) results.push(await (parallel.get(it.id) ?? runOne(it)));
  return results;
}

// ctx (optional) turns on tools: { root, mode, signal, emit, approve, queueUpdate, out }, the same ctx the Claude
// adapter takes. Without ctx this is a plain reply. ctx.out.api is left alone on purpose: historyFor in
// providers.mjs replays it to Claude only, and these tool turns are not in Claude's format, so they stay out of it.
// A stop (signal) ends the stream quietly, the way the caller expects: it is not thrown as an error.
// onUsage (optional) gets { at, input, cached, output } after each round whose provider sent token counts.
// onStop (optional) gets 'length' when the last round hit the output limit with text and no tool call. It is called once,
// at the end of the reply, and never for any other finish reason.
// images (optional) are the pictures of the newest message, each { name, mime, data }. They go in as image_url parts when the model takes
// them (lib/capabilities.mjs); a model that does not, or a type it does not take, is refused before a request is made. Documents (PDFs)
// are not sent here: streamChat turns them into text first. Text files are in the messages already.
// onModel (optional) gets the model name the provider says answered, once per round that names one (pro-08 records it).
// A request that fails before any of the reply has come (a brief rate limit, an overloaded server, a dropped connection) is made again, up
// to 4 requests in all (lib/api-retry.mjs); a notice event tells the person ("OpenAI API is busy. Trying again in 8 seconds (try 2 of 4)."),
// through onNotice when given, else ctx.emit. A retried request counts once: usage is reported for the request that answered, and the
// round and spend-cap counts do not move. retry (optional, for tests) is { sleep, random, tries }.
export async function* streamOpenAICompat({ provider, id, baseUrl, apiKey, system, messages = [], ctx, signal, effort, onUsage, onStop, onModel, images = [], documents, onActivity, onNotice, retry } = {}) {
  if (documents?.length) throw new Error(pdfRefusal(documents.length === 1 ? documents[0].name : ''));
  const label = apiProvider(provider)?.label ?? provider ?? 'The provider';
  const support = images.length ? imageSupport(`${provider}:${id}`) : null;
  if (support && !support.ok) throw new Error(`${label} cannot take images in Plenum: ${support.why}`);
  if (support && images.some(image => !support.mimes.includes(image.mime))) throw new Error(`${label} takes ${mimeWords(support.mimes)} images only.`);
  if (!apiKey) throw new Error(`No ${label} key is saved. Open Accounts, paste the key and save it.`);
  const base = String(baseUrl ?? apiProvider(provider)?.baseUrl ?? '').replace(/\/+$/, '');
  if (!base) throw new Error(`${label} has no base URL.`);
  const url = `${base}/chat/completions`;
  const convo = chatMessages(system, messages, images, support?.shape ?? 'object');
  // A raw entry (a toolset for another API) has no input_schema, so it is not sent in this format.
  if (ctx) await loadTools();
  let tools = ctx ? toolsFor(ctx).filter(t => t.input_schema).map(chatTool) : null;
  const reasoning = reasoningEffortFor(provider, id, effort);
  // Only a provider listed with streamUsage: false is left out (see lib/api-providers.mjs). A caller that names no known
  // provider still asks, since the field is part of the OpenAI format.
  const askUsage = apiProvider(provider)?.streamUsage !== false;

  const roundLimit = Math.min(MAX_AGENT_STEPS, ctx?.maxRequests ?? MAX_ROUNDS);
  for (let round = 0; ; round++) {
    if (round >= roundLimit) {
      yield `\n\n[Stopped after ${roundLimit} tool steps. Send a follow-up to continue.]`;
      return;
    }
    // The spend cap holds inside a reply too (C-4): a turn that has reached it makes no further request. Only a turn billed per token has a budgetCheck.
    if (round > 0 && ctx?.budgetCheck?.()) {
      yield SPEND_CAP_STOPPED;
      return;
    }
    const body = {
      model: id,
      stream: true,
      ...(askUsage ? { stream_options: { include_usage: true } } : {}),
      messages: convo,
      ...(tools ? { tools } : {}),
      ...(reasoning ? { reasoning_effort: reasoning } : {}),
    };
    const turn = yield* streamRound({ url, apiKey, label, body, signal, onActivity, provider, notice: onNotice ?? ctx?.emit, retry });
    // Reported even when the request was stopped or is the last one, so the tokens it used are counted.
    const tokens = tokensFromChat(turn.usage);
    if (tokens) reportUsage(onUsage, { at: turn.at, ...tokens });
    if (turn.aborted || signal?.aborted) return;
    if (turn.model) onModel?.(turn.model);
    // A reply cut at the output limit with no tool call is the last round, so the caller hears about it here.
    if (turn.finish === 'length' && turn.text && !turn.calls.some(c => c.name)) onStop?.('length');
    if (!tools) return;
    // Calls without a name cannot be run or answered, so they are dropped. A call with no id gets one here,
    // since the tool message has to name the call it answers.
    const calls = turn.calls
      .filter(c => c.name)
      .map((c, i) => ({ id: c.id || `call_${round}_${i}`, name: c.name, args: c.args }));
    // Tool calls are run whenever the reply carries them, not only when finish_reason says so, since some
    // providers report "stop" with calls attached.
    if (!calls.length) return;
    // pro-08: a model that passed the tool test answers under a different name now. Its calls are not run, the page is told, the
    // record is marked stale, and the next request carries no tools, so the reply is text.
    const served = ctx?.trust?.servedModel;
    const answeredAs = clipModel(turn.model);
    const changed = typeof served === 'string' && served !== '' && answeredAs !== '' && answeredAs !== served;
    if (changed) {
      ctx.emit?.({ type: 'notice', text: `${label} answered as ${answeredAs}, not ${served}, the model that passed the tool test. Tools are off for it until it is tested again.` });
      markStale(ctx.trust.ref, answeredAs);
    }
    const results = changed ? calls.map(notRun) : await runCalls(calls, ctx);
    if (signal?.aborted) return;
    convo.push({
      role: 'assistant',
      content: turn.text,
      tool_calls: results.map(r => ({ id: r.id, type: 'function', function: { name: r.name, arguments: r.argsText } })),
    });
    for (const r of results) convo.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    if (changed) tools = null;
  }
}

// The answer to a call that was not run because the model behind its name changed (pro-08). The arguments are kept as valid JSON.
function notRun(call) {
  let argsText = '{}';
  try {
    argsText = JSON.stringify(parseArguments(call.args));
  } catch {
    argsText = '{}';
  }
  return { id: call.id, name: call.name, argsText, content: 'Not run: tools were turned off because the model behind this name changed. Answer in text.' };
}
