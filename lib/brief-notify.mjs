// The morning and evening brief as a notification (wave 8). At the times the owner picks, ONE notice says for each of his businesses what
// was done, what is next, what waits for him and any limit warning. It is made from the same data as GET /api/business/brief
// (lib/business.mjs brief() and the business's own record), so it starts no CLI and reaches no network, and it goes out through the
// notification hub like every other notice (lib/events.mjs publish -> lib/notify.mjs admit -> the desktop, the page, the phones).
//
// THE CONTRACT (lib/routes/brief-notify.mjs and public/ext-brief-notify.js build to it; build/v06/w8-brief-notify pins each part):
//   createBriefNotify(deps) -> an instance; the default instance's functions are exported below under the same names.
//     deps: dir (the data folder), now, env, read, write, publish, setTimer, clearTimer,
//           business ({ brief(range), log(id, { limit, before }) }: lib/business.mjs, or a function that answers it),
//           hub ({ settings() -> { quiet: { on, from, to }, mutes: { <business id>: untilMs } } }: lib/notify.mjs).
//   settings()          -> { on, morning: { on, at }, evening: { on, at }, businesses: null | [business id] }
//                          on is false until the owner turns it on; the times are local 'HH:MM' (07:00 and 18:00 at first); businesses
//                          null means every business that is not closed, a list means only those.
//   setSettings(patch)  -> a promise of null when saved, else one sentence. Checked whole: one wrong value changes nothing and throws an
//                          Error with status 400 and one plain sentence.
//   state()             -> { v, settings, next: { slot, at, time, moved } | null, last: entry | null, log: [entry] (newest first, 20),
//                          quiet: { on, from, to }, lateMinutes, running, saving, why? }
//                          entry: { slot, time, key, due, effective, at, state: 'sent' | 'skipped', why: '' | 'late' | 'error' | 'nothing' |
//                          'muted' | 'none' | 'newer', late (ms), businesses (how many it spoke of), held ('' | 'quiet-hours' | 'muted'), text }
//                          'error': Plenum was running but could not put the brief together until it was too late (not a PC that slept).
//                          text is the finished sentence ("The 18:00 brief was not sent: ..."), made here so every page says the same.
//   tick({ now }?)      -> a promise of the entries written by this check ([] when nothing was due). It never rejects.
//   sendNow()           -> a promise of { sent, why, text, notice? }: the brief as it would read now, for the owner's "Send one now".
//                          It is not a scheduled brief: nothing is marked as sent and the next brief still covers its whole stretch.
//   start(), stop(), running() -> the timer (one check every 30 seconds, unref'd). Never with PLENUM_NO_SCHEDULER=1 or PLENUM_SMOKE=1.
//                          start() is called by lib/routes/brief-notify.mjs only, so importing this file starts nothing.
//   Pure parts, exported for the tests: cleanSettings(raw), slotTime(now, at, quiet), boundaryAfter(ms, hhmm), factsOf(business, lines,
//   { from, to, paused }), digest(facts, { slot, now }).
// The file: brief-notify.json in the data folder (the folder of notify.json), { v: 1, settings, slots: { morning: { since, handled },
//   evening: { since, handled } }, log, lastSentAt }, written whole through lib/atomic-write.mjs. Nothing is written until the owner saves
//   a setting. A file that is not JSON is kept as brief-notify.json.damaged; one that cannot be read, or that a newer Plenum wrote, is
//   never written over (the brief then works in memory and state() says why).
//
// THE NOTICE: { key: 'brief:<local date>:<morning|evening>', level: 'fyi', title: 'Morning brief' | 'Evening brief' (with ': N things wait
//   for you' when the list of decisions is not empty), text (at most 240 characters), route: 'today', business (only when the brief speaks
//   of exactly one business), silent: true (only when nothing waits, nothing warns and no run failed) }.
//   It is news, not a condition, so it is an 'fyi': never an open row of the bell. A key that starts with 'brief:' is the one fyi a phone
//   is pushed (lib/remote/index.mjs handleNotice), because the owner asked for it at that time; it follows the phone's approvals switch
//   and "only when away" like every pushed notice.
//
// RULES THIS MODULE KEEPS:
//   One notice per brief, never one per business. A brief with nothing to say is not sent (a next run alone, or a pause alone, is not
//   something to say). The words are Plenum's own: counts, the names of businesses and routines, the plan-use numbers of the brief. A
//   model's DONE and NEXT lines, a failure's reason, a hand-off's title and its result never reach a notice; they stay on the Businesses pane.
//   What was done is counted from the last brief that was sent (at most 24 hours back), not from midnight, so the work of an evening is in
//   the next morning's brief.
//   Quiet hours and mutes are the hub's (lib/notify.mjs settings). A time that falls inside quiet hours is moved to their end. A brief that
//   wakes inside quiet hours waits for their end. A muted business is left out; when every business of the brief is muted, it is not sent.
//   A brief is sent once. After a restart or a sleep it is sent when Plenum is back if that is within 3 hours of its time (LATE_MS), else it
//   is skipped and the record says why. Two briefs due at one wake are one notice (the newer). Switching the brief on, or moving a time,
//   never sends a brief for a time that had already passed.
import fs, { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';
import * as notifyHub from './notify.mjs';

const { BUSINESS_RE, TIME_RE, boundaryBefore, cleanText, inQuietHours, localDate } = notifyHub;

export const VERSION = 1;
export const SLOTS = Object.freeze(['morning', 'evening']);
export const SLOT_TITLES = Object.freeze({ morning: 'Morning brief', evening: 'Evening brief' });
export const DEFAULT_SETTINGS = Object.freeze({
  on: false,
  morning: Object.freeze({ on: true, at: '07:00' }),
  evening: Object.freeze({ on: true, at: '18:00' }),
  businesses: null,
});
// A brief that is later than this is not sent any more.
export const LATE_MS = 3 * 60 * 60_000;
// How far back "what was done" reaches when no brief was sent before.
export const WINDOW_MS = 24 * 60 * 60_000;
export const TICK_MS = 30_000;
export const FIRST_TICK_MS = 15_000;
export const LIMITS = Object.freeze({ text: 240, title: 60, name: 28, routine: 40, label: 24, log: 20, businesses: 200, pages: 3, page: 200 });
export const MORE = 'more in Businesses.';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = v => (typeof v === 'string' ? v : '');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const pad = n => String(n).padStart(2, '0');
const clock = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const DAYS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);

// Settings as stored: anything that is not right is the default.
export function cleanSettings(raw) {
  const s = isObject(raw) ? raw : {};
  const slot = name => {
    const v = isObject(s[name]) ? s[name] : {};
    return {
      on: typeof v.on === 'boolean' ? v.on : DEFAULT_SETTINGS[name].on,
      at: typeof v.at === 'string' && TIME_RE.test(v.at) ? v.at : DEFAULT_SETTINGS[name].at,
    };
  };
  let businesses = null;
  if (Array.isArray(s.businesses)) businesses = [...new Set(s.businesses.filter(id => typeof id === 'string' && BUSINESS_RE.test(id)))].slice(0, LIMITS.businesses);
  return { on: s.on === true, morning: slot('morning'), evening: slot('evening'), businesses };
}

// The first moment after ms that the local clock reads hhmm.
export function boundaryAfter(ms, hhmm) {
  const d = new Date(ms);
  d.setHours(Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5)), 0, 0);
  if (d.getTime() <= ms) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// Quiet hours as the hub holds them, or none when they are not in a shape that can be read.
const quietOf = q => (isObject(q) && q.on === true && TIME_RE.test(str(q.from)) && TIME_RE.test(str(q.to)) ? { on: true, from: q.from, to: q.to } : { on: false, from: '23:00', to: '07:00' });
const inQuiet = (quiet, ms) => inQuietHours(quietOf(quiet), ms);

// The newest time at or before `now` that a brief of `at` (HH:MM) was due, and when it really comes: a time inside quiet hours is moved to
// their end. key names that one brief.
export function slotTime(now, at, quiet) {
  const due = boundaryBefore(now, at);
  const q = quietOf(quiet);
  const effective = inQuietHours(q, due) ? boundaryAfter(due, q.to) : due;
  return { due, effective, key: `${localDate(due)}:${at}` };
}

// What there is to say about one business: b is one entry of brief().businesses, lines the business's record (any order), counted
// inside (from, to]. Only counts, names and the brief's own numbers are taken: never a line's done, next, why, title or text.
export function factsOf(b, lines, { from = 0, to = Infinity, paused = false } = {}) {
  const src = isObject(b) ? b : {};
  const f = {
    id: str(src.id),
    name: cleanText(str(src.name), LIMITS.name) || 'A business',
    waiting: 0,
    charter: src.charterChanged === true,
    done: 0,
    failed: 0,
    skipped: 0,
    handoffs: 0,
    limits: [],
    next: null,
    paused: paused === true || src.status === 'paused',
  };
  const waiting = Number(src.decisions?.waiting);
  if (Number.isFinite(waiting) && waiting > 0) f.waiting = Math.min(999, Math.floor(waiting));
  for (const line of Array.isArray(lines) ? lines : []) {
    if (!isObject(line) || !(line.at > from) || !(line.at <= to)) continue;
    if (line.type === 'run') {
      if (line.state === 'done') f.done += 1;
      else if (line.state === 'failed' || line.state === 'interrupted') f.failed += 1;
    } else if (line.type === 'skip') f.skipped += 1;
    else if (line.type === 'handoff') f.handoffs += 1;
  }
  for (const u of Array.isArray(src.usage) ? src.usage : []) {
    if (!isObject(u) || u.state !== 'limit' || !Number.isFinite(u.usedPercent) || f.limits.length >= 3) continue;
    const label = cleanText(str(u.label) || str(u.provider), LIMITS.label);
    if (label) f.limits.push(`${label} is at ${Math.round(u.usedPercent)}% of its plan`);
  }
  const used = Number(src.minutes?.used);
  const of = Number(src.minutes?.of);
  if (Number.isFinite(used) && Number.isFinite(of) && of > 0 && used >= of) f.limits.push('the model time of today is used up');
  // No promise the scheduler will not keep: a paused business, or everything paused, names no next run. A routine whose time has passed
  // (one that has not run yet after a wake) is not "next": the first run after `to` is (review, 17 Nov 2026).
  if (!f.paused) {
    const after = Number.isFinite(to) ? to : 0;
    const next = (Array.isArray(src.next) ? src.next : []).filter(n => isObject(n) && Number.isFinite(n.at) && n.at > 0 && n.at > after).sort((a, c) => a.at - c.at)[0];
    if (next) f.next = { name: cleanText(str(next.routine), LIMITS.routine) || 'a routine', at: next.at };
  }
  return f;
}

function dayWords(at, now) {
  const today = localDate(now);
  if (localDate(at) === today) return '';
  const t = new Date(now);
  t.setDate(t.getDate() + 1);
  if (localDate(at) === localDate(t.getTime())) return ' tomorrow';
  return at - now < 7 * 24 * 60 * 60_000 ? ` on ${DAYS[new Date(at).getDay()]}` : ` on ${localDate(at)}`;
}

function partsOf(f, now) {
  const waits = [];
  if (f.waiting > 0) waits.push(`${plural(f.waiting, 'thing waits', 'things wait')} for you`);
  if (f.charter) waits.push('BUSINESS.md changed and waits for your look');
  const done = [];
  if (f.done > 0) done.push(`${plural(f.done, 'run', 'runs')} done`);
  if (f.failed > 0) done.push(`${plural(f.failed, 'run', 'runs')} did not finish`);
  if (f.skipped > 0) done.push(`${plural(f.skipped, 'run', 'runs')} skipped`);
  if (f.handoffs > 0) done.push(`${plural(f.handoffs, 'task', 'tasks')} handed off`);
  const next = f.paused ? 'paused' : f.next && f.next.at > now ? `next: ${f.next.name}${dayWords(f.next.at, now)} at ${clock(f.next.at)}` : '';
  return { waits, warns: [...f.limits], done, next };
}

// The one notice of a brief: facts is [factsOf(...)] in the order of the businesses. null when no business has anything to say.
// -> { title, text, loud, waiting, businesses: [id of every business with something to say] }
// The text holds, per business, what was done, what is next, what waits and the warnings. When that is longer than a notice holds, the
// next runs go first, then what was done; when it still does not fit, the businesses come in their order while they fit and the rest is
// counted ("3 more in Businesses."). The title counts what waits in all of them.
export function digest(facts, { slot = 'morning', now = Date.now() } = {}) {
  const list = (Array.isArray(facts) ? facts : []).filter(isObject).map(f => ({ f, p: partsOf(f, now) })).filter(x => x.p.waits.length || x.p.warns.length || x.p.done.length);
  if (!list.length) return null;
  const waiting = list.reduce((sum, x) => sum + x.f.waiting, 0);
  const loud = list.some(x => x.p.waits.length > 0 || x.p.warns.length > 0 || x.f.failed > 0);
  const base = SLOT_TITLES[slot] ?? SLOT_TITLES.morning;
  const title = cleanText(waiting > 0 ? `${base}: ${plural(waiting, 'thing waits', 'things wait')} for you` : base, LIMITS.title);
  const line = (x, level) => {
    const groups = [];
    if (level < 2 && x.p.done.length) groups.push(x.p.done.join(', '));
    if (level < 1 && x.p.next) groups.push(x.p.next);
    if (x.p.waits.length) groups.push(x.p.waits.join(', '));
    if (x.p.warns.length) groups.push(x.p.warns.join(', '));
    return groups.length ? `${x.f.name}: ${groups.join('; ')}.` : '';
  };
  let text = '';
  for (let level = 0; level <= 2 && !text; level += 1) {
    const lines = list.map(x => line(x, level));
    if (!lines.every(Boolean)) break;
    const whole = lines.join(' ');
    if ([...whole].length <= LIMITS.text) text = whole;
  }
  if (!text) {
    // Not everything fits: each business in its shortest form that still says something, in order, while there is room.
    const shown = [];
    let used = 0;
    for (let i = 0; i < list.length; i += 1) {
      const short = line(list[i], 2) || line(list[i], 1);
      const rest = list.length - i - 1;
      const tail = rest > 0 ? ` ${rest} ${MORE}`.length : 0;
      const size = [...short].length + (shown.length ? 1 : 0);
      if (used + size + tail > LIMITS.text) break;
      shown.push(short);
      used += size;
    }
    const left = list.length - shown.length;
    text = [...shown, ...(left > 0 ? [`${left} ${MORE}`] : [])].join(' ');
  }
  return { title, text: cleanText(text, LIMITS.text), loud, waiting, businesses: list.map(x => x.f.id) };
}

// ----- the sentences of the record -----
function sentenceOf(e) {
  const what = `The ${e.time} brief`;
  if (e.state === 'sent') {
    const minutes = Math.round((e.late ?? 0) / 60_000);
    let s = `${what} was sent at ${clock(e.at)}`;
    if (minutes >= 5) s += `, ${minutes} minutes late, because this PC was asleep or Plenum was not running at its time`;
    else if (e.effective !== e.due) s += ', when quiet hours ended';
    s += '.';
    if (e.held === 'quiet-hours') s += ' Quiet hours had begun, so it waits in Recent and in the morning summary.';
    else if (e.held === 'muted') s += ' Its business is muted, so it waits in Recent.';
    return s;
  }
  if (e.why === 'late') return `${what} was not sent: this PC was asleep or Plenum was not running at its time, and it was more than 3 hours late.`;
  if (e.why === 'error') return `${what} was not sent: it could not be put together in the 3 hours after its time. Plenum tried again every half minute; the server log has the reason.`;
  if (e.why === 'muted') return `${what} was not sent: every business in it is muted.`;
  if (e.why === 'none') return `${what} was not sent: there is no business to report on.`;
  if (e.why === 'newer') return `${what} was not sent: a later brief was due as well, and one is enough.`;
  return `${what} was not sent: there was nothing to say.`;
}
const NOW_WHY = Object.freeze({
  nothing: 'There is nothing to say right now, so no brief was sent.',
  muted: 'Every business in the brief is muted, so no brief was sent.',
  none: 'There is no business to report on, so no brief was sent.',
  error: 'The brief could not be put together. Try again.',
});

// ----- the instance -----
const defaultDir = () => process.env.MUSE_CONSOLE_HOME || path.join(os.homedir(), '.muse-console');
const pause = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait: the next try follows at once */ } };

export function createBriefNotify(deps = {}) {
  const d = {
    dir: deps.dir ?? null,
    now: deps.now ?? Date.now,
    env: deps.env ?? process.env,
    read: deps.read ?? (f => fs.readFileSync(f, 'utf8')),
    write: deps.write ?? writeFileAtomic,
    // The events channel is imported only when a brief is published; lib/events.mjs hands the notice to the hub before any window sees it.
    publish: deps.publish ?? (async ev => (await import('./events.mjs')).publish(ev)),
    setTimer: deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }),
    clearTimer: deps.clearTimer ?? (t => clearTimeout(t)),
    // lib/business.mjs is loaded on first use, inside a function: this module awaits no import at its top.
    business: deps.business ?? (() => import('./business.mjs')),
    hub: deps.hub ?? notifyHub,
  };
  const dir = () => d.dir ?? defaultDir();
  const file = () => path.join(dir(), 'brief-notify.json');

  let rec = null;
  // Set when the file is there and cannot be read, or is from a newer Plenum: the brief works in memory and never writes.
  let memoryOnly = '';
  let writing = Promise.resolve(null);
  let timer = null;
  let started = false;
  let chain = Promise.resolve();
  let complained = '';
  // The briefs (slot keys) that could not be put together at a check: one that is still not made when it is too late is recorded with
  // that reason ('error'), not as a PC that was asleep (review, 17 Nov 2026). Kept in memory; a key leaves it when its brief is noted.
  const failedKeys = new Set();

  const freshSlots = () => ({ morning: { since: 0, handled: '' }, evening: { since: 0, handled: '' } });
  const fresh = () => ({ v: VERSION, settings: cleanSettings(null), slots: freshSlots(), log: [], lastSentAt: 0 });
  // An older file, and one with parts missing, loads: every field has a default.
  function migrate(raw) {
    const r = fresh();
    if (!isObject(raw)) return r;
    r.settings = cleanSettings(raw.settings);
    for (const name of SLOTS) {
      const s = isObject(raw.slots?.[name]) ? raw.slots[name] : {};
      r.slots[name] = { since: Number.isFinite(s.since) && s.since > 0 ? s.since : 0, handled: str(s.handled).slice(0, 40) };
    }
    r.log = Array.isArray(raw.log) ? raw.log.filter(e => isObject(e) && SLOTS.includes(e.slot) && Number.isFinite(e.at)).slice(-LIMITS.log) : [];
    r.lastSentAt = Number.isFinite(raw.lastSentAt) && raw.lastSentAt > 0 ? raw.lastSentAt : 0;
    return r;
  }
  function saveDamaged(text) {
    try {
      let target = `${file()}.damaged`;
      if (fs.existsSync(target)) target = `${file()}.damaged-${d.now()}`;
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, target);
    } catch { /* the damaged copy is a courtesy */ }
  }
  function load() {
    if (rec) return rec;
    let text = null;
    let code = '';
    for (let tries = 0; tries < 4; tries += 1) {
      try {
        text = d.read(file());
        code = '';
        break;
      } catch (err) {
        if (err?.code === 'ENOENT') { code = ''; text = null; break; }
        code = String(err?.code ?? 'EIO').slice(0, 20);
        if (tries < 3) pause(50);
      }
    }
    if (code) {
      memoryOnly = `brief-notify.json could not be read (${code}), so the brief's settings work without saving until Plenum restarts.`;
      rec = fresh();
      return rec;
    }
    let raw = null;
    if (text !== null) {
      try {
        raw = JSON.parse(text);
      } catch {
        if (text.trim()) saveDamaged(text);
      }
    }
    if (isObject(raw) && Number.isInteger(raw.v) && raw.v > VERSION) memoryOnly = 'brief-notify.json was written by a newer Plenum, so this version does not change it.';
    rec = migrate(raw);
    return rec;
  }
  // Writes the record now (after any write that is under way). Resolves to null when it reached the file, else to one sentence.
  function save() {
    const r = load();
    if (memoryOnly) return Promise.resolve(memoryOnly);
    const text = `${JSON.stringify(r, null, 2)}\n`;
    const job = writing.then(async () => {
      await fsp.mkdir(dir(), { recursive: true });
      await d.write(file(), text);
      return null;
    }).catch(err => {
      const why = `brief-notify.json could not be saved (${String(err?.code ?? 'error').slice(0, 20)}).`;
      console.error(why);
      return why;
    });
    writing = job;
    return job;
  }
  const flush = () => writing;

  function hubSettings() {
    try {
      const s = d.hub?.settings?.();
      return { quiet: quietOf(s?.quiet), mutes: isObject(s?.mutes) ? s.mutes : {} };
    } catch {
      return { quiet: quietOf(null), mutes: {} };
    }
  }

  const settings = () => structuredClone(load().settings);

  function setSettings(body) {
    const fail = msg => Object.assign(new Error(msg), { status: 400 });
    if (!isObject(body)) throw fail('Send the settings as an object.');
    const r = load();
    const next = structuredClone(r.settings);
    if (body.on !== undefined) {
      if (typeof body.on !== 'boolean') throw fail('Send true or false to switch the brief on or off.');
      next.on = body.on;
    }
    for (const name of SLOTS) {
      const v = body[name];
      if (v === undefined) continue;
      if (!isObject(v)) throw fail('Send each brief as an object with on and at.');
      if (v.on !== undefined) {
        if (typeof v.on !== 'boolean') throw fail('Send true or false to switch a brief on or off.');
        next[name].on = v.on;
      }
      if (v.at !== undefined) {
        if (typeof v.at !== 'string' || !TIME_RE.test(v.at)) throw fail('Send a time as HH:MM, for example 07:00.');
        next[name].at = v.at;
      }
    }
    if (body.businesses !== undefined) {
      const list = body.businesses;
      if (list === null) next.businesses = null;
      else if (Array.isArray(list) && list.length <= LIMITS.businesses && list.every(id => typeof id === 'string' && BUSINESS_RE.test(id))) next.businesses = [...new Set(list)];
      else throw fail('Send the businesses as a list of their ids, or null for all of them.');
    }
    if (next.morning.on && next.evening.on && next.morning.at === next.evening.at) throw fail('The two briefs cannot come at the same time. Pick another time for one of them.');
    // A brief that was just switched on, or whose time was moved, is owed from now on: a time that has already passed is not made up for.
    const t = d.now();
    for (const name of SLOTS) {
      const was = r.settings.on && r.settings[name].on;
      const is = next.on && next[name].on;
      if (is && (!was || r.settings[name].at !== next[name].at)) r.slots[name].since = t;
    }
    r.settings = next;
    return save();
  }

  // ----- putting a brief together -----
  const neighbour = async given => (typeof given === 'function' ? given() : given);

  // The business's record from `from` on (lib/business.mjs log gives the newest 200 lines a call).
  async function linesOf(mod, id, from) {
    if (typeof mod.log !== 'function') return [];
    const out = [];
    let before;
    for (let page = 0; page < LIMITS.pages; page += 1) {
      let lines;
      try {
        lines = await mod.log(id, { limit: LIMITS.page, ...(before === undefined ? {} : { before }) });
      } catch {
        break;
      }
      if (!Array.isArray(lines) || !lines.length) break;
      out.push(...lines);
      const oldest = lines[lines.length - 1]?.at;
      if (lines.length < LIMITS.page || !(oldest > from)) break;
      before = oldest;
    }
    return out;
  }

  // -> { digest } or { digest: null, why: 'none' | 'muted' | 'nothing' }. Throws when the business module cannot answer.
  async function build(t, slot) {
    const r = load();
    const { mutes } = hubSettings();
    const mod = await neighbour(d.business);
    if (!mod || typeof mod.brief !== 'function') throw new Error('The business module is not there.');
    const brief = await mod.brief('day');
    let list = (Array.isArray(brief?.businesses) ? brief.businesses : []).filter(b => isObject(b) && typeof b.id === 'string' && b.status !== 'closed');
    const chosen = r.settings.businesses;
    if (chosen) list = list.filter(b => chosen.includes(b.id));
    if (!list.length) return { digest: null, why: 'none' };
    const heard = list.filter(b => !(Number(mutes[b.id]) > t));
    if (!heard.length) return { digest: null, why: 'muted' };
    const from = r.lastSentAt > t - WINDOW_MS && r.lastSentAt <= t ? r.lastSentAt : t - WINDOW_MS;
    const facts = [];
    for (const b of heard) facts.push(factsOf(b, await linesOf(mod, b.id, from), { from, to: t, paused: brief?.paused === true }));
    const made = digest(facts, { slot, now: t });
    return made ? { digest: made } : { digest: null, why: 'nothing' };
  }

  // Publishes one brief. -> { notice (as the hub stamped it, when it did), held }
  async function send(made, key) {
    const notice = {
      key,
      level: 'fyi',
      title: made.title,
      text: made.text,
      route: 'today',
      ...(made.businesses.length === 1 && made.businesses[0] ? { business: made.businesses[0] } : {}),
      ...(made.loud ? {} : { silent: true }),
    };
    const ev = { type: 'notice', notice };
    await d.publish(ev);
    const stamped = isObject(ev.notice) ? ev.notice : notice;
    return { notice: stamped, held: stamped.quiet === true ? str(stamped.hold) || 'quiet-hours' : '' };
  }

  function note(r, x, state, why, t, more = {}) {
    const entry = { slot: x.name, time: x.at, key: x.key, due: x.due, effective: x.effective, at: t, state, why, late: Math.max(0, t - x.effective), businesses: 0, held: '', ...more };
    entry.text = sentenceOf(entry);
    failedKeys.delete(x.key);
    r.slots[x.name].handled = x.key;
    r.log.push(entry);
    if (r.log.length > LIMITS.log) r.log.splice(0, r.log.length - LIMITS.log);
    return { ...entry };
  }

  async function check(now) {
    const t = Number.isFinite(now) ? now : d.now();
    const r = load();
    if (!r.settings.on) return [];
    const { quiet } = hubSettings();
    const due = [];
    for (const name of SLOTS) {
      const s = r.settings[name];
      if (!s.on) continue;
      const st = slotTime(t, s.at, quiet);
      const slot = r.slots[name];
      // Sent or skipped already; switched on (or moved) after its time; or still waiting for the end of quiet hours.
      if (slot.handled === st.key || !(st.effective > slot.since) || st.effective > t) continue;
      due.push({ name, at: s.at, ...st });
    }
    if (!due.length) return [];
    // Woken inside quiet hours: nothing now. How late it is, is judged when they end.
    if (inQuiet(quiet, t)) return [];
    due.sort((a, b) => b.effective - a.effective);
    const out = [];
    let sent = false;
    for (const x of due) {
      if (t - x.effective > LATE_MS) { out.push(note(r, x, 'skipped', failedKeys.has(x.key) ? 'error' : 'late', t)); continue; }
      if (sent) { out.push(note(r, x, 'skipped', 'newer', t)); continue; }
      let built;
      try {
        built = await build(t, x.name);
        if (!built.digest) { out.push(note(r, x, 'skipped', built.why, t)); continue; }
        const went = await send(built.digest, `brief:${localDate(x.effective)}:${x.name}`);
        sent = true;
        r.lastSentAt = t;
        out.push(note(r, x, 'sent', '', t, { businesses: built.digest.businesses.length, held: went.held }));
      } catch (err) {
        // Not marked: the next check tries again, until the brief is too late. Said once for one brief.
        if (failedKeys.size < 20) failedKeys.add(x.key);
        if (complained !== x.key) {
          complained = x.key;
          console.error('The brief could not be put together; Plenum tries again:', String(err?.message ?? err).slice(0, 120));
        }
      }
    }
    if (out.length) await save();
    return out;
  }
  // One check at a time (the timer's and a test's or the route's never overlap). Never rejects.
  function tick({ now } = {}) {
    const job = chain.then(() => check(now)).catch(err => {
      console.error('The brief check failed:', String(err?.message ?? err).slice(0, 120));
      return [];
    });
    chain = job;
    return job;
  }

  function sendNow() {
    const job = chain.then(async () => {
      const t = d.now();
      let built;
      try {
        built = await build(t, new Date(t).getHours() < 12 ? 'morning' : 'evening');
      } catch {
        return { sent: false, why: 'error', text: NOW_WHY.error };
      }
      if (!built.digest) return { sent: false, why: built.why, text: NOW_WHY[built.why] ?? NOW_WHY.nothing };
      try {
        const went = await send(built.digest, `brief:now:${t.toString(36)}`);
        const text = went.held === 'quiet-hours' ? 'It is quiet hours, so the brief waits in Recent and in the morning summary.'
          : went.held ? 'Its business is muted, so the brief waits in Recent.' : 'The brief is on its way.';
        return { sent: true, why: '', text, notice: went.notice, held: went.held };
      } catch {
        return { sent: false, why: 'error', text: NOW_WHY.error };
      }
    }).catch(() => ({ sent: false, why: 'error', text: NOW_WHY.error }));
    chain = job;
    return job;
  }

  // ----- what the page is told -----
  function nextOf(r, t, quiet) {
    if (!r.settings.on) return null;
    let best = null;
    for (const name of SLOTS) {
      const s = r.settings[name];
      if (!s.on) continue;
      const cur = slotTime(t, s.at, quiet);
      const slot = r.slots[name];
      let cand = cur;
      // The brief of now is behind us (sent, skipped, not owed, or too late to send): the next one is the next time the clock reads its time.
      if (slot.handled === cur.key || !(cur.effective > slot.since) || t - cur.effective > LATE_MS) {
        const due = boundaryAfter(t, s.at);
        cand = { due, effective: inQuiet(quiet, due) ? boundaryAfter(due, quiet.to) : due };
      }
      if (!best || cand.effective < best.at) best = { slot: name, at: cand.effective, time: s.at, moved: cand.effective !== cand.due };
    }
    return best;
  }

  function state({ now } = {}) {
    const t = Number.isFinite(now) ? now : d.now();
    const r = load();
    const { quiet } = hubSettings();
    return {
      v: VERSION,
      settings: structuredClone(r.settings),
      next: nextOf(r, t, quiet),
      last: r.log.length ? { ...r.log[r.log.length - 1] } : null,
      log: r.log.slice().reverse().map(e => ({ ...e })),
      quiet: { ...quiet },
      lateMinutes: LATE_MS / 60_000,
      running: started,
      saving: !memoryOnly,
      ...(memoryOnly ? { why: memoryOnly } : {}),
    };
  }

  // ----- the timer -----
  const offByEnv = () => d.env.PLENUM_NO_SCHEDULER === '1' || d.env.PLENUM_SMOKE === '1';
  function arm(ms) {
    timer = d.setTimer(async () => {
      timer = null;
      await tick();
      if (started) arm(TICK_MS);
    }, ms);
  }
  function start() {
    if (started) return true;
    if (offByEnv()) return false;
    started = true;
    arm(FIRST_TICK_MS);
    return true;
  }
  function stop() {
    started = false;
    if (timer) { d.clearTimer(timer); timer = null; }
  }
  const running = () => started;

  return { settings, setSettings, state, tick, sendNow, start, stop, running, flush, file, isMemoryOnly: () => memoryOnly };
}

// ---------- the default instance ----------
let instance = null;
const brief = () => (instance ??= createBriefNotify());

export const settings = () => brief().settings();
export const setSettings = patch => brief().setSettings(patch);
export const state = opts => brief().state(opts);
export const tick = opts => brief().tick(opts);
export const sendNow = () => brief().sendNow();
export const start = () => brief().start();
export const stop = () => brief().stop();
export const running = () => brief().running();
export const flush = () => brief().flush();
