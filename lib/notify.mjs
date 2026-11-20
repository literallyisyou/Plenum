// The notification hub (wave 4, n1): the one place that decides what of a notice is shown, when, and how loudly. Producers (sign-ins,
// routines, the hub, ...) publish a notice on the events channel; lib/events.mjs hands it to admit() before it goes to any window, so
// the desktop, the phone push and the page all read the same stamps.
//
// THE NOTICE EVENT (shared contract): events.publish({ type: 'notice', notice: { key, level, title, text, route, business, project, clear } })
//   key       a stable id: 'signin:claude-code', 'routine:<id>', 'hub', 'routines:paused', ...
//   level     'needs-you' | 'problem' | 'fyi'            (anything else becomes 'fyi')
//   title     at most 60 characters, text at most 240, Plenum's own words (control characters are taken out, longer text is cut)
//   route     'accounts' | 'today' | 'plan-use' | 'services' | 'chat' | 'night-shift' | ''   (anything else becomes '')
//   A Night shift job's needs-you (key job:<id>) in quiet hours is delivered silently like any needs-you, and is also held for the
//   morning summary ("1 job waits for you"), since it is news of the night (wave 6).
//   clear     true (with the key only): the condition ended
//   silent    true (optional, wave 5): an update of something that was already told under this key ("still signed out" after "needs you
//             to sign in"): when it is shown, it is shown without sound
//   A key that starts with 'run:' or 'limit:' names something that happened (a run that ended, a limit that was reached), not a
//   condition: it is logged, held back and counted in the summary like any notice, but it is never on the open list (the bell), since
//   nothing would ever clear it. lib/remote/push.mjs admits these for a phone push it held back in quiet hours.
//
// THE STAMPED RECORD admit() answers (what ev.notice is once published; every field is always there):
//   { key, level, title, text, route, business, project, clear, seq, at, repeat, quiet, silent, hold }
//   seq     a growing integer (kept across restarts)          at      milliseconds
//   repeat  the same key, level and text was let through (not a repeat, and not held back as quiet) in the last 6 hours and not
//           cleared since. A notice that was held back does not count as shown: raised again once the hold ends, it is not a repeat.
//   quiet   quiet hours are on now and the level is not 'needs-you', or the notice's business is muted now
//   silent  a 'needs-you' notice in quiet hours (and not muted): it is delivered, without sound; also any notice that is not quiet and
//           that its producer sent with silent: true
//   hold    why it is quiet: '' | 'quiet-hours' | 'muted'
//   A clear record has clear: true, the key, empty words, level 'fyi', and repeat, quiet and silent false.
//
// RULES FOR EVERY CONSUMER (desktop toast, phone push, the page):
//   repeat  => do not show it again. A repeat is stamped and answered, but it is not written to the log (Recent lists a thing once).
//   quiet   => do not show it now. It is in the recent log and in the morning summary.
//   silent  => show it without sound.
//   fyi     => never a phone push; a quiet desktop toast at most.
//   clear   => take down what is shown for that key.
//   A notice without these stamps (an older producer, or the hub failed) is shown the way it was before.
//
// SETTINGS: quiet { on: true, from: '23:00', to: '07:00' } (local time, may wrap midnight; from and to must differ: the same time twice
// never held, so it is refused, and an older file that has it is read as quiet hours off), mutes { <business id>: untilMs },
// summary { on: true, at: '08:00' }. Kept with the log in notify.json in Plenum's state folder (the folder of routines.json and
// state.json), written whole through lib/atomic-write.mjs. A file that is there but cannot be read is tried again; when it still cannot
// be read, the hub works in memory and never writes over it. A file that is not JSON is kept as notify.json.damaged.
//
// THE SUMMARY: at summary.at (the time the owner picked in Settings), or when quiet hours end if summary.at falls inside quiet hours,
// and only when something was held back as quiet since the last summary (wave 5: before, the end of quiet hours came first), ONE notice is
// admitted and published: key 'summary:<local date>', level 'fyi' when nothing that was held is still a problem, else 'problem',
// title 'While you were away', text made from counts by key prefix only (never model text). A key that was open and was cleared during
// quiet hours counts as good news ('Claude Code was signed in again'). When what was held gives no words (only Night shift jobs that
// were answered), nothing is published and the list is emptied. While the summary is switched off, what is held is kept for a day at
// most, and switching it on empties the list: the first summary tells only what was held after that. The timer is unref'd, uses the injected clock, and never starts
// with PLENUM_NO_SCHEDULER=1 or PLENUM_SMOKE=1; start() is called by lib/routes/notify.mjs only, so importing this file starts nothing.
//
// OPEN ROWS AFTER A RESTART: the open list is kept in notify.json, while each producer remembers only in memory what it raised. So
// isOpen(key) tells a producer whether a kept row is still up (it then sends its clear on its first check), and dismiss(key) lets the
// owner take a row down himself (Dismiss in the sheet, POST /api/notify/clear); it answers the stamped clear record to publish, or null.
//
// createNotify(deps) -> an instance; deps: dir, now, env, read, write, publish, setTimer, clearTimer. The default instance's functions
// are exported below under the same names.
import fs, { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomic } from './atomic-write.mjs';

export const VERSION = 1;
export const LEVELS = Object.freeze(['needs-you', 'problem', 'fyi']);
export const ROUTES = Object.freeze(['accounts', 'today', 'plan-use', 'services', 'chat', 'night-shift', '']);
export const LIMITS = Object.freeze({ title: 60, text: 240, key: 120, business: 64, project: 200, log: 50, open: 50, held: 200, keys: 500 });
export const REPEAT_MS = 6 * 60 * 60_000;
export const TICK_MS = 60_000;
// How long a held notice is kept while the morning summary is switched off (nothing takes it out then).
export const HELD_OFF_MS = 24 * 60 * 60_000;
// The sentence summaryOf answers when nothing that was held has words. tick() publishes no summary for it.
export const NOTHING_TEXT = 'Nothing needs you.';
export const SUMMARY_TITLE = 'While you were away';
export const DEFAULT_SETTINGS = Object.freeze({
  quiet: Object.freeze({ on: true, from: '23:00', to: '07:00' }),
  mutes: Object.freeze({}),
  summary: Object.freeze({ on: true, at: '08:00' }),
});
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const BUSINESS_RE = /^[A-Za-z0-9_-]{1,64}$/;

// C0 and C1 controls, DEL, zero-width and direction marks: none of them belongs in a notice.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// One line of text: controls become spaces, runs of space become one, cut to max characters (a cut ends with an ellipsis).
export function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...s];
  if (chars.length <= max) return s;
  return `${chars.slice(0, max - 1).join('').trimEnd()}\u2026`;
}

const minutesOf = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const localMinutes = ms => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };
const pad = n => String(n).padStart(2, '0');
export const localDate = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
// The latest moment at or before ms that the local clock read hhmm.
export function boundaryBefore(ms, hhmm) {
  const d = new Date(ms);
  d.setHours(Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5)), 0, 0);
  if (d.getTime() > ms) d.setDate(d.getDate() - 1);
  return d.getTime();
}
// The next local midnight after ms.
export function endOfLocalDay(ms) {
  const d = new Date(ms);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}
// Whether quiet hours hold at ms. from === to is no quiet hours at all.
export function inQuietHours(quiet, ms) {
  if (!quiet?.on) return false;
  const f = minutesOf(quiet.from);
  const t = minutesOf(quiet.to);
  const m = localMinutes(ms);
  if (f === t) return false;
  return f < t ? m >= f && m < t : m >= f || m < t;
}

// Settings as stored: anything that is not right is the default.
export function cleanSettings(raw) {
  const s = isObject(raw) ? raw : {};
  const q = isObject(s.quiet) ? s.quiet : {};
  const sm = isObject(s.summary) ? s.summary : {};
  const mutes = {};
  if (isObject(s.mutes)) {
    for (const [id, until] of Object.entries(s.mutes)) if (BUSINESS_RE.test(id) && Number.isFinite(until) && until > 0) mutes[id] = Math.floor(until);
  }
  const from = TIME_RE.test(q.from ?? '') ? q.from : DEFAULT_SETTINGS.quiet.from;
  const to = TIME_RE.test(q.to ?? '') ? q.to : DEFAULT_SETTINGS.quiet.to;
  // The same From and To never held (inQuietHours), yet the page showed quiet hours as on. Such a file is read as what it did: quiet
  // hours off, with the usual times, so the switch can be turned on again.
  const same = from === to;
  return {
    quiet: {
      on: same ? false : typeof q.on === 'boolean' ? q.on : DEFAULT_SETTINGS.quiet.on,
      from: same ? DEFAULT_SETTINGS.quiet.from : from,
      to: same ? DEFAULT_SETTINGS.quiet.to : to,
    },
    mutes,
    summary: {
      on: typeof sm.on === 'boolean' ? sm.on : DEFAULT_SETTINGS.summary.on,
      at: TIME_RE.test(sm.at ?? '') ? sm.at : DEFAULT_SETTINGS.summary.at,
    },
  };
}

// ----- the summary's words (counts by key prefix only) -----
const PROGRAMS = Object.freeze({
  'claude-code': 'Claude Code', claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', 'gemini-cli': 'Gemini CLI', muse: 'Muse Code',
  'muse-code': 'Muse Code', antigravity: 'Antigravity', agy: 'Antigravity', cursor: 'Cursor', 'cursor-agent': 'Cursor', grok: 'Grok Build',
  // lib/signin-check.mjs names Claude Code 'anthropic' (its provider id).
  anthropic: 'Claude Code',
});
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// A thing that happened (a run that ended, a limit reached): never a condition on the open list (see the header).
export const happenedKey = key => typeof key === 'string' && (key.startsWith('run:') || key.startsWith('limit:'));
const prefixOf = key => (key.startsWith('routine:') ? 'routine'
  : key.startsWith('job:') ? 'job'
  : key.startsWith('nightshift:asleep:') ? 'asleep'
  : key.startsWith('signin:') ? 'signin'
  : key.startsWith('run:') ? 'run'
  : key.startsWith('limit:') ? 'limit'
  : key === 'hub' || key.startsWith('hub:') ? 'hub' : key === 'routines:paused' ? 'paused' : 'other');

// held: [{ key, level, resolved }] -> { level, text }
export function summaryOf(held) {
  const c = { routineBad: 0, routineFyi: 0, runBad: 0, runFyi: 0, limits: 0, needs: 0, signinBad: 0, hub: false, paused: false, otherBad: 0, otherFyi: 0, signedIn: [], signedInOther: 0, hubBack: false, pausedBack: false, routineBack: 0, otherBack: 0, jobFyi: 0, jobNeeds: 0, jobBad: 0, asleep: false };
  let problem = false;
  // A program is named once, even when two of its ids were signed in again ('claude-code' and 'anthropic' are both Claude Code).
  const signedIn = id => {
    const name = PROGRAMS[id];
    if (name && c.signedIn.includes(name)) return;
    if (name && c.signedIn.length < 3) c.signedIn.push(name);
    else c.signedInOther += 1;
  };
  for (const h of held) {
    const p = prefixOf(h.key);
    if (h.resolved) {
      if (p === 'signin') signedIn(h.key.slice(7));
      else if (p === 'hub') c.hubBack = true;
      else if (p === 'paused') c.pausedBack = true;
      else if (p === 'routine') c.routineBack += 1;
      else if (p === 'job') { /* a Night shift job that was answered or marked done says nothing in the summary */ }
      else c.otherBack += 1;
      continue;
    }
    if (h.level !== 'fyi') problem = true;
    // Night shift jobs (key job:<id>) have their own words, first in the sentence, and are not counted in `needs`.
    if (p === 'job') { if (h.level === 'needs-you') c.jobNeeds += 1; else if (h.level === 'problem') c.jobBad += 1; else c.jobFyi += 1; }
    // The PC slept through Night shift's hours (lib/jobs.mjs): said once, after the jobs.
    else if (p === 'asleep') c.asleep = true;
    else if (h.level === 'needs-you') c.needs += 1;
    else if (p === 'routine') { if (h.level === 'problem') c.routineBad += 1; else c.routineFyi += 1; }
    else if (p === 'run') { if (h.level === 'problem') c.runBad += 1; else c.runFyi += 1; }
    else if (p === 'limit') { if (h.level === 'problem') c.limits += 1; else c.otherFyi += 1; }
    else if (p === 'signin') { if (h.level === 'problem') c.signinBad += 1; else c.otherFyi += 1; }
    else if (p === 'hub') { if (h.level === 'problem') c.hub = true; else c.otherFyi += 1; }
    else if (p === 'paused') c.paused = true;
    else if (h.level === 'problem') c.otherBad += 1;
    else c.otherFyi += 1;
  }
  const parts = [];
  if (c.jobFyi) parts.push(`${plural(c.jobFyi, 'job', 'jobs')} finished`);
  if (c.jobNeeds) parts.push(c.jobFyi ? `${c.jobNeeds} ${c.jobNeeds === 1 ? 'waits' : 'wait'} for you` : `${plural(c.jobNeeds, 'job waits', 'jobs wait')} for you`);
  if (c.jobBad) parts.push(`${plural(c.jobBad, 'job', 'jobs')} did not finish`);
  if (c.asleep) parts.push('Night shift did not run because this PC was asleep');
  if (c.routineBad) parts.push(`${plural(c.routineBad, 'routine', 'routines')} did not run`);
  if (c.routineFyi) parts.push(`${plural(c.routineFyi, 'routine', 'routines')} ran`);
  if (c.runBad) parts.push(`${plural(c.runBad, 'run', 'runs')} did not finish`);
  if (c.runFyi) parts.push(`${plural(c.runFyi, 'run', 'runs')} finished`);
  if (c.limits) parts.push(`${plural(c.limits, 'plan or spend limit needs', 'plan or spend limits need')} a look`);
  if (c.needs) parts.push(`${c.needs} ${c.needs === 1 ? 'thing needs' : 'things need'} you`);
  if (c.signinBad) parts.push(`${plural(c.signinBad, 'program', 'programs')} could not sign in`);
  if (c.hub) parts.push('the hub had a problem');
  if (c.paused) parts.push('routines are paused');
  if (c.otherBad) parts.push(`${plural(c.otherBad, 'other problem', 'other problems')}`);
  if (c.otherFyi) parts.push(`${plural(c.otherFyi, 'update', 'updates')}`);
  for (const name of c.signedIn) parts.push(`${name} was signed in again`);
  if (c.signedInOther) {
    const more = c.signedIn.length ? 'more ' : '';
    parts.push(`${plural(c.signedInOther, `${more}program was`, `${more}programs were`)} signed in again`);
  }
  if (c.hubBack) parts.push('the hub works again');
  if (c.pausedBack) parts.push('routines run again');
  if (c.routineBack) parts.push(`${plural(c.routineBack, 'routine', 'routines')} ran again`);
  if (c.otherBack) parts.push(`${plural(c.otherBack, 'problem', 'problems')} cleared up`);
  const sentence = parts.length ? `${parts.join(', ')}.` : NOTHING_TEXT;
  return { level: problem ? 'problem' : 'fyi', text: cleanText(sentence.charAt(0).toUpperCase() + sentence.slice(1), LIMITS.text) };
}

// ----- the instance -----
const defaultDir = () => process.env.MUSE_CONSOLE_HOME || path.join(os.homedir(), '.muse-console');
const pause = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait: the next try follows at once */ } };

export function createNotify(deps = {}) {
  const d = {
    dir: deps.dir ?? null,
    now: deps.now ?? Date.now,
    env: deps.env ?? process.env,
    read: deps.read ?? (f => fs.readFileSync(f, 'utf8')),
    write: deps.write ?? writeFileAtomic,
    // The events channel is imported only when a summary is published, so lib/events.mjs and this file never import each other at load.
    publish: deps.publish ?? (async ev => (await import('./events.mjs')).publish(ev)),
    setTimer: deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }),
    clearTimer: deps.clearTimer ?? (t => clearTimeout(t)),
    saveDelay: deps.saveDelay ?? 100,
  };
  const dir = () => d.dir ?? defaultDir();
  const file = () => path.join(dir(), 'notify.json');

  let rec = null;
  // Set when notify.json is there and cannot be read (or is from a newer Plenum): the hub works in memory and never writes.
  let memoryOnly = '';
  let writing = Promise.resolve();
  let saveTimer = null;
  let timer = null;
  let started = false;
  // The records this instance answered: admitting one again (events.publish of the summary) gives it back as it is.
  const stamped = new WeakSet();

  const fresh = () => ({ v: VERSION, seq: 0, settings: cleanSettings(null), log: [], open: [], keys: {}, held: {}, lastSummaryAt: 0, seenAt: 0 });
  function migrate(raw) {
    const r = fresh();
    if (!isObject(raw)) return r;
    r.seq = Number.isInteger(raw.seq) && raw.seq > 0 ? raw.seq : 0;
    r.settings = cleanSettings(raw.settings);
    r.log = Array.isArray(raw.log) ? raw.log.filter(isObject).slice(-LIMITS.log) : [];
    r.open = Array.isArray(raw.open) ? raw.open.filter(isObject).slice(-LIMITS.open) : [];
    // An entry that is not an object (a hand-edited file) is left out: admit() writes fields on these.
    const objects = v => (isObject(v) ? Object.fromEntries(Object.entries(v).filter(([, e]) => isObject(e))) : {});
    r.keys = objects(raw.keys);
    r.held = objects(raw.held);
    r.lastSummaryAt = Number.isFinite(raw.lastSummaryAt) ? raw.lastSummaryAt : 0;
    r.seenAt = Number.isFinite(raw.seenAt) ? raw.seenAt : 0;
    for (const e of r.log) if (Number.isInteger(e.seq) && e.seq > r.seq) r.seq = e.seq;
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
      memoryOnly = `notify.json could not be read (${code}), so notifications work without saving until Plenum restarts.`;
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
    if (isObject(raw) && Number.isInteger(raw.v) && raw.v > VERSION) {
      memoryOnly = 'notify.json was written by a newer Plenum, so this version does not change it.';
    }
    rec = migrate(raw);
    return rec;
  }

  function prune(r, now) {
    for (const [id, until] of Object.entries(r.settings.mutes)) if (!(until > now)) delete r.settings.mutes[id];
    const keys = Object.entries(r.keys);
    for (const [k, v] of keys) if (!isObject(v) || now - (v.at ?? 0) > REPEAT_MS) delete r.keys[k];
    const left = Object.entries(r.keys);
    if (left.length > LIMITS.keys) for (const [k] of left.sort((a, b) => a[1].at - b[1].at).slice(0, left.length - LIMITS.keys)) delete r.keys[k];
    // With the summary switched off nothing empties the held list: what is older than a day is dropped, so it does not grow.
    if (!r.settings.summary.on) for (const [k, v] of Object.entries(r.held)) if (!isObject(v) || now - (v.at ?? 0) > HELD_OFF_MS) delete r.held[k];
    const held = Object.entries(r.held);
    if (held.length > LIMITS.held) for (const [k] of held.sort((a, b) => a[1].at - b[1].at).slice(0, held.length - LIMITS.held)) delete r.held[k];
  }

  // Writes the record now (after any write that is under way). Resolves to null when it reached the file, else to one sentence.
  function saveNow() {
    if (saveTimer) { d.clearTimer(saveTimer); saveTimer = null; }
    const r = load();
    if (memoryOnly) return Promise.resolve(memoryOnly);
    prune(r, d.now());
    const text = `${JSON.stringify(r, null, 2)}\n`;
    const job = writing.then(async () => {
      await fsp.mkdir(dir(), { recursive: true });
      await d.write(file(), text);
      return null;
    }).catch(err => {
      const why = `notify.json could not be saved (${String(err?.code ?? 'error').slice(0, 20)}).`;
      console.error(why);
      return why;
    });
    writing = job;
    return job;
  }
  // A save soon: many notices in a burst become one write.
  function saveSoon() {
    if (memoryOnly || saveTimer) return;
    saveTimer = d.setTimer(() => { saveTimer = null; saveNow(); }, d.saveDelay);
  }
  // Resolves once every save asked for so far has finished (null, or the sentence of the last failure).
  const flush = () => (saveTimer ? saveNow() : writing);

  const isMuted = (r, business, now) => Boolean(business) && r.settings.mutes[business] > now;
  const special = key => key.startsWith('summary:') || key.startsWith('test:');

  function clean(n) {
    const src = isObject(n) ? n : {};
    const level = LEVELS.includes(src.level) ? src.level : 'fyi';
    const title = cleanText(src.title, LIMITS.title);
    const text = cleanText(src.text, LIMITS.text);
    let key = cleanText(src.key, LIMITS.key);
    if (!key) key = `notice:${createHash('sha256').update(`${title}\n${text}`).digest('hex').slice(0, 12)}`;
    return {
      key,
      level,
      title,
      text,
      route: ROUTES.includes(src.route) ? src.route : '',
      business: cleanText(src.business, LIMITS.business),
      project: cleanText(src.project, LIMITS.project),
      clear: src.clear === true,
    };
  }

  // Cleans and stamps one notice (see the header) and writes it down. Never throws for a bad notice: anything wrong is made safe.
  function admit(notice, { now } = {}) {
    if (isObject(notice) && stamped.has(notice)) return notice;
    const t = Number.isFinite(now) ? now : d.now();
    const r = load();
    const n = clean(notice);
    r.seq += 1;
    let out;
    if (n.clear) {
      out = { ...n, level: 'fyi', title: '', text: '', clear: true, seq: r.seq, at: t, repeat: false, quiet: false, silent: false, hold: '' };
      const k = r.keys[n.key];
      if (k) k.clearedAt = t;
      const i = r.open.findIndex(o => o.key === n.key);
      if (i >= 0) {
        const was = r.open[i];
        r.open.splice(i, 1);
        // An open thing that ended while the owner was away is good news for the summary.
        if (!special(n.key) && (inQuietHours(r.settings.quiet, t) || isMuted(r, was.business, t) || r.held[n.key])) {
          r.held[n.key] = { level: r.held[n.key]?.level ?? was.level, at: r.held[n.key]?.at ?? t, resolved: true };
        }
      } else if (r.held[n.key]) r.held[n.key].resolved = true;
      for (const e of r.log) if (e.key === n.key && !e.clearedAt) e.clearedAt = t;
    } else {
      const k = r.keys[n.key];
      // A held-back admission (k.held) was never shown, so it does not make a later one a repeat.
      const repeat = Boolean(k) && !k.held && k.level === n.level && k.text === n.text && t - k.at < REPEAT_MS && t - k.at >= 0 && !(k.clearedAt >= k.at);
      const quietHours = !special(n.key) && inQuietHours(r.settings.quiet, t);
      const muted = !special(n.key) && isMuted(r, n.business, t);
      const quiet = muted || (quietHours && n.level !== 'needs-you');
      // The producer may ask for no sound (an update of something already told under this key); quiet hours may too.
      const asked = isObject(notice) && notice.silent === true;
      const silent = !quiet && ((!muted && quietHours && n.level === 'needs-you') || asked);
      out = { ...n, seq: r.seq, at: t, repeat, quiet, silent, hold: muted ? 'muted' : quiet ? 'quiet-hours' : '' };
      if (!repeat) r.keys[n.key] = { level: n.level, text: n.text, at: t, clearedAt: 0, held: quiet };
      // A Night shift job that waits for the owner, raised in quiet hours: delivered without sound, and counted in the morning summary.
      const nightJob = n.key.startsWith('job:') && n.level === 'needs-you' && quietHours && !muted;
      if ((quiet || nightJob) && !special(n.key)) {
        const h = r.held[n.key];
        // A job's latest word is its state (it waited for him, then he answered and it finished): for job: keys the newest level counts.
        const keepNeeds = h && h.level === 'needs-you' && !n.key.startsWith('job:');
        r.held[n.key] = { level: keepNeeds ? h.level : n.level, at: h?.at ?? t, resolved: false };
      } else if (r.held[n.key]) r.held[n.key].resolved = false;
      const i = r.open.findIndex(o => o.key === n.key);
      if (i >= 0) r.open.splice(i, 1);
      if (n.level !== 'fyi' && !special(n.key) && !happenedKey(n.key)) {
        r.open.push({ ...out });
        if (r.open.length > LIMITS.open) r.open.splice(0, r.open.length - LIMITS.open);
      }
      // A repeat was told already and is in the log once: writing it again would list it once per repeat and push real history out.
      if (!repeat) {
        r.log.push({ ...out, clearedAt: 0 });
        if (r.log.length > LIMITS.log) r.log.splice(0, r.log.length - LIMITS.log);
      }
    }
    stamped.add(out);
    saveSoon();
    return out;
  }

  // ----- reads and settings -----
  function snapshot({ now } = {}) {
    const t = Number.isFinite(now) ? now : d.now();
    const r = load();
    prune(r, t);
    const recent = r.log.slice().reverse().map(e => ({ ...e }));
    return {
      settings: structuredClone(r.settings),
      recent,
      open: r.open.slice().reverse().map(e => ({ ...e })),
      seenAt: r.seenAt,
      unseen: r.log.filter(e => e.at > r.seenAt).length,
      quietNow: inQuietHours(r.settings.quiet, t),
      saving: !memoryOnly,
      ...(memoryOnly ? { why: memoryOnly } : {}),
    };
  }
  const settings = () => structuredClone(load().settings);

  // { quiet: { on?, from?, to? }, summary: { on?, at? } }: checked whole before anything changes. Throws an Error with status 400 and
  // one sentence when a value is wrong (the same From and To for quiet hours is wrong: it would never hold). Resolves to null when
  // saved, else the sentence of the failure. Switching the summary on empties what was held while it was off.
  function setSettings(body) {
    const fail = msg => Object.assign(new Error(msg), { status: 400 });
    if (!isObject(body)) throw fail('Send the settings as an object.');
    const r = load();
    const next = structuredClone(r.settings);
    for (const [part, fields] of [['quiet', { on: 'bool', from: 'time', to: 'time' }], ['summary', { on: 'bool', at: 'time' }]]) {
      if (body[part] === undefined) continue;
      if (!isObject(body[part])) throw fail(`Send ${part} as an object.`);
      for (const [name, kind] of Object.entries(fields)) {
        const v = body[part][name];
        if (v === undefined) continue;
        if (kind === 'bool' && typeof v !== 'boolean') throw fail('Send true or false to switch it on or off.');
        if (kind === 'time' && (typeof v !== 'string' || !TIME_RE.test(v))) throw fail('Send a time as HH:MM, for example 23:00.');
        next[part][name] = v;
      }
    }
    if (next.quiet.from === next.quiet.to) throw fail('Pick two different times for quiet hours.');
    // What was held while the summary was off is old news: the first summary tells only what is held from now on.
    if (next.summary.on && !r.settings.summary.on) r.held = {};
    r.settings = next;
    return saveNow();
  }

  // Mutes one business: minutes 1..1440 from now, 'day' until the end of the local day, 0 ends the mute.
  function mute(business, minutes, { now } = {}) {
    const fail = msg => Object.assign(new Error(msg), { status: 400 });
    if (typeof business !== 'string' || !BUSINESS_RE.test(business)) throw fail('Say which business to mute.');
    const t = Number.isFinite(now) ? now : d.now();
    const r = load();
    if (minutes === 0) delete r.settings.mutes[business];
    else if (minutes === 'day' || minutes === 'today') r.settings.mutes[business] = endOfLocalDay(t);
    else if (Number.isInteger(minutes) && minutes > 0 && minutes <= 1440) r.settings.mutes[business] = t + minutes * 60_000;
    else throw fail('Mute for 60 minutes, until the end of the day, or 0 to end the mute.');
    return saveNow().then(failure => ({ failure, until: r.settings.mutes[business] ?? 0 }));
  }

  function seen({ now } = {}) {
    const r = load();
    r.seenAt = Number.isFinite(now) ? now : d.now();
    return saveNow().then(failure => ({ failure, seenAt: r.seenAt }));
  }

  // Whether a key is on the open list now (kept across restarts). A producer that lost its own memory in a restart asks this before it
  // sends a clear, so it clears a row that was kept without sending a clear on every check.
  const isOpen = key => typeof key === 'string' && load().open.some(o => o.key === key);

  // The owner took a row down himself (Dismiss on a Needs you row: a way out for a row its producer will not clear, for example one
  // kept across a restart, or a deleted routine's). Answers the stamped clear record for the caller to publish, or null when the key is
  // not open. A dismissed row is not good news for the morning summary (nothing was put right), so it leaves the held list too.
  function dismiss(key, { now } = {}) {
    if (!isOpen(key)) return null;
    const out = admit({ key, clear: true }, { now });
    delete load().held[key];
    saveSoon();
    return out;
  }

  // ----- the summary -----
  // Whether a summary is due at t: something was held since the last one, it is not quiet hours, and the summary's time came after the
  // first thing was held. The summary's time is summary.at, the time the owner picked; when that time falls inside quiet hours (when
  // nothing but what needs him is shown), it is the end of quiet hours instead.
  function summaryDue(t) {
    const r = load();
    const s = r.settings;
    if (!s.summary.on) return false;
    const held = Object.values(r.held).filter(isObject);
    if (!held.length) return false;
    if (inQuietHours(s.quiet, t)) return false;
    const first = Math.min(...held.map(h => h.at ?? t));
    const at = boundaryBefore(t, s.summary.at);
    const mark = inQuietHours(s.quiet, at) ? boundaryBefore(t, s.quiet.to) : at;
    return mark > first && mark <= t;
  }
  // One check of the summary. Answers the summary record it published, or null (none was due, or there was nothing to say).
  function tick({ now } = {}) {
    const t = Number.isFinite(now) ? now : d.now();
    if (!summaryDue(t)) return null;
    const r = load();
    const held = Object.entries(r.held).filter(([, h]) => isObject(h)).map(([key, h]) => ({ key, level: h.level, resolved: h.resolved === true }));
    const { level, text } = summaryOf(held);
    r.held = {};
    r.lastSummaryAt = t;
    // Nothing that was held has words (a Night shift job that was answered in the night): a summary about nothing is not sent.
    if (text === NOTHING_TEXT) {
      saveSoon();
      return null;
    }
    const out = admit({ key: `summary:${localDate(t)}`, level, title: SUMMARY_TITLE, text, route: 'today' }, { now: t });
    try {
      Promise.resolve(d.publish({ type: 'notice', notice: out })).catch(() => {});
    } catch { /* the summary is in the log either way */ }
    return out;
  }
  const offByEnv = () => d.env.PLENUM_NO_SCHEDULER === '1' || d.env.PLENUM_SMOKE === '1';
  function arm() {
    timer = d.setTimer(() => {
      timer = null;
      try { tick(); } catch (err) { console.error('The notification summary check failed:', String(err?.message ?? err).slice(0, 120)); }
      if (started) arm();
    }, TICK_MS);
  }
  // The summary timer. Never with PLENUM_NO_SCHEDULER=1 or PLENUM_SMOKE=1. Answers whether a timer runs.
  function start() {
    if (started) return true;
    if (offByEnv()) return false;
    started = true;
    arm();
    return true;
  }
  function stop() {
    started = false;
    if (timer) { d.clearTimer(timer); timer = null; }
  }
  const running = () => started;

  return { admit, snapshot, settings, setSettings, mute, seen, isOpen, dismiss, tick, summaryDue, start, stop, running, flush, saveNow, file, isMemoryOnly: () => memoryOnly };
}

let instance = null;
const hub = () => (instance ??= createNotify());

export const admit = (notice, opts) => hub().admit(notice, opts);
export const snapshot = opts => hub().snapshot(opts);
export const settings = () => hub().settings();
export const setSettings = body => hub().setSettings(body);
export const mute = (business, minutes, opts) => hub().mute(business, minutes, opts);
export const seen = opts => hub().seen(opts);
export const isOpen = key => hub().isOpen(key);
export const dismiss = (key, opts) => hub().dismiss(key, opts);
export const tick = opts => hub().tick(opts);
export const start = () => hub().start();
export const stop = () => hub().stop();
export const flush = () => hub().flush();
