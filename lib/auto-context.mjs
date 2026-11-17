// Auto routing's context (wave 6, ultra/work/wave6/AUTOROUTE-BRIEF.md sections 1.5, 3 and 4): gathers what route() of
// lib/auto-route.mjs reads (the plan readings, the team's plan use and line, the Scorecard's counts, the tries that did not finish) and
// remembers how team tasks ended, in memory only, keyed by a hash and never by the task's text.
//
// THE CONTRACT (build/v06/w6-ar1 pins each part):
//   createAutoContext({ planState, team, scorecard, now, waitMs, load }) -> { forTeam, forLeads, routeFor, noteResult, size }
//     planState  () -> { subs } (lib/plan-watch.mjs planState). Read with a cap of waitMs (1.5 s): on a timeout or an error planRows is
//                null and the team's plan use alone counts. A reading is kept for 15 s, and one that arrives late is kept for the next ask.
//     team       { get, planUse, registry, availability, labelOf, SIZE_HINTS } (lib/team.mjs, or a stand-in)
//     scorecard  { cellsFor(kind) } or { record() } (lib/scorecard.mjs, or a stand-in)
//     now        () -> ms.   load (tests only): name -> a promise of the module, in place of import().
//     A neighbour that is not given is imported when first needed; null means "none". Nothing here starts a program or sends a prompt.
//   forTeam({ kind, type, inp, project, job, notes, title }) -> a promise of { task, ctx } | null   (never rejects)
//        lib/team-run.mjs puts it on the pick query as `auto`; lib/team.mjs pick then calls routeFor(q.auto, { candidates, counts,
//        atOnce, avoid, allowApi, lines, exclude }). A lead's inp.effort becomes pins.effort (effortBy 'lead'); a kind with
//        pinEffort: true and an effort, pins.effort (effortBy 'owner'). failures: the tries of this task noteResult saw (same
//        project, kind and title, not ok, within 2 hours, since the last one that was ok; a Stop counts as neither). Only when the ring
//        holds nothing of this task or of this job: the job's newest notes of this agent type that say "<Type>, <model>: not
//        finished:", back to the last one of that type that finished.
//   routeFor(auto, more) -> route(auto.task, { ...auto.ctx, ...more })
//   forLeads({ refs, business, kind, text, doneWhen, playbook, typeKind, commands, level, failures, minutesLeft, source, avoid, exclude,
//              pins, billing, manual }) -> a promise of route()'s answer (never rejects)
//        For routines (source 'routine') and Night shift (source 'night'): the candidates are the refs, in that order, with the team's
//        label, size and availability (last: true unless manual). billing: { [ref]: 'plan'|'api'|null } as the caller checked it, else
//        the registry's. A playbook counts as 3,000 characters. allowApi and lines are the business's own.
//   noteResult({ project, job, kind, title, ok, stopped, at }) -> nothing   one ended team task; a ring of 200 { key, job, ok, at },
//        key and job salted hashes ('' without a job), ok null when stopped is set (the owner pressed Stop). Pass job: with it, the
//        ring knows the job, and other tasks' notes in that job are not counted as this task's tries.
//   size(), peek() -> the number of results kept, and a copy of them (for tests)
// The default instance's forTeam, forLeads, routeFor and noteResult are exported below under the same names, so the module can be a
// neighbour of lib/team-run.mjs as it is.
import crypto from 'node:crypto';
import { ALL_EFFORTS, SIZES, STEP_BACK_OTHER, route } from './auto-route.mjs';

export const PLAN_WAIT_MS = 1500;
export const PLAN_KEEP_MS = 15_000;
export const RING_SIZE = 200;
export const RETRY_WINDOW_MS = 2 * 60 * 60_000;
export const PLAYBOOK_LEN = 3000;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = v => (typeof v === 'string' ? v : '');
const given = v => v !== undefined && v !== null && String(v).trim() !== '';
const splitRef = ref => {
  const text = String(ref ?? '');
  const i = text.indexOf(':');
  return i < 0 ? { provider: text, id: '' } : { provider: text.slice(0, i), id: text.slice(i + 1) };
};
const projectIdOf = p => (isObject(p) ? str(p.id) : str(p));
const NOT_FINISHED = /^not finished:/i;

const LOADERS = Object.freeze({
  team: () => import('./team.mjs'),
  planWatch: () => import('./plan-watch.mjs'),
  scorecard: () => import('./scorecard.mjs'),
});

// route() never throws on its own; should it, Auto steps back and the caller does what it does today.
function safeRoute(task, ctx) {
  try {
    return route(task, ctx);
  } catch {
    return { ref: null, label: null, effort: null, why: STEP_BACK_OTHER, stepBack: true, alternatives: [], features: null };
  }
}

// Resolves with the promise's value, or with null after ms. The promise goes on (its late value is kept by the caller).
function within(promise, ms) {
  let timer;
  const late = new Promise(resolve => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

export function createAutoContext(deps = {}) {
  const d = isObject(deps) ? deps : {};
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  const waitMs = finite(d.waitMs) ?? PLAN_WAIT_MS;
  const keepMs = finite(d.keepMs) ?? PLAN_KEEP_MS;
  const load = typeof d.load === 'function' ? d.load : name => LOADERS[name]();
  const salt = crypto.randomBytes(16);
  const ring = [];
  const mods = {};
  const plan = { rows: null, at: null, flight: null };

  const neighbour = name => {
    if (Object.hasOwn(d, name) && d[name] !== undefined) return Promise.resolve(d[name]);
    mods[name] ??= Promise.resolve().then(() => load(name)).catch(() => null);
    return mods[name];
  };

  async function planRowsNow() {
    if (plan.at !== null && now() - plan.at < keepMs) return plan.rows;
    let fn = typeof d.planState === 'function' ? d.planState : null;
    if (!fn && d.planState === undefined) {
      const pw = await neighbour('planWatch');
      fn = typeof pw?.planState === 'function' ? pw.planState : null;
    }
    if (!fn) return null;
    plan.flight ??= Promise.resolve()
      .then(() => fn())
      .then(s => {
        const rows = Array.isArray(s?.subs) ? s.subs : null;
        if (rows) {
          plan.rows = rows;
          plan.at = now();
        }
        return rows;
      }, () => null)
      .finally(() => { plan.flight = null; });
    return within(plan.flight, waitMs);
  }

  const call = (fn, fallback) => {
    try {
      const v = fn();
      return v === undefined ? fallback : v;
    } catch {
      return fallback;
    }
  };
  const planUseOf = t => call(() => (typeof t?.planUse === 'function' && isObject(t.planUse()) ? { ...t.planUse() } : {}), {});
  const teamLineOf = t => call(() => finite(t?.get?.()?.limits?.skipAbovePercent), null);
  // Only the counts: { [ref]: { pass, fail } }.
  const cellsOf = (sc, kindId) => call(() => {
    if (!sc || !given(kindId)) return null;
    const raw = typeof sc.cellsFor === 'function' ? sc.cellsFor(kindId) : typeof sc.record === 'function' ? sc.record()?.cells?.[kindId] : null;
    if (!isObject(raw)) return null;
    const out = {};
    for (const [ref, cell] of Object.entries(raw)) if (isObject(cell)) out[ref] = { pass: finite(cell.pass) ?? 0, fail: finite(cell.fail) ?? 0 };
    return out;
  }, null);

  // ----- the tries that did not finish -----
  const keyOf = (project, kind, title) => {
    const t = str(title).trim().toLowerCase().replace(/\s+/g, ' ');
    if (!t || !given(kind)) return '';
    return crypto.createHmac('sha256', salt).update(`${project}\n${kind}\n${t}`).digest('hex').slice(0, 24);
  };

  // The job a result belongs to, hashed like the key ('' when not given).
  const jobKeyOf = (project, job) => (given(job) ? crypto.createHmac('sha256', salt).update(`job\n${project}\n${String(job).trim()}`).digest('hex').slice(0, 24) : '');

  // ok: true (finished), false (did not finish), null (the owner pressed Stop: neither a try that failed nor one that finished).
  function noteResult(r) {
    if (!isObject(r)) return;
    const kind = isObject(r.kind) ? str(r.kind.id) : str(r.kind ?? r.work);
    const project = projectIdOf(r.project);
    const key = keyOf(project, kind, r.title);
    if (!key) return;
    ring.push({ key, job: jobKeyOf(project, r.job), ok: r.stopped ? null : r.ok === true, at: finite(r.at) ?? now() });
    while (ring.length > RING_SIZE) ring.shift();
  }

  const fresh = e => now() - e.at <= RETRY_WINDOW_MS;
  // This task's tries that did not finish, newest first, up to the last one that did (within 2 hours); and whether the ring holds any
  // result of this task or of this job at all.
  const ringOf = (project, kind, title, job) => {
    const key = keyOf(project, kind, title);
    const jk = jobKeyOf(project, job);
    let n = 0;
    let run = true;
    let seen = false;
    for (let i = ring.length - 1; i >= 0; i--) {
      const e = ring[i];
      if (!fresh(e)) break;
      if (jk && e.job === jk) seen = true;
      if (!key || e.key !== key) continue;
      seen = true;
      if (!run || e.ok === null) continue;
      if (e.ok) run = false;
      else n += 1;
    }
    return { n, seen };
  };

  // The job's notes (lib/team-run.mjs createNotes), used only when the ring knows nothing of this task or this job (noteResult was
  // not called for it): the newest notes of this agent type that say "<Type>, <model>: not finished: ...", back to the last one of that
  // type that finished. The words must follow the model's name: a summary that contains them is not a failure.
  const notesFailures = (notes, project, job, type) => {
    if (!given(job)) return 0;
    const list = call(() => (typeof notes?.list === 'function' ? notes.list(project, job) : Array.isArray(notes) ? notes : []), []);
    const prefix = `${given(type?.label) ? type.label : 'Agent'}, `;
    let n = 0;
    const arr = Array.isArray(list) ? list : [];
    for (let i = arr.length - 1; i >= 0; i--) {
      const text = typeof arr[i] === 'string' ? arr[i] : str(arr[i]?.text);
      if (!text.startsWith(prefix)) continue;
      const rest = text.slice(prefix.length);
      const cut = rest.indexOf(': ');
      if (cut < 0 || !NOT_FINISHED.test(rest.slice(cut + 2))) break;
      n += 1;
    }
    return n;
  };

  // ----- team tasks -----
  async function forTeam(q) {
    try {
      const a = isObject(q) ? q : {};
      const kind = isObject(a.kind) ? a.kind : null;
      const type = isObject(a.type) ? a.type : null;
      const inp = isObject(a.inp) ? a.inp : {};
      const project = projectIdOf(a.project);
      const title = given(a.title) ? str(a.title) : str(inp.title);
      const [t, sc, planRows] = await Promise.all([neighbour('team'), neighbour('scorecard'), planRowsNow()]);
      const pins = {};
      const leadEffort = given(inp.effort) ? String(inp.effort).trim().toLowerCase() : '';
      if (ALL_EFFORTS.includes(leadEffort)) Object.assign(pins, { effort: leadEffort, effortBy: 'lead' });
      else if (kind?.pinEffort === true && ALL_EFFORTS.includes(kind.effort)) Object.assign(pins, { effort: kind.effort, effortBy: 'owner' });
      const level = given(inp.level) ? String(inp.level).trim().toLowerCase() : '';
      const fromRing = ringOf(project, kind?.id, title, a.job);
      const failures = fromRing.seen ? fromRing.n : notesFailures(a.notes, project, a.job, type);
      const task = {
        source: 'team',
        kind: { id: str(kind?.id), agent: str(kind?.agent), label: str(kind?.label) },
        typeKind: type?.kind === 'edit' ? 'edit' : 'read',
        commands: Array.isArray(type?.commands) ? type.commands.length > 0 : Boolean(type?.commands),
        text: [str(inp.title), str(inp.instructions)].filter(Boolean).join('\n'),
        doneWhen: str(inp.done_when ?? inp.doneWhen),
        level: SIZES.includes(level) ? level : null,
        failures,
        minutesLeft: null,
        pins,
      };
      const ctx = { planRows, planUse: planUseOf(t), cells: cellsOf(sc, kind?.id), teamLine: teamLineOf(t), now: now() };
      return { task, ctx };
    } catch {
      return null;
    }
  }

  const routeFor = (auto, more = {}) => safeRoute(isObject(auto) ? auto.task : null, { ...(isObject(auto?.ctx) ? auto.ctx : {}), ...(isObject(more) ? more : {}) });

  // ----- routines and Night shift -----
  const sizeByName = (t, ref) => {
    const hints = isObject(t?.SIZE_HINTS) ? t.SIZE_HINTS : null;
    if (!hints) return 'unknown';
    const words = splitRef(ref).id.toLowerCase().split(/[-.:/_]+/);
    for (let i = words.length - 1; i >= 0; i--) if (Object.hasOwn(hints, words[i]) && SIZES.includes(hints[words[i]])) return hints[words[i]];
    return 'unknown';
  };

  async function forLeads(q) {
    const a = isObject(q) ? q : {};
    const source = a.source === 'night' ? 'night' : 'routine';
    let task = { source };
    let ctx = { candidates: [] };
    try {
      const refs = [...new Set((Array.isArray(a.refs) ? a.refs : []).filter(r => typeof r === 'string' && r))];
      const b = isObject(a.business) ? a.business : {};
      const lines = isObject(b.lines) ? b.lines : null;
      const kind = isObject(a.kind) ? a.kind : null;
      const [t, sc, planRows] = await Promise.all([neighbour('team'), refs.length ? neighbour('scorecard') : null, refs.length ? planRowsNow() : null]);
      const reg = call(() => (typeof t?.registry === 'function' ? t.registry() : []), []);
      const byRef = new Map((Array.isArray(reg) ? reg : []).filter(e => isObject(e) && typeof e.ref === 'string').map(e => [e.ref, e]));
      const candidates = refs.map(ref => {
        const e = byRef.get(ref) ?? null;
        const av = call(() => (typeof t?.availability === 'function' ? t.availability(ref, { ...(lines ? { lines } : {}), last: a.manual !== true }) : null), null);
        const avail = isObject(av) ? { state: str(av.state), usedPercent: finite(av.usedPercent) } : isObject(e?.avail) ? e.avail : null;
        const billing = isObject(a.billing) && Object.hasOwn(a.billing, ref) ? a.billing[ref] : e?.billing ?? null;
        const label = given(e?.label) ? e.label : call(() => t?.labelOf?.(ref), null) ?? splitRef(ref).id;
        return { ref, label: String(label), provider: given(e?.provider) ? e.provider : splitRef(ref).provider, size: SIZES.includes(e?.size) ? e.size : sizeByName(t, ref), billing, avail };
      });
      const level = given(a.level) ? String(a.level).trim().toLowerCase() : '';
      task = {
        source,
        kind: kind ? { id: str(kind.id), agent: str(kind.agent), label: str(kind.label) } : { id: '', agent: '', label: '' },
        typeKind: a.typeKind === 'edit' ? 'edit' : 'read',
        commands: Boolean(a.commands),
        text: str(a.text),
        doneWhen: str(a.doneWhen),
        level: SIZES.includes(level) ? level : null,
        failures: finite(a.failures) ?? 0,
        minutesLeft: finite(a.minutesLeft),
        lenHint: a.playbook ? PLAYBOOK_LEN : 0,
        pins: isObject(a.pins) ? { ...a.pins } : {},
      };
      ctx = {
        candidates,
        planRows,
        planUse: planUseOf(t),
        lines,
        teamLine: teamLineOf(t),
        allowApi: b.allowApi === true,
        cells: kind ? cellsOf(sc, kind.id) : null,
        avoid: Array.isArray(a.avoid) ? a.avoid : [],
        exclude: Array.isArray(a.exclude) ? a.exclude : [],
        now: now(),
      };
    } catch {
      // What could not be read counts as not known; route still answers.
    }
    return safeRoute(task, ctx);
  }

  return { forTeam, forLeads, routeFor, noteResult, size: () => ring.length, peek: () => ring.map(e => ({ ...e })) };
}

// ---------- the default instance ----------

let instance = null;
export function autoContext() {
  instance ??= createAutoContext();
  return instance;
}
export const forTeam = q => autoContext().forTeam(q);
export const forLeads = q => autoContext().forLeads(q);
export const routeFor = (auto, more) => autoContext().routeFor(auto, more);
export const noteResult = r => autoContext().noteResult(r);
