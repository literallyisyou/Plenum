// Plan watch (14 Nov 2026, DECISIONS item 153): the plan-use meter (lib/quota.mjs) read by itself, kept as a history, projected forward and
// turned into alerts, so the owner hears BEFORE a business runs out of plan use, not after a routine failed.
//
// THE CONTRACT (the page, the desktop shell and the phone build to it; build/v06/d-planwatch-s pins each part):
//   createPlanWatch(deps) -> an instance; the default instance's functions are exported below under the same names.
//     deps: dir (the data folder), now, quota ({ read(), refresh(provider, reason) }), termsOk, env, setTimer, clearTimer, publish,
//           business ({ list(), overlayFor(projectId) }), team ({ get(), availability(ref, { lines }), labelOf(ref) }), accounts() (what is known
//           about the installed and signed-in programs, or null), running() (the providers that have a run going now), roundMs, readLimitMs,
//           askLimitMs. A value or a function is taken for each. The neighbours are loaded with import() on first use.
//   state()            -> a promise of the answer of GET /api/plan-watch (the shape is in ultra/work/d-planwatch-s/NOTES.md)
//   check()            -> a promise of the same after one round of readings now (a paid reading keeps to its budget)
//   setSettings(patch) -> a promise of { on, paidEveryMin, alerts }; throws an Error with status 400 and one plain sentence
//   seen(id)           -> a promise of { ok: true }
//   start(), stop()    -> the timer. start() never starts one with PLENUM_NO_SCHEDULER=1 or PLENUM_SMOKE=1, and a round does nothing before the
//                         License Agreement is accepted or while the watch is switched off.
//   latestAlert()      -> { seq, id, level, title, text, at } | null: the newest alert made since this server started (for the desktop shell)
// The file: plan-use.json in the data folder, { v: 1, settings, subs, alerts, fired } (see NOTES.md). Written atomically.
//
// RULES THIS MODULE KEEPS: a poll is free (readQuota); a request that costs plan use is sent only for Claude Code and Muse Code, only
// through the refresh reason 'watch' of lib/quota.mjs (never more often than every 30 minutes), never while a run of that provider goes,
// and never for a program that is missing or signed out. The watch does not spend the plan it measures: a request that found nothing
// moved makes the next one wait twice as long, 6 hours at most, and use that is seen ends the wait. Nothing starts a sign-in. A reader
// that throws or hangs ends in "could not be read" after its time limit. Nothing is read, written or timed before the License Agreement
// is accepted. An alert never opens a dialog and never stops a run. Every sentence is made here, so the page, the notification and the
// phone say the same words.
// WHAT IS WORTH AN ALERT: a fact always (a limit that is used up, a business whose leads are all at their lines), when it lasts 30 minutes
// or more. A projection only for a window longer than 12 hours, with a lead, a margin and the whole period agreeing (RULES, onCourse). A
// reading so old that its pace would have reached a line by now is a guess: it is said as one ("may have nothing left by now") and never
// alerts. A lead that cannot run (missing, signed out, no key) is named as that, never as "at your line".
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';
import { publish as publishEvent, publishState as publishStateEvent } from './events.mjs';

export const VERSION = 1;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const ROUND_MS = 5 * MIN;
export const FIRST_ROUND_MS = 30_000;
export const TERMS_RECHECK_MS = MIN;
export const READ_LIMIT_MS = 45_000;
export const ASK_LIMIT_MS = 90_000;
export const PAID_GAP_MS = 30 * MIN;
// A request the person asks for (Check now) keeps to the gap lib/quota.mjs has for a person: an hour after the newest request of any reason.
export const USER_ASK_GAP_MS = 60 * MIN;
// A request that found nothing moved makes the next one wait twice as long, this many times at most (and never longer than PAID_RANGE.max).
export const CALM_MAX = 4;
// What "Check now" said stays in the answer this long.
export const NOTE_KEEP_MS = 10 * MIN;
export const DEFAULT_SETTINGS = Object.freeze({ on: true, paidEveryMin: 60, alerts: true });
export const PAID_RANGE = Object.freeze({ min: 30, max: 360 });
// The subscriptions whose reading can only be renewed by a very small request, and the ones that report nothing at all.
export const PAID_PROVIDERS = Object.freeze(['anthropic', 'muse']);
export const REPORTING = Object.freeze(['codex', 'muse', 'anthropic']);
export const EXTRA_PROVIDERS = Object.freeze(['antigravity', 'cursor', 'grok']);
export const ORDER = Object.freeze(['anthropic', 'codex', 'muse', 'gemini', 'antigravity', 'cursor', 'grok']);
export const LABELS = Object.freeze({ anthropic: 'Claude', codex: 'Codex', muse: 'Muse Code', gemini: 'Gemini', antigravity: 'Antigravity', cursor: 'Cursor', grok: 'Grok Build' });
const NO_REPORT = Object.freeze({
  gemini: 'Gemini CLI does not report plan use, so Plenum cannot read it.',
  antigravity: 'Antigravity does not report plan use, so Plenum cannot read it.',
  cursor: 'Cursor does not report plan use, so Plenum cannot read it.',
  grok: 'Grok Build does not report plan use, so Plenum cannot read it.',
});

// What the numbers mean. Every rule of the projection has its number here and a test that pins it.
export const RULES = Object.freeze({
  keepMs: 14 * DAY,          // history kept
  thinAfterMs: DAY,          // points older than this are thinned to one per hour
  heartbeatMs: 30 * MIN,     // an unchanged value is written again after this
  maxPoints: 600,            // per period
  maxPeriods: 20,
  maxAlerts: 30,
  maxFired: 400,
  resetMoveMs: 2 * MIN,      // a reset time that moves by more than this starts a new period
  fallPoints: 2,             // a fall of this many points (or more) starts a new period; a smaller one is noise
  shortSpanMs: 2 * HOUR,     // the recent span for windows up to 12 hours (or of unknown length)
  longSpanMs: DAY,           // the recent span for longer windows
  longAboveMin: 720,
  minPoints: 3,              // recent needs this many readings ...
  coverFraction: 0.25,       // ... covering this part of the span
  periodFraction: 0.1,       // the whole-period pace needs this part of the window gone
  sureRise: 2,               // a recent pace is sure only from a rise of this many points (or a flat line)
  sureElapsed: 0.25,         // a whole-period pace is sure only after this part of the window
  sureUsed: 10,              // ... and from this many percent
  staleMs: 3 * HOUR,         // a reading older than this makes nothing sure
  tightAt: 85,               // atReset from here to 100 is tight
  nearLine: 10,              // a business provider is tight when it ends this close to its line
  // --- when a course past a line is worth an alert (the state and the sentence of a window do not change) ---
  // Only a window longer than 12 hours (longAboveMin) is alerted ahead of time. The pace of a 5-hour limit says too little: of made-up
  // 5-hour windows that ended at 85 percent, 4 in 10 raised an alert under any rule that was tried, and an alert that was right came
  // about 15 minutes before the limit. A short window is told when it IS used up.
  alertLeadFraction: 0.1,    // the lead before the reset must be at least this part of the window
  alertMargin: 110,          // the value at the reset must be at least this percent of the line
  alertAgree: 1,             // used / part of the window gone must reach this part of the line (with sureElapsed of the window gone)
  alertOutMin: 30 * MIN,     // "used up" and "nothing left" are told only when that lasts at least this (or no end is known)
  risingMs: 30 * MIN,        // a whole-period pace is sure only with a rise inside this time ...
  periodPoints: 3,           // ... or this many points in the period
  blockMin: 10 * MIN,        // a business has nothing left only for a stretch at least this long
  noticeMax: 240,            // the one-line notice
  namedMax: 3,               // businesses named in an alert before "and N more"
  errorMax: 160,             // a program's own error sentence kept in a row's note
});

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const whole = (v, lo, hi) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const finite = v => typeof v === 'number' && Number.isFinite(v);
const badRequest = message => Object.assign(new Error(message), { status: 400 });

// ---------- words ----------

// "Sat 3:10 PM", in the PC's time; a date is added for a time more than 6 days away.
export function fmtTime(ms, now = Date.now()) {
  if (!finite(ms)) return '';
  const far = Math.abs(ms - now) > 6 * DAY;
  const opts = far ? { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' };
  return new Date(ms).toLocaleString('en-US', opts).replace(/[  ]/g, ' ');
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// "1 day 4 hours", "2 hours 10 minutes", "35 minutes", "less than a minute".
export function fmtDuration(ms) {
  if (!finite(ms) || ms < MIN) return 'less than a minute';
  const total = Math.round(ms / MIN);
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  if (days) return hours ? `${plural(days, 'day')} ${plural(hours, 'hour')}` : plural(days, 'day');
  if (hours) return minutes ? `${plural(hours, 'hour')} ${plural(minutes, 'minute')}` : plural(hours, 'hour');
  return plural(minutes, 'minute');
}

const list = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const lower = text => (/^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text);

// ---------- windows ----------

export const slug = name => String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'plan-limit';

// A window's length in minutes from its name (lib/usage.mjs names a window from its length): "5-hour limit", "Weekly limit", "3-day limit",
// "45-minute limit". A name that says nothing of a length (Extra usage, Plan limit) is null.
export function minutesOf(name) {
  const text = String(name ?? '');
  if (/\bweekly\b/i.test(text)) return 10_080;
  let m = text.match(/\b(\d+)-day\b/i);
  if (m) return Number(m[1]) * 1440;
  m = text.match(/\b(\d+)-hour\b/i);
  if (m) return Number(m[1]) * 60;
  m = text.match(/\b(\d+)-minute\b/i);
  if (m) return Number(m[1]);
  return null;
}

const lastOf = list => list[list.length - 1];

// Adds one reading to the record of a window (the record is changed and returned with whether anything changed).
//   rec      null or { name, minutes, seenAt, reached, unmeasured, periods: [{ key, resetsAt, startedAt, points: [[t, percent]] }] }
//   reading  { name, usedPercent (a whole number or null), resetsAt (ms or null), observedAt (ms), reached (boolean), status? }
export function recordReading(rec, reading, now = Date.now()) {
  const t = finite(reading.observedAt) && reading.observedAt <= now + MIN ? reading.observedAt : now;
  const minutes = minutesOf(reading.name);
  const resetsAt = finite(reading.resetsAt) ? reading.resetsAt : null;
  let changed = false;
  if (!rec) {
    rec = { name: reading.name, minutes, seenAt: 0, reached: false, unmeasured: null, periods: [] };
    changed = true;
  }
  if (rec.name !== reading.name || rec.minutes !== minutes) {
    rec.name = reading.name;
    rec.minutes = minutes;
    changed = true;
  }
  // Readings stamped in the future (a clock that was wrong and then corrected) must not freeze the window: they go.
  if (rec.seenAt > now + MIN) {
    rec.seenAt = 0;
    for (const period of rec.periods) period.points = period.points.filter(pt => pt[0] <= now + MIN);
    rec.periods = rec.periods.filter(period => period.points.length);
    changed = true;
  }
  // An older reading than the newest one is a replay (a cached answer): it adds nothing.
  if (t < rec.seenAt) return { rec, changed };
  const reached = reading.reached === true;
  if (rec.reached !== reached) {
    rec.reached = reached;
    changed = true;
  }
  if (reading.usedPercent === null || reading.usedPercent === undefined) {
    const next = { status: typeof reading.status === 'string' ? reading.status : '', resetsAt };
    if (!rec.unmeasured || rec.unmeasured.status !== next.status || rec.unmeasured.resetsAt !== next.resetsAt) {
      rec.unmeasured = next;
      changed = true;
    }
    if (rec.seenAt !== t) {
      rec.seenAt = t;
      changed = true;
    }
    return { rec, changed };
  }
  if (rec.unmeasured) {
    rec.unmeasured = null;
    changed = true;
  }
  const used = reading.usedPercent;
  let cur = lastOf(rec.periods) ?? null;
  const lastPoint = cur ? lastOf(cur.points) : null;
  let fresh = !cur;
  if (cur) {
    const sameReset = resetsAt !== null && cur.resetsAt !== null && Math.abs(resetsAt - cur.resetsAt) <= RULES.resetMoveMs;
    if (resetsAt !== null && cur.resetsAt !== null && !sameReset) fresh = true;
    else if (cur.resetsAt !== null && t >= cur.resetsAt && !sameReset) fresh = true;
    else if (lastPoint && used <= lastPoint[1] - RULES.fallPoints) fresh = true;
  }
  if (fresh) {
    const startedAt = resetsAt !== null && minutes !== null ? resetsAt - minutes * MIN : t;
    cur = { key: String(resetsAt ?? t), resetsAt, startedAt, points: [[t, used]] };
    rec.periods.push(cur);
    changed = true;
  } else {
    if (cur.resetsAt === null && resetsAt !== null) {
      cur.resetsAt = resetsAt;
      if (minutes !== null) cur.startedAt = Math.min(cur.startedAt, resetsAt - minutes * MIN);
      changed = true;
    }
    const noise = lastPoint && used < lastPoint[1];
    const same = lastPoint && used === lastPoint[1];
    if (noise) {
      // A fall of one point with the same reset time is rounding: the old value stays.
    } else if (!lastPoint || !same || t - lastPoint[0] >= RULES.heartbeatMs) {
      if (!lastPoint || t > lastPoint[0] || used !== lastPoint[1]) {
        cur.points.push([Math.max(t, lastPoint ? lastPoint[0] : t), used]);
        changed = true;
      }
    }
  }
  if (rec.seenAt !== t) {
    rec.seenAt = t;
    changed = true;
  }
  return { rec, changed };
}

// Keeps the history bounded: 14 days; points older than a day thinned to one per hour; at most 600 points per period, 20 periods.
export function tidy(rec, now = Date.now()) {
  rec.periods = rec.periods.filter(p => p.points.length && (lastOf(p.points)[0] >= now - RULES.keepMs));
  if (rec.periods.length > RULES.maxPeriods) rec.periods = rec.periods.slice(-RULES.maxPeriods);
  for (const p of rec.periods) {
    const old = p.points.filter(pt => pt[0] < now - RULES.thinAfterMs);
    if (old.length > 1) {
      const kept = [];
      let hour = null;
      for (const pt of old) {
        const h = Math.floor(pt[0] / HOUR);
        if (h === hour) kept[kept.length - 1] = pt;
        else {
          kept.push(pt);
          hour = h;
        }
      }
      p.points = [...kept, ...p.points.filter(pt => pt[0] >= now - RULES.thinAfterMs)];
    }
    if (p.points.length > RULES.maxPoints) p.points = p.points.slice(-RULES.maxPoints);
  }
  return rec;
}

// ---------- the projection ----------

// The pace of one window, from its newest reading's point of view.
//   -> { perHour, basis: 'recent' | 'period' | null, points, sure }
export function paceOf(rec, now = Date.now()) {
  const none = { perHour: null, basis: null, points: 0, sure: false };
  const cur = rec && lastOf(rec.periods ?? []);
  if (!cur || !cur.points.length || rec.unmeasured) return none;
  const readAt = Math.max(rec.seenAt, lastOf(cur.points)[0]);
  const used = lastOf(cur.points)[1];
  const fresh = now - readAt <= RULES.staleMs;
  const span = rec.minutes !== null && rec.minutes > RULES.longAboveMin ? RULES.longSpanMs : RULES.shortSpanMs;
  // The value is the same until the next change, so the newest reading counts as a point at its own time.
  const pts = cur.points.filter(p => p[0] >= readAt - span);
  const line = pts.length && lastOf(pts)[0] < readAt ? [...pts, [readAt, used]] : pts;
  if (line.length >= RULES.minPoints) {
    const cover = readAt - line[0][0];
    if (cover >= span * RULES.coverFraction) {
      const rise = used - line[0][1];
      const perHour = rise / (cover / HOUR);
      return { perHour: Math.round(perHour * 10) / 10, raw: perHour, basis: 'recent', points: line.length, sure: fresh && (rise >= RULES.sureRise || rise === 0) };
    }
  }
  if (rec.minutes !== null && cur.resetsAt !== null) {
    const length = rec.minutes * MIN;
    const elapsed = readAt - (cur.resetsAt - length);
    if (elapsed >= length * RULES.periodFraction && elapsed <= length * 1.05) {
      const perHour = used / (elapsed / HOUR);
      // A whole-period average is sure only with signs of use now: a rise inside the last 30 minutes, or three points in the period.
      const lately = cur.points.filter(pt => pt[0] >= readAt - RULES.risingMs);
      const rising = lately.length >= 2 && lastOf(lately)[1] > lately[0][1];
      const signs = rising || cur.points.length >= RULES.periodPoints;
      return { perHour: Math.round(perHour * 10) / 10, raw: perHour, basis: 'period', points: cur.points.length, sure: fresh && signs && elapsed >= length * RULES.sureElapsed && used >= RULES.sureUsed };
    }
  }
  return { ...none, points: line.length };
}

// What a window looks like now: its value, its pace, where it ends up and in what state.
//   -> { usedPercent, resetsAt, readAt, pace, projected: { atReset, usedUpAt, state, sure }, stale }
export function projectWindow(rec, now = Date.now()) {
  const cur = lastOf(rec.periods ?? []) ?? null;
  const idle = { perHour: null, basis: null, points: 0 };
  const unknown = { atReset: null, usedUpAt: null, state: 'unknown', sure: false };
  if (!cur || rec.unmeasured) {
    const resetsAt = rec.unmeasured?.resetsAt ?? cur?.resetsAt ?? null;
    const stale = resetsAt !== null && now >= resetsAt;
    // A window with no percentage: the provider's own word is all there is.
    const out = rec.reached === true && !stale;
    // Claude's own warning: the limit is close, with no percentage. It says so and raises no alert.
    const warned = !out && !stale && rec.unmeasured?.status === 'allowed_warning';
    return { usedPercent: null, resetsAt, readAt: rec.seenAt || null, pace: idle, projected: out ? { ...unknown, state: 'out', sure: true } : warned ? { ...unknown, state: 'tight', sure: true } : unknown, stale };
  }
  const used = lastOf(cur.points)[1];
  const readAt = Math.max(rec.seenAt, lastOf(cur.points)[0]);
  const resetsAt = cur.resetsAt;
  const stale = resetsAt !== null && now >= resetsAt;
  if (stale) return { usedPercent: used, resetsAt, readAt, pace: idle, projected: unknown, stale: true };
  const p = paceOf(rec, now);
  const pace = { perHour: p.perHour, basis: p.basis, points: p.points };
  if (used >= 100 || rec.reached === true) return { usedPercent: used, resetsAt, readAt, pace, projected: { atReset: used, usedUpAt: null, state: 'out', sure: true }, stale: false };
  if (p.basis === null || resetsAt === null) return { usedPercent: used, resetsAt, readAt, pace, projected: unknown, stale: false };
  const atReset = Math.round(used + p.raw * ((resetsAt - readAt) / HOUR));
  const state = atReset > 100 ? 'short' : atReset >= RULES.tightAt ? 'tight' : 'fine';
  let usedUpAt = state === 'short' && p.raw > 0 ? Math.round(readAt + ((100 - used) / p.raw) * HOUR) : null;
  // A used-up time that is already past is no time to come: an old reading cannot say when, and so it is not sure.
  const late = usedUpAt !== null && usedUpAt < now;
  if (late) usedUpAt = null;
  return { usedPercent: used, resetsAt, readAt, pace, projected: { atReset, usedUpAt, state, sure: p.sure && !late }, stale: false };
}

// Part of the window that has gone at the time of the reading (null when its length or reset time is not known).
export function elapsedOf(win) {
  if (win.minutes === null || win.resetsAt === null || !finite(win.readAt)) return null;
  const length = win.minutes * MIN;
  return (win.readAt - (win.resetsAt - length)) / length;
}

// A window longer than 12 hours: the only kind whose pace is worth an alert ahead of time (see RULES).
export const isLong = win => win.minutes !== null && win.minutes > RULES.longAboveMin;

// Whether the whole period so far agrees that a window is on course to reach `line` percent: a long window, at least a quarter of it gone,
// and used / part gone reaches the line. A shorter window, or one of unknown length, never agrees.
export function agrees(win, line = 100) {
  if (win.usedPercent === null || !isLong(win)) return false;
  const gone = elapsedOf(win);
  return gone !== null && gone >= RULES.sureElapsed && win.usedPercent / gone >= line * RULES.alertAgree;
}

// Whether a window on course to pass `line` percent at the time `reach` is worth an alert: a long window whose projection is sure, the
// moment still ahead and at least a tenth of the window before the reset, a tenth over the line at the reset, and the whole period agreeing.
export function onCourse(win, line, reach, now = Date.now()) {
  const pr = win.projected;
  if (!isLong(win) || pr.sure !== true || win.stale || win.resetsAt === null || !finite(reach) || reach < now) return false;
  return win.resetsAt - reach >= RULES.alertLeadFraction * win.minutes * MIN && pr.atReset >= (line * RULES.alertMargin) / 100 && agrees(win, line);
}

// Whether a short WINDOW is worth an alert (its state and sentence are shown either way).
export function alertWorthy(win, now = Date.now()) {
  const pr = win.projected;
  return pr.state === 'short' && pr.usedUpAt !== null && onCourse(win, 100, pr.usedUpAt, now);
}

const WORSE = ['out', 'short', 'tight', 'fine', 'unknown'];
export const worst = states => WORSE.find(s => states.includes(s)) ?? 'unknown';

// The pace in words. A long window is measured by the day and a short one by the hour (a weekly limit at "0 percent an hour" that still
// rises says nothing to a person). One decimal below ten, whole numbers from ten; a pace too small for one decimal is said as that.
export function sayPace(win) {
  const perHour = finite(win.rawPerHour) ? win.rawPerHour : win.pace?.perHour;
  if (!finite(perHour)) return '';
  const long = isLong(win);
  const value = long ? perHour * 24 : perHour;
  const unit = long ? 'a day' : 'an hour';
  const shown = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  if (value > 0 && shown === 0) return `less than 0.1 percent ${unit}`;
  return `${shown === 0 ? 0 : shown} percent ${unit}`;
}

// The sentence of a window. It says only what is known: the value, the pace and where it ends up, or why there is no projection.
export function sayWindow(win, now = Date.now()) {
  const { usedPercent: used, resetsAt, projected: pr, pace } = win;
  const name = lower(win.name);
  const reset = resetsAt !== null ? fmtTime(resetsAt, now) : '';
  const age = win.readAt && now - win.readAt > RULES.staleMs ? ` This reading is ${fmtDuration(now - win.readAt)} old.` : '';
  if (win.stale) return `The ${name} reset on ${reset}. Plenum is waiting for a new reading.`;
  if (used === null) {
    if (pr.state === 'out') return `The ${name} is used up${reset ? `. It resets ${reset}, in ${fmtDuration(resetsAt - now)}` : '. No reset time was reported'}.`;
    if (pr.state === 'tight') return `Claude says the ${name} is close to its limit${reset ? `. It resets ${reset}` : ''}.`;
    if (win.status === 'allowed') return `Claude says the ${name} is within its limit${reset ? ` (it resets ${reset})` : ''}. It gave no percentage, so Plenum cannot tell how much is left.${age}`;
    return `The ${name} reported no percentage, so Plenum cannot tell how much is left.${age}`;
  }
  if (pr.state === 'out') return `The ${name} is used up${reset ? `. It resets ${reset}, in ${fmtDuration(resetsAt - now)}` : '. No reset time was reported'}.`;
  const base = pace.basis === 'recent' ? `At the pace of ${win.minutes !== null && win.minutes > RULES.longAboveMin ? 'the last day' : 'the last 2 hours'}` : 'At the pace of this whole period';
  const rate = pace.perHour !== null ? ` (${sayPace(win)})` : '';
  const early = pr.sure === false && pr.state !== 'unknown' ? ' This is an early estimate.' : '';
  if (pr.state === 'unknown') {
    if (resetsAt === null) return `Used ${used}%. No reset time was reported, so Plenum cannot project it.${age}`;
    return `Used ${used}%, resets ${reset}. There are not enough readings yet to tell how fast it is used.${age}`;
  }
  if (pr.state === 'short' && pr.usedUpAt === null) return `At that pace it would be used up by now. This reading is ${fmtDuration(now - win.readAt)} old.`;
  if (pr.state === 'short') return `${base}${rate}, it is used up ${fmtTime(pr.usedUpAt, now)}, ${fmtDuration(resetsAt - pr.usedUpAt)} before it resets (${reset}).${early}${age}`;
  if (pr.state === 'tight') return `${base}${rate}, it will be at ${pr.atReset}% when it resets ${reset}. That is close to the limit.${early}${age}`;
  return `Used ${used}%. ${base}${rate}, it will be at ${pr.atReset}% when it resets ${reset}.${early}${age}`;
}

// The window as the contract has it.
export function windowView(id, rec, now = Date.now()) {
  const pw = projectWindow(rec, now);
  const win = {
    id,
    name: rec.name,
    minutes: rec.minutes,
    usedPercent: pw.usedPercent,
    resetsAt: pw.resetsAt,
    seenAt: rec.seenAt || null,
    pace: pw.pace,
    projected: pw.projected,
    readAt: pw.readAt,
    stale: pw.stale,
    // The pace as it was measured (pace.perHour is rounded for reading): a business's line is reckoned with this one, so its time agrees
    // with the window's own. Not part of the answer.
    rawPerHour: pw.pace.perHour === null ? null : paceOf(rec, now).raw ?? null,
    // The provider's own word for a limit that came with no percentage (allowed, allowed_warning). Not part of the answer.
    status: pw.usedPercent === null ? rec.unmeasured?.status ?? '' : '',
  };
  win.say = sayWindow(win, now);
  return win;
}

// ---------- the settings ----------

export function cleanSettings(patch, current = DEFAULT_SETTINGS) {
  if (!isObject(patch)) throw badRequest('Send an object with on, paidEveryMin or alerts.');
  const out = { ...DEFAULT_SETTINGS, ...(isObject(current) ? current : {}) };
  if (patch.on !== undefined) {
    if (typeof patch.on !== 'boolean') throw badRequest('Automatic checks must be on or off.');
    out.on = patch.on;
  }
  if (patch.alerts !== undefined) {
    if (typeof patch.alerts !== 'boolean') throw badRequest('Alerts must be on or off.');
    out.alerts = patch.alerts;
  }
  if (patch.paidEveryMin !== undefined) {
    const v = patch.paidEveryMin;
    if (!(v === 0 || whole(v, PAID_RANGE.min, PAID_RANGE.max))) throw badRequest(`The time between checks that send a request must be 0 (never) or from ${PAID_RANGE.min} to ${PAID_RANGE.max} minutes.`);
    out.paidEveryMin = v;
  }
  return out;
}

// ---------- businesses ----------

const providerOf = ref => String(ref ?? '').slice(0, Math.max(0, String(ref ?? '').indexOf(':')));
// A line as a person reads it: 87.5 stays 87.5, 90 is 90.
const lineText = n => String(Math.round(n * 10) / 10);
const endOf = b => (b.to === null ? Infinity : b.to);
const endsLast = (a, b) => (endOf(a) >= endOf(b) ? a : b);
const coversAt = (blocks, t) => blocks.some(x => x.from <= t && t < endOf(x));

// Blocks are stretches [from, to) in which a provider cannot be used at a line (to: null = no end known). Overlapping ones are merged: sure
// only when every part is sure, `win` the window that ends last, `parts` every window that took part, each with its own stretch.
function mergeBlocks(blocks) {
  const out = [];
  for (const b of [...blocks].sort((x, y) => x.from - y.from)) {
    const last = out[out.length - 1];
    if (last && (last.to === null || b.from <= last.to)) {
      const keep = endsLast(last, b);
      last.to = last.to === null || b.to === null ? null : Math.max(last.to, b.to);
      last.sure = last.sure && b.sure;
      last.win = keep.win;
      last.parts = [...last.parts, ...b.parts];
    } else {
      out.push({ ...b, parts: [...b.parts] });
    }
  }
  return out;
}

// How one provider stands against a line (a percent), from its windows' projections.
//   -> { state, reachesLimitAt, sure, late, warned, blocks, hard, solid }
// A window that is out, or at or over the line, blocks from now to its reset: a FACT (its part has atLine: true). One whose pace reaches the
// line before its reset blocks from that moment to its reset: a PROJECTION, sure as the window's projection is, and `solid` when it is
// worth an alert (onCourse). A projection whose moment is already past (the reading is old) blocks from now, is never sure and is `late`:
// nobody knows whether the line was reached.
//   blocks  all of them, merged          hard  the facts alone          solid  the facts and the solid projections
//   state   out when a fact blocks now, short when a projection will (late: the window whose projection may already have),
//           tight when it ends near the line or the provider itself says it is close (warned: true, no percentage needed), fine, or
//           unknown with no reading.
export function providerAgainst(windows, line, now = Date.now()) {
  const live = windows.filter(w => !w.stale && (w.usedPercent !== null || w.projected.state === 'out' || w.projected.state === 'tight'));
  if (!live.length) return { state: 'unknown', reachesLimitAt: null, sure: false, late: null, warned: false, blocks: [], hard: [], solid: [] };
  const raw = [];
  let sure = true;
  let tight = false;
  let warned = false;
  for (const w of live) {
    const used = w.usedPercent;
    if (w.projected.state === 'out' || (used !== null && used >= line)) {
      raw.push({ from: now, to: w.resetsAt, sure: true, win: w, parts: [{ win: w, line, atLine: true, solid: true, late: false, from: now, to: w.resetsAt }] });
      continue;
    }
    // No percentage, and the provider's own word is that the limit is close.
    if (used === null) {
      if (w.projected.state === 'tight') tight = warned = true;
      continue;
    }
    if (w.pace.perHour === null || w.resetsAt === null) continue;
    // The pace as it was measured (a view made by hand may carry only the rounded one).
    const pace = finite(w.rawPerHour) ? w.rawPerHour : w.pace.perHour;
    const reach = pace > 0 ? Math.round(w.readAt + ((line - used) / pace) * HOUR) : null;
    if (reach !== null && reach < w.resetsAt) {
      const late = reach < now;
      const from = Math.max(reach, now);
      raw.push({ from, to: w.resetsAt, sure: w.projected.sure === true && !late, win: w, parts: [{ win: w, line, atLine: false, solid: onCourse(w, line, reach, now), late, from, to: w.resetsAt }] });
    } else if (w.projected.atReset !== null && w.projected.atReset >= line - RULES.nearLine) {
      tight = true;
      if (!w.projected.sure) sure = false;
    }
  }
  const blocks = mergeBlocks(raw);
  const hard = mergeBlocks(raw.filter(b => b.parts[0].atLine));
  const solid = mergeBlocks(raw.filter(b => b.parts[0].solid));
  if (hard.length) return { state: 'out', reachesLimitAt: now, sure: true, late: null, warned, blocks, hard, solid };
  if (blocks.length) {
    const first = blocks[0];
    const late = first.from <= now ? (first.parts.find(p => p.late)?.win ?? null) : null;
    return { state: 'short', reachesLimitAt: first.from, sure: blocks.every(b => b.sure), late, warned, blocks, hard, solid };
  }
  return { state: tight ? 'tight' : 'fine', reachesLimitAt: null, sure, late: null, warned, blocks: [], hard: [], solid: [] };
}

// The stretches in which every one of the lists has a block (a business with nothing left): [{ from, to, sure, parts }]. A part is a
// window's own stretch, with its provider; only the parts that touch the stretch are kept.
function intersect(lists) {
  if (!lists.length || lists.some(l => !l.length)) return [];
  const tagged = b => b.parts.map(q => ({ ...q, provider: b.provider, block: b }));
  let pieces = lists[0].map(b => ({ from: b.from, to: b.to, sure: b.sure, parts: tagged(b) }));
  for (const list of lists.slice(1)) {
    const next = [];
    for (const p of pieces) {
      for (const b of list) {
        const from = Math.max(p.from, b.from);
        const to = p.to === null ? b.to : b.to === null ? p.to : Math.min(p.to, b.to);
        if (to !== null && to <= from) continue;
        next.push({ from, to, sure: p.sure && b.sure, parts: [...p.parts, ...tagged(b)] });
      }
    }
    pieces = next;
  }
  return pieces
    .map(p => ({ ...p, parts: p.parts.filter(q => q.from < endOf(p) && endOf(q) > p.from) }))
    .sort((a, b) => a.from - b.from);
}

// A stretch in which every lead is blocked, as the sentences and the alerts need it. `out`: it has begun. The window that decides it (the
// key of its alert): for one that has begun the window that lets the first lead back (of the lead whose block ends first, the part that
// ends last); for one to come the window that takes the last lead away (of the lead whose block begins last, the part that begins first).
function pieceOf(p, now) {
  const out = p.from <= now;
  const byLead = new Map();
  for (const q of p.parts) if (q.win) byLead.set(q.provider, [...(byLead.get(q.provider) ?? []), q]);
  const groups = [...byLead.values()];
  const owner = out
    ? groups.map(g => g.reduce((a, c) => (endOf(c) > endOf(a) ? c : a))).sort((x, y) => endOf(x.block) - endOf(y.block))[0]
    : groups.map(g => g.reduce((a, c) => (c.from < a.from ? c : a))).sort((x, y) => y.block.from - x.block.from)[0];
  return { from: p.from, to: p.to, sure: p.sure, out, provider: owner?.provider ?? '', window: owner?.win?.id ?? '', win: owner?.win ?? null, parts: p.parts };
}

// One business. input:
//   business   { id, name, status, leads: [ref], kinds, lines, allowApi, projects } (a record of lib/business.mjs)
//   overlay    its overlay (kinds, lines, allowApi) or null
//   teamKinds  [{ id, workers: [ref] }] the team's own lists (the models of kinds the business does not list itself)
//   teamLine   the team's skipAbovePercent (a number or null)
//   subs       { <provider>: { label, windows: [window view], note } }
//   usable     (ref, lines) -> false when the program is missing or signed out (the team's availability), else true
// A routine starts only on the business's LEADS (lib/routines.mjs), so the leads alone decide "nothing left" and "takes over". The models of
// its kinds are helpers for handed-over tasks: they are listed (role 'team') and never make the business short or out.
// Beside what the page gets (id, name, state, say, providers, next) the view carries what the alerts need: paused, chain, helpers,
// leadLabels, leads (each lead's blocks), firm (the stretches with nothing left that facts and solid projections give), alarms (the ones
// worth an alert, each { level, from, to, provider, window, win, parts }) and dry (the stretch the sentence is about, or null).
export function businessView({ business: b, overlay, teamKinds = [], teamLine = null, subs, usable = () => true, now = Date.now() }) {
  const lines = isObject(overlay?.lines) ? overlay.lines : isObject(b.lines) ? b.lines : {};
  const allowApi = (overlay ? overlay.allowApi : b.allowApi) === true;
  const kinds = isObject(overlay?.kinds) ? overlay.kinds : isObject(b.kinds) ? b.kinds : null;
  const lineOf = provider => (finite(lines[provider]) && lines[provider] >= 1 && lines[provider] <= 100 ? lines[provider] : finite(teamLine) && teamLine >= 1 && teamLine <= 100 ? teamLine : 100);
  const leadRefs = (b.leads ?? []).filter(ref => typeof ref === 'string' && ref.includes(':'));
  const lists = kinds ? Object.values(kinds).map(k => k?.workers ?? []) : teamKinds.map(k => k?.workers ?? []);
  const helperRefs = [];
  for (const workers of lists) if (typeof workers[0] === 'string') helperRefs.push(workers[0]);
  for (const workers of lists) for (const ref of workers.slice(1)) if (typeof ref === 'string') helperRefs.push(ref);
  const rows = [];
  const seen = new Set();
  const none = { reachesLimitAt: null, late: null, warned: false, blocks: [], hard: [], solid: [] };
  const row = (ref, role) => {
    const provider = providerOf(ref);
    if (!provider || seen.has(provider)) return null;
    const sub = subs[provider];
    // A model billed per token is no part of a business's plans until the business allows it.
    if (!sub && !allowApi && role === 'team') return null;
    seen.add(provider);
    const line = lineOf(provider);
    let view;
    if (sub) view = providerAgainst(sub.windows, line, now);
    else if (allowApi) view = { ...none, state: 'fine', sure: true };
    else view = { ...none, state: 'unknown', sure: false };
    // A lead that cannot run at all (missing, signed out, no key, not offered, or billed per token and not allowed) is blocked for ever.
    const cannot = role === 'lead' && (usable(ref, lines) === false || (!sub && !allowApi));
    if (cannot) {
      const forever = [{ from: now, to: null, sure: true, win: null, parts: [{ win: null, line, atLine: true, solid: true, late: false, from: now, to: null }] }];
      view = { state: 'out', reachesLimitAt: now, sure: view.sure, late: null, warned: false, blocks: forever, hard: forever, solid: forever };
    }
    const tag = list => list.map(x => ({ ...x, provider }));
    const r = { provider, label: sub?.label ?? LABELS[provider] ?? provider, role, limitPercent: line, state: view.state, reachesLimitAt: view.reachesLimitAt, sure: view.sure, late: view.late, warned: view.warned === true, ref, blocks: tag(view.blocks), hard: tag(view.hard), solid: tag(view.solid), cannot, noReading: !sub || sub.windows.length === 0, noPercent: Boolean(sub) && sub.windows.length > 0 && sub.windows.every(w => w.usedPercent === null) };
    rows.push(r);
    return r;
  };
  const leads = leadRefs.map(ref => row(ref, 'lead')).filter(Boolean);
  for (const ref of helperRefs) row(ref, 'team');
  const name = b.name;
  const paused = b.status === 'paused';
  let dry = null;
  let firm = [];
  let alarms = [];
  const view = (state, say, next = null) => ({
    id: b.id,
    name,
    state,
    say,
    providers: rows.map(({ provider, label, role, limitPercent, state: s, reachesLimitAt, sure }) => ({ provider, label, role, limitPercent, state: s, reachesLimitAt, sure })),
    next,
    paused,
    chain: leads.map(l => l.provider),
    helpers: rows.filter(r => r.role === 'team').map(r => ({ provider: r.provider, label: r.label })),
    leadLabels: leads.map(l => ({ provider: l.provider, label: l.label })),
    leads: leads.map(l => ({ provider: l.provider, label: l.label, cannot: l.cannot, blocks: l.blocks, solid: l.solid })),
    firm,
    alarms,
    dry,
  });
  if (!leadRefs.length) return view('unknown', `${name} has no lead chosen yet, so there is no plan use to watch.`);
  if (!leads.length) return view('unknown', `${name} runs on no plan that Plenum can watch.`);
  const early = ' This is an early estimate.';
  const stuck = leads.filter(l => l.cannot);
  const onPlan = leads.filter(l => !l.cannot);
  // No lead can run, and plan use is not the reason: this is said, and it is no matter for a plan alert.
  if (!onPlan.length) return view('out', `${name} cannot run now: ${list(stuck.map(l => l.label))} ${stuck.length === 1 ? 'is' : 'are'} not ready to run. Plan use is not the reason.`);
  const too = stuck.length ? `, and ${list(stuck.map(l => l.label))} cannot run now` : '';
  const labels = list(onPlan.map(l => l.label));
  const be = onPlan.length === 1 ? 'is' : 'are';
  const stretches = key => intersect(leads.map(l => l[key])).filter(p => p.to === null || p.to - p.from >= RULES.blockMin).map(p => pieceOf(p, now));
  const all = stretches('blocks');
  firm = stretches('solid');
  const factNow = leads.every(l => l.hard.length > 0);
  const cover = factNow ? firm.find(p => p.from <= now) ?? null : null;
  const lasts = p => p.to === null || p.to - Math.max(p.from, now) >= RULES.alertOutMin;
  alarms = [
    ...(cover && lasts(cover) ? [{ ...cover, level: 'out' }] : []),
    ...firm.filter(p => p.from > now && p.sure === true && lasts(p)).map(p => ({ ...p, level: 'short' })),
  ];
  const waitOf = p => (p.to !== null ? ` Nothing is left until ${fmtTime(p.to, now)}.` : ' No reset time was reported.');
  const dryOf = p => ({ dryAt: p.from, until: p.to, sure: p.sure, provider: p.provider || leads[0].provider, window: p.window, win: p.win, parts: p.parts.map(q => ({ provider: q.provider, win: q.win, line: q.line, atLine: q.atLine, solid: q.solid })), out: p.out });
  // Nothing left now: every lead is at its line by its own reading.
  if (cover) {
    dry = dryOf(cover);
    return view('out', `${name} has nothing left now: ${labels} ${be} at your line${too}.${waitOf(cover)}`);
  }
  // Nothing left later (or perhaps already, when a reading is old): the first stretch in which every lead is blocked.
  const piece = all[0] ?? null;
  if (piece) {
    dry = { ...dryOf(piece), out: false };
    if (piece.from <= now) return view('short', `${name} may have nothing left by now: at the pace of the last readings ${labels} would be at your line${too}.${waitOf(piece)}${early}`);
    return view('short', `${name} runs out of plan use about ${fmtTime(piece.from, now)}: ${labels} will be at your line${too}.${waitOf(piece)}${piece.sure ? '' : early}`);
  }
  const first = leads[0];
  const dead = r => r.state === 'out' || r.state === 'short';
  const startOf = first.blocks[0]?.from ?? now;
  const takeOver = leads.slice(1).find(r => !r.cannot && !coversAt(r.blocks, startOf)) ?? null;
  const nextOf = r => (r ? { ref: r.ref, label: r.label } : null);
  const unsure = first.state !== 'unknown' && first.state !== 'fine' && first.sure === false ? early : '';
  if (dead(first)) {
    const line = lineText(first.limitPercent);
    const when = first.cannot ? `${first.label} cannot run now.`
      : first.state === 'out' ? `${first.label} is at your ${line}% line.`
      : first.late ? `${first.label} may be at your ${line}% line by now: its last reading is ${fmtDuration(now - first.late.readAt)} old.`
      : `${first.label} reaches your ${line}% line about ${fmtTime(first.reachesLimitAt, now)}.`;
    const how = takeOver ? ` ${takeOver.label} takes over${first.state === 'out' || first.late ? '' : ' then'}.${takeOver.state === 'unknown' && takeOver.noReading ? ' Its use is not reported.' : ''}` : '';
    return view('tight', `${when}${how}${first.late ? '' : unsure}`, nextOf(takeOver));
  }
  if (first.state === 'tight' && first.warned) return view('tight', takeOver ? `${first.label} says it is close to its limit. ${takeOver.label} takes over when it is used up.` : `${first.label} says it is close to its limit. It gives no percentage, so Plenum cannot tell when ${name} would run out.`, nextOf(takeOver));
  if (first.state === 'tight') return view('tight', `${first.label} may get close to your ${lineText(first.limitPercent)}% line before it resets.${unsure}`, nextOf(takeOver));
  // The provider reports its limits with no percentage (Claude Code often does): what is known is said, and nothing is projected.
  if (first.state === 'unknown' && first.noPercent) return view('unknown', `Plenum cannot tell for ${name}: ${first.label} reports whether it is within its limits, and no percentage.`);
  if (first.state === 'unknown') return view('unknown', `Plenum cannot tell yet for ${name}. ${subs[first.provider]?.note ?? `${first.label} has not reported its use.`}`);
  const known = leads.filter(l => l.state !== 'unknown');
  const names = list(known.map(l => l.label));
  const unknown = leads.filter(l => l.state === 'unknown').slice(0, 2).map(l => subs[l.provider]?.note).filter(Boolean);
  return view('fine', `${name} is fine: ${names} ${known.length === 1 ? 'is' : 'are'} not projected to reach your line before ${known.length === 1 ? 'it resets' : 'they reset'}.${unknown.length ? ` ${unknown.join(' ')}` : ''}`);
}

// What an alert about one window of `provider` means for one business: { kind: 'nothing' | 'takes' | 'team', text, piece? }, or null when
// the business is not touched. nothing: that window leaves the business with no lead (piece: that stretch): it is part of a stretch that
// has begun, or it is the window that takes the last lead away in one to come. takes: another lead goes on when this one stops.
// A paused business has no runs to lose and is never named.
export function effectOf(view, provider, windowId, now = Date.now()) {
  if (view.paused) return null;
  if (view.chain.includes(provider)) {
    const mine = q => q.provider === provider && q.win?.id === windowId;
    const piece = (view.firm ?? []).find(p => p.parts.some(mine) && (p.out || (p.provider === provider && p.window === windowId))) ?? null;
    if (piece) return { kind: 'nothing', text: piece.to !== null ? `nothing is left until ${fmtTime(piece.to, now)}` : 'nothing is left until it resets', piece };
    const lead = (view.leads ?? []).find(l => l.provider === provider);
    const part = lead?.solid.flatMap(x => x.parts).find(q => q.win?.id === windowId) ?? null;
    const at = Math.max(part?.from ?? now, now) + RULES.blockMin;
    const other = (view.leads ?? []).find(l => l.provider !== provider && !l.cannot && !coversAt(l.blocks, at));
    return { kind: 'takes', text: other ? `${other.label} takes over` : 'it runs on this plan' };
  }
  const helper = view.helpers.find(h => h.provider === provider);
  if (helper) return { kind: 'team', text: `its team does without ${helper.label}` };
  return null;
}

// ---------- alerts ----------

// One line for a channel that shows no title: the title, a full stop and the text, cut at a sentence end or a word end with "…" and never
// inside the title; at most 240 characters. With no title it is the text alone.
export function cutNotice(title, text) {
  const head = title ? `${title}. ` : '';
  const full = `${head}${text}`;
  if (full.length <= RULES.noticeMax) return full;
  const room = RULES.noticeMax - head.length - 1;
  if (room < 20) return `${title.slice(0, RULES.noticeMax - 1).replace(/\s+\S*$/, '')}…`;
  const slice = text.slice(0, room);
  const stop = slice.lastIndexOf('. ');
  if (stop >= 20) return `${head}${slice.slice(0, stop + 1)}…`;
  const space = slice.lastIndexOf(' ');
  return `${head}${(space >= 20 ? slice.slice(0, space) : slice).replace(/[\s,;:.]+$/, '')}…`;
}

// "This affects A (effect), B (effect) and 2 more." in the order nothing left, takes over, team; at most three named.
function effectsSentence(affected) {
  if (!affected.length) return 'No business of yours runs on it.';
  const order = { nothing: 0, takes: 1, team: 2 };
  const sorted = [...affected].sort((a, b) => order[a.kind] - order[b.kind]);
  const named = sorted.slice(0, RULES.namedMax).map(a => `${a.name} (${a.text})`);
  const more = sorted.length - named.length;
  return `This affects ${list(more > 0 ? [...named, `${more} more`] : named)}.`;
}

const levelOf = state => (state === 'short' ? 'short' : state === 'out' ? 'out' : null);
const titleFor = (level, names) => (level === 'short'
  ? (names.length === 1 ? `${names[0]} will run out of plan use` : `${names.length} businesses will run out of plan use`)
  : (names.length === 1 ? `${names[0]} has no plan use left` : `${names.length} businesses have no plan use left`));

// The words of a WINDOW alert. affected: [{ name, kind, text }]. When a business is left with nothing the title is about the business.
export function alertText(sub, win, level, affected, now = Date.now()) {
  const name = lower(win.name);
  const who = LABELS[sub.provider] ?? sub.label;
  const reset = win.resetsAt !== null ? fmtTime(win.resetsAt, now) : '';
  const effects = effectsSentence(affected);
  const nothing = affected.filter(a => a.kind === 'nothing').map(a => a.name);
  let title;
  let text;
  if (level === 'out') {
    const used = `${who}'s ${name} is used up.`;
    const when = reset ? `It resets ${reset}.` : 'No reset time was reported.';
    if (nothing.length) {
      title = titleFor('out', nothing);
      text = `${used} ${when} ${effects}`;
    } else {
      title = `${who}'s ${name} is used up`;
      text = `${when} ${effects}`;
    }
    return { title, text, notice: cutNotice(title, text) };
  }
  const basis = win.pace.basis === 'recent' ? (win.minutes !== null && win.minutes > RULES.longAboveMin ? 'the last day' : 'the last 2 hours') : 'this whole period';
  text = `At the pace of ${basis}, ${who}'s ${name} is used up ${fmtTime(win.projected.usedUpAt, now)}, ${fmtDuration(win.resetsAt - win.projected.usedUpAt)} before it resets (${reset}). ${effects}`;
  if (nothing.length) {
    title = titleFor('short', nothing);
    return { title, text, notice: cutNotice(title, text) };
  }
  title = `${who}'s ${name} may run out`;
  return { title, text, notice: cutNotice('', text) };
}

// The words of a BUSINESS alert about one of its alarms (a stretch with nothing left that is worth an alert).
export function businessAlertText(view, alarm, now = Date.now()) {
  const onPlan = view.leads.filter(l => !l.cannot).map(l => l.label);
  const stuck = view.leads.filter(l => l.cannot).map(l => l.label);
  const wait = alarm.to !== null ? `Nothing is left until ${fmtTime(alarm.to, now)}.` : 'No reset time was reported.';
  const title = titleFor(alarm.level, [view.name]);
  const text = alarm.level === 'out'
    ? `${list(onPlan)} ${onPlan.length === 1 ? 'is' : 'are'} at your line${stuck.length ? `, and ${list(stuck)} cannot run now` : ''}. ${wait}`
    : `About ${fmtTime(alarm.from, now)}, when ${list(onPlan)} ${onPlan.length === 1 ? 'reaches your line' : 'are all at your line'}${stuck.length ? ` (${list(stuck)} cannot run now)` : ''}. ${wait}`;
  return { title, text, notice: cutNotice(title, text) };
}

// Whether a business has a stretch to come with nothing left that is worth an alert (businessView works it out: view.alarms).
export const businessWorthy = view => (view.alarms ?? []).some(a => a.level === 'short');

// The alerts to make now, in the order window short, window out, business short, business out; each is { key, alert }, or
// { key, silent: true } for a business alert that a window alert of this round already says (its key is spent, nothing is made).
//   subs        { <provider>: { label, windows } }       views  the business views (paused ones are not named, and make none)
//   periodKeys  { 'provider|window': period key }
// Keys: provider|window|period|level for a window; biz|id|provider|window|period|level for a business (no reset time: the day number).
// A limit that is used up, or a business with nothing left, is told only when that lasts 30 minutes or more (or no end is known).
export function newAlerts({ subs, views, periodKeys, fired, alertsOn, now = Date.now() }) {
  if (!alertsOn) return [];
  const made = [];
  const taken = new Set(Object.keys(fired));
  const named = new Set(); // the stretches (of a business) that a window alert of this round already says
  const windowAlerts = [];
  for (const [provider, sub] of Object.entries(subs)) {
    for (const win of sub.windows) {
      const level = levelOf(win.projected.state);
      if (!level || win.projected.sure !== true || win.stale) continue;
      if (level === 'short' && !alertWorthy(win, now)) continue;
      if (level === 'out' && win.resetsAt !== null && win.resetsAt - now < RULES.alertOutMin) continue;
      const period = periodKeys[`${provider}|${win.id}`] ?? '';
      const key = `${provider}|${win.id}|${period}|${level}`;
      if (taken.has(key)) continue;
      taken.add(key);
      const affected = views.map(v => ({ v, e: effectOf(v, provider, win.id, now) })).filter(x => x.e !== null).map(({ v, e }) => ({ name: v.name, id: v.id, kind: e.kind, text: e.text, piece: e.piece ?? null }));
      for (const a of affected) if (a.kind === 'nothing') named.add(a.piece);
      const { title, text, notice } = alertText({ provider, label: sub.label }, win, level, affected, now);
      windowAlerts.push({ key, level, alert: { level, provider, window: win.id, business: '', period, title, text, notice, at: now, businesses: affected.map(a => a.name), seen: false } });
    }
  }
  for (const level of ['short', 'out']) for (const w of windowAlerts) if (w.level === level) made.push({ key: w.key, alert: w.alert });
  const day = String(Math.floor(now / DAY));
  for (const level of ['short', 'out']) {
    for (const v of views) {
      if (v.paused) continue;
      for (const alarm of v.alarms ?? []) {
        if (alarm.level !== level) continue;
        const period = (alarm.win && periodKeys[`${alarm.provider}|${alarm.window}`]) || day;
        const key = `biz|${v.id}|${alarm.provider}|${alarm.window}|${period}|${level}`;
        if (taken.has(key)) continue;
        taken.add(key);
        // The same stretch as a window alert of this round names: one alert is enough.
        if ((v.firm ?? []).some(p => named.has(p) && p.from === alarm.from && p.to === alarm.to)) {
          made.push({ key, silent: true });
          continue;
        }
        const { title, text, notice } = businessAlertText(v, alarm, now);
        made.push({ key, alert: { level, provider: '', window: '', business: v.id, period, title, text, notice, at: now, businesses: [v.name], seen: false } });
      }
    }
  }
  return made;
}

// ---------- the instance ----------

const asFn = v => (typeof v === 'function' ? v : () => v);
const withLimit = (promise, ms) => {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The reading took too long.')), ms); });
  return Promise.race([Promise.resolve(promise), limit]).finally(() => clearTimeout(timer));
};
const SIGNED_OUT = /not (installed or )?signed in|is not installed/i;
// A program's own error sentence as it may be kept and shown: when it holds an e-mail address or a key-shaped string only the part before
// the first colon is kept; at most 160 characters.
function plainSentence(text) {
  const secret = /\S+@\S+|\b[\w-]{24,}\b/;
  let out = text;
  if (secret.test(out)) {
    const colon = out.indexOf(':');
    out = colon > 0 ? `${out.slice(0, colon).trim()}.` : out.replace(new RegExp(secret.source, 'g'), '').replace(/\s{2,}/g, ' ').trim();
  }
  return out.slice(0, RULES.errorMax);
}

export function createPlanWatch(deps = {}) {
  const d = {
    dir: deps.dir ?? process.env.MUSE_CONSOLE_HOME ?? path.join(os.homedir(), '.muse-console'),
    now: deps.now ?? (() => Date.now()),
    env: deps.env ?? process.env,
    termsOk: deps.termsOk ?? (() => false),
    setTimer: deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }),
    clearTimer: deps.clearTimer ?? (t => clearTimeout(t)),
    publish: deps.publish ?? (ev => publishEvent(ev)),
    // The desktop shell hears only state events, so a round that made an alert also publishes one (as lib/setup.mjs does for needsYou).
    publishState: deps.publishState ?? (reason => publishStateEvent(reason)),
    roundMs: deps.roundMs ?? ROUND_MS,
    firstMs: deps.firstMs ?? FIRST_ROUND_MS,
    readLimitMs: deps.readLimitMs ?? READ_LIMIT_MS,
    askLimitMs: deps.askLimitMs ?? ASK_LIMIT_MS,
    write: deps.write ?? writeFileAtomic,
    quota: deps.quota ?? null,
    business: deps.business ?? null,
    team: deps.team ?? null,
    accounts: deps.accounts ?? null,
    running: deps.running ?? null,
  };
  const file = path.join(d.dir, 'plan-use.json');

  let rec = null; // the record in force
  let newer = false; // a file of a newer version: read, never written
  let timer = null;
  let nextAt = null;
  let started = false;
  let flight = null;
  let checking = false;
  let note = '';
  let noteAt = 0;
  let rounds = 0;
  let queue = Promise.resolve();
  let dirty = false;
  let failedOnce = false;
  let lastSignature = '';
  let owed = false; // a page was answered while a round ran
  let currentSig = ''; // which alerts still hold, as of the last round: part of what the page is told
  let alertSeq = 0;
  let latest = null;
  const usableMemo = new Map(); // ref -> whether the team said the lead can run, as of the last round
  const mem = {}; // provider -> { entry, at } (the last answer of the meter in this run)
  const modules = {};

  const blank = () => ({ v: VERSION, settings: { ...DEFAULT_SETTINGS }, subs: {}, alerts: [], fired: {} });

  function migrate(raw) {
    const out = blank();
    if (!isObject(raw)) return out;
    try {
      out.settings = cleanSettings(isObject(raw.settings) ? raw.settings : {}, DEFAULT_SETTINGS);
    } catch {
      out.settings = { ...DEFAULT_SETTINGS };
    }
    for (const [provider, s] of Object.entries(isObject(raw.subs) ? raw.subs : {})) {
      if (!isObject(s)) continue;
      const sub = { checkedAt: finite(s.checkedAt) ? s.checkedAt : null, askedAt: finite(s.askedAt) ? s.askedAt : null, requestAt: finite(s.requestAt) ? s.requestAt : null, calm: whole(s.calm, 0, CALM_MAX) ? s.calm : 0, source: typeof s.source === 'string' ? s.source : 'none', note: typeof s.note === 'string' ? s.note : '', windows: {} };
      for (const [id, w] of Object.entries(isObject(s.windows) ? s.windows : {})) {
        if (!isObject(w) || typeof w.name !== 'string' || !Array.isArray(w.periods)) continue;
        const periods = w.periods
          .filter(p => isObject(p) && Array.isArray(p.points))
          .map(p => ({ key: String(p.key ?? ''), resetsAt: finite(p.resetsAt) ? p.resetsAt : null, startedAt: finite(p.startedAt) ? p.startedAt : 0, points: p.points.filter(pt => Array.isArray(pt) && finite(pt[0]) && finite(pt[1])).map(pt => [pt[0], pt[1]]) }))
          .filter(p => p.points.length);
        sub.windows[id] = { name: w.name.slice(0, 80), minutes: minutesOf(w.name), seenAt: finite(w.seenAt) ? w.seenAt : 0, reached: w.reached === true, unmeasured: isObject(w.unmeasured) ? { status: String(w.unmeasured.status ?? ''), resetsAt: finite(w.unmeasured.resetsAt) ? w.unmeasured.resetsAt : null } : null, periods };
      }
      out.subs[provider] = sub;
    }
    out.alerts = (Array.isArray(raw.alerts) ? raw.alerts : [])
      .filter(a => isObject(a) && typeof a.id === 'string' && (a.level === 'short' || a.level === 'out') && typeof a.text === 'string')
      .map(a => ({ id: a.id, level: a.level, provider: String(a.provider ?? ''), window: String(a.window ?? ''), business: String(a.business ?? ''), period: typeof a.period === 'string' ? a.period : '', title: String(a.title ?? ''), text: a.text, notice: typeof a.notice === 'string' && a.notice ? a.notice : cutNotice(String(a.title ?? ''), a.text), at: finite(a.at) ? a.at : 0, businesses: Array.isArray(a.businesses) ? a.businesses.map(String).slice(0, 20) : [], seen: a.seen === true }))
      .slice(0, RULES.maxAlerts);
    out.fired = isObject(raw.fired) ? Object.fromEntries(Object.entries(raw.fired).filter(([, t]) => finite(t)).slice(-RULES.maxFired)) : {};
    return out;
  }

  async function load() {
    if (rec) return rec;
    let text = null;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') console.error(`The plan-use history could not be read: ${err?.code ?? err?.message}. Plenum starts a new one.`);
    }
    let raw = null;
    if (text !== null) {
      try {
        raw = JSON.parse(text);
      } catch {
        // Damaged: a new history starts, and the damaged file is kept once beside it.
        await fsp.copyFile(file, `${file}.bad`).catch(() => {});
      }
    }
    if (rec) return rec;
    rec = migrate(raw);
    newer = isObject(raw) && Number(raw.v) > VERSION;
    return rec;
  }

  function save() {
    if (newer) return queue;
    dirty = true;
    queue = queue.then(async () => {
      if (!dirty) return;
      dirty = false;
      try {
        await fsp.mkdir(d.dir, { recursive: true });
        await d.write(file, `${JSON.stringify(rec)}\n`);
        failedOnce = false;
      } catch (err) {
        dirty = true;
        if (!failedOnce) {
          failedOnce = true;
          console.error(`The plan-use history could not be written: ${err?.code ?? err?.message}. Plenum keeps it and tries again.`);
        }
      }
    });
    return queue;
  }

  // ----- neighbours (loaded on first use, inside a function) -----
  async function mod(name, load) {
    if (modules[name] === undefined) modules[name] = await load().catch(() => null);
    return modules[name];
  }
  async function quotaMod() {
    return d.quota ?? (await mod('quota', () => import('./quota.mjs').then(m => ({ read: () => m.readQuota(), refresh: (p, r) => m.refreshQuota(p, r) }))));
  }
  async function businessMod() {
    return d.business ?? (await mod('business', () => import('./business.mjs')));
  }
  async function teamMod() {
    return d.team ?? (await mod('team', () => import('./team.mjs')));
  }
  async function accountsNow() {
    try {
      if (d.accounts) return (await asFn(d.accounts)()) ?? null;
      const m = await mod('provider-status', () => import('./provider-status.mjs'));
      return m?.knownProviders?.() ?? null;
    } catch {
      return null;
    }
  }
  async function runningNow() {
    try {
      if (d.running) return new Set(await asFn(d.running)());
      const m = await mod('activity', () => import('./activity.mjs'));
      return new Set((m?.snapshot?.().runs ?? []).map(r => providerOf(r.model)).filter(Boolean));
    } catch {
      return new Set();
    }
  }

  // ----- what the watch is doing -----
  const offByEnv = () => d.env.PLENUM_NO_SCHEDULER === '1' || d.env.PLENUM_SMOKE === '1';
  const settings = () => (rec ? rec.settings : DEFAULT_SETTINGS);
  const termsOk = () => {
    try {
      return d.termsOk() === true;
    } catch {
      return false;
    }
  };
  function why() {
    if (offByEnv()) return d.env.PLENUM_SMOKE === '1' && d.env.PLENUM_NO_SCHEDULER !== '1' ? 'Automatic checks are off in smoke mode.' : 'Automatic checks are off for this start.';
    if (!termsOk()) return 'Automatic checks start after you accept the License Agreement.';
    if (settings().on === false) return 'Automatic checks are switched off.';
    return '';
  }
  const watching = () => why() === '';

  // ----- recording a reading -----
  const subOf = provider => (rec.subs[provider] ??= { checkedAt: null, askedAt: null, requestAt: null, calm: 0, source: 'none', note: '', windows: {} });

  // The newest value of each window, for "was use seen": { id: [period key, percent, reached, status] }.
  const valuesOf = sub => Object.fromEntries(Object.entries(sub.windows).map(([id, w]) => {
    const cur = lastOf(w.periods) ?? null;
    return [id, [cur ? cur.key : '', cur && cur.points.length ? lastOf(cur.points)[1] : null, w.reached === true, w.unmeasured?.status ?? '']];
  }));
  // Whether use was seen between two such pictures: a window that is new, a value that rose inside its period, a new period that does not
  // begin at nothing, or a limit whose word changed. A window that only reset (a new period at 0) is no use: a request of the watch itself
  // can begin one.
  function moved(before, after) {
    for (const [id, v] of Object.entries(after)) {
      const was = before[id];
      if (!was || v[2] !== was[2] || v[3] !== was[3]) return true;
      if (v[0] === was[0] ? (v[1] ?? 0) > (was[1] ?? 0) : (v[1] ?? 0) > 0) return true;
    }
    return false;
  }
  // How long the watch waits between two requests that cost plan use: the time the person chose, doubled for each request in a row that
  // found nothing moved, and never more than 6 hours (or the chosen time, when that is longer).
  const everyOf = (sub, s) => Math.min(s.paidEveryMin * 2 ** (sub?.calm ?? 0), Math.max(s.paidEveryMin, PAID_RANGE.max)) * MIN;

  function ingest(provider, entry, now) {
    const sub = subOf(provider);
    const before = valuesOf(sub);
    let changed = false;
    const observedAt = finite(entry?.observedAt) ? entry.observedAt : now;
    const windows = Array.isArray(entry?.windows) ? entry.windows : [];
    const loose = Array.isArray(entry?.unmeasured) ? entry.unmeasured : [];
    for (const w of windows) {
      const id = slug(w.name);
      // A limit that Claude Code reported earlier keeps its own time; the reading's time is for the ones that have none.
      const r = recordReading(sub.windows[id] ?? null, { name: w.name, usedPercent: w.usedPercent, resetsAt: w.resetsAt, observedAt: finite(w.observedAt) ? w.observedAt : observedAt, reached: w.reached === true || w.usedPercent >= 100 }, now);
      sub.windows[id] = r.rec;
      changed = changed || r.changed;
    }
    for (const w of loose) {
      const id = slug(w.name);
      const r = recordReading(sub.windows[id] ?? null, { name: w.name, usedPercent: null, resetsAt: w.resetsAt ?? null, observedAt: finite(w.observedAt) ? w.observedAt : observedAt, reached: w.reached === true, status: w.status }, now);
      sub.windows[id] = r.rec;
      changed = changed || r.changed;
    }
    for (const w of Object.values(sub.windows)) tidy(w, now);
    // Use that was seen (in a reply or a request) ends the longer wait between requests.
    if (sub.calm && moved(before, valuesOf(sub))) {
      sub.calm = 0;
      changed = true;
    }
    const has = windows.length || loose.length;
    if (has && sub.checkedAt !== observedAt) {
      sub.checkedAt = observedAt;
      changed = true;
    }
    const source = !has ? (sub.windows && Object.keys(sub.windows).length ? sub.source : 'none') : PAID_PROVIDERS.includes(provider) ? (sub.requestAt === observedAt ? 'request' : 'replies') : REPORTING.includes(provider) ? 'free' : 'none';
    if (sub.source !== source) {
      sub.source = source;
      changed = true;
    }
    // Nothing came with this entry and the row still shows readings from before (a restart empties the meter, not this record).
    const kept = !has && Object.keys(sub.windows ?? {}).length > 0;
    const sentence = noteOf(provider, entry, source, kept);
    if (sub.note !== sentence) {
      sub.note = sentence;
      changed = true;
    }
    mem[provider] = { entry, at: now };
    return changed;
  }

  // How a reading that is shown came about, in one sentence.
  function howOf(provider, source) {
    const label = LABELS[provider] ?? provider;
    if (source === 'free') return `${label} is asked directly. This costs nothing.`;
    if (source === 'request') return `${label} reported this when Plenum sent one very small request.`;
    return `${label} reports this with its own replies, so it can be old.`;
  }

  // The one sentence of a row: how it is read, or why there is no reading. `kept`: the entry brought nothing and the row still shows
  // readings from before; then the sentence stays the one of the reading that is shown, unless the meter says why it could not read
  // (seen after a restart with real programs: a card with a reading of 19 minutes ago said "has not reported its plan use yet").
  function noteOf(provider, entry, source, kept = false) {
    const has = (Array.isArray(entry?.windows) && entry.windows.length) || (Array.isArray(entry?.unmeasured) && entry.unmeasured.length);
    if (has) return howOf(provider, source);
    if (NO_REPORT[provider]) return NO_REPORT[provider];
    const own = typeof entry?.note === 'string' ? entry.note.trim() : '';
    if (!own || /^Not seen yet/.test(own)) {
      if (kept && source !== 'none') return howOf(provider, source);
      // Only Claude Code and Muse Code are asked by a request; Codex is asked at no cost.
      return `${LABELS[provider] ?? provider} has not reported its plan use yet.${PAID_PROVIDERS.includes(provider) ? ' A check sends one very small request to ask.' : ''}`;
    }
    // The meter's own sentences end with "Refresh to try again."; the button is called Check now.
    return plainSentence(own.replace(/ ?Refresh to (ask|try again)\.?/g, '').trim()) || `${LABELS[provider] ?? provider} has not reported its plan use yet.`;
  }

  // ----- asking for a paid reading -----
  // Whether a request that costs plan use may be sent for this provider now (the reason it may not is returned as text, '' when it may).
  async function mayAsk(provider, reason, now, accounts, running) {
    const s = settings();
    // "Never" means never: neither the timer nor Check now sends a request then (a card's own Refresh is the person's and is not asked here).
    if (s.paidEveryMin === 0) return 'off';
    const sub = rec.subs[provider];
    if (running.has(provider)) return 'running';
    const acc = accounts?.[provider];
    if (acc && (acc.installed === false || acc.signedIn === false || acc.cliInstalled === false || acc.credentials === false)) return 'missing';
    if (provider === 'anthropic' && acc && acc.route && acc.route !== 'cli') return 'api';
    const entry = mem[provider]?.entry;
    if (entry && typeof entry.note === 'string' && /API key has rate limits|not installed or not signed in|not signed in/i.test(entry.note) && !(Array.isArray(entry.windows) && entry.windows.length)) return 'missing';
    const every = everyOf(sub, s);
    const gap = reason === 'user' ? USER_ASK_GAP_MS : Math.max(PAID_GAP_MS, every);
    if (sub?.askedAt && now - sub.askedAt < gap) return 'budget';
    if (reason === 'watch') {
      const newest = sub?.checkedAt ?? 0;
      if (newest && now - newest < every) return 'fresh';
    }
    return '';
  }

  async function ask(provider, reason, now) {
    const q = await quotaMod();
    const sub = subOf(provider);
    const askedBefore = sub.askedAt;
    // The time is kept before the request, so a restart in the middle does not ask again at once.
    sub.askedAt = now;
    // ... and it is on the disk before the request, so a restart in the middle does not ask again.
    await save();
    const before = valuesOf(sub);
    let entry;
    try {
      entry = await withLimit(q.refresh(provider, reason), d.askLimitMs);
    } catch {
      return { sent: false, held: false, failed: true };
    }
    const at = d.now();
    const held = typeof entry?.note === 'string' && /^Refreshed less than/.test(entry.note);
    // The meter held it back (a Refresh on a card was sooner): no request was sent, so the time of the last one stands.
    if (held) sub.askedAt = askedBefore;
    const newer = finite(entry?.observedAt) && entry.observedAt >= now - MIN;
    if (!held && newer) sub.requestAt = entry.observedAt;
    ingest(provider, entry, at);
    // A request of the watch that found nothing moved: the next one waits twice as long (ingest ends the wait when use is seen).
    if (reason === 'watch' && !held && newer && !moved(before, valuesOf(sub))) sub.calm = Math.min((sub.calm ?? 0) + 1, CALM_MAX);
    return { sent: !held, held, failed: false };
  }

  // ----- one round -----
  async function round(reason) {
    if (flight) return flight;
    // A round that fails still counts as tried, so a page that asks again does not start one after another.
    rounds += 1;
    flight = (async () => {
      checking = true;
      const told = { asked: [], held: [], waiting: [], skipped: [], never: [] };
      try {
        await load();
        const q = await quotaMod();
        const at = d.now();
        let answer = null;
        try {
          answer = await withLimit(q.read(), d.readLimitMs);
        } catch {
          answer = null;
        }
        const now = d.now();
        let changed = false;
        const providers = isObject(answer?.providers) ? answer.providers : {};
        for (const [provider, entry] of Object.entries(providers)) changed = ingest(provider, entry, now) || changed;
        const accounts = await accountsNow();
        for (const extra of EXTRA_PROVIDERS) {
          const acc = accounts?.[extra];
          if (acc?.signedIn === true && !providers[extra]) changed = ingest(extra, { unavailable: NO_REPORT[extra] }, now) || changed;
        }
        const running = await runningNow();
        for (const provider of PAID_PROVIDERS) {
          if (!Object.hasOwn(providers, provider)) continue;
          const wanted = reason === 'user' ? 'user' : 'watch';
          const block = await mayAsk(provider, wanted, d.now(), accounts, running);
          if (block === '') {
            const r = await ask(provider, wanted, d.now());
            if (r.sent) told.asked.push(provider);
            else if (r.held) told.held.push(provider);
            changed = true;
          } else if (reason === 'user') {
            if (block === 'running') told.waiting.push(provider);
            else if (block === 'off') told.never.push(provider);
            else if (block === 'budget' || block === 'fresh') told.held.push(provider);
            else told.skipped.push(provider);
          }
        }
        await settle();
      } catch (err) {
        console.error(`The plan watch could not finish a round: ${String(err?.message ?? err).split('\n')[0]}`);
      } finally {
        checking = false;
        flight = null;
      }
      return told;
    })();
    return flight;
  }

  // Whether an alert still holds, from the answer being built (never stored): a window alert while that window, in that period, is at its
  // level or worse and not stale; a business alert while that business is at its level or worse.
  function currentOf(a, built) {
    const holds = state => (a.level === 'out' ? state === 'out' : state === 'short' || state === 'out');
    if (a.business) {
      const v = built.viewsRaw.find(x => x.id === a.business);
      return v ? holds(v.state) : false;
    }
    const win = built.subsRaw[a.provider]?.windows.find(w => w.id === a.window);
    if (!win || win.stale) return false;
    if (a.period && built.periodKeys[`${a.provider}|${a.window}`] !== a.period) return false;
    return holds(win.projected.state);
  }

  // After a round: alerts, saving, and the events. The new alerts are made in the order window short, window out, business short, business
  // out; each is announced by an event in that order (the worst last, so planAlert ends on it) and one state event follows for the shell.
  async function settle() {
    const now = d.now();
    const built = await build(now, true);
    const fresh = newAlerts({ subs: built.subsRaw, views: built.viewsRaw, periodKeys: built.periodKeys, fired: rec.fired, alertsOn: settings().alerts, now });
    const made = [];
    for (const { key, alert: a, silent } of fresh) {
      rec.fired[key] = now;
      if (silent) continue;
      const full = { id: `a${now.toString(36)}${(alertSeq += 1).toString(36)}`, ...a };
      rec.alerts.unshift(full);
      made.push(full);
      latest = { seq: alertSeq, id: full.id, level: full.level, title: full.title, text: full.text, notice: full.notice, at: full.at };
    }
    if (fresh.length) {
      rec.alerts = rec.alerts.slice(0, RULES.maxAlerts);
      const keys = Object.entries(rec.fired).sort((a, b) => a[1] - b[1]);
      if (keys.length > RULES.maxFired) rec.fired = Object.fromEntries(keys.slice(-RULES.maxFired));
    }
    currentSig = JSON.stringify(rec.alerts.map(a => [a.id, currentOf(a, built)]));
    await save();
    // A page that was answered while the round ran was told checking: true, so it is told again even when nothing else changed.
    const force = owed;
    owed = false;
    if (made.length) {
      made.forEach((a, i) => announce(a, force || i > 0));
      try {
        d.publishState('plan');
      } catch {
        // The shell hears the next state.
      }
    } else {
      announce(null, force);
    }
  }

  // One event when what a person sees changed (or a new alert came). The signature leaves out the times that move by themselves.
  function announce(alert = null, force = false) {
    try {
      const sig = JSON.stringify([rec ? Object.entries(rec.subs).map(([p, s]) => [p, s.checkedAt, s.source, s.note, Object.entries(s.windows).map(([id, w]) => [id, w.seenAt, w.reached, w.periods.length && lastOf(w.periods).points.length && lastOf(lastOf(w.periods).points)[1]])]) : null, rec ? rec.alerts.map(a => [a.id, a.seen]) : null, currentSig, note, rec?.settings]);
      if (sig === lastSignature && !alert && !force) return;
      lastSignature = sig;
      d.publish(alert ? { type: 'plan-watch', alert: { id: alert.id, level: alert.level, title: alert.title, text: alert.text, notice: alert.notice } } : { type: 'plan-watch' });
    } catch {
      // An event that cannot be sent is skipped; the next change sends one.
    }
  }

  // ----- the answer -----
  // ask: only a round (not an answer to a GET) asks the team whether a lead can run; the team's answer may start a program to look at a sign-in,
  // and a GET starts none. An answer to a GET uses what the last round learned.
  async function build(now, ask = false) {
    await load();
    const accounts = await accountsNow();
    const subsRaw = {};
    const periodKeys = {};
    const rows = [];
    const providers = [...new Set([...ORDER.filter(p => Object.hasOwn(rec.subs, p) || ['anthropic', 'codex', 'muse', 'gemini'].includes(p)), ...Object.keys(rec.subs)])];
    for (const provider of providers) {
      const stored = rec.subs[provider];
      const entry = mem[provider]?.entry;
      const acc = accounts?.[provider];
      const windows = Object.entries(stored?.windows ?? {})
        .filter(([, w]) => w.seenAt >= now - RULES.keepMs)
        .map(([id, w]) => {
          const cur = lastOf(w.periods);
          if (cur) periodKeys[`${provider}|${id}`] = cur.key;
          return windowView(id, w, now);
        });
      const reads = Boolean(windows.length);
      const fresh = Array.isArray(entry?.windows) && entry.windows.length > 0;
      let signedIn = null;
      if (acc?.installed === false || acc?.cliInstalled === false) signedIn = false;
      else if (typeof acc?.signedIn === 'boolean') signedIn = acc.signedIn;
      else if (fresh) signedIn = true;
      else if (typeof entry?.note === 'string' && SIGNED_OUT.test(entry.note)) signedIn = false;
      if (provider === 'anthropic' && ((acc?.route && acc.route !== 'cli') || (typeof entry?.note === 'string' && /API key has rate limits/i.test(entry.note)))) signedIn = false;
      if (EXTRA_PROVIDERS.includes(provider) && signedIn !== true) continue;
      const source = reads ? stored.source : 'none';
      const rowNote = reads ? stored.note : noteOf(provider, entry, 'none');
      const label = LABELS[provider] ?? provider;
      const row = { provider, label, signedIn, source, checkedAt: reads ? stored.checkedAt : null, note: rowNote, state: worst(windows.map(w => w.projected.state)), windows: windows.map(({ readAt, stale, rawPerHour, status, ...rest }) => rest) };
      rows.push(row);
      subsRaw[provider] = { provider, label, windows, reports: REPORTING.includes(provider), note: rowNote, signedIn };
    }
    // The businesses.
    const viewsRaw = [];
    try {
      const bm = await businessMod();
      const tm = await teamMod();
      const all = typeof bm?.list === 'function' ? bm.list() : [];
      const team = typeof tm?.get === 'function' ? tm.get() : null;
      const teamLine = team?.limits?.skipAbovePercent ?? null;
      const labelOf = ref => {
        try {
          return tm?.labelOf?.(ref) ?? ref;
        } catch {
          return ref;
        }
      };
      for (const b of all) {
        if (!isObject(b) || b.status === 'closed') continue;
        let overlay = null;
        try {
          overlay = bm.overlayFor?.(Array.isArray(b.projects) ? b.projects[0] : null) ?? null;
        } catch {
          overlay = null;
        }
        const usable = (ref, lines) => {
          const known = usableMemo.get(ref);
          if (!ask) return known ?? true;
          try {
            const a = tm?.availability?.(ref, { lines });
            const ok = !(a && ['not-installed', 'sign-in', 'no-key', 'not-offered'].includes(a.state));
            usableMemo.set(ref, ok);
            return ok;
          } catch {
            return true;
          }
        };
        viewsRaw.push(businessView({ business: b, overlay, teamKinds: team?.kinds ?? [], teamLine, subs: subsRaw, usable, now }));
      }
    } catch {
      // A neighbour that cannot be read leaves the businesses out; the subscriptions are still answered.
    }
    // The labels of the models, for the one that takes over.
    const businesses = viewsRaw.map(({ id, name, state, say, providers, next }) => ({ id, name, state, say, providers, next }));
    return { rows, businesses, subsRaw, viewsRaw, periodKeys };
  }

  async function state() {
    await load();
    const now = d.now();
    // The first read of a run starts one round in the background; the answer does not wait for it.
    if (rounds === 0 && !flight && watching()) round('auto').catch(() => {});
    const built = await build(now);
    const s = settings();
    if (checking) owed = true;
    return {
      v: VERSION,
      at: now,
      on: watching(),
      why: why(),
      settings: { ...s },
      checking,
      nextCheckAt: timer !== null ? nextAt : null,
      note: note && now - noteAt < NOTE_KEEP_MS ? note : '',
      subs: built.rows,
      businesses: built.businesses,
      alerts: rec.alerts.map(a => ({ ...a, businesses: [...a.businesses], current: currentOf(a, built) })),
    };
  }

  // "Check now": one round of free readings, and the paid ones that keep to their budget.
  async function check() {
    await load();
    if (!termsOk()) {
      note = 'Plan use is not read until you accept the License Agreement.';
      noteAt = d.now();
      return state();
    }
    const told = await round('user');
    const labelList = names => list(names.map(p => LABELS[p] ?? p));
    const parts = [];
    if (told?.asked?.length) parts.push(`${labelList(told.asked)} sent one very small request just now.`);
    if (told?.held?.length) parts.push(told.held.length === 1 ? `${labelList(told.held)} is sent one very small request at most once an hour when you ask, so it was not asked again yet.` : `${labelList(told.held)} are sent one very small request at most once an hour when you ask, so they were not asked again yet.`);
    if (told?.never?.length) parts.push(told.never.length === 1 ? `${labelList(told.never)} was not asked, because checks that send a request are set to Never.` : `${labelList(told.never)} were not asked, because checks that send a request are set to Never.`);
    if (told?.waiting?.length) parts.push(told.waiting.length === 1 ? `${labelList(told.waiting)} was not asked, because a run of it is going and reports by itself.` : `${labelList(told.waiting)} were not asked, because runs of them are going and report by themselves.`);
    note = parts.join(' ');
    noteAt = d.now();
    announce();
    return state();
  }

  async function setSettings(patch) {
    await load();
    rec.settings = cleanSettings(patch, rec.settings);
    await save();
    // A switch that was turned on starts the timer again; one turned off ends it.
    if (started) {
      if (!watching()) disarm();
      else if (timer === null) arm(d.firstMs);
    }
    announce();
    return { ...rec.settings };
  }

  async function seen(id) {
    if (typeof id !== 'string' || !id || id.length > 80) throw badRequest('Send the id of the alert.');
    await load();
    const a = rec.alerts.find(x => x.id === id);
    if (a && !a.seen) {
      a.seen = true;
      await save();
      announce();
    }
    return { ok: true };
  }

  // ----- the timer -----
  function disarm() {
    if (timer !== null) d.clearTimer(timer);
    timer = null;
    nextAt = null;
  }
  function arm(ms) {
    disarm();
    timer = d.setTimer(onTimer, ms);
    nextAt = d.now() + ms;
  }
  async function onTimer() {
    timer = null;
    nextAt = null;
    if (!started) return;
    try {
      await load();
      // Before the terms are accepted, or with the watch off, a tick does nothing at all: no read, no file, no request.
      if (!termsOk()) return arm(TERMS_RECHECK_MS);
      if (settings().on === false) return;
      await round('auto');
    } catch {
      // The next tick tries again.
    }
    if (started && watching()) arm(d.roundMs);
  }

  function start() {
    if (started || offByEnv()) return false;
    started = true;
    arm(d.firstMs);
    return true;
  }
  function stop() {
    started = false;
    disarm();
  }

  return { state, check, setSettings, seen, start, stop, latestAlert: () => (latest ? { ...latest } : null), round, load, file, mayAsk, build, watching };
}

// ---------- the default instance ----------

let instance = null;
export function planWatch() {
  instance ??= createPlanWatch();
  return instance;
}
// server.mjs: the watcher of this run, with the answer to "are the terms accepted" and the data folder.
export function startPlanWatch({ accepted, dir } = {}) {
  instance = createPlanWatch({ ...(dir ? { dir } : {}), termsOk: accepted ?? (() => false) });
  return instance.start();
}
export const planState = () => planWatch().state();
export const checkPlanNow = () => planWatch().check();
export const setPlanSettings = patch => planWatch().setSettings(patch);
export const markPlanSeen = id => planWatch().seen(id);
export const latestPlanAlert = () => (instance ? instance.latestAlert() : null);
