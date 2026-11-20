// The owner-time meter (wave 8). The one number the owner and the council watch: how many of HIS minutes each business costs in a week.
// His limit is ten hours a week for all of them together. This module counts only what Plenum itself can see, says that it is an
// estimate, keeps the count in the data folder, and tells the leads to hold what can wait once the week's time is nearly used.
// It refuses nothing: no answer, no press and no Stop ever waits for it or is turned away by it.
//
// THE CONTRACT (build/v06/w8-owner-time pins each part):
//   createOwnerTime(deps) -> an instance; the default instance's functions are exported below under the same names.
//     deps: dir (the data folder), now, write (writeFileAtomic), publish, business and decisions (each a module, null, or a function
//           that answers one; left out, lib/business.mjs and lib/decisions.mjs are loaded on first use).
//   The file: business-owner-time.json in store.HOME (the data folder, beside businesses.json; never the program folder and never a
//     business's own folder, where a model could write it):
//     { v: 1, capMinutes, weeks: { '<YYYY-MM-DD, the Monday the week began>': { '<business id>': { queue, setup, charter, thread
//       (milliseconds each), answers, presses, floors } } }, last: { at } | null, seen: { '<business id>': at } }
//     Twelve weeks are kept. A file from a newer version is read and never written; one that cannot be understood is kept aside
//     (business-owner-time.damaged-<time>.json) and the count starts again.
//   mark({ what, item? | business? + kind? | project? }) -> a promise of { ok: true, counted, business, kind, floor? } or
//     { ok: false, counted: 0, why: 'bad-mark' | 'no-business' }. It never rejects and never throws.
//       what: 'open' (something of a business came up in front of him), 'active' (he moved, scrolled or pressed a key on it), 'type'
//             (he typed in a chat), 'press' (he pressed a button), 'answer' (he answered an item).
//       item: the number of an item of his list: the business and the kind come from the item (a setup step is 'setup', the proposal of
//             his instructions is 'charter', anything else 'queue'). business + kind: a press or activity that belongs to no item
//             (kind is 'setup' or 'charter', or 'queue'). project: a chat's folder; counted as 'thread' when it belongs to a business.
//     THE RULE: there is one clock for the one owner. A mark takes the time since the mark before it, when that is no more than two
//     minutes (IDLE_MS), and gives it to its own business and kind; a longer silence is cut whole. So no moment is counted twice, and
//     the total can never be more than the time that passed. An 'open' takes nothing: it starts the clock when it is not running. An
//     'answer' or a 'press' that found the clock stopped counts as FLOOR_MS (10 seconds), and the count of those is kept (floors). A mark
//     of now more than two minutes before the clock's last moment (the PC's clock was put back) starts the clock again from now.
//   start() -> a promise: listens to the businesses' changes and reads his answers from each business's own record (the 'decision' and
//     'outside' lines lib/decisions.mjs writes at the moment of his tap), so an answer from any window or phone is counted, once.
//     stop() ends it; idle() resolves when no reading is going on.
//   summary() -> a promise of { v, estimate: true, label, counts: [sentence], doesNotCount: [sentence], capMinutes, idleMinutes,
//     floorSeconds, holdPercent, percent, state: 'ok' | 'hold' | 'over', line ('' below 80%), nextBatch (ms), newer?,
//     thisWeek: { from, to, ms, minutes, businesses: [{ id, name, status, ms, minutes, queue, setup, charter, thread, answers, presses,
//     floors }], other: { ms, minutes } }, lastWeek: the same }. A week is Monday 00:00 to the next Monday, in the PC's own time.
//     other is the time of businesses that are no longer in Plenum; it stays in the total.
//   setCap(minutes) -> a promise of the summary; an Error with status 400 and one sentence for anything but a whole number from 1 to
//     10,080; 409 when the file is from a newer version.
//   promptLine(businessId) -> a promise of the text a lead is told from 80% on (lib/prompt-parts/62-owner-time.mjs), or null.
//   flush() -> a promise: what is not yet on the disk is written now. It never rejects.
// Events: { type: 'owner-time', state, percent, capMinutes } through publish when the state changes and when the cap is set.
//
// RULES THIS MODULE KEEPS: nothing is read before the first call and nothing is written until there is something to save. One write at a
// time, through writeFileAtomic. A save that fails is tried again with the next one; the numbers in force stay. Nothing here starts a
// program or reaches the network. It awaits no import at its top: the businesses and the list are loaded on first use.
import fs, { promises as fsp } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';
import * as events from './events.mjs';
import * as store from './store.mjs';
import { CODE_ROOT, moduleUrl } from './overlay.mjs';

export const VERSION = 1;
export const FILE = 'business-owner-time.json';
export const DEFAULT_CAP_MINUTES = 600;
export const MAX_CAP_MINUTES = 7 * 24 * 60;
export const IDLE_MS = 2 * 60_000;
export const FLOOR_MS = 10_000;
export const HOLD_PERCENT = 80;
export const KEEP_WEEKS = 12;
export const KINDS = Object.freeze(['queue', 'setup', 'charter', 'thread']);
export const WHATS = Object.freeze(['open', 'active', 'type', 'press', 'answer']);
export const LABEL = 'An estimate of your own time for your businesses, from what Plenum can see.';
export const COUNTS = Object.freeze([
  'The time from when an item of your list or a setup prompt came up in front of you until you answered it.',
  'Your presses in a business\'s setup and on its instructions (BUSINESS.md), with the reading before them.',
  'The time you type in a chat of a business\'s folder, with the short pauses between.',
  'A silence of more than two minutes is cut. An answer or a press with nothing seen before it counts as 10 seconds.',
]);
export const DOES_NOT_COUNT = Object.freeze([
  'Anything you do for a business outside Plenum: email, calls, your bank, other programs, thinking it over.',
  'Reading a chat, a brief or a file here without typing.',
  'Reading for more than two minutes without touching anything.',
  'On a phone without Full access only your answers are seen: each counts as 10 seconds.',
]);
const SAVE_MS = 3000;
const SETUP_STEP = /^Setup step \d+$/;
const ID = /^b_[a-z0-9]{4,16}$/;
const WEEK_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (status, message) => Object.assign(new Error(message), { status });
const count = v => (Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
const two = n => String(n).padStart(2, '0');
const oneLine = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

// Monday 00:00 of the week `ms` lies in, in the PC's own time.
export function weekStart(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}
// The same moment `weeks` calendar weeks on (a week in which the clocks change is an hour shorter or longer).
export function addWeeks(ms, weeks) {
  const d = new Date(ms);
  d.setDate(d.getDate() + 7 * weeks);
  return d.getTime();
}
export function weekKey(ms) {
  const d = new Date(weekStart(ms));
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}
// "Monday 23 Nov".
const dayWords = ms => {
  const d = new Date(ms);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

const emptyTally = () => ({ queue: 0, setup: 0, charter: 0, thread: 0, answers: 0, presses: 0, floors: 0 });
const cleanTally = t => {
  const x = isObject(t) ? t : {};
  return { queue: count(x.queue), setup: count(x.setup), charter: count(x.charter), thread: count(x.thread), answers: count(x.answers), presses: count(x.presses), floors: count(x.floors) };
};
const msOf = t => t.queue + t.setup + t.charter + t.thread;
const validCap = v => Number.isInteger(v) && v >= 1 && v <= MAX_CAP_MINUTES;

// A v1 record from anything: an older file, a damaged one, or a newer one. It never throws. What does not check out takes its default;
// a file from a newer version keeps its version and its unknown fields (this build reads it and never writes it).
export function migrate(raw) {
  const r = isObject(raw) ? raw : {};
  const newer = Number.isInteger(r.v) && r.v > VERSION;
  const weeks = {};
  for (const [key, week] of Object.entries(isObject(r.weeks) ? r.weeks : {})) {
    if (!WEEK_KEY.test(key) || !isObject(week)) continue;
    const out = {};
    for (const [id, tally] of Object.entries(week)) if (ID.test(id) && isObject(tally)) out[id] = cleanTally(tally);
    if (Object.keys(out).length) weeks[key] = out;
  }
  const seen = {};
  for (const [id, at] of Object.entries(isObject(r.seen) ? r.seen : {})) if (ID.test(id) && Number.isFinite(at) && at > 0) seen[id] = at;
  const known = {
    capMinutes: validCap(r.capMinutes) ? r.capMinutes : DEFAULT_CAP_MINUTES,
    weeks,
    last: isObject(r.last) && Number.isFinite(r.last.at) && r.last.at > 0 ? { at: r.last.at } : null,
    seen,
  };
  return newer ? { ...r, ...known, v: r.v } : { v: VERSION, ...known };
}

export function createOwnerTime(deps = {}) {
  const d = {
    dir: deps.dir ?? store.HOME,
    now: deps.now ?? (() => Date.now()),
    write: deps.write ?? writeFileAtomic,
    publish: deps.publish ?? (ev => events.publish(ev)),
  };
  const file = path.join(d.dir, FILE);

  // ----- the neighbours: loaded on first use, inside a function; a missing or broken one is null -----
  const neighbourFiles = { business: 'lib/business.mjs', decisions: 'lib/decisions.mjs' };
  const loading = new Map();
  function neighbour(name) {
    if (deps[name] !== undefined) return Promise.resolve(typeof deps[name] === 'function' ? deps[name]() : deps[name]).then(m => m ?? null, () => null);
    if (!loading.has(name)) loading.set(name, import(moduleUrl(neighbourFiles[name], CODE_ROOT)).then(m => m, () => null));
    return loading.get(name);
  }
  async function ask(name, fn, fallback = null) {
    try {
      const mod = await neighbour(name);
      if (!mod) return fallback;
      const value = await fn(mod);
      return value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  }

  // ----- the saved record -----
  let rec = null; // the record in force
  let newer = false; // the file is from a newer version: read, never written
  let damaged = false; // the file could not be understood: the first save keeps a copy of it
  let unread = false; // the file is there and could not be read just now: nothing is written over it until it can be
  let dirty = false;
  let timer = null;
  let queue = Promise.resolve();

  function read() {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      return err?.code === 'ENOENT' ? { rec: migrate(null) } : null;
    }
    let raw = null;
    try {
      raw = JSON.parse(text.replace(/^﻿/, ''));
    } catch {
      // Damaged: handled below.
    }
    return { rec: migrate(raw), damaged: !isObject(raw) };
  }

  function load() {
    if (rec && !unread) return rec;
    const got = read();
    if (!got) {
      // There, and not readable now (locked, no access): the count goes on in memory and is added to the file's own when it reads.
      unread = true;
      rec ??= migrate(null);
      return rec;
    }
    if (unread && rec) {
      for (const [key, week] of Object.entries(rec.weeks)) {
        got.rec.weeks[key] ??= {};
        for (const [id, t] of Object.entries(week)) {
          const into = (got.rec.weeks[key][id] ??= emptyTally());
          for (const k of Object.keys(t)) into[k] += t[k];
        }
      }
      if (rec.last && (!got.rec.last || rec.last.at > got.rec.last.at)) got.rec.last = rec.last;
      for (const [id, at] of Object.entries(rec.seen)) if (!(got.rec.seen[id] >= at)) got.rec.seen[id] = at;
    }
    unread = false;
    rec = got.rec;
    damaged = got.damaged === true;
    newer = !damaged && rec.v > VERSION;
    return rec;
  }

  function prune(r) {
    const oldest = weekKey(addWeeks(weekStart(d.now()), -(KEEP_WEEKS - 1)));
    for (const key of Object.keys(r.weeks)) if (key < oldest) delete r.weeks[key];
  }

  async function save() {
    if (!dirty) return;
    load();
    if (newer || unread) return;
    dirty = false;
    try {
      prune(rec);
      await fsp.mkdir(d.dir, { recursive: true });
      if (damaged) {
        await fsp.copyFile(file, path.join(d.dir, `business-owner-time.damaged-${d.now()}.json`)).catch(() => {});
        damaged = false;
      }
      await d.write(file, `${JSON.stringify(rec, null, 2)}\n`);
    } catch {
      // Not written: the numbers in force stay, and the next save writes them.
      dirty = true;
    }
  }
  function saveSoon(ms = SAVE_MS) {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      queue = queue.then(save).catch(() => {});
    }, ms);
    timer.unref?.();
  }
  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    queue = queue.then(save).catch(() => {});
    return queue;
  }

  // ----- the numbers of a week -----
  const capOf = r => (validCap(r.capMinutes) ? r.capMinutes : DEFAULT_CAP_MINUTES);
  const weekMs = (r, key) => Object.values(r.weeks[key] ?? {}).reduce((sum, t) => sum + msOf(cleanTally(t)), 0);
  function stateOf(r) {
    const ms = weekMs(r, weekKey(d.now()));
    const capMs = capOf(r) * 60_000;
    // Whole numbers only, so that exactly 80% is 80%.
    return { ms, percent: Math.floor((ms * 100) / capMs), state: ms >= capMs ? 'over' : ms * 100 >= capMs * HOLD_PERCENT ? 'hold' : 'ok' };
  }
  let lastState = null;
  function tellIfChanged(force = false) {
    const r = load();
    const s = stateOf(r);
    const was = lastState;
    lastState = s.state;
    if (!force && (was === null ? s.state === 'ok' : was === s.state)) return;
    try {
      d.publish({ type: 'owner-time', state: s.state, percent: s.percent, capMinutes: capOf(r) });
    } catch {
      // The count is kept whether or not a window hears of it.
    }
  }

  // ----- one mark on the one clock -----
  function add(business, kind, what, at) {
    const r = load();
    const live = !(Number.isFinite(at) && at > 0);
    const t = live ? d.now() : at;
    let gap = r.last ? t - r.last.at : Infinity;
    // A mark of now that lies more than the idle limit before the clock's last moment: the PC's clock was put back (or the file holds a
    // time from a clock that was wrong). The clock starts again from now, so the meter does not stand still until the clock catches up.
    // A line read from a record carries its own, earlier time and never moves the clock back.
    if (live && gap < -IDLE_MS) gap = Infinity;
    if (what === 'open') {
      // It starts the clock when the clock is not running, and takes nothing.
      if (gap > IDLE_MS) {
        r.last = { at: t };
        saveSoon();
      }
      return { counted: 0, floor: false };
    }
    let counted = 0;
    let floor = false;
    if (gap > 0 && gap <= IDLE_MS) counted = gap;
    else if (gap > IDLE_MS && (what === 'press' || what === 'answer')) {
      counted = FLOOR_MS;
      floor = true;
    }
    if (gap > 0) r.last = { at: t };
    const acts = what === 'press' || what === 'answer';
    if (counted > 0 || acts) {
      const key = weekKey(t);
      r.weeks[key] ??= {};
      const tally = (r.weeks[key][business] = cleanTally(r.weeks[key][business]));
      tally[kind] += counted;
      if (what === 'answer') tally.answers += 1;
      if (what === 'press') tally.presses += 1;
      if (floor) tally.floors += 1;
    }
    saveSoon(acts ? 200 : SAVE_MS);
    tellIfChanged();
    return { counted, floor };
  }

  const itemKind = item => (item?.charter === true ? 'charter' : SETUP_STEP.test(String(item?.routine ?? '')) ? 'setup' : 'queue');
  const itemByN = n => ask('decisions', mod => (mod.list({}) ?? []).find(i => i?.n === n) ?? null);
  const NO_BUSINESS = Object.freeze({ ok: false, counted: 0, why: 'no-business' });
  const BAD = Object.freeze({ ok: false, counted: 0, why: 'bad-mark' });

  // Who and what a mark is for: { business, kind } or null.
  async function resolve(m) {
    if (m.item !== undefined) {
      const n = typeof m.item === 'string' && /^\d{1,15}$/.test(m.item) ? Number(m.item) : m.item;
      if (!Number.isInteger(n) || n < 1) return BAD;
      const item = await itemByN(n);
      const id = typeof item?.business === 'string' ? item.business : '';
      if (!id || !ID.test(id)) return NO_BUSINESS;
      return { business: id, kind: itemKind(item) };
    }
    if (m.business !== undefined) {
      if (typeof m.business !== 'string' || !ID.test(m.business)) return BAD;
      const kind = m.kind === undefined ? 'queue' : m.kind;
      if (!KINDS.includes(kind) || kind === 'thread') return BAD;
      const b = await ask('business', mod => mod.byId(m.business));
      return b ? { business: m.business, kind } : NO_BUSINESS;
    }
    if (m.project !== undefined) {
      if (typeof m.project !== 'string' || !m.project || m.project.length > 80) return BAD;
      const b = await ask('business', mod => mod.businessFor(m.project));
      return typeof b?.id === 'string' && ID.test(b.id) ? { business: b.id, kind: 'thread' } : NO_BUSINESS;
    }
    return NO_BUSINESS;
  }

  async function mark(input) {
    try {
      if (!isObject(input) || !WHATS.includes(input.what)) return { ...BAD };
      const who = await resolve(input);
      if (who.ok === false) return { ...who };
      const { counted, floor } = add(who.business, who.kind, input.what, null);
      return { ok: true, counted, business: who.business, kind: who.kind, ...(floor ? { floor: true } : {}) };
    } catch {
      return { ...BAD };
    }
  }

  // ----- his answers, read from each business's own record -----
  let unsubscribe = null;
  let watchFrom = 0;
  let scans = Promise.resolve();
  async function scan(id) {
    if (typeof id !== 'string' || !ID.test(id)) return;
    // The most the record gives (200): a busy lead can write many lines in the second before the change is told, and his answer must
    // not fall behind them.
    const lines = await ask('business', mod => mod.log(id, { limit: 200 }), []);
    const r = load();
    const from = Math.max(watchFrom, r.seen[id] ?? 0);
    const fresh = (Array.isArray(lines) ? lines : [])
      .filter(l => isObject(l) && (l.type === 'decision' || l.type === 'outside') && l.by === 'owner' && Number.isFinite(l.at) && l.at > from)
      .sort((a, b) => a.at - b.at);
    for (const line of fresh) {
      const item = Number.isInteger(line.n) ? await itemByN(line.n) : null;
      add(id, itemKind(item), 'answer', line.at);
      r.seen[id] = line.at;
    }
  }
  async function start() {
    if (unsubscribe) return;
    watchFrom = d.now();
    const off = await ask('business', mod => mod.onChange(ev => {
      if (ev?.reason !== 'record') return;
      scans = scans.then(() => scan(ev.id)).catch(() => {});
    }));
    unsubscribe = typeof off === 'function' ? off : null;
  }
  function stop() {
    try {
      unsubscribe?.();
    } catch {
      // Nothing to end.
    }
    unsubscribe = null;
  }
  const idle = () => scans;

  // ----- what the page, the brief and the leads read -----
  async function weekOf(r, from, list) {
    const key = weekKey(from);
    const week = r.weeks[key] ?? {};
    const businesses = [];
    const known = new Set();
    for (const b of list) {
      if (typeof b?.id !== 'string' || known.has(b.id)) continue;
      known.add(b.id);
      const t = cleanTally(week[b.id]);
      if (b.status === 'closed' && !msOf(t)) continue;
      businesses.push({ id: b.id, name: oneLine(b.name, 60) || 'A business', status: oneLine(b.status, 24), ms: msOf(t), minutes: Math.round(msOf(t) / 60_000), ...t });
    }
    const otherMs = Object.entries(week).filter(([id]) => !known.has(id)).reduce((sum, [, t]) => sum + msOf(cleanTally(t)), 0);
    const ms = weekMs(r, key);
    return { from, to: addWeeks(from, 1), ms, minutes: Math.round(ms / 60_000), businesses, other: { ms: otherMs, minutes: Math.round(otherMs / 60_000) } };
  }

  function lineOf(s, cap, nextBatch) {
    const minutes = Math.round(s.ms / 60_000);
    if (s.state === 'over') return `You are over the time you set for this week: about ${minutes} of ${cap} minutes. Leads are told to hold what can wait until ${dayWords(nextBatch)}. Nothing is blocked: you can still answer anything, and Stop works as always.`;
    if (s.state === 'hold') return `You have used about ${minutes} of ${cap} minutes this week (${s.percent}%). Leads are now told to hold what can wait for next week's batch.`;
    return '';
  }

  async function summary() {
    const r = load();
    const list = (await ask('business', mod => mod.list(), [])) ?? [];
    const from = weekStart(d.now());
    const s = stateOf(r);
    const cap = capOf(r);
    const nextBatch = addWeeks(from, 1);
    return {
      v: VERSION,
      estimate: true,
      label: LABEL,
      counts: [...COUNTS],
      doesNotCount: [...DOES_NOT_COUNT],
      capMinutes: cap,
      idleMinutes: IDLE_MS / 60_000,
      floorSeconds: FLOOR_MS / 1000,
      holdPercent: HOLD_PERCENT,
      percent: s.percent,
      state: s.state,
      line: lineOf(s, cap, nextBatch),
      nextBatch,
      ...(newer ? { newer: true } : {}),
      thisWeek: await weekOf(r, from, Array.isArray(list) ? list : []),
      lastWeek: await weekOf(r, addWeeks(from, -1), Array.isArray(list) ? list : []),
    };
  }

  async function setCap(minutes) {
    if (!validCap(minutes)) throw fail(400, 'The weekly limit is a whole number of minutes from 1 to 10,080 (a week). Ten hours is 600.');
    const r = load();
    if (newer) throw fail(409, 'business-owner-time.json was written by a newer Plenum, so this build does not change it. Update Plenum, then try again.');
    r.capMinutes = minutes;
    dirty = true;
    await flush();
    tellIfChanged(true);
    return summary();
  }

  async function promptLine(businessId) {
    try {
      const r = load();
      const s = stateOf(r);
      if (s.state === 'ok') return null;
      if (typeof businessId !== 'string' || !(await ask('business', mod => mod.byId(businessId)))) return null;
      const cap = capOf(r);
      const next = dayWords(addWeeks(weekStart(d.now()), 1));
      return [
        'THE OWNER\'S TIME (Plenum\'s own count of his minutes; an estimate)',
        // The same words all through a state (no minute count that changes every turn): a system text that changes with each minute he
        // spends would make every turn a new prompt for the model and its program, and cost the owner's usage.
        s.state === 'over'
          ? `The owner has used all of the ${cap} minutes he gives all his businesses this week: he is over his limit for this week.`
          : `The owner has used ${HOLD_PERCENT}% or more of the ${cap} minutes he gives all his businesses this week.`,
        `- Hold every OWNER: ask that can wait for the next weekly batch: note it in PLAN.md with [?], and write its OWNER: line on or after ${next}.`,
        '- Still write the OWNER: line now for what cannot wait until then: money or a customer would be lost, a promise or a deadline would be missed, or something is unsafe. Say in its title why it cannot wait.',
        '- Do not ask the same thing twice and do not split one ask into several. Go on with the work that needs no answer.',
      ].join('\n');
    } catch {
      return null;
    }
  }

  return { mark, start, stop, idle, summary, setCap, promptLine, flush, file, get: () => JSON.parse(JSON.stringify(load())) };
}

// ---------- the default instance ----------

let instance = null;
const meter = () => (instance ??= createOwnerTime());

export const mark = input => meter().mark(input);
export const start = () => meter().start();
export const stop = () => meter().stop();
export const idle = () => meter().idle();
export const summary = () => meter().summary();
export const setCap = minutes => meter().setCap(minutes);
export const promptLine = businessId => meter().promptLine(businessId);
export const flush = () => meter().flush();
