// Auto routing (wave 6, ultra/work/wave6/AUTOROUTE-BRIEF.md section 1): for one task, pick a model from the owner's own list and an
// effort, from the task itself and the room left in each plan. Pure: it imports nothing, reads no clock, file or network, and the same
// input always gives the same output. lib/auto-context.mjs gathers the readings; lib/team.mjs (pick), lib/routines.mjs (chooseLead)
// and lib/jobs.mjs (Night shift) call route().
//
// THE CONTRACT (build/v06/w6-ar1 pins each part):
//   features(task) -> { points, demand, phrase, files, risk, len, simple, escalated, retry, base }
//        demand: 'small' | 'mid' | 'top'. points 0-6 (after a retry's +2). risk: the number of distinct risk stems. escalated: the
//        demand was already top before a retry, so the effort goes up one step instead.
//   roomOf(provider, ctx, avail?) -> { band: 'plenty'|'some'|'little'|'unknown'|'tight', room, used, line, cause }
//        cause (tight only, else null): 'line' (within 5 of the line) | 'limit' (a limit mark, a row that says out) | 'course' (a row
//        that says short or tight). A why names this cause and no other.
//        avail (optional): the candidate's { state, usedPercent }; without it, the candidates of that provider in ctx are read.
//   effortsFor(provider, id) -> [levels Auto may use] | null       null: the program has no effort setting
//        (Claude lists xhigh, which route() uses only on a retry from high; route() never chooses max.)
//   route(task, ctx) -> { ref, label, effort, why, alternatives: [{ ref, label, why }], stepBack?, features }
//        ref null with stepBack: true when nothing is eligible: the caller then does what it does today, in the owner's order.
//
//   task: { source: 'team'|'routine'|'night', kind: { id, agent, label }, typeKind: 'read'|'edit', commands, text, doneWhen, level,
//           failures, minutesLeft, lenHint, pins: { ref?, effort?, effortBy?: 'owner'|'lead' } }
//         lenHint (optional): a length the brief counts as at least (a routine's playbook counts as 3,000 characters).
//   ctx:  { candidates: [{ ref, label, provider, size, billing, avail: { state, usedPercent } }], planRows, planUse, lines, teamLine,
//           allowApi, cells, counts, atOnce, avoid, exclude, now }
//         candidates come in the owner's order and have already passed pick's or chooseLead's own tests. planRows: planState().subs.
//         cells: the Scorecard's { [ref]: { pass, fail } } for this kind, or null. avoid and exclude: refs or providers. now: the time
//         of the readings (ms), used only to tell a plan window that has reset or is older than 3 hours; without it only a window's own
//         `stale` flag counts.
//
// RULES THIS MODULE KEEPS: the ref is always one of the candidates (or the pinned ref); a per-token model is never chosen without
// allowApi; a model whose plan is tight or at or over the owner's line is never chosen; nothing is added to the list; every candidate is
// returned in `alternatives` (so Muse Code, Codex and Gemini are never left out); no task text ever reaches a `why` (only labels, provider
// names, numbers and fixed words); a why is at most 160 characters.

export const LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh']);
export const ALL_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const SIZES = Object.freeze(['small', 'mid', 'top']);
export const WHY_MAX = 160;
export const MIN_CHECKS = 20;
export const DEFAULT_LINE = 90;
export const STALE_MS = 3 * 60 * 60_000;
export const FILES_CAP = 50;
export const STEP_BACK_TIGHT = 'Auto stepped back: every plan in this list is close to its limit, so your order was used.';
export const STEP_BACK_OTHER = 'Auto stepped back: no model in this list can take this task now, so your order was used.';
export const RETRY_WORDS = 'one step up because the last try did not finish';
export const LARGEST_WORDS = 'the largest that can run now';

const PROVIDER_LABELS = Object.freeze({
  anthropic: 'Claude', codex: 'Codex', muse: 'Muse Code', gemini: 'Gemini', antigravity: 'Antigravity', cursor: 'Cursor', grok: 'Grok Build',
  openai: 'OpenAI', googleai: 'Google AI', echo: 'Echo',
});
// The programs that report no plan use: their room is never known, unless a limit mark says they are out.
const NO_READING = new Set(['gemini', 'antigravity', 'cursor', 'grok']);
const TIGHT_STATES = new Set(['out', 'short', 'tight']);
const KIND_BASE = Object.freeze({ find: 0, data: 0, write: 1, research: 1, test: 1, code: 2, review: 2 });
const AGENT_BASE = Object.freeze({ researcher: 1, tester: 1, coder: 2, reviewer: 2 });
const KIND_PHRASE = Object.freeze({
  find: 'a lookup', research: 'research', code: 'a code change', test: 'a test run', write: 'a piece of writing', data: 'bulk rows', review: 'a check',
});
const EFFORT_WORDS = Object.freeze({ low: 'low effort', medium: 'medium effort', high: 'high effort', xhigh: 'extra high effort', max: 'maximum effort' });
const BAND_ORDER = Object.freeze({ plenty: 0, some: 1, unknown: 2, little: 3, tight: 4 });
const NO_DATA_RATE = 0.8;
// The text is read this far for files, risk words and simple words (the length counts in full).
const SCAN_MAX = 200_000;

const RISK_STEMS = Object.freeze([
  'migrat', 'delet', 'remov', 'drop', 'refactor', 'secur', 'auth', 'password', 'credential', 'payment', 'money', 'invoice', 'legal',
  'contract', 'production', 'release', 'deploy', 'database', 'schema', 'concurren', 'race', 'lock', 'encrypt', 'token', 'irreversib', 'customer',
]);
// A stem at the start of a word. "auth" is not "author".
const RISK_RES = RISK_STEMS.map(stem => [stem, new RegExp(`\\b${stem}${stem === 'auth' ? '(?!or)' : ''}`, 'i')]);
const SIMPLE_RE = /\b(?:list|find|where|look up|lookup|summari[sz]e|count|rename|typo|format|classify|extract|translate)/i;
// A path (a/b, lib/x.mjs) or a file name with a known ending. Tried in that order at each place, so lib/x.mjs counts once.
const FILE_RE = /\b[\w.-]+\/[\w./-]+|\b[\w.-]+\.(?:mjs|js|cjs|ts|tsx|py|md|json|css|html|go|rs|kt|java)\b/g;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = v => (typeof v === 'string' ? v : '');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sizeRankOf = size => (size === 'small' ? 0 : size === 'top' ? 2 : 1);
const demandOf = points => (points >= 4 ? 2 : points >= 2 ? 1 : 0);
const splitRef = ref => {
  const text = String(ref ?? '');
  const i = text.indexOf(':');
  return i < 0 ? { provider: text, id: '' } : { provider: text.slice(0, i), id: text.slice(i + 1) };
};
export const providerLabel = provider => (Object.hasOwn(PROVIDER_LABELS, provider) ? PROVIDER_LABELS[provider] : String(provider || 'This program'));
const round = n => Math.round(n);

// ---------- the task ----------

function countFiles(text) {
  const seen = new Set();
  FILE_RE.lastIndex = 0;
  for (const m of text.matchAll(FILE_RE)) {
    const token = m[0].replace(/[./-]+$/, '');
    if (!token || (!token.includes('/') && !/\.[a-z]+$/i.test(token))) continue;
    seen.add(token);
    if (seen.size >= FILES_CAP) break;
  }
  return seen.size;
}

function countRisk(text) {
  let n = 0;
  for (const [, re] of RISK_RES) if (re.test(text)) n += 1;
  return n;
}

export function features(task) {
  const t = isObject(task) ? task : {};
  const text = str(t.text);
  const done = str(t.doneWhen);
  const len = Math.max(text.length + done.length, finite(t.lenHint) ?? 0);
  const scan = (done ? `${text}\n${done}` : text).slice(0, SCAN_MAX);
  const kind = isObject(t.kind) ? t.kind : {};
  const kindId = str(kind.id);
  const base = Object.hasOwn(KIND_BASE, kindId) ? KIND_BASE[kindId] : Object.hasOwn(AGENT_BASE, str(kind.agent)) ? AGENT_BASE[kind.agent] : 1;
  const files = countFiles(scan);
  const risk = countRisk(scan);
  const simple = len < 500 && risk === 0 && SIMPLE_RE.test(scan);
  const commands = Array.isArray(t.commands) ? t.commands.length > 0 : Boolean(t.commands);
  const edit = t.typeKind === 'edit';
  let points = base
    + (len >= 6000 ? 2 : len >= 2500 ? 1 : 0)
    + (files >= 12 ? 2 : files >= 4 ? 1 : 0)
    + (risk >= 3 ? 2 : risk >= 1 ? 1 : 0)
    + (edit && commands ? 1 : 0)
    - (simple ? 1 : 0);
  points = clamp(points, 0, 6);
  const lead = t.source === 'routine' || t.source === 'night';
  const level = SIZES.indexOf(t.level);
  const floorOf = p => Math.max(demandOf(p), level, lead ? 1 : 0);
  let demand = floorOf(points);
  // Escalation (1.3 rule 3 and 1.5): once, however many tries did not finish.
  const retry = (finite(t.failures) ?? 0) >= 1;
  let escalated = false;
  if (retry) {
    if (demand === 2) escalated = true;
    else {
      points = Math.min(6, points + 2);
      demand = floorOf(points);
    }
  }
  let phrase;
  if (risk > 0 && edit) phrase = files >= 2 ? `a risky change across ${files} files` : files === 1 ? 'a risky change to one file' : 'a risky change';
  else if (risk > 0) phrase = 'risky work';
  else if (files >= 4) phrase = `work across ${files} files`;
  else if (len >= 2500) phrase = 'a long brief';
  else if (simple) phrase = 'a short lookup';
  else if (Object.hasOwn(KIND_PHRASE, kindId)) phrase = KIND_PHRASE[kindId];
  else phrase = lead && !kindId ? 'this run' : 'this kind of task';
  return { points, demand: SIZES[demand], demandRank: demand, phrase, files, risk, len, simple, escalated, retry, base };
}

// ---------- room ----------

const rowOf = (planRows, provider) => {
  if (Array.isArray(planRows)) return planRows.find(r => isObject(r) && (r.provider === provider || r.id === provider)) ?? null;
  return isObject(planRows) && isObject(planRows[provider]) ? planRows[provider] : null;
};

const staleWindow = (w, now) => {
  if (w.stale === true) return true;
  if (now === null) return false;
  if (finite(w.resetsAt) !== null && now >= w.resetsAt) return true;
  const read = finite(w.readAt) ?? finite(w.seenAt);
  return read !== null && now - read > STALE_MS;
};

export function roomOf(provider, ctx = {}, avail) {
  const c = isObject(ctx) ? ctx : {};
  const line = finite(isObject(c.lines) ? c.lines[provider] : null) ?? finite(c.teamLine) ?? DEFAULT_LINE;
  const now = finite(c.now);
  const row = rowOf(c.planRows, provider);
  const avails = avail !== undefined
    ? [avail].filter(isObject)
    : (Array.isArray(c.candidates) ? c.candidates : []).filter(x => isObject(x) && isObject(x.avail) && (x.provider ?? splitRef(x.ref).provider) === provider).map(x => x.avail);
  const readings = [];
  const fromPlan = finite(isObject(c.planUse) ? c.planUse[provider] : null);
  if (fromPlan !== null) readings.push(fromPlan);
  for (const a of avails) if (finite(a.usedPercent) !== null) readings.push(a.usedPercent);
  for (const w of Array.isArray(row?.windows) ? row.windows : []) {
    if (isObject(w) && finite(w.usedPercent) !== null && !staleWindow(w, now)) readings.push(w.usedPercent);
  }
  const used = readings.length ? Math.max(...readings) : null;
  const room = used === null ? null : line - used;
  const limitMark = avails.some(a => a.state === 'limit');
  const rowState = typeof row?.state === 'string' ? row.state : '';
  // cause: why a plan is tight. 'line': at most 5 points below the owner's line; 'limit': a limit mark or a plan row that says out;
  // 'course': a plan row that says it is on course to run out (short, tight). null when it is not tight. The line wins, as its numbers
  // say the most; a why names the cause, never another one.
  const atLine = room !== null && room < 5;
  const outRow = rowState === 'out';
  let cause = null;
  if (atLine) cause = 'line';
  else if (limitMark || outRow) cause = 'limit';
  else if (!NO_READING.has(provider) && TIGHT_STATES.has(rowState)) cause = 'course';
  let band;
  if (cause) band = 'tight';
  else if (NO_READING.has(provider) || room === null) band = 'unknown';
  else band = room >= 40 ? 'plenty' : room >= 15 ? 'some' : 'little';
  return { band, room, used, line, cause };
}

// How a provider's room reads in a why: the cause of a tight plan (its line with the numbers, its plan limit, or on course to run out),
// or for a plan with little room, near the line with the numbers.
function roomWords(provider, r) {
  const name = providerLabel(provider);
  if (r.cause === 'limit') return `${name} is close to its plan limit`;
  if (r.cause === 'course') return `${name} is on course to run out before it resets`;
  if (r.used !== null) {
    const u = round(r.used);
    const l = round(r.line);
    if (u > l) return `${name} is past your line (${u} of ${l})`;
    if (u === l) return `${name} is at your line (${u} of ${l})`;
    return `${name} is near your line (${u} of ${l})`;
  }
  return r.band === 'tight' ? `${name} is close to its plan limit` : noReadingWords(provider);
}

// A plan with no reading: only the programs that report no use at all (NO_READING) "do not report" it; any other (Codex before its first
// reading, a model on a key, the offline Echo) simply has no reading in Plenum yet.
function noReadingWords(provider) {
  const name = providerLabel(provider);
  return NO_READING.has(provider) ? `${name} does not report its use` : `Plenum has no reading of ${name} yet`;
}

function ownRoomWords(provider, r) {
  const name = providerLabel(provider);
  if (r.band === 'plenty' || r.band === 'some') return `${name} has room`;
  if (r.band === 'unknown') return noReadingWords(provider);
  return roomWords(provider, r);
}

// ---------- effort ----------

const LMH = Object.freeze(['low', 'medium', 'high']);
const LMHX = Object.freeze(['low', 'medium', 'high', 'xhigh']);

export function effortsFor(provider, id) {
  const model = String(id ?? '');
  switch (provider) {
    case 'anthropic': return [...LMHX];
    case 'codex':
    case 'muse': return [...LMH];
    case 'googleai':
      if (/^gemini-4-hydrogen/.test(model)) return [...LMHX];
      return /^gemini-(2\.5|3|4)/.test(model) ? [...LMH] : null;
    case 'openai': return /^(o\d|gpt-5)/.test(model) ? [...LMH] : null;
    default: return null;
  }
}

// 1.3 rule 7. `chosen` is the candidate's info ({ provider, id, cap, proven }).
function effortOf(f, chosen, task) {
  let i = f.points >= 4 ? 2 : f.points >= 2 ? 1 : 0;
  if (chosen.cap < f.demandRank) i += 1;
  else if (chosen.cap > f.demandRank || chosen.proven) i -= 1;
  i = clamp(i, 0, 2);
  const kind = isObject(task.kind) ? task.kind : {};
  if (kind.id === 'code' || kind.id === 'review' || kind.agent === 'coder' || kind.agent === 'reviewer') i = Math.max(i, 1);
  const before = i;
  if (f.escalated) i = Math.min(3, i + 1);
  const minutes = finite(task.minutesLeft);
  if (minutes !== null && minutes < 20) i = Math.min(i, 1);
  const levels = effortsFor(chosen.provider, chosen.id);
  if (!levels) return null;
  // xhigh only on a retry from high; max never.
  const allowed = levels.filter(l => l !== 'xhigh' || (f.escalated && before === 2 && i === 3));
  const want = LEVELS[i];
  if (allowed.includes(want)) return want;
  const below = allowed.filter(l => LEVELS.indexOf(l) <= i);
  return below.length ? below[below.length - 1] : allowed[0] ?? null;
}

// ---------- the why ----------

function sayWhy(label, effortWords, phrase, tails, optional = []) {
  const build = (name, list) => `Auto: ${name}, ${effortWords}: ${[phrase, ...list].join('; ')}.`;
  let list = [...tails];
  let text = build(label, list);
  // Too long: the optional tails go first, then the label is cut.
  for (const o of optional) {
    if (text.length <= WHY_MAX) break;
    list = list.filter(x => x !== o);
    text = build(label, list);
  }
  if (text.length > WHY_MAX) {
    const over = text.length - WHY_MAX;
    const short = label.length - over - 1 > 3 ? `${label.slice(0, label.length - over - 1)}…` : label.slice(0, 3);
    text = build(short, list);
  }
  return text.length > WHY_MAX ? `${text.slice(0, WHY_MAX - 1)}.` : text;
}

// ---------- the route ----------

function cleanCandidates(raw) {
  const out = [];
  const seen = new Set();
  for (const c of Array.isArray(raw) ? raw : []) {
    if (!isObject(c) || typeof c.ref !== 'string' || !c.ref || seen.has(c.ref)) continue;
    seen.add(c.ref);
    const { provider: fromRef, id } = splitRef(c.ref);
    const provider = typeof c.provider === 'string' && c.provider ? c.provider : fromRef;
    // A label is a name from the registry; a control character or an over-long one is not shown as given.
    const label = typeof c.label === 'string' && c.label.trim() && !/[\u0000-\u001f\u007f]/.test(c.label) ? c.label.trim().slice(0, 80) : id || c.ref;
    out.push({ ref: c.ref, label, provider, id, size: SIZES.includes(c.size) ? c.size : 'unknown', billing: c.billing ?? null, avail: isObject(c.avail) ? c.avail : null });
  }
  return out;
}

function statsOf(cells, ref) {
  const cell = isObject(cells) && isObject(cells[ref]) ? cells[ref] : null;
  const pass = Math.max(0, Math.floor(finite(cell?.pass) ?? 0));
  const fail = Math.max(0, Math.floor(finite(cell?.fail) ?? 0));
  const checks = pass + fail;
  return checks >= MIN_CHECKS ? { rate: pass / checks, counts: true } : { rate: null, counts: false };
}

function infoOf(c, i, ctx, f) {
  const room = roomOf(c.provider, ctx, c.avail ?? null);
  const s = statsOf(ctx.cells, c.ref);
  const proven = s.counts && s.rate >= 0.9 && f.risk === 0;
  const weak = s.counts && s.rate < 0.7;
  const sizeRank = sizeRankOf(c.size);
  let cap = clamp(sizeRank + (proven ? 1 : 0) - (weak ? 1 : 0), 0, 2);
  // A model of unknown size counts as mid and never fits a top demand.
  if (c.size === 'unknown') cap = Math.min(cap, 1);
  return { ...c, order: i, room, rate: s.rate, proven, weak, sizeRank, cap };
}

const listHas = (list, x) => list.includes(x.ref) || list.includes(x.provider);

// 1.3 rule 4: the order of the fits.
const ahead = (a, b) =>
  (a.sizeRank + (a.room.band === 'little' ? 1 : 0)) - (b.sizeRank + (b.room.band === 'little' ? 1 : 0))
  || (a.weak ? 1 : 0) - (b.weak ? 1 : 0)
  || BAND_ORDER[a.room.band] - BAND_ORDER[b.room.band]
  || (b.rate ?? NO_DATA_RATE) - (a.rate ?? NO_DATA_RATE)
  || a.order - b.order;

export function route(task, ctx) {
  const t = isObject(task) ? task : {};
  const c = isObject(ctx) ? ctx : {};
  const f = features(t);
  const pins = isObject(t.pins) ? t.pins : {};
  const pinEffort = ALL_EFFORTS.includes(pins.effort) ? pins.effort : null;
  const pinBy = pins.effortBy === 'lead' ? 'named by the lead' : 'set by you';
  const infos = cleanCandidates(c.candidates).map((x, i) => infoOf(x, i, c, f));
  const tails = f.retry ? [RETRY_WORDS] : [];
  const wordsFor = (chosen, effort) => {
    if (effort === null || !effortsFor(chosen.provider, chosen.id)) return 'its own effort';
    return pinEffort ? `${EFFORT_WORDS[effort]} (${pinBy})` : EFFORT_WORDS[effort];
  };
  const effortFor = chosen => (pinEffort ?? effortOf(f, chosen, t));

  // Rule 1: a pinned ref is that ref only. No ranking: the effort alone.
  if (typeof pins.ref === 'string' && pins.ref) {
    const known = infos.find(x => x.ref === pins.ref);
    const chosen = known ?? infoOf(cleanCandidates([{ ref: pins.ref }])[0], infos.length, c, f);
    const effort = effortFor(chosen);
    const roomTail = f.retry ? [] : [ownRoomWords(chosen.provider, chosen.room)];
    const why = sayWhy(chosen.label, wordsFor(chosen, effort), f.phrase, [...roomTail, ...tails], roomTail);
    const alternatives = [{ ref: chosen.ref, label: chosen.label, why: 'pinned for this task' },
      ...infos.filter(x => x.ref !== chosen.ref).map(x => ({ ref: x.ref, label: x.label, why: 'not used: another model was named for this task' }))];
    return { ref: chosen.ref, label: chosen.label, effort, why, alternatives, features: f };
  }

  // Rule 2: who is eligible. Nothing is ever added.
  const allowApi = c.allowApi === true;
  const counts = isObject(c.counts) ? c.counts : {};
  const atOnce = finite(c.atOnce) !== null && c.atOnce > 0 ? c.atOnce : Infinity;
  const avoid = Array.isArray(c.avoid) ? c.avoid : [];
  const exclude = Array.isArray(c.exclude) ? c.exclude : [];
  const dropped = new Map(); // ref -> { code, why }
  const left = [];
  for (const x of infos) {
    const n = finite(Number(counts[x.provider])) ?? 0;
    if (listHas(exclude, x)) dropped.set(x.ref, { code: 'tried', why: 'was already tried for this task' });
    else if (x.billing === 'api' && !allowApi) dropped.set(x.ref, { code: 'per-token', why: 'is billed per token, which is not allowed here' });
    else if (x.room.band === 'tight') dropped.set(x.ref, { code: 'tight', why: roomWords(x.provider, x.room) });
    else if (n >= atOnce) dropped.set(x.ref, { code: 'full', why: `${providerLabel(x.provider)} already has ${n} ${n === 1 ? 'worker' : 'workers'} of this run` });
    else left.push(x);
  }
  let eligible = left.filter(x => !listHas(avoid, x));
  if (!eligible.length) eligible = left;
  else for (const x of left) if (!eligible.includes(x)) dropped.set(x.ref, { code: 'avoid', why: avoid.includes(x.ref) ? 'was passed over for this run' : `${providerLabel(x.provider)} already worked on this job` });

  // Rule 6: nothing eligible.
  if (!eligible.length) {
    const reasons = [...dropped.values()];
    const why = reasons.length && reasons.every(r => r.code === 'tight') ? STEP_BACK_TIGHT : STEP_BACK_OTHER;
    return { ref: null, label: null, effort: null, why, stepBack: true, alternatives: infos.map(x => ({ ref: x.ref, label: x.label, why: dropped.get(x.ref)?.why ?? 'cannot run now' })), features: f };
  }

  // Rule 4: the fits, ranked.
  const fits = eligible.filter(x => x.cap >= f.demandRank).sort(ahead);
  const short = eligible.filter(x => x.cap < f.demandRank).sort((a, b) => b.cap - a.cap || a.order - b.order);

  let chosen;
  let why;
  let effort;
  if (fits.length) {
    chosen = fits[0];
    effort = effortFor(chosen);
    // Rule 8: a candidate passed over for its room is named first; else the chosen one's own room (left out on a retry, whose words say why).
    // Passed over for its room: with plenty of room it would have ranked first.
    const roomy = x => ({ ...x, room: { ...x.room, band: 'plenty' } });
    const passed = infos.find(x => x.provider !== chosen.provider && x.cap >= f.demandRank
      && (dropped.has(x.ref) ? dropped.get(x.ref).code === 'tight' : x.room.band === 'little' && eligible.includes(x))
      && ahead(roomy(x), chosen) < 0);
    const roomTail = passed ? [roomWords(passed.provider, passed.room)] : f.retry ? [] : [ownRoomWords(chosen.provider, chosen.room)];
    why = sayWhy(chosen.label, wordsFor(chosen, effort), f.phrase, [...roomTail, ...tails], roomTail);
  } else {
    // Rule 5: no fit. The largest that can run now (the owner's order breaks ties); the effort goes one step up (rule 7, cap below demand).
    chosen = short[0];
    effort = effortFor(chosen);
    why = sayWhy(chosen.label, wordsFor(chosen, effort), f.phrase, [LARGEST_WORDS, ...tails], [LARGEST_WORDS]);
  }

  // Rule 9: every candidate goes back, ranked, each with its reason.
  const alt = [];
  const add = (x, text) => alt.push({ ref: x.ref, label: x.label, why: text });
  add(chosen, 'chosen');
  for (const x of fits) if (x !== chosen) add(x, x.room.band === 'little' ? `fits, but ${roomWords(x.provider, x.room)}` : x.weak ? 'fits, but did less well in checks' : 'fits; ranked lower');
  for (const x of short) if (x !== chosen) add(x, 'is smaller than this task needs');
  for (const x of infos) if (dropped.has(x.ref)) add(x, dropped.get(x.ref).why);
  return { ref: chosen.ref, label: chosen.label, effort, why, alternatives: alt, features: f };
}
