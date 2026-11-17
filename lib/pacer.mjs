// Night shift's pacer (wave 6, ns1; work/wave6/NIGHTSHIFT-BRIEF.md "The pacer's rule, exactly"). Pure functions only: no file, no
// timer, no import of the app. lib/jobs.mjs gathers the inputs on every tick and does what decide() answers.
//
//   inHours(settings, ms)        whether the night hours hold at ms (local time; the same wrap rule as notify.inQuietHours; from equal
//                                to to is no hours at all, and lib/jobs.mjs refuses it when the owner saves)
//   nightKey(settings, ms)       'YYYY-MM-DD' of the local date on which these hours started (the latest `from` at or before ms)
//   hoursStart(settings, ms)     the start of the hours that hold at ms, or of the next hours when they do not hold
//   hoursEnd(settings, ms)       the end of the hours that hold at ms, or of the next hours when they do not hold
//   roomOf({ provider, row, ledger, now, line, share }) -> { ok, room, ledger, why }   the room a provider that reports its use has tonight
//   decide(inputs) -> { start?: { job, ref, note }, stop?: { job, why, pacerStop: true }, code, line, awake, ledger }
//
// decide's inputs: { now, settings, jobs (in the owner's order), held ({ at, until } | null: routines.held()), presence (the desktop's idle
//   seconds, or null), owners ({ <provider>: { live, lastEnd } }), outside ({ <provider>: true }), subs (planState().subs: rows of
//   { provider, windows: [{ id, minutes, usedPercent, resetsAt, seenAt, projected: { atReset, state } }] }), businesses ({ <id>: record }),
//   teamLine (the team's skipAbovePercent), today ({ <business id>: { runs, minutes } }), night (tonight's { ledger, runs, out }), running
//   ({ jobId, ref, since, workers?: [provider] } | null: the Night shift run that is going, and the providers of the team workers it runs
//   now), exclude (Map '<job id>|<ref>' -> sentence: leads step() turned down in this tick; '<job id>|*' -> sentence: step() said wait for
//   the job itself, its folder busy or its business not allowed to run) }.
// The ledger that comes back is tonight's ledger with every window looked at for the first time frozen in it; the caller keeps it.
// Codes: off | before | idle | hold | running | here | tonight | day | paused | wait | using | noroom (and start when a job starts).
// Wave 6 integration: the jobs of a paused business wait and do not keep the PC awake; a run is stopped at tonight's cap of any provider it
// uses, its workers' included.

export const MIN_ROOM = 2;
export const FRESH_MS = 90 * 60_000;
export const AWAY_S = 600;
export const OWNER_GAP_MS = 20 * 60_000;
export const JOB_GAP_MS = 10 * 60_000;
export const MAX_RUNS = 3;
export const REPORTING = Object.freeze(['anthropic', 'codex', 'muse']);
export const COUNTED = Object.freeze(['gemini', 'antigravity', 'cursor', 'grok']);
export const LABELS = Object.freeze({ anthropic: 'Claude', codex: 'Codex', muse: 'Muse Code', gemini: 'Gemini', antigravity: 'Antigravity', cursor: 'Cursor', grok: 'Grok' });
export const DEFAULT_LINE = 90;
const DAY_MS = 86_400_000;
export const PACER_STOP = 'Paused at the edge of tonight\'s share. It goes on when there\'s room.';
export const OFF_STOP = 'Stopped: Night shift was switched off. It goes on when it is on again.';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const two = n => String(n).padStart(2, '0');
const minutesOf = hhmm => Number(String(hhmm).slice(0, 2)) * 60 + Number(String(hhmm).slice(3, 5));
export const clockOf = ms => { const d = new Date(ms); return `${two(d.getHours())}:${two(d.getMinutes())}`; };
export const providerOf = ref => (typeof ref === 'string' && ref.includes(':') ? ref.slice(0, ref.indexOf(':')) : '');
export const labelOfProvider = p => LABELS[p] ?? (p ? p.charAt(0).toUpperCase() + p.slice(1) : 'A program');
const jobsWord = n => (n === 1 ? '1 job' : `${n} jobs`);

// The latest moment at or before ms that the local clock read hhmm, and the first one after ms.
function before(ms, hhmm) {
  const d = new Date(ms);
  d.setHours(Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5)), 0, 0);
  if (d.getTime() > ms) d.setDate(d.getDate() - 1);
  return d.getTime();
}
function after(ms, hhmm) {
  const d = new Date(ms);
  d.setHours(Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5)), 0, 0);
  if (d.getTime() <= ms) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function inHours(settings, ms) {
  const f = minutesOf(settings?.from ?? '23:00');
  const t = minutesOf(settings?.to ?? '07:00');
  if (!Number.isFinite(f) || !Number.isFinite(t) || f === t) return false;
  const d = new Date(ms);
  const m = d.getHours() * 60 + d.getMinutes();
  return f < t ? m >= f && m < t : m >= f || m < t;
}
export function hoursStart(settings, ms) {
  const from = settings?.from ?? '23:00';
  return inHours(settings, ms) ? before(ms, from) : after(ms, from);
}
export function hoursEnd(settings, ms) {
  return after(hoursStart(settings, ms), settings?.to ?? '07:00');
}
export function nightKey(settings, ms) {
  const d = new Date(before(ms, settings?.from ?? '23:00'));
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

// When the reading of a window was taken: the plan watch's readAt when it is there, else when the window was last seen.
const readOf = w => (Number.isFinite(w?.readAt) ? w.readAt : Number.isFinite(w?.seenAt) ? w.seenAt : null);
export const ledgerKey = (provider, w) => `${provider}|${w.id}|${w.resetsAt ?? ''}`;

// The room a provider that reports its use has tonight (gate c). row: its planState().subs row. The first look at a window in this
// period freezes its entry in the ledger: unused = 100 - atReset, spread over the nights left before a long window resets, and the cap
// is the reading then plus `share` percent of that, never above the owner's line. The room is the least of the windows' rooms.
export function roomOf({ provider, row, ledger = {}, now, line = DEFAULT_LINE, share = 50 }) {
  const out = { ...ledger };
  const windows = (Array.isArray(row?.windows) ? row.windows : []).filter(w => isObject(w) && Number.isFinite(w.usedPercent));
  if (!windows.length) return { ok: false, room: null, ledger: out, why: 'unknown' };
  let room = Infinity;
  for (const w of windows) {
    const read = readOf(w);
    const state = w.projected?.state;
    const atReset = w.projected?.atReset;
    if (read === null || now - read > FRESH_MS || (state !== 'fine' && state !== 'tight') || !Number.isFinite(atReset)) return { ok: false, room: null, ledger: out, why: 'unknown' };
    const key = ledgerKey(provider, w);
    let e = isObject(out[key]) && Number.isFinite(out[key].cap) ? out[key] : null;
    if (!e) {
      const unused = Math.max(0, 100 - atReset);
      const nights = Number.isFinite(w.minutes) && w.minutes > 1440 && Number.isFinite(w.resetsAt) ? Math.max(1, Math.ceil((w.resetsAt - now) / DAY_MS)) : 1;
      const cap = Math.min(line, w.usedPercent + ((share / 100) * unused) / nights);
      e = { start: w.usedPercent, atReset, nights, cap, at: now };
      out[key] = e;
    }
    room = Math.min(room, e.cap - w.usedPercent);
  }
  return { ok: room >= MIN_ROOM, room, ledger: out, why: room >= MIN_ROOM ? '' : 'noroom' };
}

const lastEndOf = job => {
  const r = Array.isArray(job?.runs) && job.runs.length ? job.runs[job.runs.length - 1] : null;
  return r && Number.isFinite(r.at) ? r.at + (Number.isFinite(r.ms) ? r.ms : 0) : 0;
};

export function awakeOf({ settings, now, waiting, running }) {
  return Boolean(settings?.on && settings?.keepAwake && inHours(settings, now) && (waiting > 0 || Boolean(running)));
}

// A business the owner paused: its jobs wait without a word of the pacer's and do not keep the PC awake.
const pausedOf = (businesses, job) => isObject(businesses) && isObject(businesses[job?.business]) && businesses[job.business].status === 'paused';

export function decide(inputs = {}) {
  const now = inputs.now;
  const s = inputs.settings ?? {};
  const jobs = Array.isArray(inputs.jobs) ? inputs.jobs : [];
  const waiting = jobs.filter(j => j?.state === 'waiting' && (j.runs?.length ?? 0) < MAX_RUNS);
  const running = inputs.running ?? null;
  const night = isObject(inputs.night) ? inputs.night : {};
  let ledger = isObject(night.ledger) ? { ...night.ledger } : {};
  const awake = awakeOf({ settings: s, now, waiting: waiting.filter(j => !pausedOf(inputs.businesses, j)).length, running });
  const to = s.to ?? '07:00';
  const done = (code, line, more = {}) => ({ code, line, awake, ledger, ...more });
  const runningJob = running ? jobs.find(j => j?.id === running.jobId) ?? null : null;

  // Whether a window of a provider the running job uses reached tonight's frozen cap: its lead's, and those of the team workers it handed
  // work to that run now (running.workers, providers). A worker's provider that reports its use and has no entry yet gets one frozen now,
  // by the same rule as a lead's; with less than MIN_ROOM it is at the cap. A worker of a provider counted in runs is one of that
  // provider's runs tonight (lib/jobs.mjs counts it): past the owner's "Runs a night" the run is at the cap.
  const atCap = () => {
    const lead = providerOf(running.ref);
    const workers = Array.isArray(running.workers) ? running.workers.filter(p => typeof p === 'string' && p) : [];
    const rows = Array.isArray(inputs.subs) ? inputs.subs : [];
    for (const p of [...new Set([lead, ...workers])]) {
      if (COUNTED.includes(p)) {
        if (p === lead) continue;
        const allowed = Number.isInteger(s.countRuns?.[p]) ? s.countRuns[p] : 0;
        const had = Number.isInteger(night.runs?.[p]) ? night.runs[p] : 0;
        if (had > allowed) return true;
        continue;
      }
      const row = rows.find(r => r?.provider === p);
      const windows = (Array.isArray(row?.windows) ? row.windows : []).filter(w => isObject(w) && Number.isFinite(w.usedPercent));
      if (p !== lead && REPORTING.includes(p) && windows.some(w => !isObject(ledger[ledgerKey(p, w)]))) {
        const b = isObject(inputs.businesses) ? inputs.businesses[runningJob?.business] : null;
        const line = isObject(b?.lines) && Number.isFinite(b.lines[p]) ? b.lines[p] : Number.isFinite(inputs.teamLine) ? inputs.teamLine : DEFAULT_LINE;
        const room = roomOf({ provider: p, row, ledger, now, line, share: Number.isFinite(s.share) ? s.share : 50 });
        ledger = room.ledger;
        if (!room.ok && room.why === 'noroom') return true;
      }
      for (const w of windows) {
        const e = ledger[ledgerKey(p, w)];
        if (isObject(e) && Number.isFinite(e.cap) && w.usedPercent >= e.cap) return true;
      }
    }
    return false;
  };
  const capStop = () => ({ stop: { job: runningJob, jobId: running.jobId, why: PACER_STOP, pacerStop: true } });

  // 1. Switched off: a run that is going is stopped, and goes on when Night shift is on again.
  if (!s.on) {
    if (running) return done('off', 'Night shift is off.', { stop: { job: runningJob, jobId: running.jobId, why: OFF_STOP, pacerStop: true } });
    return done('off', 'Night shift is off.');
  }
  // 2. Outside the hours: a run that is going is stopped at their end.
  if (!inHours(s, now)) {
    const line = `Starts at ${s.from ?? '23:00'}. ${waiting.length ? `${jobsWord(waiting.length)} waiting` : 'No jobs waiting'}.`;
    if (running) return done('before', line, { stop: { job: runningJob, jobId: running.jobId, why: `Stopped at ${to}, the end of the hours. It goes on tonight.`, pacerStop: true } });
    return done('before', line);
  }
  // 3. Nothing waits (and nothing runs).
  if (!waiting.length && !running) return done('idle', 'No job is waiting.');
  // 4. The hold after a Stop.
  const held = inputs.held;
  if (held && Number.isFinite(held.until) && held.until > now) {
    // A run that is still going during a hold is still held to tonight's share.
    return done('hold', `You pressed Stop at ${clockOf(held.at || held.until - 30 * 60_000)}. Night shift starts again at ${clockOf(held.until)}.`, { resume: true, ...(running && atCap() ? capStop() : {}) });
  }
  // 5. A run is going: it is stopped when a window of its provider reached tonight's cap.
  if (running) {
    const line = `Working on "${runningJob?.name ?? 'a job'}" with ${labelOfProvider(providerOf(running.ref))}.`;
    return done('running', line, atCap() ? capStop() : {});
  }
  // 6. The owner is at this PC.
  if (Number.isFinite(inputs.presence) && inputs.presence < AWAY_S) return done('here', 'Waiting while you\'re at this PC.');

  // 7. The jobs in order; jobs that ran tonight after those that did not; a job whose last run ended less than JOB_GAP_MS ago waits.
  const tonight = hoursStart(s, now);
  const ranTonight = j => (j.runs ?? []).some(r => Number.isFinite(r?.at) && r.at >= tonight);
  const order = [...waiting.filter(j => !ranTonight(j)), ...waiting.filter(ranTonight)];
  const ready = order.filter(j => now - lastEndOf(j) >= JOB_GAP_MS);
  if (!ready.length) return done('tonight', `Working tonight until ${to}. ${jobsWord(waiting.length)} waiting.`);

  const reasons = [];
  const say = (code, line, rank) => reasons.push({ code, line, rank });
  const businesses = isObject(inputs.businesses) ? inputs.businesses : {};
  const owners = isObject(inputs.owners) ? inputs.owners : {};
  const outside = isObject(inputs.outside) ? inputs.outside : {};
  const today = isObject(inputs.today) ? inputs.today : {};
  const runs = isObject(night.runs) ? night.runs : {};
  const out = Array.isArray(night.out) ? night.out : [];
  const exclude = inputs.exclude instanceof Map ? inputs.exclude : new Map();
  const countRuns = isObject(s.countRuns) ? s.countRuns : {};
  const share = Number.isFinite(s.share) ? s.share : 50;
  const rows = Array.isArray(inputs.subs) ? inputs.subs : [];

  for (const job of ready) {
    const b = businesses[job.business];
    if (!isObject(b)) { say('noroom', 'Waiting: the business of a job is not there any more.', 4); continue; }
    // A paused business: its jobs wait, and the jobs of the other businesses go on.
    if (b.status === 'paused') { say('paused', `Waiting: ${b.name ?? 'This business'} is paused.`, 2); continue; }
    // step() said wait for this job (its folder or thread is busy, the business may not run now): the next job is tried in the same tick.
    const waitWhy = exclude.get(`${job.id}|*`);
    if (waitWhy !== undefined) { say('wait', String(waitWhy || 'Waiting: this job cannot start just now.'), 2); continue; }
    // (a) The day's budget of the business: half of it is kept for the day.
    const t = isObject(today[job.business]) ? today[job.business] : { runs: 0, minutes: 0 };
    if (Number.isFinite(b.runsPerDay) && (Number(t.runs) || 0) >= b.runsPerDay / 2) { say('day', `Waiting: ${b.name ?? 'This business'} keeps half of today's runs for the day.`, 2); continue; }
    if (Number.isFinite(b.minutesPerDay) && (Number(t.minutes) || 0) >= b.minutesPerDay / 2) { say('day', `Waiting: ${b.name ?? 'This business'} keeps half of today's minutes for the day.`, 2); continue; }
    // The pinned lead only, never another; else the business's leads in order.
    const leads = (job.lead ? [job.lead] : Array.isArray(b.leads) ? b.leads : []).filter(r => typeof r === 'string' && r);
    if (!leads.length) { say('noroom', `Waiting: ${b.name ?? 'This business'} has no lead.`, 4); continue; }
    const skipped = [];
    for (const ref of leads) {
      const p = providerOf(ref);
      const label = labelOfProvider(p);
      const turned = exclude.get(`${job.id}|${ref}`);
      if (turned !== undefined) { skipped.push(`${label} could not start.`); say('noroom', String(turned || `Waiting: ${label} could not start.`), 3); continue; }
      if (REPORTING.includes(p)) {
        // (b) The owner's own use of that provider.
        const o = isObject(owners[p]) ? owners[p] : {};
        if (o.live === true || (Number.isFinite(o.lastEnd) && now - o.lastEnd < OWNER_GAP_MS)) { skipped.push(`${label} was in use.`); say('using', `Waiting: you're using ${label} right now.`, 1); continue; }
        if (outside[p] === true) { skipped.push(`${label} was in use.`); say('using', `Waiting: ${label} is in use outside Plenum.`, 1); continue; }
        // (c) Room that would go unused.
        const b2 = isObject(b.lines) && Number.isFinite(b.lines[p]) ? b.lines[p] : Number.isFinite(inputs.teamLine) ? inputs.teamLine : DEFAULT_LINE;
        const room = roomOf({ provider: p, row: rows.find(r => r?.provider === p), ledger, now, line: b2, share });
        ledger = room.ledger;
        if (!room.ok) {
          skipped.push(`${label} had no room to spare.`);
          if (room.why === 'unknown') say('noroom', `Plenum can't tell yet how much of ${label} is left.`, 3);
          else say('noroom', 'Waiting: no plan has room to spare tonight.', 4);
          continue;
        }
      } else {
        // (d) Providers that do not report their use: a number of runs a night.
        const allowed = Number.isInteger(countRuns[p]) ? countRuns[p] : 0;
        const had = Number.isInteger(runs[p]) ? runs[p] : 0;
        if (out.includes(p)) { skipped.push(`${label} reached a limit tonight.`); say('noroom', `${label} reached a limit tonight.`, 3); continue; }
        if (had >= allowed) {
          skipped.push(`${label} had no room to spare.`);
          say('noroom', allowed > 0 ? `${label} has had its ${allowed} runs tonight.` : 'Waiting: no plan has room to spare tonight.', allowed > 0 ? 3 : 4);
          continue;
        }
      }
      // (e) The first lead that passes starts; the note names the leads passed over.
      return done('start', `Working on "${job.name}" with ${label}.`, { start: { job, ref, note: skipped.join(' ') } });
    }
  }
  // 8. Nothing can start: the most specific reason seen.
  const best = reasons.slice().sort((x, y) => x.rank - y.rank)[0];
  return best ? done(best.code, best.line) : done('noroom', 'Waiting: no plan has room to spare tonight.');
}
