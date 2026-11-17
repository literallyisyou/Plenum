// The Scorecard's runs (wave 6, package sc2; ultra/work/wave6/SCORECARD-BRIEF.md sections 3, 4 and 6): the spot-check that follows a
// finished team task, and "Try each worker". lib/scorecard.mjs (sc1) holds the counts, the gates and the rules; this module only starts the
// runs, reads their answers and hands the counts back. Nothing here is ever awaited by the team task it follows: the lead's answer is the
// same, byte for byte, with or without the scorecard.
//
// THE CONTRACT (lib/team-run.mjs and lib/routes/scorecard.mjs build to it; build/v06/w6-sc2 pins each part):
//   createScorecardRun(deps) -> { afterTask, tryEach, running, idle }; the default instance's functions are exported below.
//     deps (each one optional; one left out is imported on first use, never at load time):
//       scorecard  lib/scorecard.mjs or an instance of createScorecard (noteFinished, gate, startCheck, giveBack, endCheck, recordVerdict,
//                  noteSkip, hold, saveTried, and the pure chooseChecker, checkPrompt, parseVerdict, CHECK_TYPE, SKIP_KEYS, TRY_MINUTES;
//                  the pure ones are read from lib/scorecard.mjs when the instance has none)
//       team       lib/team.mjs (get, registry, availability, planUse, labelOf, classifyFailure, noteOutcome, ready)
//       planState  () -> { subs } (lib/plan-watch.mjs, imported lazily; read with a cap of 1.5 seconds, and none counts as no rows)
//       runAgent, openRun   lib/agent-run.mjs
//       gitDiff    (root, paths) -> the text of `git diff` of those paths, or null when it could not be read (lib/git-run.mjs runGit)
//       canRun     (ref, kind) -> { ok } (lib/agents.mjs)
//       billingFor (ref) -> 'plan' | 'api' | null (lib/providers.mjs): asked NOW for every choice, never read from the team's registry,
//                  whose kept answer stays after a route is changed in Accounts (lib/team.mjs billedNow keeps the same rule)
//       nightShift () -> true while Night shift works (lib/jobs.mjs working): no spot-check starts then (wave 6 integration)
//       now        () -> ms
//       publish    (event) -> void (lib/events.mjs publish): { type: 'scorecard', reason } after each change the page shows
//   afterTask(info) -> a promise that never rejects (and the call itself never throws), of what happened: { picked, why?, verdict? }.
//     info: { project, root, agents, stream, signal, callerRole, kind, typeKind, worker, title, brief, doneWhen, answer, changed,
//     modelChars }. callerRole is the root role of the lead (chat, build, or a seat's role). lib/team-run.mjs calls it, never awaited,
//     after the log line of a task the team chose a model for that finished well and was not stopped, and whose kind is not Review. The
//     rest of section 3 is checked here: the model wrote text, the worker is in that kind's team list, and the counter of
//     lib/scorecard.mjs picks this task (1 in 10).
//     The check is linked to the lead's signal, so the lead's Stop ends it, except for a seat (council, moderator, relay, compare,
//     pipeline): those runners abort their signal when they end normally, which is no Stop. A seat's check still ends with Stop all.
//   tryEach({ project, root, agents }) -> a promise of { started: true, count } | { started: false, say }. The tiny tasks run in the
//     background, all admitted into ONE run of the project at once, so the queued ones are on the Agents board too and Stop all ends
//     them. A model is run only when billingFor answers 'plan' now: one billed per token (its row is 'api') or one whose billing could not
//     be read (its row is 'unknown') is never run. Each failure is classed by team.classifyFailure and taught to team.noteOutcome.
//   running() -> null | { type: 'check', kind, kindLabel, projectName } | { type: 'try', count }
//   idle() -> a promise that settles once every check and try started by this instance has ended (for tests).
//
// RULES THIS MODULE KEEPS: the check sees the work in memory only; no title, brief, answer, diff or project id goes to the scorecard
// file (only the kind id, the worker's ref and the verdict word). A check starts only after its place in the day's count is saved, and a
// run that was refused before any model ran gives that place back. A check or a try that the person stopped (Stop all, Stop of the lead)
// holds new checks for 30 minutes. It imports only node's own modules statically: never lib/team-run.mjs, lib/tools/40-delegate.mjs or
// lib/routes/index.mjs, and lib/plan-watch.mjs only when a check first needs it.
import { randomUUID } from 'node:crypto';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const LOOSE_REF = /^[a-z0-9-]{1,40}:[^\s\u0000-\u001f\u007f]{1,160}$/;
const KIND_ID = /^[a-z0-9-]{1,24}$/;
const PLAN_WAIT_MS = 1500;
const DIFF_PATHS = 30;
const PERSON_STOPS = new Set(['user', 'parent']);
// The root roles whose runners abort the lead's signal when they end normally (lib/council.mjs's finally, the seat watches).
const SEAT_ROLES = new Set(['council', 'moderator', 'relay', 'compare', 'pipeline']);
const BILL_WAIT_MS = 1500;

// The tiny task of "Try each worker": text only, one step, two minutes (TRY_MINUTES of lib/scorecard.mjs).
export const TRY_TYPE = Object.freeze({
  name: 'scorecard-try', label: 'Try', kind: 'read', returns: 'summary', buildOnly: false, model: null, effort: 'low',
  maxSteps: 1, timeoutMin: 2, idleMin: 2, files: false, commands: false, web: false, folders: Object.freeze([]), brief: '',
  description: 'Answers one tiny task, to show that the model can run.',
});
export const TRY_SYSTEM = 'This is a short test that Plenum runs to see that you can answer. Reply with the single word OK and nothing else.';
export const TRY_TASK = 'Reply with OK.';

export const TEXT = Object.freeze({
  trying: 'The models are being tried now. Stop all ends it.',
  noProject: 'Open a project first. The tiny tasks run in it.',
  noTeam: 'Your team has no models yet. Add them under Settings > Agents > Team.',
  notReady: 'Plenum could not start the try. Try again in a moment.',
});

// What a failure class of team.classifyFailure is as a row of the try (TRY_STATES of lib/scorecard.mjs).
const TRY_STATE_OF = { limit: 'limit', 'sign-in': 'signed-out', 'not-offered': 'retired', 'not-installed': 'not-installed', slow: 'slow' };

// The parts this module needs, each loaded on first use and kept. A part that cannot be loaded is null.
const LOADERS = {
  scorecard: () => import('./scorecard.mjs'),
  team: () => import('./team.mjs'),
  planState: async () => (await import('./plan-watch.mjs')).planState,
  runAgent: async () => (await import('./agent-run.mjs')).runAgent,
  openRun: async () => (await import('./agent-run.mjs')).openRun,
  canRun: async () => (await import('./agents.mjs')).canRun,
  billingFor: async () => (await import('./providers.mjs')).billingFor,
  publish: async () => (await import('./events.mjs')).publish,
  gitDiff: async () => defaultGitDiff,
  pure: () => import('./scorecard.mjs'),
  nightShift: async () => (await import('./jobs.mjs')).working,
};

// `git diff` of the changed paths, as the check reads them. Paths are taken literally (no pathspec magic), and an error is null.
async function defaultGitDiff(root, paths) {
  const { runGit, DIFF_SAFE } = await import('./git-run.mjs');
  const r = await runGit(['diff', ...DIFF_SAFE, '--', ...paths], { cwd: root, timeoutMs: 15_000, maxBuffer: 1024 * 1024, env: { GIT_LITERAL_PATHSPECS: '1' } });
  return r?.ok ? String(r.stdout ?? '') : null;
}

// Resolves to what the promise gives, or to `fallback` after ms. Never rejects.
function within(promise, ms, fallback = null) {
  let timer = null;
  const late = new Promise(resolve => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(promise).catch(() => fallback), late]).finally(() => clearTimeout(timer));
}

const safe = (fn, fallback = null) => {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
};

export function createScorecardRun(deps = {}) {
  const loaded = new Map();
  const need = name => {
    if (Object.hasOwn(deps, name) && deps[name] !== undefined) return Promise.resolve(deps[name]);
    if (!loaded.has(name)) loaded.set(name, Promise.resolve().then(() => LOADERS[name]()).catch(() => null));
    return loaded.get(name);
  };
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const pending = new Set();
  let checkNow = null; // { kind, kindLabel, projectName } of the check that runs now
  let tryNow = null; // { count } of the try that runs now

  const track = promise => {
    pending.add(promise);
    promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  };
  const tell = async reason => {
    try {
      const publish = await need('publish');
      if (typeof publish === 'function') publish({ type: 'scorecard', reason });
    } catch {
      // The page reads again at its next event; a check never depends on it.
    }
  };
  // A function of the scorecard instance, else the pure one of lib/scorecard.mjs (an instance holds no pure functions).
  const pureOf = async (sc, name) => sc?.[name] ?? (await need('pure'))?.[name];
  const labelOf = (team, ref) => {
    const l = safe(() => team?.labelOf?.(ref));
    if (typeof l === 'string' && l) return l;
    const s = String(ref ?? '');
    return s.slice(s.indexOf(':') + 1) || s;
  };
  const kindsOf = team => {
    const list = safe(() => team?.get?.()?.kinds);
    return Array.isArray(list) ? list.filter(k => isObject(k) && typeof k.id === 'string') : [];
  };
  const refsOf = list => (Array.isArray(list) ? list.map(w => (isObject(w) ? w.ref : w)).filter(r => typeof r === 'string' && LOOSE_REF.test(r)) : []);

  // How each of these models is billed, asked NOW (billingFor reads memory, the key store and one settings file; no program starts). A
  // model whose ask failed is asked once more; one with no answer inside the wait is not in the map, so it counts as not on the plan.
  async function billedNow(refs) {
    const answers = new Map();
    const fn = await need('billingFor');
    if (typeof fn !== 'function' || !refs.length) return answers;
    const ask = ref => Promise.resolve()
      .then(() => fn(ref))
      .then(v => { if (v === 'plan' || v === 'api') answers.set(ref, v); }, () => {});
    const all = async () => {
      await Promise.all(refs.map(ask));
      const again = refs.filter(ref => !answers.has(ref));
      if (again.length) await Promise.all(again.map(ask));
    };
    await within(all(), BILL_WAIT_MS, null);
    // A copy: an answer that comes after the wait does not change a choice that is already made.
    return new Map(answers);
  }

  // ---------- the check after a team task ----------

  async function planRows() {
    const fn = await need('planState');
    if (typeof fn !== 'function') return [];
    const s = await within(Promise.resolve().then(() => fn()), PLAN_WAIT_MS, null);
    return Array.isArray(s?.subs) ? s.subs : [];
  }

  async function check(info) {
    const sc = await need('scorecard');
    const team = await need('team');
    if (!sc || typeof sc.noteFinished !== 'function' || !team) return { picked: false, why: 'missing' };
    const kind = isObject(info.kind) ? info.kind : null;
    const kindId = kind?.id;
    const worker = typeof info.worker === 'string' ? info.worker : '';
    // Section 3, the parts lib/team-run.mjs does not check: a kind that is not Review, a model that wrote text, and a worker in that
    // kind's team list (the owner's own, not a business's). A hand-off to a program never reaches here.
    if (typeof kindId !== 'string' || !KIND_ID.test(kindId) || kindId === 'review') return { picked: false, why: 'kind' };
    if (!LOOSE_REF.test(worker) || !(Number(info.modelChars) > 0)) return { picked: false, why: 'task' };
    const own = kindsOf(team).find(k => k.id === kindId);
    const list = refsOf(own ? own.workers : kind.workers);
    if (!list.includes(worker)) return { picked: false, why: 'list' };
    // While Night shift works (on, inside its hours, a job waiting or running) no spot-check starts: Night shift spends only plan time
    // that would go unused, and its pacer does not count a check. Such a task is not counted toward the 1 in 10 either.
    const nightShift = await need('nightShift');
    if (typeof nightShift === 'function' && safe(() => nightShift(), false) === true) return { picked: false, why: 'night' };

    const { pick } = safe(() => sc.noteFinished({ kind: kindId, ref: worker }), { pick: false }) ?? { pick: false };
    if (!pick) return { picked: false };

    const SKIPS = (await pureOf(sc, 'SKIP_KEYS')) ?? ['tight', 'none', 'busy', 'held', 'cap'];
    const skip = async why => {
      if (SKIPS.includes(why)) {
        await Promise.resolve(safe(() => sc.noteSkip(why))).catch(() => {});
        tell('skipped');
      }
      return { picked: true, why };
    };
    // A seat's runner aborts its signal when it ends normally: that is no Stop, so a seat's check is not linked to it (Stop all ends it).
    const signal = SEAT_ROLES.has(info.callerRole) ? null : (info.signal ?? null);
    const g = safe(() => sc.gate({ signal }), { ok: false, why: 'readonly' });
    if (!g?.ok) return skip(g?.why);

    // The checker (section 3): the Review list first, then the plan models by size and provider.
    const chooseChecker = await pureOf(sc, 'chooseChecker');
    const kindsNow = kindsOf(team);
    const reviewList = refsOf(kindsNow.find(k => k.id === 'review')?.workers);
    const limits = safe(() => team.get?.()?.limits, {}) ?? {};
    const canRun = await need('canRun');
    // The registry's sizes, with billing asked now: its kept answer can be from before a key route was switched on in Accounts, and the
    // checker is never billed per token. A model whose billing is not known now is not a checker.
    const kept = safe(() => team.registry?.(), []);
    const rows = (Array.isArray(kept) ? kept : []).filter(r => isObject(r) && typeof r.ref === 'string' && LOOSE_REF.test(r.ref));
    const bills = await billedNow([...new Set([...reviewList, ...rows.map(r => r.ref)])].filter(ref => ref !== worker));
    const checker = typeof chooseChecker === 'function' ? chooseChecker(worker, {
      reviewList,
      registry: rows.map(r => ({ ...r, billing: bills.get(r.ref) ?? null })),
      availability: typeof team.availability === 'function' ? (ref, o) => team.availability(ref, o) : null,
      planRows: await planRows(),
      planUse: safe(() => team.planUse?.(), {}) ?? {},
      line: typeof limits.skipAbovePercent === 'number' ? limits.skipAbovePercent : 90,
      canRun: typeof canRun === 'function' ? canRun : null,
    }) : { ref: null, why: 'none' };
    if (!checker?.ref) return skip(checker?.why === 'tight' ? 'tight' : 'none');

    // The place in the day's count is on the disk before the check starts.
    let started;
    try {
      started = await sc.startCheck({ signal });
    } catch {
      started = { ok: false, why: 'save' };
    }
    if (!started?.ok) return skip(started?.why);
    const id = started.id;

    const runAgent = await need('runAgent');
    const openRun = await need('openRun');
    const project = isObject(info.project) ? info.project : null;
    if (typeof runAgent !== 'function' || typeof openRun !== 'function' || !project?.id) {
      await Promise.resolve(safe(() => sc.giveBack(id))).catch(() => {});
      return { picked: true, why: 'cannot-start' };
    }

    // What the checker reads: the work, in memory only, inside a fence.
    const changed = Array.isArray(info.changed) ? info.changed.filter(p => typeof p === 'string' && p) : [];
    let diff = null;
    if (changed.length) {
      const gitDiff = await need('gitDiff');
      try {
        diff = typeof gitDiff === 'function' ? await gitDiff(info.root, changed.slice(0, DIFF_PATHS)) : null;
      } catch {
        diff = null;
      }
      if (typeof diff !== 'string') diff = null;
    }
    const checkPrompt = await pureOf(sc, 'checkPrompt');
    const parseVerdict = await pureOf(sc, 'parseVerdict');
    const CHECK_TYPE = await pureOf(sc, 'CHECK_TYPE');
    const kindLabel = typeof kind.label === 'string' && kind.label ? kind.label : kindId;
    const prompt = checkPrompt({ kindLabel, brief: info.brief, doneWhen: info.doneWhen, answer: info.answer, changed, diff });
    const title = String(info.title ?? '').replace(/\s+/g, ' ').trim() || `${kindLabel} task`;

    const run = openRun({ projectId: project.id, kind: 'check', signal });
    checkNow = { kind: kindId, kindLabel, projectName: typeof project.name === 'string' ? project.name : '' };
    tell('checking');
    let r;
    try {
      r = await runAgent({
        run,
        caller: { role: 'chat', ref: checker.ref, label: 'Scorecard', depth: 0, parentId: `scorecard-${id}`, parentLabel: 'Scorecard' },
        agents: info.agents,
        type: { ...CHECK_TYPE, folders: [] },
        task: { id: `scorecard-${id}`, title: `Check · ${title}`, instructions: prompt.text },
        project,
        root: info.root,
        mode: 'ask',
        signal,
        internal: true,
        system: prompt.system,
        context: 'scorecard',
        modelOverride: checker.ref,
        effortOverride: 'medium',
        ...(info.stream ? { stream: info.stream } : {}),
      });
    } catch (err) {
      r = { ok: false, summary: '', error: err?.message || String(err) };
    } finally {
      safe(() => run.close?.());
      checkNow = null;
    }

    const stopped = typeof r?.stopped === 'string' ? r.stopped : '';
    const ran = Number.isFinite(r?.modelChars);
    let verdict;
    if (r?.refused === true || r?.denied === true || (PERSON_STOPS.has(stopped) && !ran)) {
      // Refused, or stopped while it waited: no model ran, and the place is given back.
      await Promise.resolve(safe(() => sc.giveBack(id))).catch(() => {});
      verdict = null;
    } else if (PERSON_STOPS.has(stopped)) {
      safe(() => sc.endCheck?.(id));
      verdict = null;
    } else {
      verdict = safe(() => parseVerdict(r), 'notFinished');
      await Promise.resolve(safe(() => sc.recordVerdict(kindId, worker, verdict, id))).catch(() => {});
      if (r?.ok !== true) {
        // A checker at its limit or signed out is told to the team, so the next choice knows.
        const cls = safe(() => team.classifyFailure?.(String(r?.error ?? ''), r?.stopped, r?.errorKind), 'failed');
        if (cls === 'limit' || cls === 'sign-in') {
          try {
            const done = team.noteOutcome?.({ ref: checker.ref, cls, ok: false, ...(r?.errorKind ? { kind: r.errorKind } : {}) });
            if (done && typeof done.catch === 'function') done.catch(() => {});
          } catch {
            // What the team learns must not change the count.
          }
        }
      }
    }
    if (PERSON_STOPS.has(stopped)) await Promise.resolve(safe(() => sc.hold())).catch(() => {});
    tell(verdict ? 'checked' : 'stopped');
    return { picked: true, checker: checker.ref, ...(verdict ? { verdict } : { stopped: stopped || 'refused' }) };
  }

  function afterTask(info) {
    try {
      const work = Promise.resolve().then(() => check(isObject(info) ? info : {})).catch(() => ({ picked: false, why: 'error' }));
      return track(work);
    } catch {
      return Promise.resolve({ picked: false, why: 'error' });
    }
  }

  // ---------- Try each worker ----------

  function stateOf(team, r) {
    const stopped = typeof r?.stopped === 'string' ? r.stopped : '';
    if (PERSON_STOPS.has(stopped)) return 'stopped';
    if (r?.ok === true) return Number(r.modelChars) > 0 ? 'ok' : 'failed';
    const cls = safe(() => team.classifyFailure?.(String(r?.error ?? ''), r?.stopped, r?.errorKind), 'failed');
    return TRY_STATE_OF[cls] ?? 'failed';
  }

  async function tryAll({ project, root, agents, stream, team, sc, refs, rows }) {
    const runAgent = await need('runAgent');
    const openRun = await need('openRun');
    const run = openRun({ projectId: project.id, kind: 'check' });
    const id = randomUUID().slice(0, 8);
    let stoppedByPerson = false;
    try {
      // Every tiny task starts now, in the same run: runAgent's own queue holds those that wait, so they are on the board too.
      const results = await Promise.all(refs.map(async ref => {
        let r;
        try {
          r = await runAgent({
            run,
            caller: { role: 'chat', ref: null, label: 'Scorecard', depth: 0, seat: 'scorecard-try', parentId: `scorecard-${id}`, parentLabel: 'Scorecard' },
            agents,
            type: { ...TRY_TYPE, folders: [] },
            task: { id: `scorecard-try-${id}`, title: `Try · ${labelOf(team, ref)}`, instructions: TRY_TASK },
            project,
            root,
            mode: 'ask',
            internal: true,
            system: TRY_SYSTEM,
            context: 'scorecard',
            modelOverride: ref,
            effortOverride: 'low',
            ...(stream ? { stream } : {}),
          });
        } catch (err) {
          r = { ok: false, summary: '', error: err?.message || String(err) };
        }
        const state = stateOf(team, r);
        if (state === 'stopped') stoppedByPerson = true;
        else if (!r?.refused) {
          const cls = r?.ok === true ? '' : safe(() => team.classifyFailure?.(String(r?.error ?? ''), r?.stopped, r?.errorKind), 'failed');
          try {
            const done = team.noteOutcome?.({ ref, cls, ok: r?.ok === true, ...(r?.errorKind ? { kind: r.errorKind } : {}) });
            if (done && typeof done.catch === 'function') done.catch(() => {});
          } catch {
            // What the team learns must not change the rows.
          }
        }
        return { ref, state };
      }));
      for (const row of results) rows.find(x => x.ref === row.ref).state = row.state;
    } finally {
      safe(() => run.close?.());
    }
    try {
      await sc.saveTried(rows.map(({ ref, state }) => ({ ref, state })));
    } catch {
      // A file of a newer Plenum or one that cannot be read now: the rows are not kept.
    }
    if (stoppedByPerson) await Promise.resolve(safe(() => sc.hold())).catch(() => {});
    return rows;
  }

  // stream (tests only): the stand-in model stream every tiny task runs on.
  async function tryEach({ project, root, agents, stream } = {}) {
    if (tryNow) return { started: false, say: TEXT.trying };
    if (!isObject(project) || !project.id) return { started: false, say: TEXT.noProject };
    const sc = await need('scorecard');
    const team = await need('team');
    const runAgent = await need('runAgent');
    const openRun = await need('openRun');
    if (!sc || !team || typeof runAgent !== 'function' || typeof openRun !== 'function') return { started: false, say: TEXT.notReady };
    if (tryNow) return { started: false, say: TEXT.trying };
    tryNow = { count: 0 };
    try {
      await within(Promise.resolve().then(() => team.ready?.()), PLAN_WAIT_MS, null);
      // Every model on the team, once, in the order of the kinds and of each list.
      const refs = [];
      for (const k of kindsOf(team)) for (const ref of refsOf(k.workers)) if (!refs.includes(ref)) refs.push(ref);
      if (!refs.length) {
        tryNow = null;
        return { started: false, say: TEXT.noTeam };
      }
      // Billing asked now for each model, never the registry's kept answer: only a model on its plan runs. One billed per token, or one
      // whose billing could not be read, is not tried (its row says so).
      const bills = await billedNow(refs);
      const rows = [];
      const runs = [];
      for (const ref of refs) {
        // 'unknown': the billing could not be read in time, which is not "billed per token".
        const bill = bills.get(ref);
        const row = { ref, state: bill === 'plan' ? 'stopped' : bill === 'api' ? 'api' : 'unknown' };
        rows.push(row);
        if (row.state === 'stopped') runs.push(ref);
      }
      tryNow = { count: runs.length };
      const work = (runs.length ? tryAll({ project, root, agents, stream: stream ?? deps.stream, team, sc, refs: runs, rows }) : Promise.resolve().then(() => sc.saveTried(rows)))
        .catch(() => null)
        .finally(() => {
          tryNow = null;
          tell('tried');
        });
      track(work);
      return { started: true, count: runs.length };
    } catch {
      tryNow = null;
      return { started: false, say: TEXT.notReady };
    }
  }

  function running() {
    if (tryNow) return { type: 'try', count: tryNow.count };
    if (checkNow) return { type: 'check', ...checkNow };
    return null;
  }

  const idle = async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  };

  return { afterTask, tryEach, running, idle };
}

// ---------- the default instance: what lib/team-run.mjs (its neighbour `scorecard`) and lib/routes/scorecard.mjs read ----------

let instance = null;
const runner = () => (instance ??= createScorecardRun());
export const afterTask = info => runner().afterTask(info);
export const tryEach = opts => runner().tryEach(opts);
export const running = () => runner().running();
export const idle = () => runner().idle();
