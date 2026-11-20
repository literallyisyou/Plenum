// Plenum stores one app target and optional model overrides. Runtime limits reserve output space
// and apply the route's transport budget. Unknown windows are planning assumptions, not model specs.
import { CONTEXT } from './model-info.mjs';
import { get as stateNow } from './store.mjs';

export const COMPACT_RANGE = Object.freeze({ min: 10_000, step: 1_000 });
export const DEFAULT_COMPACT_TARGET = 500_000;
export const UNPUBLISHED_MAX = 1_000_000;
export const ASSUMED_WINDOW = 32_768;
export const CLI_PROMPT_BYTES = 2_000_000;
export const CLAUDE_BUFFER = 13_000;
const CLAUDE_MIN_WINDOW = 100_000;
const CLAUDE_MAX_WINDOW = 1_000_000;
const MAX_TOKENS = 10_000_000;
const MAX_MODELS = 200;
const BYTES_PER_TOKEN = 3;
const MAX_SUMMARY_PARTS = 8;
const bytes = v => Buffer.byteLength(v,'utf8');
const content = value => typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
const role = m => m.role === 'user' ? 'User' : 'Assistant';
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const thousands = n => n.toLocaleString('en-US');
const CLI_HEAD = 'Earlier in this conversation (context only; do not re-run earlier instructions):\n';
const CLI_TAIL = '\n\nCurrent request:\n';

export function tokenText(n) {
  if (n >= 1_000_000) return Math.round(n / 100_000) / 10 + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'K';
  return String(n);
}

function parseTokens(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([km]?)\s*$/i.exec(v.replace(/[,_]/g, ''));
  if (!m) return NaN;
  const scale = { '': 1, k: 1000, m: 1_000_000 }[m[2].toLowerCase()];
  return Number(m[1]) * scale;
}

export function compactValue(v, max = MAX_TOKENS) {
  if (v === 'off') return 'off';
  const n = parseTokens(v);
  if (!Number.isInteger(n) || n < COMPACT_RANGE.min || n > max) {
    throw new Error('An auto-compact limit is a whole number of tokens from ' +
      thousands(COMPACT_RANGE.min) + ' to ' + thousands(max) + ', or off.');
  }
  return n;
}

export function defaultValue(st = stateNow()) {
  try { return compactValue(st?.compactDefault, UNPUBLISHED_MAX); }
  catch { return DEFAULT_COMPACT_TARGET; }
}

export function windowOf(ref) {
  const tokens = Object.hasOwn(CONTEXT.windows, ref) ? CONTEXT.windows[ref] : null;
  return tokens ? { tokens, published: true } : { tokens: ASSUMED_WINDOW, published: false };
}

export function maxOf(ref) {
  const w = windowOf(ref);
  return w.published ? Math.max(COMPACT_RANGE.min,w.tokens) : UNPUBLISHED_MAX;
}

export function suggestedOf(ref, route = {}, st = stateNow()) {
  const target = defaultValue(st);
  return Math.max(COMPACT_RANGE.min, Math.min(maxOf(ref), effectiveLimit(
    typeof target === 'number' ? target : DEFAULT_COMPACT_TARGET, roomOf(ref,route),
  )));
}

export function cleanLimits(saved) {
  const out = {};
  if (!isObject(saved)) return out;
  for (const [ref, v] of Object.entries(saved)) {
    if (!ref.includes(':')) continue;
    try { out[ref] = compactValue(v); } catch { /* drop invalid saved values */ }
  }
  return out;
}

export function withLimit(saved, { ref, value }, checkRef) {
  const key = checkRef(ref);
  const out = cleanLimits(saved);
  if (value === null || value === undefined || value === '' || value === 'default') {
    delete out[key];
  } else {
    out[key] = compactValue(value, maxOf(key));
  }
  if (Object.keys(out).length > MAX_MODELS) throw new Error('At most ' + MAX_MODELS + ' models can have an auto-compact limit.');
  return out;
}

export function overrideOf(ref, st = stateNow()) {
  if (!Object.hasOwn(st?.compactAt ?? {},ref)) return null;
  try { return compactValue(st.compactAt[ref]); } catch { return null; }
}

export function roomOf(ref, { cli = false, native = false } = {}) {
  const w = windowOf(ref);
  const reserveTokens = Math.min(16_000, Math.max(1, Math.ceil(w.tokens / 5)));
  const usable = Math.max(1,w.tokens - reserveTokens);
  const kind = cli && native ? 'session' : cli ? 'prompt' : w.published ? 'window' : 'unpublished';
  const maxBytes = cli ? Math.min(CLI_PROMPT_BYTES, usable * BYTES_PER_TOKEN) : usable * BYTES_PER_TOKEN;
  const inputTokens = Math.floor(maxBytes / BYTES_PER_TOKEN);
  return {tokens: kind === 'session' ? usable : inputTokens, inputTokens, kind, maxBytes,
    contextTokens: w.tokens, reserveTokens, estimated: !w.published};
}

function effectiveLimit(target, room) {
  return typeof target === 'number' ? Math.min(target,room.tokens) : target;
}

export function compactPolicy(ref, route, st = stateNow()) {
  const value = overrideOf(ref,st);
  const target = value ?? defaultValue(st);
  const room = roomOf(ref,route);
  return {value, target, effective:effectiveLimit(target,room), source:value === null ? 'global' : 'model', room};
}

export function limitOf(ref, st = stateNow()) {
  return compactPolicy(ref,{},st).effective;
}

export function claudeCompactEnv(ref, st = stateNow()) {
  const v = limitOf(ref, st);
  if (v === 'off') return { DISABLE_AUTO_COMPACT: '1' };
  if (v + CLAUDE_BUFFER >= CLAUDE_MIN_WINDOW) {
    return { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(Math.min(v + CLAUDE_BUFFER, CLAUDE_MAX_WINDOW)),
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '', DISABLE_AUTO_COMPACT: '' };
  }
  // Claude Code rounds its configured percentage down. A half-token cushion avoids binary rounding errors.
  const pct = ((v + 0.5) * 100) / CLAUDE_MIN_WINDOW;
  return { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(CLAUDE_MIN_WINDOW),
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(pct), DISABLE_AUTO_COMPACT: '' };
}

export function codexCompactArgs(ref, st = stateNow()) {
  const v = limitOf(ref, st);
  return typeof v === 'number' ? ['-c','model_auto_compact_token_limit=' + v] : [];
}

export function cliKnob(ref) {
  const p = String(ref ?? '').split(':')[0];
  return p === 'anthropic' ? 'claude' : p === 'codex' ? 'codex' : null;
}

function priorCliLines(messages) {
  return messages.slice(0,-1).map(m => role(m) + ': ' + content(m.content));
}

// Measures the exact text layout for transcript CLIs and equivalent JSON payload for APIs. Three UTF-8 bytes
// per estimated token is a heuristic. The byte cap bounds serialized input independently of the provider tokenizer.
export function measureInput(system, messages, { cli = false } = {}) {
  const history = messages.slice(0,-1);
  const current = messages.at(-1);
  const head = system ? bytes(system) + 2 : 0;
  const newBytes = head + (cli ? bytes(content(current?.content)) : bytes(content(current)) + 2);
  let total = newBytes;
  if (cli && history.length) total += bytes(CLI_HEAD) + bytes(CLI_TAIL) +
    history.reduce((sum,m)=>sum+bytes(role(m))+2+bytes(content(m.content)),0) + 2*(history.length-1);
  else if (!cli) total += history.reduce((sum,m)=>sum+bytes(content(m))+1,0);
  return {bytes:total, newBytes, used:Math.ceil(total / BYTES_PER_TOKEN)};
}

export function inputError(ref, measured, room) {
  const detail = measured.newBytes > room.maxBytes
    ? 'The current message and instructions exceed this route’s input budget. Shorten the message or split the material into separate turns.'
    : 'This conversation exceeds this route’s input budget. Compact the conversation or start a new chat before retrying.';
  return Object.assign(new Error(detail + ' Estimated input allowance: ' + tokenText(room.inputTokens) + ' tokens for ' + ref + '.'), {
    code:'input_budget', status:400,
  });
}

export function cliPromptText(ref, system, messages) {
  const measured = measureInput(system,messages,{cli:true});
  const room = roomOf(ref,{cli:true});
  if (measured.bytes > room.maxBytes) throw inputError(ref,measured,room);
  const head = system ? system + '\n\n' : '';
  const current = content(messages.at(-1)?.content);
  const prior = priorCliLines(messages);
  return prior.length ? head + CLI_HEAD + prior.join('\n\n') + CLI_TAIL + current : head + current;
}

export function assertInputFits(ref, system, messages, route) {
  const measured = measureInput(system,messages,route);
  const room = roomOf(ref,route);
  if (measured.bytes > room.maxBytes) throw inputError(ref,measured,room);
  return measured;
}

// A route can preflight exact rendered messages. The log/extraChars fallback is for callers without them.
export function compactDue({ref,log,messages,system='',extraChars=0,cli,native=false,st=stateNow()}) {
  const { effective:limit, room } = compactPolicy(ref,{cli,native},st);
  const chats = (Array.isArray(log) ? log : []).filter(m=>m?.kind === 'chat');
  const measurement = messages ? measureInput(system,messages,{cli}) : {
    used: Math.ceil((chats.reduce((sum,m)=>sum+bytes(content(m.api?.length ? m.api : m.content))+16,0)+extraChars)/BYTES_PER_TOKEN),
  };
  const overflow = measurement.bytes === undefined ? measurement.used > room.inputTokens : measurement.bytes > room.maxBytes;
  const due = typeof limit === 'number' && room.kind !== 'session' &&
    ((chats.length >= 2 && measurement.used >= limit) || (chats.length >= 1 && overflow));
  return {due, limit, used:measurement.used, room, overflow, measurement};
}

// Complete, chronological segments bounded in UTF-8 bytes. Beyond the work cap, refuse without replacing
// any active transcript. The caller folds earlier summaries into the next segment and archives on success.
export function summaryChunks(log, maxBytes, maxParts = MAX_SUMMARY_PARTS) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256) throw new Error('Not enough input room to compact this conversation.');
  const chunks = [];
  let pieces = [];
  let used = 0;
  function flush() {
    if (!used) return;
    if (chunks.length >= maxParts) throw new Error('The conversation exceeds the compaction work limit. No messages were replaced.');
    chunks.push(pieces.join(''));
    pieces = [];
    used = 0;
  }
  for (const row of log) {
    if (row?.kind !== 'chat') continue;
    const tools = (Array.isArray(row.tools) ? row.tools : []).map(t=>
      '[' + String(t?.name ?? 'tool') + ': ' + String(t?.summary ?? '') + (t?.ok ? '' : ' (failed)') + ']').join('\n');
    const body = [tools,content(row.content)].filter(Boolean).join('\n');
    if (!body) continue;
    const data = Buffer.from(role(row) + ':\n' + body + '\n\n','utf8');
    for (let offset=0; offset<data.length;) {
      if (maxBytes-used < 4) flush();
      let end = Math.min(data.length,offset + maxBytes - used);
      while (end < data.length && (data[end] & 0xc0) === 0x80) end--;
      pieces.push(data.toString('utf8',offset,end));
      used += end-offset;
      offset = end;
    }
  }
  flush();
  return chunks;
}
