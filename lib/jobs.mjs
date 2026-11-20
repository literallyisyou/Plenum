// Night shift (wave 6, ns1; work/wave6/NIGHTSHIFT-BRIEF.md is the shared design): a short list of one-off jobs the owner leaves for
// Plenum. During the night hours Plenum works through them one at a time, each as an ordinary chat turn in the business's "Jobs" thread,
// through lib/routines.mjs step(), and spends only plan time that would otherwise go unused (lib/pacer.mjs decides).
//
// THE CONTRACT (lib/routes/night-shift.mjs and public/ext-night-shift.js build to it; build/v06/w6-ns1 pins each part):
//   The file: night-shift.json in store.HOME (the folder of routines.json, which every model tool refuses),
//     { v: 1,
//       settings: { on, from: 'HH:MM', to: 'HH:MM', share: 10..50, keepAwake, countRuns: { gemini, antigravity, cursor, grok } },
//       jobs: [{ id: 'j_<8 hex>', business, project, name, text, doneWhen, lead: '' | ref, source: 'owner' | 'suggested', order,
//                addedAt, updatedAt, finishedAt, state: waiting | running | done | needs-you | stopped | not-finished, why, fails,
//                runs: [{ at, ms, lead, state, why, done, next, owner, finished, pacerStop?, note?, auto? }] }],
//       nights: { '<YYYY-MM-DD of the hours' start>': { ledger: { '<provider>|<window>|<resetsAt>': { start, atReset, nights, cap, at } },
//                                                       runs: { <provider>: n }, out: [provider] } } }
//     Beside the design's shape: fails (start failures in a row; 3 make the job needs-you) and a run's note (the leads passed over).
//   createNightShift(deps) -> an instance; the default instance's functions are exported below under the same names.
//     deps: dir, now, env, setTimer, clearTimer, routines, business, team, planWatch ({ planState }), activity ({ subscribe, snapshot }),
//           agents ({ onLive, liveAll }: lib/agent-run.mjs, the team workers, Scorecard's checks and tries, which never reach activity),
//           shell ({ shellRequest, shellAvailable }) (each a module, null, or a function that gives one or a promise of one), termsOk,
//           publish, write, read, threadFacts(projectId) -> { canWrite, approvals }, projectById,
//           autoRoute(q) -> a promise of lib/auto-route.mjs route()'s answer (forLeads of lib/auto-context.mjs; by default an auto
//           context made on first use with this instance's team and planWatch).
//   AUTO ROUTING (wave 6, ar3): for a job with no pinned lead whose business has autoLeads: true, the pacer walks the business's leads in
//     the order Auto ranks them for that job (its text, Done when, the runs that did not finish, the minutes left in the hours) instead of
//     the owner's order; every lead stays in the list, so the pacer's room checks still decide. At the start the lead the pacer took is
//     routed once more as the only candidate for its effort and its line ("Auto: <lead>, <effort>: ..."): step() gets both, the run keeps
//     the line as auto, and the last-run line says it. A pinned lead is never routed. autoLeads off: as before.
//   describe()                -> a promise of what GET /api/night-shift answers
//   add(input) update(input) move(input) remove(input) cont(input) done(input) stop(input) setSettings(input) resume()
//                             -> each a promise; a refusal is an Error with a status (400, 409) and one plain sentence
//   start()                   the timer's only way in: lib/routes/night-shift.mjs calls it when the server loads the route
//   tick(), idle(), shutdown(), observe(activityMessage), file, VERSION
//   Events: { type: 'night-shift', action: 'changed' } after every change.
//   Notices (lib/notify.mjs), one per job end under the key job:<id>, route 'night-shift' (wave 6 integration; it was 'today', which
//     opened Businesses > Today, where nothing of the job is): fyi "Job finished: <Business>", needs-you "<Business>: a job waits for
//     you", problem "Job not finished: <Business>". Only the owner's own job name, never model text.
//   working() -> true while Night shift is on, inside its hours, with a job waiting or running (lib/scorecard-run.mjs holds spot-checks).
//
// RULES THIS MODULE KEEPS
//   - Only the owner adds a job: there is no tool for it, the routes need the token, and the file is in the data folder models cannot reach.
//   - No timer before start(); none with PLENUM_NO_SCHEDULER=1 or PLENUM_SMOKE=1. A tick does nothing before the License Agreement.
//   - A job runs only through routines.step(): its pauses, hold, one run per folder, today's caps, the lead check, approvals and Stop.
//   - A pinned lead is never switched; when the first lead of the business is passed over, the run's line says which and why.
//   - At most 3 runs a job. Stop on a job goes to routines.stop(key) only.
//   - It awaits no import at its top: the neighbours load on first use, inside a function.
import fs, { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeFileAtomic } from './atomic-write.mjs';
import { CODE_ROOT, moduleUrl } from './overlay.mjs';
import { canWrite, openThreads, threadsOf } from './threads.mjs';
import { approvalModeOf } from './projects.mjs';
import * as store from './store.mjs';
import * as pacer from './pacer.mjs';

export const VERSION = 1;
export const THREAD_NAME = 'Jobs';
export const TICK_MS = 60_000;
export const SHELL_WAIT_MS = 5000;
export const LIMITS = Object.freeze({ open: 50, text: 4000, doneWhen: 300, name: 60, runs: pacer.MAX_RUNS, nights: 7, line: 300, fails: 3, countRuns: 20 });
export const STATES = Object.freeze(['waiting', 'running', 'done', 'needs-you', 'stopped', 'not-finished']);
export const PILLS = Object.freeze({ waiting: 'Waiting', running: 'Running', done: 'Done', 'needs-you': 'Needs you', stopped: 'Stopped', 'not-finished': 'Not finished' });
export const DEFAULT_SETTINGS = Object.freeze({ on: true, from: '23:00', to: '07:00', share: 50, keepAwake: true, countRuns: Object.freeze({ gemini: 4, antigravity: 4, cursor: 4, grok: 4 }) });
export const NEWER = 'Night shift was saved by a newer Plenum. This version shows it and does not change it.';
export const EMPTY = 'Leave a job here and Plenum works on it overnight, using only plan time you would otherwise lose.';
export const PAUSED_OUT = `Plenum paused its last run, and it has had its ${pacer.MAX_RUNS} runs. Add it again as a new job to go on.`;
const ID_RE = /^j_[a-f0-9]{8}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const OUTSIDE_MS = 30 * 60_000;
const GAP_MS = 15 * 60_000; // a gap between ticks this long inside the hours means the PC slept (or Plenum was not running)
const STEP_WHY_MS = 3 * 60_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// The words of a failure that came from a plan's limit (as lib/team.mjs LIMIT_RE; that one is used when the team is there).
const LIMIT_WORDS = /\b(usage|rate|plan|weekly|5-hour|five-hour|hourly|daily|monthly|session)[ -]limit\b|\blimit (reached|exceeded|hit)\b|\bout of (credits|quota)\b|\btoo many requests\b|\b429\b|resource[_ ]exhausted|exceeded your (current )?quota/i;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (status, message) => Object.assign(new Error(message), { status });
const oneLine = (text, max = LIMITS.line) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const time = v => (Number.isFinite(v) && v > 0 ? v : 0);
const dateOf = ms => { const d = new Date(ms); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
const copy = v => structuredClone(v);
const asGetter = v => (typeof v === 'function' ? v : () => v);

// The job's name: its first line that holds anything, cut to 60 characters.
export function nameOf(text) {
  const line = String(text ?? '').split(/\r\n|\n|\r/).map(r => r.replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
  return line.length > LIMITS.name ? line.slice(0, LIMITS.name).trimEnd() : line;
}

// The last line of a reply that starts with word: (as lib/routines.mjs lineOf).
function lineOf(text, word) {
  const hits = [...String(text ?? '').matchAll(new RegExp(`^[ \\t>*-]*${word}:[ \\t]*(.+)$`, 'gim'))];
  return hits.length ? oneLine(hits[hits.length - 1][1]) : '';
}
// The marks a model may wrap a value in (**finished**, `none`, "n/a", [none]), taken off both ends before the value is read.
const bare = s => String(s ?? '').replace(/^[\s*_`"'([{<]+/, '').replace(/[\s*_`"')\]}>.!]+$/, '');
// Finished only when the STATUS line starts with "finished" ("not yet finished", "unfinished", "partly finished" are not).
export const finishedOf = text => /^finished\b/i.test(bare(lineOf(text, 'STATUS')));
// An OWNER line that says there is nothing for him (the words of lib/job-suggestions.mjs NOTHING, and a few more) is no question.
const NOTHING = /^(none|nothing|n\/a|na|no|nil|-+|—|–|not applicable|no(ne)? (decisions?|questions?|action)( needed| required)?|(none|nothing) (needed|required|for (the )?owner|for now|at this time)|no further (work|steps?|action|decisions?)s?( needed| required)?|nothing (further|more|left)( to (do|decide))?|all done|done)$/i;
export const ownerOf = text => { const o = lineOf(text, 'OWNER'); const b = bare(o); return !b || NOTHING.test(b) ? '' : o; };

// ---------- the record ----------

function cleanSettings(raw) {
  const s = isObject(raw) ? raw : {};
  const from = TIME_RE.test(s.from ?? '') ? s.from : DEFAULT_SETTINGS.from;
  const to = TIME_RE.test(s.to ?? '') ? s.to : DEFAULT_SETTINGS.to;
  const same = from === to;
  const c = isObject(s.countRuns) ? s.countRuns : {};
  const countRuns = {};
  for (const p of pacer.COUNTED) countRuns[p] = Number.isInteger(c[p]) && c[p] >= 0 && c[p] <= LIMITS.countRuns ? c[p] : DEFAULT_SETTINGS.countRuns[p];
  return {
    on: typeof s.on === 'boolean' ? s.on : DEFAULT_SETTINGS.on,
    from: same ? DEFAULT_SETTINGS.from : from,
    to: same ? DEFAULT_SETTINGS.to : to,
    share: Number.isInteger(s.share) && s.share >= 10 && s.share <= 50 ? s.share : DEFAULT_SETTINGS.share,
    keepAwake: typeof s.keepAwake === 'boolean' ? s.keepAwake : DEFAULT_SETTINGS.keepAwake,
    countRuns,
  };
}
function cleanRun(raw) {
  const r = isObject(raw) ? raw : {};
  return {
    at: time(r.at),
    ms: Number.isFinite(r.ms) && r.ms > 0 ? Math.round(r.ms) : 0,
    lead: typeof r.lead === 'string' ? r.lead.slice(0, 200) : '',
    state: typeof r.state === 'string' ? r.state.slice(0, 20) : '',
    why: oneLine(r.why),
    done: oneLine(r.done),
    next: oneLine(r.next),
    owner: oneLine(r.owner),
    finished: r.finished === true,
    ...(r.pacerStop === true ? { pacerStop: true } : {}),
    ...(typeof r.note === 'string' && r.note ? { note: oneLine(r.note) } : {}),
    ...(typeof r.auto === 'string' && oneLine(r.auto, 160) ? { auto: oneLine(r.auto, 160) } : {}),
  };
}
function cleanJob(raw) {
  if (!isObject(raw) || typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null;
  if (typeof raw.business !== 'string' || !raw.business || typeof raw.project !== 'string' || !raw.project) return null;
  const text = typeof raw.text === 'string' ? raw.text.slice(0, LIMITS.text) : '';
  if (!text.trim()) return null;
  return {
    id: raw.id,
    business: raw.business.slice(0, 80),
    project: raw.project.slice(0, 200),
    name: nameOf(text) || 'Job',
    text,
    doneWhen: typeof raw.doneWhen === 'string' ? raw.doneWhen.slice(0, LIMITS.doneWhen) : '',
    lead: typeof raw.lead === 'string' ? raw.lead.slice(0, 200) : '',
    source: raw.source === 'suggested' ? 'suggested' : 'owner',
    order: Number.isFinite(raw.order) ? raw.order : 0,
    addedAt: time(raw.addedAt),
    updatedAt: time(raw.updatedAt),
    finishedAt: time(raw.finishedAt),
    state: STATES.includes(raw.state) ? raw.state : 'waiting',
    why: oneLine(raw.why),
    // whyPacer: why is the pacer's reason of the night (keepReasons), which a later one may replace; another why is kept as it is.
    ...(raw.whyPacer === true ? { whyPacer: true } : {}),
    fails: Number.isInteger(raw.fails) && raw.fails >= 0 ? Math.min(raw.fails, 100) : 0,
    runs: (Array.isArray(raw.runs) ? raw.runs : []).slice(-LIMITS.runs).map(cleanRun),
  };
}
function cleanNights(raw) {
  const out = {};
  if (!isObject(raw)) return out;
  for (const key of Object.keys(raw).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort().slice(-(LIMITS.nights + 1))) {
    const n = isObject(raw[key]) ? raw[key] : {};
    const ledger = {};
    for (const [k, e] of Object.entries(isObject(n.ledger) ? n.ledger : {})) {
      if (isObject(e) && Number.isFinite(e.cap) && k.length <= 200) ledger[k] = { start: Number(e.start) || 0, atReset: Number(e.atReset) || 0, nights: Number(e.nights) || 1, cap: e.cap, at: time(e.at) };
    }
    const runs = {};
    for (const [p, v] of Object.entries(isObject(n.runs) ? n.runs : {})) if (/^[a-z0-9-]{1,40}$/.test(p) && Number.isInteger(v) && v >= 0) runs[p] = v;
    out[key] = { ledger, runs, out: (Array.isArray(n.out) ? n.out : []).filter(p => typeof p === 'string' && /^[a-z0-9-]{1,40}$/.test(p)).slice(0, 20) };
  }
  return out;
}
// The jobs a file holds at most, and the done jobs kept (the oldest done ones go when a job is added or a run ends).
const JOBS_MAX = 500;
const DONE_KEEP = 200;
const doneAt = j => j.finishedAt || j.updatedAt || j.addedAt || 0;
// The newest n done jobs of a list.
const newestDone = (list, n) => (n > 0 ? list.filter(j => j.state === 'done').sort((a, b) => doneAt(b) - doneAt(a) || b.order - a.order).slice(0, n) : []);
// Takes the oldest done jobs past DONE_KEEP out of a list, in place.
function pruneDone(list) {
  if (list.filter(j => j.state === 'done').length <= DONE_KEEP) return;
  const keep = new Set(newestDone(list, DONE_KEEP));
  for (let i = list.length - 1; i >= 0; i -= 1) if (list[i].state === 'done' && !keep.has(list[i])) list.splice(i, 1);
}
// A v1 record from anything. A file from a newer version keeps its version and its fields (this build shows it and never writes it).
export function migrate(raw) {
  const r = isObject(raw) ? raw : {};
  const newer = Number.isInteger(r.v) && r.v > VERSION;
  const all = [];
  const seen = new Set();
  for (const item of Array.isArray(r.jobs) ? r.jobs : []) {
    const j = cleanJob(item);
    if (!j || seen.has(j.id)) continue;
    seen.add(j.id);
    all.push(j);
  }
  // At most JOBS_MAX: every job that is not done is kept, then the newest done ones (the file is in the order jobs were added, so a
  // cap by file order dropped the newest jobs, waiting ones included).
  let jobs = all;
  if (all.length > JOBS_MAX) {
    const open = all.filter(j => j.state !== 'done').slice(0, JOBS_MAX);
    const done = newestDone(all, JOBS_MAX - open.length);
    const keep = new Set([...open, ...done]);
    jobs = all.filter(j => keep.has(j));
  }
  const clean = { v: VERSION, settings: cleanSettings(r.settings), jobs, nights: cleanNights(r.nights) };
  return newer ? { ...r, ...clean, v: r.v } : clean;
}

// The message of one run (the owner's words indented, so no line of his reads as Plenum's own heading).
export function messageOf({ job, business, n, at }) {
  const rows = String(job.text).replace(/\r\n?/g, '\n').split('\n').map(row => `  ${row}`);
  return [
    `This is a Night shift job of the business "${business}", left by the owner on ${dateOf(job.addedAt || at)}. Plenum started it at ${pacer.clockOf(at)}. The owner is not at the PC. This is run ${n} of at most ${LIMITS.runs}.`,
    // A suggested job is an earlier run's NEXT line, taken unedited: it is never given the authority of the owner's own words.
    job.source === 'suggested' ? 'THE JOB (suggested by an earlier run; the owner chose to run it):' : 'THE JOB (the owner\'s words):',
    ...rows,
    `Done when: ${job.doneWhen && job.doneWhen.trim() ? oneLine(job.doneWhen, LIMITS.doneWhen) : 'you judge it done'}`,
    'Earlier runs of this job are above in this thread; go on from where the last one stopped.',
    'End your reply with:',
    'STATUS: finished, or not finished.',
    'DONE: what was finished, in one line.',
    'NEXT: the next step, in one line.',
    'OWNER: one line for each thing only the owner can decide, or none.',
  ].join('\n');
}

// ---------- the instance ----------

export function createNightShift(deps = {}) {
  const d = {
    dir: deps.dir ?? store.HOME,
    now: deps.now ?? Date.now,
    env: deps.env ?? process.env,
    setTimer: deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }),
    clearTimer: deps.clearTimer ?? (t => clearTimeout(t)),
    routines: asGetter(deps.routines ?? null),
    business: asGetter(deps.business ?? null),
    team: asGetter(deps.team ?? null),
    planWatch: asGetter(deps.planWatch ?? null),
    activity: asGetter(deps.activity ?? null),
    agents: asGetter(deps.agents ?? null),
    shell: asGetter(deps.shell ?? null),
    termsOk: deps.termsOk ?? (() => true),
    publish: deps.publish ?? (() => {}),
    write: deps.write ?? writeFileAtomic,
    read: deps.read ?? (f => fs.readFileSync(f, 'utf8')),
    threadFacts: deps.threadFacts ?? (() => ({ canWrite: false, approvals: 'ask' })),
    projectById: deps.projectById ?? (() => null),
    autoRoute: typeof deps.autoRoute === 'function' ? deps.autoRoute : null,
  };
  const file = path.join(d.dir, 'night-shift.json');

  let rec = null;
  let writing = Promise.resolve();
  let unreadable = '';
  let unreadableAt = 0;
  let damaged = false;
  let recovered = false;
  const sched = { started: false, off: false, timer: null, ticking: false };
  let probePage = null;
  const PROBES_PER_TICK = 8;
  const probeRevision = job => JSON.stringify([job.state, job.order, job.updatedAt, job.lead, job.project, job.business, job.runs.length]);
  const live = new Map(); // job id -> { key, ref, since }: the Night shift run that is going
  const starting = new Set(); // job ids whose step() is being asked for
  // Job ids the owner pressed Stop on while their step() was being asked for. routines.stop(key) alone can be lost then: step() may
  // answer "wait" before it begins the run, and the mark of routines is cleared with that answer.
  const stopWanted = new Set();
  const early = new Map(); // job id -> an onEnd that came before step() answered
  const flags = new Map(); // job id -> { why }: a stop the pacer asked for (the hours ended, the share was reached)
  const flights = new Set();
  // What the desktop said last: available (false after a 503), awake, idleSec, when, and what was sent.
  const desk = { available: null, awake: null, idleSec: null, at: 0, sent: null };
  let stepWhy = null; // { why, at }: step() said wait for a reason of its own

  // ----- the neighbours (each may be missing) -----
  const neighbour = async get => { try { return (await get()) ?? null; } catch { return null; } };
  const rt = () => neighbour(d.routines);
  const biz = () => neighbour(d.business);
  const team = () => neighbour(d.team);
  let rtSync = null; // the routines module once loaded, for the activity listener (which must answer at once)

  // ----- the file (the pattern of lib/routines.mjs) -----
  const pause = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait */ } };
  function saveDamaged(text) {
    try {
      let target = `${file}.damaged`;
      if (fs.existsSync(target)) target = `${file}.damaged-${d.now()}`;
      const tmpName = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmpName, text);
      fs.renameSync(tmpName, target);
    } catch { /* the damaged text is a courtesy */ }
  }
  function load() {
    if (rec) return rec;
    if (unreadable && d.now() - unreadableAt < 5000) return migrate(null);
    let raw = null;
    let text = null;
    let code = '';
    for (let tries = 0; tries < 4; tries += 1) {
      try {
        text = d.read(file);
        code = '';
        break;
      } catch (err) {
        if (err?.code === 'ENOENT') { code = ''; break; }
        code = String(err?.code ?? 'EIO').slice(0, 20);
        if (tries < 3) pause(50);
      }
    }
    if (code) {
      unreadable = code;
      unreadableAt = d.now();
      return migrate(null);
    }
    unreadable = '';
    if (text !== null) {
      try {
        raw = JSON.parse(String(text).replace(/^﻿/, ''));
      } catch {
        if (String(text).trim()) {
          saveDamaged(text);
          damaged = true;
        }
      }
    }
    rec = migrate(raw);
    return rec;
  }
  const unreadableSentence = () => `night-shift.json could not be read (${unreadable}), so nothing was changed. Close other programs that use Plenum's data folder and try again.`;
  const isNewer = () => load().v > VERSION;
  function guardWritable() {
    load();
    if (unreadable && !rec) throw fail(409, unreadableSentence());
    if (isNewer()) throw fail(409, NEWER);
  }
  function persist() {
    if (isNewer()) return Promise.reject(fail(409, NEWER));
    if (unreadable && !rec) return Promise.reject(fail(409, unreadableSentence()));
    const text = `${JSON.stringify(load(), null, 2)}\n`;
    const job = writing.then(async () => {
      await fsp.mkdir(d.dir, { recursive: true });
      await d.write(file, text);
    });
    writing = job.catch(() => {});
    return job;
  }
  const persistQuiet = () => persist().catch(err => { console.error(`Could not save night-shift.json: ${String(err?.code ?? err?.message ?? err).slice(0, 120)}`); });
  // A change of the owner's: written whole; when the write fails the change is taken back and he is told.
  async function saveOrUndo(was) {
    try {
      await persist();
    } catch (err) {
      if (err?.status) throw err;
      rec = was;
      await persist().catch(() => {});
      throw fail(500, `Plenum could not save Night shift, so nothing changed (${String(err?.code ?? 'write failed').slice(0, 20)}). Close other programs that use Plenum's data folder and try again.`);
    }
  }

  const changed = () => { try { d.publish({ type: 'night-shift', action: 'changed' }); } catch { /* a window that cannot be told asks again */ } };
  const sorted = () => [...load().jobs].sort((a, b) => a.order - b.order || a.addedAt - b.addedAt);
  const find = id => (typeof id === 'string' ? load().jobs.find(j => j.id === id) ?? null : null);
  const keyOf = id => `s:n${id}`;
  const isLive = id => live.has(id) || starting.has(id);

  // ----- tonight -----
  function nightOf(now) {
    const r = load();
    const key = pacer.nightKey(r.settings, now);
    if (!isObject(r.nights[key])) {
      r.nights[key] = { ledger: {}, runs: {}, out: [] };
      // Nights older than LIMITS.nights are pruned.
      const keys = Object.keys(r.nights).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - (LIMITS.nights + 1)))) delete r.nights[k];
    }
    return r.nights[key];
  }

  // ----- what the owner is told -----
  async function nameOfBusiness(id) {
    try {
      const b = await (await biz())?.byId?.(id);
      return typeof b?.name === 'string' && b.name.trim() ? oneLine(b.name, 60) : 'A business';
    } catch {
      return 'A business';
    }
  }
  const notice = n => { try { d.publish({ type: 'notice', notice: n }); } catch { /* the pane says it too */ } };
  async function tell(job, kind) {
    const b = await nameOfBusiness(job.business);
    // Route 'night-shift' opens the Night shift pane (the notice's words point there, and its row leads on to the Jobs thread).
    const base = { key: `job:${job.id}`, route: 'night-shift', business: job.business, project: job.project };
    if (kind === 'done') notice({ ...base, level: 'fyi', title: `Job finished: ${b}`, text: `"${job.name}" is done.` });
    else if (kind === 'needs-you') notice({ ...base, level: 'needs-you', title: `${b}: a job waits for you`, text: `"${job.name}" needs your answer. It's in the Jobs thread.` });
    else if (kind === 'no-start') notice({ ...base, level: 'needs-you', title: `${b}: a job waits for you`, text: `"${job.name}" could not start ${LIMITS.fails} times. Open Night shift to see why.` });
    else if (kind === 'not-finished') notice({ ...base, level: 'problem', title: `Job not finished: ${b}`, text: `"${job.name}" ran ${LIMITS.runs} times and is not done.` });
    else if (kind === 'paused-out') notice({ ...base, level: 'problem', title: `Job not finished: ${b}`, text: `"${job.name}" had its ${LIMITS.runs} runs, the last one paused by Plenum, and is not done.` });
  }
  const clearNotice = job => notice({ key: `job:${job.id}`, clear: true });
  function put(job, state, why = '') {
    job.state = state;
    job.why = oneLine(why);
    delete job.whyPacer;
    job.updatedAt = d.now();
    if (state === 'done') job.finishedAt = d.now();
  }

  // ----- the owner's use, seen on the activity channel -----
  const acts = new Map(); // scope -> { provider, claimed }
  const ownerLast = {};
  const plenumLast = {};
  let watching = false;
  const claimOf = run => {
    try {
      return Boolean(rtSync?.isRoutineRun?.(run.projectId, run.scope));
    } catch {
      return false;
    }
  };
  function observe(msg) {
    const run = isObject(msg?.run) ? msg.run : null;
    if (!run || typeof run.scope !== 'string') return;
    const now = d.now();
    const p = pacer.providerOf(run.model);
    if (msg.op === 'run-start') {
      acts.set(run.scope, { provider: p, claimed: claimOf(run) });
      if (p) plenumLast[p] = now;
    } else if (msg.op === 'run-step') {
      const a = acts.get(run.scope) ?? { provider: '', claimed: claimOf(run) };
      if (p) a.provider = p;
      acts.set(run.scope, a);
    } else if (msg.op === 'run-end') {
      const a = acts.get(run.scope) ?? { provider: p, claimed: claimOf(run) };
      acts.delete(run.scope);
      const q = a.provider || p;
      if (q) {
        plenumLast[q] = now;
        if (!a.claimed) ownerLast[q] = now;
      }
    }
  }
  // The agents of lib/agent-run.mjs (team workers, Scorecard's checks and tries) are Plenum's use of their plans too, so a reading that
  // rose with them is never "in use outside Plenum". One that a Night shift run handed work to is that job's (it counts toward the
  // night: lib/pacer.mjs stops the run at tonight's cap of the worker's plan, and a worker of a plan counted in runs is one of its runs).
  // A Scorecard check is Plenum's own. Every other one (Try each worker, the owner's own chats and their workers) is the owner's use.
  const agentActs = new Map(); // agent id -> { provider, jobId, owner }
  let watchingAgents = false;
  function observeAgent(msg) {
    const a = isObject(msg?.agent) ? msg.agent : null;
    if (!a || typeof a.id !== 'string') return;
    const now = d.now();
    const p = pacer.providerOf(a.model);
    if (msg.action === 'done') {
      // An agent that never started (stopped while it waited) used nothing.
      const was = agentActs.get(a.id);
      agentActs.delete(a.id);
      const q = was?.provider || '';
      if (q) {
        plenumLast[q] = now;
        if (was.owner) ownerLast[q] = now;
      }
      return;
    }
    if (msg.action !== 'start' || agentActs.has(a.id)) return;
    const scorecard = a.parentLabel === 'Scorecard';
    const jobId = scorecard ? '' : [...live.entries()].find(([id]) => find(id)?.project === a.projectId)?.[0] ?? '';
    agentActs.set(a.id, { provider: p, jobId, owner: !jobId && !(scorecard && a.seat !== 'scorecard-try') });
    if (p) plenumLast[p] = now;
    if (jobId && pacer.COUNTED.includes(p)) {
      const night = nightOf(now);
      night.runs[p] = (night.runs[p] ?? 0) + 1;
      persistQuiet();
    }
  }
  async function ensureWatch() {
    const r = await rt();
    if (r) rtSync = r;
    if (!watchingAgents) {
      const g = await neighbour(d.agents);
      if (typeof g?.onLive === 'function') {
        watchingAgents = true;
        try {
          for (const a of g.liveAll?.() ?? []) observeAgent({ action: 'start', agent: a });
          g.onLive(observeAgent);
        } catch { /* the agents' use is then not known */ }
      }
    }
    if (watching) return;
    const a = await neighbour(d.activity);
    if (typeof a?.subscribe !== 'function') return;
    watching = true;
    try {
      for (const run of a.snapshot?.()?.runs ?? []) observe({ op: 'run-start', run });
      a.subscribe(observe);
    } catch { /* the owner's use is then not known: presence still holds */ }
  }
  function owners() {
    const out = {};
    for (const p of pacer.REPORTING) {
      const live1 = [...acts.values()].some(a => !a.claimed && a.provider === p) || [...agentActs.values()].some(a => a.owner && a.provider === p);
      out[p] = { live: live1, lastEnd: ownerLast[p] ?? 0 };
    }
    return out;
  }
  const workersOf = jobId => [...new Set([...agentActs.values()].filter(a => a.jobId === jobId && a.provider).map(a => a.provider))];
  // A reading that rose by a point or more in the last 30 minutes while no Plenum run of that provider went on.
  const samples = new Map(); // '<provider>|<window>|<resetsAt>' -> [[readAt, used]]
  function outsideOf(subs, now) {
    const out = {};
    for (const row of Array.isArray(subs) ? subs : []) {
      const p = row?.provider;
      if (!pacer.REPORTING.includes(p)) continue;
      for (const w of Array.isArray(row.windows) ? row.windows : []) {
        if (!isObject(w) || !Number.isFinite(w.usedPercent)) continue;
        const at = Number.isFinite(w.readAt) ? w.readAt : Number.isFinite(w.seenAt) ? w.seenAt : null;
        if (at === null) continue;
        const k = pacer.ledgerKey(p, w);
        const list = (samples.get(k) ?? []).filter(s => now - s[0] <= OUTSIDE_MS);
        if (!list.length || list[list.length - 1][0] !== at) list.push([at, w.usedPercent]);
        samples.set(k, list);
        const first = list[0];
        const quiet = !(plenumLast[p] >= first[0]) && ![...acts.values()].some(a => a.provider === p) && ![...agentActs.values()].some(a => a.provider === p);
        if (w.usedPercent - Math.min(...list.map(s => s[1])) >= 1 && quiet) out[p] = true;
      }
    }
    for (const [k, list] of samples) if (!list.some(s => now - s[0] <= OUTSIDE_MS)) samples.delete(k);
    return out;
  }

  // ----- after a restart -----
  async function recover() {
    if (recovered) return;
    load();
    if (isNewer() || (unreadable && !rec)) return;
    recovered = true;
    const cut = load().jobs.filter(j => j.state === 'running' && !isLive(j.id));
    if (!cut.length) return;
    for (const j of cut) {
      const why = 'Plenum closed during this run.';
      const last = j.runs[j.runs.length - 1];
      if (last && last.state === 'running') Object.assign(last, { state: 'interrupted', why });
      if (j.runs.length >= LIMITS.runs) {
        put(j, 'not-finished', why);
        await tell(j, 'not-finished');
      } else put(j, 'waiting', why);
    }
    await persistQuiet();
    changed();
  }

  // ----- the inputs of the pacer -----
  // The plan readings of the last tick. GET /api/night-shift answers from these and never asks the plan watch itself, so the GET reaches
  // no provider and a phone below Full can read the pane (lib/remote/tiers.mjs gives every gated GET Full).
  let lastSubs = [];
  // Plan watch was switched off at the last reading: no reading will come, so the pacer's "can't tell yet" is said as what to do.
  let planOff = false;
  const PLAN_UNKNOWN_RE = /^Plenum can't tell yet how much of (.+) is left\.$/;
  const planLine = line => {
    const m = planOff ? PLAN_UNKNOWN_RE.exec(String(line ?? '')) : null;
    return m ? `Night shift needs Plan watch to know how much of ${m[1]} is left. Switch it on in Settings > Plan watch.` : line;
  };
  async function gather({ ask = false } = {}) {
    const r = load();
    const s = r.settings;
    const now = d.now();
    const jobs = sorted();
    const [jobId, run] = [...live.entries()][0] ?? [];
    const running = run ? { jobId, ref: run.ref, since: run.since, workers: workersOf(jobId) } : null;
    const hoursNow = pacer.inHours(s, now);
    const b = await biz();
    const businesses = {};
    const today = {};
    // gone: id -> the line for the jobs of a business that is closed, or that a sound read says is not there (tick stops those jobs).
    const gone = {};
    for (const id of new Set(jobs.filter(j => j.state === 'waiting' || j.state === 'running').map(j => j.business))) {
      try {
        const one = await b?.byId?.(id);
        if (isObject(one) && one.status !== 'closed') businesses[id] = one;
        else if (isObject(one)) gone[id] = `${oneLine(one.name ?? 'Its business', 80)} is closed.`;
        else if (one === null && typeof b?.byId === 'function' && (typeof b.readable !== 'function' || (await b.readable()) === true)) gone[id] = 'Its business is not there any more.';
      } catch { /* a business that cannot be read waits */ }
      try {
        today[id] = (await b?.today?.(id)) ?? { runs: 0, minutes: 0 };
      } catch {
        today[id] = { runs: Infinity, minutes: Infinity };
      }
    }
    // Only a job of a business that is there and not closed can run: the others neither ask for plan readings nor keep the PC awake.
    const canRun = j => j.state === 'waiting' && j.runs.length < LIMITS.runs && isObject(businesses[j.business]);
    const queued = jobs.filter(canRun);
    const waiting = queued.length;
    const active = queued.filter(j => businesses[j.business].status !== 'paused').length;
    const need = s.on && hoursNow && (active > 0 || Boolean(running));
    let teamLine = null;
    try {
      const t = await team();
      const g = typeof t?.get === 'function' ? await t.get() : null;
      teamLine = Number.isFinite(g?.limits?.skipAbovePercent) ? g.limits.skipAbovePercent : null;
    } catch { teamLine = null; }
    let subs = [];
    if (need && ask) {
      try {
        const pw = await neighbour(d.planWatch);
        const st = await pw?.planState?.();
        subs = Array.isArray(st?.subs) ? st.subs : [];
        planOff = st?.on === false;
      } catch { subs = []; }
      lastSubs = subs;
    } else if (need) subs = lastSubs;
    const rmod = await rt();
    let held = null;
    try { held = rmod?.held?.() ?? null; } catch { held = null; }
    // The jobs of a paused business wait without keeping the PC awake.
    const awake = pacer.awakeOf({ settings: s, now, waiting: active, running });
    if (ask) await askDesk({ awake, need, until: pacer.hoursEnd(s, now), now });
    const presence = Number.isFinite(desk.idleSec) && now - desk.at < 3 * TICK_MS ? desk.idleSec : null;
    const night = isObject(r.nights[pacer.nightKey(s, now)]) ? r.nights[pacer.nightKey(s, now)] : { ledger: {}, runs: {}, out: [] };
    return { now, settings: s, jobs, held, presence, owners: owners(), outside: outsideOf(subs, now), subs, businesses, gone, teamLine, today, night, running, waiting, need, awake, routines: rmod };
  }
  // Keep awake and presence: { on, until } to the desktop, which answers { ok, awake, idleSec }. A 503 means no desktop app.
  async function askDesk({ awake, need, until, now }) {
    if (!awake && !need && desk.sent === false) return;
    const sh = await neighbour(d.shell);
    if (typeof sh?.shellRequest !== 'function') { desk.available = false; desk.idleSec = null; return; }
    try {
      const reply = await sh.shellRequest('night-shift-awake', { on: awake, until }, { timeoutMs: SHELL_WAIT_MS });
      desk.available = true;
      desk.sent = awake;
      desk.awake = reply?.awake === true;
      desk.idleSec = Number.isFinite(reply?.idleSec) ? reply.idleSec : null;
      desk.at = now;
    } catch (err) {
      if (err?.status === 503) desk.available = false;
      // No desktop app (plain Node) stays so: it is not asked again for "may sleep".
      desk.sent = err?.status === 503 ? false : null;
      desk.idleSec = null;
      desk.awake = null;
    }
  }
  // While jobs wait inside the hours Stop all starts the 30-minute hold for Night shift too (routines.expect).
  async function syncExpect() {
    try {
      const s = load().settings;
      const need = s.on && pacer.inHours(s, d.now()) && (live.size > 0 || load().jobs.some(j => j.state === 'waiting' && j.runs.length < LIMITS.runs));
      (await rt())?.expect?.('night-shift', Boolean(need));
    } catch { /* a hint only */ }
  }
  function expectFor(ctx, rmod) {
    try { rmod?.expect?.('night-shift', Boolean(ctx.need)); } catch { /* a hint only */ }
  }

  // ----- a PC that slept through the hours -----
  // The timer does not run while the PC sleeps, and nothing here wakes it (keep-awake holds only inside the hours). When the first tick
  // after a gap finds that the hours went by while jobs waited, the owner is told once: a line in the pane and an fyi notice (in the
  // morning summary when it comes in quiet hours).
  let lastTickAt = 0;
  let slept = null; // { from, to, at }
  function noteGap(now) {
    const prev = lastTickAt;
    lastTickAt = now;
    if (!prev || now - prev < GAP_MS) return;
    const r = load();
    const s = r.settings;
    const waiting = r.jobs.filter(j => j.state === 'waiting' && j.runs.length < LIMITS.runs).length;
    if (!s.on || !waiting) return;
    const step = Math.max(60_000, Math.ceil((now - prev) / 20_000));
    let missed = 0;
    let from = 0;
    let to = 0;
    for (let t = prev + step; t < now; t += step) {
      if (!pacer.inHours(s, t)) continue;
      missed += step;
      if (!from) from = t;
      to = t;
    }
    if (missed < GAP_MS) return;
    slept = { from, to: Math.min(now, to + step), at: now };
    const line = sleptLine(slept, waiting);
    notice({ key: `nightshift:asleep:${pacer.nightKey(s, from)}`, level: 'fyi', route: 'night-shift', title: 'Night shift did not run', text: line });
    changed();
  }
  const sleptLine = (g, waiting) => `This PC was asleep from ${pacer.clockOf(g.from)} to ${pacer.clockOf(g.to)}, so Night shift did not run. ${waiting === 1 ? '1 job waits' : `${waiting} jobs wait`}.`;

  // ----- Auto routing (ar3) -----
  let autoCtx = null;
  async function routeLeads(q) {
    try {
      if (d.autoRoute) return (await d.autoRoute(q)) ?? null;
      if (!autoCtx) {
        const mod = await import(moduleUrl('lib/auto-context.mjs', CODE_ROOT));
        const [t, pw] = [await team(), await neighbour(d.planWatch)];
        autoCtx = mod.createAutoContext({ team: t, scorecard: null, planState: typeof pw?.planState === 'function' ? () => pw.planState() : null });
      }
      return (await autoCtx.forLeads(q)) ?? null;
    } catch {
      return null;
    }
  }
  // Whether Auto picks the lead of this job: no pinned lead, and its business has the switch on.
  const autoFor = (job, b) => !job.lead && isObject(b) && b.autoLeads === true && Array.isArray(b.leads) && b.leads.length > 0;
  // The runs of a job that did not finish (a stop of the pacer's or the owner's is not a try that failed).
  const failsOf = job => job.runs.filter(r => r.state !== 'running' && r.finished !== true && r.pacerStop !== true && r.state !== 'stopped').length;
  const askOf = (job, b, ctx, more) => ({
    business: b, text: job.text, doneWhen: job.doneWhen, failures: failsOf(job), source: 'night',
    minutesLeft: Math.max(0, Math.round((pacer.hoursEnd(ctx.settings, ctx.now) - ctx.now) / 60_000)),
    ...(['low', 'medium', 'high'].includes(b.leadEffort) ? { pins: { effort: b.leadEffort, effortBy: 'owner' } } : {}),
    ...more,
  });
  async function rankLeads(job, business, ctx) {
    const res = await routeLeads(askOf(job, business, ctx, { refs: business.leads }));
    const ranked = !res?.stepBack && Array.isArray(res?.alternatives)
      ? res.alternatives.map(a => a?.ref).filter(ref => business.leads.includes(ref)) : [];
    return [...new Set([...ranked, ...business.leads])];
  }

  // ----- the tick -----
  async function tick() {
    if (sched.ticking) return;
    sched.ticking = true;
    try {
      if (!(await d.termsOk())) return;
      load();
      if ((unreadable && !rec) || isNewer()) return;
      noteGap(d.now());
      await ensureWatch();
      await recover();
      // Nothing waits and nothing runs: the desktop is told once that it may sleep, and nothing else is read.
      if (!live.size && !load().jobs.some(j => j.state === 'waiting' && j.runs.length < LIMITS.runs)) {
        probePage = null;
        const s = load().settings;
        await askDesk({ awake: false, need: false, until: pacer.hoursEnd(s, d.now()), now: d.now() });
        await syncExpect();
        return;
      }
      const ctx = await gather({ ask: true });
      expectFor(ctx, ctx.routines);
      if (await stopGone(ctx)) { probePage = null; return; }
      const nightKey = pacer.nightKey(ctx.settings, ctx.now);
      const revisions = new Map(ctx.jobs.map(job => [job.id, probeRevision(job)]));
      const visited = new Map();
      if (probePage?.nightKey === nightKey) {
        for (const [key, entry] of probePage.visited) {
          if (revisions.get(entry.id) === entry.revision) visited.set(key, entry);
        }
      }
      probePage = null;
      const exclude = new Map([...visited].map(([key, entry]) => [key, entry.why]));
      const leadOrders = new Map();
      const paced = { ...ctx, exclude, leadOrders };
      let started = false;
      for (let i = 0; i < PROBES_PER_TICK; i += 1) {
        let out = pacer.decide(paced);
        // Auto only changes the lead order within one job. Let the pacer find a job that can start
        // before ranking its leads. A blocked tick need not consult Auto for any job.
        const job = out.start?.job;
        const business = ctx.businesses[job?.business];
        if (job && !leadOrders.has(job.id) && autoFor(job, business)) {
          leadOrders.set(job.id, await rankLeads(job, business, ctx));
          out = pacer.decide(paced);
        }
        keepLedger(ctx.now, out.ledger);
        if (out.stop) { await pacerStop(out.stop); break; }
        if (!out.start) break;
        const res = await startJob(out.start, ctx);
        if (res?.started) started = true;
        if (!res?.next) break;
        const id = out.start.job.id;
        const key = `${id}|${res.job ? '*' : out.start.ref}`;
        exclude.set(key, res.why);
        visited.set(key, { id, revision: revisions.get(id), why: res.why });
        // A full page continues next tick. A start, global hold, or end of the queue clears the page.
        if (i === PROBES_PER_TICK - 1) probePage = { nightKey, visited };
      }
      if (!started && !live.size) await keepReasons(paced);
    } finally {
      sched.ticking = false;
    }
  }
  // The waiting jobs of a business that was closed (or that is not there any more) can never run: they are stopped with a line that
  // says why, so they no longer keep the PC awake every night. Continue starts one again if the business is open again. Answers whether
  // a job was stopped (the tick then ends; the next one reads again).
  async function stopGone(ctx) {
    let n = 0;
    for (const j of load().jobs) {
      if (j.state !== 'waiting' || !Object.hasOwn(ctx.gone ?? {}, j.business)) continue;
      put(j, 'stopped', ctx.gone[j.business]);
      n += 1;
    }
    if (!n) return false;
    await persistQuiet();
    changed();
    await syncExpect();
    return true;
  }
  // Inside the hours, when nothing started: each waiting job keeps the reason it did not run (the pacer's line for that job alone), so
  // the list says in the morning why a job never ran. Written only when it changed, and never over a line its last run or a restart left
  // ("Plenum closed during this run.", "Stopped at 07:00, ..."): only an empty why or an earlier reason of the pacer's is replaced.
  const REASON_CODES = new Set(['here', 'using', 'noroom', 'paused', 'day', 'wait', 'hold']);
  async function keepReasons(paced) {
    if (!pacer.inHours(paced.settings, paced.now) || !paced.settings.on) return;
    let n = 0;
    for (const pj of paced.jobs) {
      const j = find(pj.id);
      if (!j || j.state !== 'waiting' || j.runs.length >= LIMITS.runs || (j.why && j.whyPacer !== true)) continue;
      let out = null;
      try {
        out = pacer.decide({ ...paced, jobs: [pj], night: copy(paced.night) });
      } catch { out = null; }
      const line = oneLine(planLine(out?.line ?? ''));
      if (!out || !REASON_CODES.has(out.code) || !line || j.why === line) continue;
      j.why = line;
      j.whyPacer = true;
      n += 1;
    }
    if (!n) return;
    await persistQuiet();
    changed();
  }
  function keepLedger(now, ledger) {
    if (!isObject(ledger)) return;
    const n = nightOf(now);
    if (JSON.stringify(n.ledger) === JSON.stringify(ledger)) return;
    n.ledger = ledger;
    persistQuiet();
  }
  async function pacerStop(stop) {
    const id = stop.jobId ?? stop.job?.id;
    if (!id || !live.has(id) || flags.has(id)) return;
    flags.set(id, { why: stop.why });
    const r = await rt();
    try {
      // routines.stop(key, why) words the business record line and the run's notice with the pacer's sentence (wave 7); the job's own
      // line has it through the flag.
      await r?.stop?.(keyOf(id), stop.why);
    } catch { /* it ended by itself: its end finds the flag */ }
  }

  async function startJob({ job: picked, ref, note }, ctx) {
    const job = find(picked.id);
    const r = ctx.routines;
    if (!job || job.state !== 'waiting' || typeof r?.step !== 'function') return null;
    const b = ctx.businesses[job.business];
    const bizName = oneLine(b?.name ?? job.business, 80);
    const n = job.runs.length + 1;
    // Auto (ar3): the lead the pacer took, routed as the only candidate, for its effort and its line.
    let auto = '';
    let effort = '';
    if (autoFor(job, b)) {
      const routed = await routeLeads(askOf(job, b, ctx, { refs: [ref], pins: { ref, ...(['low', 'medium', 'high'].includes(b.leadEffort) ? { effort: b.leadEffort, effortBy: 'owner' } : {}) } }));
      if (routed?.ref === ref && typeof routed.why === 'string') {
        auto = oneLine(routed.why, 160);
        effort = ['low', 'medium', 'high', 'xhigh'].includes(routed.effort) ? routed.effort : '';
      }
    }
    const now = d.now();
    // Routing can wait on plan data. Recheck the live switch, hours and queue entry before starting.
    const settings = load().settings;
    if (!settings.on || !pacer.inHours(settings, now) || find(job.id)?.state !== 'waiting') return null;
    starting.add(job.id);
    let res;
    try {
      res = await r.step({
        key: keyOf(job.id), business: job.business, project: job.project, thread: THREAD_NAME, name: job.name, leads: [ref], manual: false,
        message: ({ at }) => messageOf({ job, business: bizName, n, at: Number.isFinite(at) ? at : d.now() }),
        onEnd: end => ended(job.id, end),
        // A run cut short because today's minutes of the business ran out ends as a stop (stopped 'budget'), handled in ended().
        budgetStop: true,
        // The record line names the job, so its NEXT line is not offered back as a new job (lib/job-suggestions.mjs).
        job: job.id,
        ...(effort ? { effort } : {}),
        ...(auto ? { auto } : {}),
      });
    } catch (err) {
      res = { outcome: 'failed', code: 'failed', why: oneLine(err?.message ?? 'The job could not be started.') };
    }
    starting.delete(job.id);
    const wanted = stopWanted.delete(job.id);
    const came = early.get(job.id);
    early.delete(job.id);
    const j = find(job.id);
    if (!j) return null;
    const why = oneLine(res?.why ?? '');
    if (wanted && res?.outcome !== 'started') {
      // The owner pressed Stop while it was being started: it does not start, in this tick or any other, until Continue tonight.
      put(j, 'stopped', 'Stopped by you.');
      await persistQuiet();
      changed();
      await syncExpect();
      return { started: false };
    }
    if (res?.outcome === 'started') {
      stepWhy = null;
      slept = null;
      j.fails = 0;
      j.runs.push({ at: now, ms: 0, lead: ref, state: 'running', why: '', done: '', next: '', owner: '', finished: false, ...(note ? { note: oneLine(note) } : {}), ...(auto ? { auto } : {}) });
      if (j.runs.length > LIMITS.runs) j.runs.splice(0, j.runs.length - LIMITS.runs);
      put(j, 'running');
      const p = pacer.providerOf(ref);
      const night = nightOf(now);
      if (p) night.runs[p] = (night.runs[p] ?? 0) + 1;
      live.set(j.id, { key: keyOf(j.id), ref, since: now });
      await persistQuiet();
      changed();
      if (came) await ended(j.id, came);
      else if (wanted) {
        // Stop came while it was being started and the run began anyway: it is stopped now that routines has it.
        try { await r.stop?.(keyOf(j.id)); } catch { /* it ended by itself */ }
      }
      return { started: true };
    }
    if (res?.outcome === 'wait' && res.code === 'lead') return { next: true, why };
    // A wait of this job's own (its business paused, another run of its folder, its thread busy, today's limit of its business): the
    // next job is tried in the same tick, so one job never holds up the whole list. The hold after a Stop holds every job.
    if (res?.outcome === 'wait' && res.code !== 'hold') {
      stepWhy = { why: why || 'Night shift waits.', at: now };
      changed();
      return { next: true, job: true, why: why || 'Night shift waits.' };
    }
    if (res?.outcome === 'wait') {
      stepWhy = { why: why || 'Night shift waits.', at: now };
      changed();
      return { started: false };
    }
    if (res?.outcome === 'refused') {
      put(j, 'stopped', res.code === 'stopped' || came?.stopped === 'user' ? 'Stopped by you.' : why || 'Plenum could not start this job.');
      await persistQuiet();
      changed();
      return { started: false };
    }
    // failed: not counted as a run; tried again next tick; after 3 in a row the job needs the owner.
    j.fails += 1;
    if (j.fails >= LIMITS.fails) {
      put(j, 'needs-you', `It could not start ${LIMITS.fails} times: ${why || 'the run did not start.'}`);
      await tell(j, 'no-start');
    } else {
      j.why = oneLine(`It could not start: ${why || 'the run did not start.'} Plenum tries again in a minute.`);
      j.updatedAt = d.now();
    }
    await persistQuiet();
    changed();
    return { started: false };
  }

  // A run of a job ended (lib/routines.mjs calls this once the run's line is written).
  async function ended(id, end) {
    if (starting.has(id)) {
      early.set(id, end);
      return;
    }
    const flight = (async () => {
      const job = find(id);
      live.delete(id);
      const flag = flags.get(id);
      flags.delete(id);
      if (!job || job.state !== 'running') return;
      const text = String(end?.text ?? '');
      const finished = finishedOf(text);
      const owner = ownerOf(text);
      const run = job.runs[job.runs.length - 1];
      if (run) {
        Object.assign(run, {
          ms: Number.isFinite(end?.ms) ? Math.round(end.ms) : Math.max(0, d.now() - run.at),
          state: oneLine(end?.state, 20),
          why: oneLine(flag ? flag.why : end?.why),
          done: oneLine(end?.done),
          next: oneLine(end?.next),
          owner,
          finished,
          ...(flag ? { pacerStop: true } : {}),
        });
      }
      const p = pacer.providerOf(run?.lead ?? end?.lead);
      if (end?.state === 'failed' && p && !pacer.REPORTING.includes(p)) {
        let limit = false;
        try {
          const t = await team();
          limit = (t?.LIMIT_RE instanceof RegExp ? t.LIMIT_RE : LIMIT_WORDS).test(String(end?.why ?? ''));
        } catch { limit = LIMIT_WORDS.test(String(end?.why ?? '')); }
        const night = nightOf(d.now());
        if (limit && !night.out.includes(p)) night.out.push(p);
      }
      const full = job.runs.length >= LIMITS.runs;
      if (flag) {
        // 1. The pacer stopped it (the edge of tonight's share, the end of the hours, switched off): it waits, unless it has had its 3
        //    runs. Then the pacer's "It goes on …" would not be true: the line says what happened and what he can do.
        if (full) { put(job, 'not-finished', PAUSED_OUT); await tell(job, 'paused-out'); } else put(job, 'waiting', flag.why);
      } else if (end?.state === 'stopped' && ['line', 'paused', 'pacer'].includes(end?.stopped)) {
        // 1b. Plenum stopped it, not the owner: its lead reached his plan line, or its business was paused. It waits as after the
        //     pacer's stop (a paused business's jobs wait until it is resumed), unless it has had its 3 runs.
        if (full) { put(job, 'not-finished', oneLine(end?.why)); await tell(job, 'not-finished'); } else put(job, 'waiting', oneLine(end?.why));
      } else if (end?.state === 'stopped' && end?.stopped === 'user') {
        // 2. Stopped by the owner (his Stop, Stop all): never tried again by itself.
        put(job, 'stopped', 'Stopped by you.');
      } else if (end?.stopped === 'budget') {
        // 3. Today's minutes of the business ran out.
        if (full) { put(job, 'not-finished', oneLine(end?.why)); await tell(job, 'not-finished'); } else put(job, 'waiting', oneLine(end?.why));
      } else if (owner || (Number(end?.unanswered) || 0) > 0) {
        // 4. Something only the owner can decide, or a card that waited for him in vain.
        put(job, 'needs-you', owner ? `It needs your answer: ${owner}` : 'A question for you timed out. It\'s in the Jobs thread.');
        await tell(job, 'needs-you');
      } else if (finished) {
        // 5. Done.
        put(job, 'done', '');
        await tell(job, 'done');
      } else if (full) {
        put(job, 'not-finished', `It ran ${LIMITS.runs} times and is not done.`);
        await tell(job, 'not-finished');
      } else {
        put(job, 'waiting', end?.state === 'failed' ? oneLine(end?.why) : 'Not finished yet. It goes on with its next run.');
      }
      pruneDone(load().jobs);
      await persistQuiet();
      changed();
      await syncExpect();
    })();
    flights.add(flight);
    try { await flight; } finally { flights.delete(flight); }
  }

  // ----- the timer -----
  const timerOff = () => d.env.PLENUM_NO_SCHEDULER === '1' || d.env.PLENUM_SMOKE === '1';
  function arm() {
    if (!sched.started || sched.off || sched.timer) return;
    sched.timer = d.setTimer(() => {
      sched.timer = null;
      tick().catch(() => {}).finally(() => arm());
    }, TICK_MS);
  }
  function start() {
    if (sched.started) return { on: !sched.off };
    sched.started = true;
    if (timerOff()) {
      sched.off = true;
      return { on: false };
    }
    ensureWatch().catch(() => {});
    arm();
    return { on: true };
  }
  function shutdown() {
    if (sched.timer) d.clearTimer(sched.timer);
    sched.timer = null;
    sched.started = false;
  }
  const idle = async () => {
    while (flights.size) await Promise.allSettled([...flights]);
    await writing;
  };

  // ----- what GET /api/night-shift answers -----
  // "Ran on Codex at 01:12 (run 2 of 3)." or, when a lead was passed over, "Ran on Codex: Claude had no room to spare." (the plan's name,
  // as the status lines say it).
  // With Auto the line goes on with its own sentence: "Ran on Codex at 01:12 (run 2 of 3). Auto: Codex, medium effort: ...".
  function lastLine(job) {
    const r = job.runs[job.runs.length - 1];
    if (!r || !r.lead) return '';
    const who = pacer.labelOfProvider(pacer.providerOf(r.lead));
    const tail = r.auto ? ` ${r.auto}` : '';
    if (r.note) return `Ran on ${who}: ${r.note}${tail}`;
    return `Ran on ${who} at ${pacer.clockOf(r.at)} (run ${job.runs.length} of ${LIMITS.runs}).${tail}`;
  }
  async function describe() {
    const r = load();
    const terms = (await d.termsOk()) === true;
    if (terms) await recover();
    const ctx = await gather({ ask: false });
    const t = await team();
    const labelOf = ref => {
      try {
        const own = t?.labelOf?.(ref);
        if (typeof own === 'string' && own && own !== ref) return own;
      } catch { /* the provider's name below */ }
      return pacer.labelOfProvider(pacer.providerOf(ref));
    };
    const s = r.settings;
    const now = ctx.now;
    const out = pacer.decide({ ...ctx, night: copy(ctx.night), exclude: new Map() });
    let status = { code: out.code, line: planLine(out.line) };
    if (out.code === 'start') {
      status = sched.off
        ? { code: 'scheduler', line: 'Nothing starts by itself in this start of Plenum.' }
        : stepWhy && now - stepWhy.at < STEP_WHY_MS ? { code: 'wait', line: stepWhy.why } : { code: 'tonight', line: `Working tonight until ${s.to}. ${ctx.waiting === 1 ? '1 job' : `${ctx.waiting} jobs`} waiting.` };
    }
    if (!terms) status = { code: 'terms', line: 'Night shift waits until the License Agreement is accepted.' };
    if (unreadable && !rec) status = { code: 'unreadable', line: unreadableSentence() };
    else if (isNewer()) status = { code: 'newer', line: NEWER };
    if (out.code === 'hold') status.note = 'Resume lets routines and Night shift start again.';
    let available = desk.available;
    if (available === null) {
      try { const sh = await neighbour(d.shell); available = typeof sh?.shellAvailable === 'function' ? sh.shellAvailable() !== false : null; } catch { available = null; }
    }
    const awakeOn = out.awake && available !== false && desk.awake !== false;
    const awake = {
      on: awakeOn,
      line: available === false ? 'Keeping the PC awake works in the desktop app.'
        : awakeOn ? `Keeping this PC awake until ${s.to} while jobs wait.`
          : 'This PC may sleep. Jobs wait until it is awake during the hours.',
    };
    const [jobId, run] = [...live.entries()][0] ?? [];
    const businesses = [];
    try {
      const b = await biz();
      for (const one of (await b?.list?.()) ?? []) {
        if (!isObject(one) || one.status === 'closed') continue;
        businesses.push({
          id: one.id,
          name: one.name,
          projects: (Array.isArray(one.projects) ? one.projects : []).map(id => {
            let f = { canWrite: false, approvals: 'ask' };
            try { f = { ...f, ...(d.threadFacts(id) ?? {}) }; } catch { /* the safe side */ }
            let name = id;
            try { name = d.projectById(id)?.name ?? id; } catch { name = id; }
            return { id, name, canWrite: f.canWrite === true, approvals: f.approvals === 'auto' || f.approvals === 'all' ? f.approvals : 'ask' };
          }),
          leads: (Array.isArray(one.leads) ? one.leads : []).map(ref => ({ ref, label: labelOf(ref) })),
          // Auto picks the lead of a job with no pinned lead (ar3): the pane words its "First with room" option so.
          ...(one.autoLeads === true ? { autoLeads: true } : {}),
        });
      }
    } catch { /* the jobs are still shown */ }
    const hours = { from: s.from, to: s.to, inHours: pacer.inHours(s, now), startsAt: pacer.hoursStart(s, now), endsAt: pacer.hoursEnd(s, now) };
    return {
      v: r.v,
      settings: copy({ on: s.on, from: s.from, to: s.to, share: s.share, keepAwake: s.keepAwake, countRuns: s.countRuns }),
      hours,
      status,
      awake,
      running: run ? { jobId, lead: run.ref, since: run.since } : null,
      jobs: ctx.jobs.map(j => ({ ...copy(j), pill: PILLS[j.state] ?? 'Waiting', line: lastLine(j), canContinue: (j.state === 'needs-you' || j.state === 'stopped') && j.runs.length < LIMITS.runs })),
      businesses,
      empty: EMPTY,
      ...(isNewer() ? { newer: NEWER } : {}),
      ...(damaged ? { damaged: true } : {}),
      // The PC slept through the hours while jobs waited (shown for 12 hours, or until a job starts).
      ...(slept && now - slept.at < 12 * 3_600_000 ? { slept: { from: slept.from, to: slept.to, line: sleptLine(slept, ctx.waiting) } } : {}),
    };
  }

  // Whether Night shift is at work now: on, inside its hours, with a job waiting or running. Synchronous, from memory and the file.
  function working() {
    try {
      const r = load();
      const s = r.settings;
      if (!s.on || !pacer.inHours(s, d.now())) return false;
      return live.size > 0 || starting.size > 0 || r.jobs.some(j => j.state === 'waiting' && j.runs.length < LIMITS.runs);
    } catch {
      return false;
    }
  }

  // The current window for native computer use. Reading it here shares the PC's Night shift preferences without touching its keep-awake lease.
  function computerWindow() {
    const record = load();
    const now = d.now();
    if (isNewer() || unreadable || !record.settings.on || !pacer.inHours(record.settings, now)) return null;
    return pacer.hoursEnd(record.settings, now);
  }

  // ----- the owner's changes -----
  const textOf = (v, max, sentence, tooLong) => {
    if (typeof v !== 'string' || !v.trim()) throw fail(400, sentence);
    if (v.length > max) throw fail(400, tooLong);
    return v;
  };
  const doneWhenOf = v => {
    if (v === undefined || v === null || v === '') return '';
    if (typeof v !== 'string') throw fail(400, 'Say when it is done in words.');
    if (v.length > LIMITS.doneWhen) throw fail(400, `"Done when" is at most ${LIMITS.doneWhen} characters.`);
    return v;
  };
  const leadOf = (v, business) => {
    if (v === undefined || v === null || v === '') return '';
    if (typeof v !== 'string' || !(Array.isArray(business?.leads) && business.leads.includes(v))) throw fail(400, 'Pick one of the business\'s leads, or First with room.');
    return v;
  };
  async function businessOf(id) {
    if (typeof id !== 'string' || !id) throw fail(400, 'Say which business the job is for.');
    const b = await biz();
    if (!b) throw fail(400, 'Night shift needs the businesses, and that part of Plenum is not in this build.');
    const one = await b.byId?.(id);
    if (!isObject(one)) throw fail(400, 'That business is not there any more.');
    if (one.status === 'closed') throw fail(400, `${one.name ?? 'That business'} is closed.`);
    return one;
  }
  const jobOf = input => {
    if (!isObject(input)) throw fail(400, 'Send an object that names the job.');
    const j = find(input.id);
    if (!j) throw fail(400, 'That job is not on the list any more.');
    return j;
  };
  const notRunning = j => { if (isLive(j.id) || j.state === 'running') throw fail(409, 'This job is running. Stop it first.'); };
  async function change(fn) {
    guardWritable();
    const was = copy(load());
    const out = await fn();
    await saveOrUndo(was);
    changed();
    await syncExpect();
    return out;
  }

  // What the pane says once a job is added: nothing wakes a sleeping PC, so outside the hours he is told it must be awake when they start.
  function addNote(now) {
    const s = load().settings;
    if (!s.on) return 'Night shift is off. The job runs once you switch it on.';
    if (pacer.inHours(s, now)) return 'Night shift is working now. The job starts when there is room.';
    return `It waits for the hours. This PC must be awake at ${s.from}${s.keepAwake ? '; from then Plenum keeps it awake' : ''}.`;
  }
  function add(input) {
    return change(async () => {
      if (!isObject(input)) throw fail(400, 'Send an object with the job.');
      const b = await businessOf(input.business);
      const projects = Array.isArray(b.projects) ? b.projects : [];
      const project = input.project === undefined || input.project === null || input.project === '' ? projects[0] : input.project;
      if (typeof project !== 'string' || !project || !projects.includes(project)) throw fail(400, 'That folder does not belong to this business.');
      const text = textOf(input.text, LIMITS.text, 'Say what should be done.', `A job is at most ${LIMITS.text.toLocaleString('en-US')} characters.`);
      const doneWhen = doneWhenOf(input.doneWhen);
      const lead = leadOf(input.lead, b);
      if (input.source !== undefined && input.source !== 'owner' && input.source !== 'suggested') throw fail(400, 'A job is the owner\'s own or a suggestion he took.');
      if (load().jobs.filter(j => j.state !== 'done').length >= LIMITS.open) throw fail(400, `Night shift holds at most ${LIMITS.open} jobs that are not done. Remove one first.`);
      let id;
      do id = `j_${randomBytes(4).toString('hex')}`; while (find(id));
      const now = d.now();
      const order = load().jobs.reduce((m, j) => Math.max(m, j.order), 0) + 1;
      const job = { id, business: b.id ?? input.business, project, name: nameOf(text) || 'Job', text, doneWhen, lead, source: input.source === 'suggested' ? 'suggested' : 'owner', order, addedAt: now, updatedAt: now, finishedAt: 0, state: 'waiting', why: '', fails: 0, runs: [] };
      load().jobs.push(job);
      pruneDone(load().jobs);
      return { job: copy(job), note: addNote(now) };
    });
  }
  function update(input) {
    return change(async () => {
      const j = jobOf(input);
      notRunning(j);
      // Every field is checked before anything changes.
      const text = input.text !== undefined ? textOf(input.text, LIMITS.text, 'Say what should be done.', `A job is at most ${LIMITS.text.toLocaleString('en-US')} characters.`) : j.text;
      const doneWhen = input.doneWhen !== undefined ? doneWhenOf(input.doneWhen) : j.doneWhen;
      const lead = input.lead !== undefined ? leadOf(input.lead, await businessOf(j.business)) : j.lead;
      notRunning(j);
      Object.assign(j, { text, name: nameOf(text) || 'Job', doneWhen, lead, updatedAt: d.now() });
      return { job: copy(j) };
    });
  }
  function move(input) {
    return change(async () => {
      const j = jobOf(input);
      const list = sorted();
      const at = list.indexOf(j);
      let to = input.to;
      if (to === 'up') to = at - 1;
      else if (to === 'down') to = at + 1;
      else if (to === 'top') to = 0;
      else if (to === 'bottom') to = list.length - 1;
      if (!Number.isInteger(to)) throw fail(400, 'Say where the job goes: up, down, or a place in the list.');
      to = Math.max(0, Math.min(list.length - 1, to));
      list.splice(at, 1);
      list.splice(to, 0, j);
      list.forEach((x, i) => { x.order = i + 1; });
      return { ok: true, jobs: sorted().map(x => x.id) };
    });
  }
  function remove(input) {
    return change(async () => {
      const j = jobOf(input);
      if (isLive(j.id) || j.state === 'running') throw fail(409, 'Stop it first.');
      load().jobs.splice(load().jobs.indexOf(j), 1);
      clearNotice(j);
      return { ok: true };
    });
  }
  function cont(input) {
    return change(async () => {
      const j = jobOf(input);
      notRunning(j);
      if (j.state !== 'needs-you' && j.state !== 'stopped') throw fail(400, 'Continue tonight is for a job that needs you or was stopped.');
      if (j.runs.length >= LIMITS.runs) throw fail(400, `This job has had its ${LIMITS.runs} runs. Add it again as a new job to go on.`);
      put(j, 'waiting', '');
      j.fails = 0;
      clearNotice(j);
      return { job: copy(j) };
    });
  }
  function done(input) {
    return change(async () => {
      const j = jobOf(input);
      notRunning(j);
      put(j, 'done', 'Marked done by you.');
      clearNotice(j);
      return { job: copy(j) };
    });
  }
  // Stop always answers. A run that goes on (or is being started) is stopped through routines.stop(key), never through
  // /api/routines/stop, which sends every s: key to the setup first. A waiting job is stopped where it stands.
  async function stop(input) {
    if (!isObject(input) || typeof input.id !== 'string') throw fail(400, 'Send an object that names the job.');
    load();
    const j = find(input.id);
    if (!j) throw fail(400, 'That job is not on the list any more.');
    if (isLive(j.id)) {
      const beingStarted = starting.has(j.id) && !live.has(j.id);
      if (beingStarted) stopWanted.add(j.id);
      const notYet = 'The job had not started yet. It will not start.';
      const r = await rt();
      try {
        const res = await r?.stop?.(keyOf(j.id));
        return { ok: true, happened: oneLine(res?.happened ?? (beingStarted ? notYet : 'The run was asked to stop.')) };
      } catch (err) {
        return { ok: true, happened: beingStarted ? notYet : oneLine(err?.message ?? 'The run is ending.') };
      }
    }
    if (j.state === 'waiting' || j.state === 'running') {
      guardWritable();
      const was = copy(load());
      put(j, 'stopped', 'Stopped by you.');
      await saveOrUndo(was);
      changed();
      return { ok: true, happened: 'It will not run until you press Continue tonight.' };
    }
    return { ok: true, happened: 'This job was not running.' };
  }
  async function setSettings(input) {
    const out = await change(async () => {
      if (!isObject(input)) throw fail(400, 'Send the settings as an object.');
      const s = copy(load().settings);
      for (const k of ['on', 'keepAwake']) {
        if (input[k] === undefined) continue;
        if (typeof input[k] !== 'boolean') throw fail(400, 'Send true or false to switch it on or off.');
        s[k] = input[k];
      }
      for (const k of ['from', 'to']) {
        if (input[k] === undefined) continue;
        if (typeof input[k] !== 'string' || !TIME_RE.test(input[k])) throw fail(400, 'Send a time as HH:MM, for example 23:00.');
        s[k] = input[k];
      }
      if (s.from === s.to) throw fail(400, 'The hours must start and end at different times.');
      if (input.share !== undefined) {
        if (!Number.isInteger(input.share) || input.share < 10 || input.share > 50) throw fail(400, 'Use between 10 and 50 percent of what would go unused.');
        s.share = input.share;
      }
      if (input.countRuns !== undefined) {
        if (!isObject(input.countRuns)) throw fail(400, 'Send the runs a night as an object.');
        for (const [p, v] of Object.entries(input.countRuns)) {
          if (!pacer.COUNTED.includes(p)) throw fail(400, 'Runs a night are set for Gemini, Antigravity, Cursor and Grok.');
          if (!Number.isInteger(v) || v < 0 || v > LIMITS.countRuns) throw fail(400, `Runs a night is a whole number from 0 to ${LIMITS.countRuns}.`);
          s.countRuns[p] = v;
        }
      }
      load().settings = s;
      return { settings: copy(s) };
    });
    // Switched off while a job runs: that run is stopped now (the next tick would stop it too) and the job waits for Night shift to be on.
    if (!out.settings.on) for (const id of [...live.keys()]) await pacerStop({ jobId: id, why: pacer.OFF_STOP });
    return out;
  }
  async function resume() {
    const r = await rt();
    if (typeof r?.resume !== 'function') throw fail(409, 'Routines are not part of this Plenum, so there is nothing to resume.');
    const out = r.resume();
    changed();
    return { ok: true, was: out?.was === true };
  }

  return { describe, add, update, move, remove, cont, done, stop, setSettings, resume, start, shutdown, tick, idle, observe, observeAgent, working, computerWindow, file, migrate, load: () => copy(load()) };
}

// ---------- the default instance ----------

const lazy = rel => {
  let p = null;
  return () => (p ??= import(moduleUrl(rel, CODE_ROOT)).then(m => m, () => null));
};
const legal = lazy('lib/legal.mjs');
const events = lazy('lib/events.mjs');

function defaultThreadFacts(projectId) {
  const st = store.get();
  const project = st?.projects?.find(p => p.id === projectId);
  if (!project) return { canWrite: false, approvals: 'ask' };
  const record = threadsOf(st, project);
  const thread = openThreads(record).find(t => typeof t.name === 'string' && t.name.trim().toLowerCase() === THREAD_NAME.toLowerCase()) ?? null;
  return { canWrite: thread ? canWrite(record, thread.id) : record.multiWriter === true, approvals: approvalModeOf(st, project) };
}

let instance = null;
const ns = () => (instance ??= createNightShift({
  routines: lazy('lib/routines.mjs'),
  business: lazy('lib/business.mjs'),
  team: lazy('lib/team.mjs'),
  planWatch: lazy('lib/plan-watch.mjs'),
  activity: lazy('lib/activity.mjs'),
  agents: lazy('lib/agent-run.mjs'),
  shell: lazy('lib/shell.mjs'),
  termsOk: async () => (await legal())?.termsAccepted?.(store.get()) === true,
  publish: ev => { events().then(m => m?.publish?.(ev)).catch(() => {}); },
  threadFacts: defaultThreadFacts,
  projectById: id => store.get()?.projects?.find(p => p.id === id) ?? null,
}));

export const describe = () => ns().describe();
export const add = input => ns().add(input);
export const update = input => ns().update(input);
export const move = input => ns().move(input);
export const remove = input => ns().remove(input);
export const cont = input => ns().cont(input);
export const done = input => ns().done(input);
export const stop = input => ns().stop(input);
export const setSettings = input => ns().setSettings(input);
export const resume = () => ns().resume();
export const start = () => ns().start();
export const tick = () => ns().tick();
export const idle = () => ns().idle();
export const working = () => ns().working();
export const computerWindow = () => ns().computerWindow();
