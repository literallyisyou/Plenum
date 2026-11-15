// The team runner: what the delegate tool (lib/tools/40-delegate.mjs) puts between the lead's call and runAgent (lib/agent-run.mjs).
// A lead names the KIND of work, the owner's team (lib/team.mjs) gives the task to the first model in his list that can run now, the
// worker gets a short brief, the lead gets a short answer, several tasks go out in one call, and a limit or a sign-in failure moves a
// task to the next model in the owner's own list and says so. Nothing changes until the owner turns his team on: a call that uses none
// of the new arguments while the team is off goes to runAgent untouched.
//
// THE CONTRACT (ultra/biz/DELEGATION-DESIGN.md sections 7, 8, 9, 11 and 15; pinned by build/v06/ultra-w3-team-run)
//
//   withTeamFields(def)              -> def with work, level, done_when, job, tasks, program after coder, and the sentences of 7.1 (then
//                                       programs.toolText()) at the end of the description. Its argument unchanged if anything throws.
//   agentForWork(work)               -> the agent type of that kind of work, or undefined (no kind of that name, or no work given).
//   describeTail(input)              -> ' in Claude Code' for a program hand-off, ' (+2 more)' for further tasks, '' when anything throws.
//   runTeamTask(input, ctx, args)    -> what runAgent(args) returns, plus team: { lines, summaryTail } when it did more than pass the
//                                       call through. args is the exact object lib/tools/40-delegate.mjs gave runAgent before.
//   runAll(input, ctx, runOne)       -> runOne(input, ctx) with no tasks; with tasks the call's own task and up to 7 more at the same
//                                       time, each through runOne with the same ctx, joined under [n of m] in one answer.
//   createTeamRun(deps)              -> one instance of the five above with its neighbours injected (the tests), plus .neighbours (the
//                                       live object it reads on every call), .notes (the job notes) and .hooksFor(args). deps: the
//                                       five neighbours, runAgent, now, notes and teamPage (is the Team page in this build).
//   loadNeighbours(urls, { waitMs }) -> { team, teamLog, business, programs, programRun }, each a module or null. Never throws.
//
// Arguments the lead may add (7.1): work, level (small, mid, top), done_when (600 characters), job (40), tasks (up to 7 objects with
// title, instructions, work, scope, done_when, program) and program. What a further task leaves out it takes from the call: job,
// model, level and effort, and the kind of work when it names none.
//
// The worker's brief (7.2): the lead's instructions, then only the parts that apply: DONE WHEN, NOTES FROM THIS JOB (1,600 characters
// at most), RULE (the business this folder belongs to), the kind's reply sentence and "Keep your reply under N characters." 12,000
// characters at most in all. No reply layout of Plenum's own: every agent type has one.
//
// Events, through the call's own emit: { type: 'tool', name: 'team', id, summary, parent } and its { type: 'tool_result', id, ok: true,
// summary } (the same sentence; in a call with several tasks it starts with the task's title)
// when the team chose the model and for each move (a call that has no parent sends the same sentence as { type: 'notice', kind: 'team' },
// so it is never counted as a tool step of an agent); { type: 'notice', kind: 'team-off' } once per server run while the team is off
// (only in a build that has the team and its page).
//
// The log line handed to lib/team-log.mjs append(entry) (5.4): { v: 1, at, project, job, work, agent, title, lead, worker, provider,
// program: '', picked, moved: [{ from, why }], ok, state: 'done' | 'not finished' | 'stopped', cls, ms, steps, changed,
// usage: { billing, input, output, dollars } }. Titles, models, times and counts; never instructions, answers or file contents.
//
// NEIGHBOURS. lib/team.mjs, lib/team-log.mjs, lib/business.mjs, lib/programs.mjs and lib/program-run.mjs are loaded with import() inside
// a try at the top of this file, because the tool's definition is built synchronously. This is the ONE new module that awaits an import
// at its top, so none of those five, and nothing they import statically, may import this file, lib/tools/40-delegate.mjs or
// lib/routes/index.mjs. A neighbour that is missing, broken or slower than ten seconds counts as missing (one that arrives late is
// taken up then): without the first three this file runs as before the team existed, and without the last two a call that names a
// program is refused with one sentence. What it reads of them: team.teamOn(), get().kinds, pick(q), noteOutcome({ ref, cls, ok }),
// classifyFailure(text, stopped); teamLog.append(entry); business.overlayFor(projectId) -> { kinds, lines, allowApi, rule } | null;
// programs.toolText(), labelOf(id); programRun.runProgramTask(input, ctx, args, hooks) with hooks = { runAgent, kindOf(input),
// briefOf(input, kind), noteJob(project, job, text), log(entry) }.
//
// ADDING TO IT LATER. A new kind of work is a record of the team, not code. A new argument is one entry in FIELDS and one line where it
// is read. A new neighbour is one name in NEIGHBOURS. A new way to run a task (as programs are) is a module of its own that gets
// hooksFor(args), so that it never imports this file.

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { runAgent as agentRunner } from './agent-run.mjs';
import { labelFor, splitRef } from './providers.mjs';

// ---------- limits and texts ----------

export const LIMITS = { tasks: 7, brief: 12_000, doneWhen: 600, job: 40, note: 300, notesInBrief: 1_600, jobs: 200, notesPerJob: 20, joined: 20_000, moves: 2, answerMax: 2_400 };
const LEVELS = ['small', 'mid', 'top'];
// The arguments that take a call out of the legacy path even while the team is off (program is handled before them).
const NEW_ARGS = ['work', 'level', 'done_when', 'job'];

// The kinds of work when lib/team.mjs is not in this build: the seven built-in ones, with the type each runs as (5.3).
export const FALLBACK_KINDS = [
  { id: 'find', label: 'Find', agent: 'researcher', reply: '', answerMax: 2_400 },
  { id: 'research', label: 'Research', agent: 'researcher', reply: '', answerMax: 2_400 },
  { id: 'code', label: 'Code', agent: 'coder', reply: '', answerMax: 2_400 },
  { id: 'test', label: 'Test', agent: 'tester', reply: '', answerMax: 2_400 },
  { id: 'write', label: 'Write', agent: 'researcher', reply: 'Reply with the finished text only. The findings layout does not apply to this task.', answerMax: 8_000 },
  { id: 'data', label: 'Data', agent: 'researcher', reply: 'Reply with the rows or the table asked for, then OPEN: and what you could not settle.', answerMax: 8_000 },
  { id: 'review', label: 'Review', agent: 'reviewer', reply: '', answerMax: 2_400 },
];

export const TEXT = {
  noProgramsBuild: 'This build cannot hand work to a program yet. Leave program out.',
  noProgramSetUp: 'No program is set up. Leave this out.',
  tooMany: 'At most 8 tasks in one call. Send the rest in a second call.',
  tasksNotList: 'tasks must be a list of tasks, each with a title and instructions.',
  badLevel: 'level must be small, mid or top.',
  briefCut: 'The brief was cut at 12,000 characters. Name files by path instead of pasting them.',
  teamOff: 'Delegated work uses one model for everything. Your team can spread it over your subscriptions: Settings > Agents > Team.',
  levelUnused: 'TEAM: Your team is off, so level was not used. The type\'s own model did the work.',
};

// What a failure class reads as: after a model's name ("X is at its plan limit, so ..."), and after "stopped".
const CAUSE = {
  limit: ['is at its plan limit', 'at its plan limit'],
  'sign-in': ['needs sign-in', 'because it needs sign-in'],
  // The program is signed in and its sign-in was refused for that one run (lib/cli-errors.mjs, kind sign-in-refused).
  refused: ['had its sign-in refused for this task, although it is signed in', 'because its sign-in was refused, although it is signed in'],
  'not-offered': ['is not offered on this account right now', 'because it is not offered on this account right now'],
  'not-installed': ['is not installed on this computer', 'because it is not installed on this computer'],
  slow: ['took too long', 'at its time limit'],
};
const MOVE_ALWAYS = new Set(['limit', 'sign-in', 'refused', 'not-offered', 'not-installed']);
// A coder on one of these cannot ask before it writes (CANNOT_ASK in lib/agent-run.mjs, DECISIONS item 43): the move line says so.
const CANNOT_ASK = { codex: 'Codex', gemini: 'Gemini' };

// The new properties, in the order the battery pins (after coder). `program` is always in the schema.
const FIELDS = {
  work: () => ({ type: 'string', description: 'One of the kinds of work. It sets the agent type.' }),
  level: () => ({ type: 'string', enum: LEVELS, description: 'Optional. The smallest model size to use.' }),
  done_when: () => ({ type: 'string', description: 'How to tell the task is finished.' }),
  job: () => ({ type: 'string', description: 'A short name shared by the tasks of one piece of work. A later task gets the earlier results as notes.' }),
  tasks: () => ({
    type: 'array',
    description: 'Up to 7 more tasks to run at the same time. Each takes job, model, level and effort from this call.',
    items: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        instructions: { type: 'string' },
        work: { type: 'string' },
        scope: { type: 'array', items: { type: 'string' } },
        done_when: { type: 'string' },
        program: { type: 'string' },
      },
      required: ['title', 'instructions'],
      additionalProperties: false,
    },
  }),
  program: hasPrograms => ({ type: 'string', description: hasPrograms ? 'Optional. A program named above to run the task in.' : TEXT.noProgramSetUp }),
};

// ---------- small helpers ----------

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const given = v => v !== undefined && v !== null && String(v).trim() !== '';
const oneLine = v => String(v ?? '').replace(/\s+/g, ' ').trim();
// A cut can leave half of a surrogate pair at the end, which is not valid text, so that half goes too.
const head = (s, n) => (s.length > n ? s.slice(0, n).replace(/[\ud800-\udbff]$/, '') : s);
const num = n => Number(n).toLocaleString('en-US');
const lowerFirst = s => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const openMode = mode => mode === 'auto' || mode === 'all';
const providerOf = ref => {
  const s = String(ref ?? '');
  return s.includes(':') ? splitRef(s).provider : '';
};
const labelOf = ref => {
  try {
    return String(ref ?? '').includes(':') ? labelFor(String(ref)) : String(ref ?? '');
  } catch {
    return String(ref ?? '');
  }
};
// The name of a subscription ("Claude", "Codex") where the table of the team's log is not at hand: what labelFor puts in front of an
// id it does not know, and for a provider it has no name for, the id with a capital.
const providerName = provider => {
  try {
    const name = labelFor(`${provider}:\u0001`).split(' · ')[0];
    return name && name !== provider ? name : provider.charAt(0).toUpperCase() + provider.slice(1);
  } catch {
    return provider;
  }
};

// An answer cut to its limit, with the sentence that says so (7.3).
export function cutAnswer(text, max) {
  const s = String(text ?? '');
  const lim = Number.isFinite(max) && max > 0 ? Math.floor(max) : LIMITS.answerMax;
  if (s.length <= lim) return s;
  return `${head(s, lim).trimEnd()}\n[cut at ${num(lim)} of ${num(s.length)} characters. Ask again for the part you need.]`;
}

// "3.1k tokens", and dollars for a model billed per token (7.3). '' when the provider reported nothing.
export function usageWords(usage, cost) {
  const parts = [];
  if (usage && usage.reported) {
    const n = (Number(usage.input) || 0) + (Number(usage.output) || 0);
    if (n > 0) parts.push(n < 1000 ? `${n} tokens` : n < 100_000 ? `${(n / 1000).toFixed(1)}k tokens` : n < 1_000_000 ? `${Math.round(n / 1000)}k tokens` : `${(n / 1_000_000).toFixed(1)}M tokens`);
  }
  if (usage?.billing === 'api' && Number.isFinite(cost)) parts.push(cost > 0 && cost < 0.005 ? 'under $0.01' : `$${cost.toFixed(2)}`);
  return parts.join(' · ');
}

// The shape runAgent gives a start refused for a wrong input: lib/tools/40-delegate.mjs writes "Not finished: <sentence>".
const refuse = error => ({ ok: false, summary: '', changed: [], outOfScope: [], error, refused: true, why: 'input', elapsedMs: 0, turns: 0, cost: null, usage: null, agentId: null });

// ---------- the neighbours ----------

export const NEIGHBOURS = { team: './team.mjs', teamLog: './team-log.mjs', business: './business.mjs', programs: './programs.mjs', programRun: './program-run.mjs' };

// Imports each neighbour inside a try. A missing or broken one is null; one that takes longer than waitMs is null for now and is put
// into the answer when it arrives (onLate(name, module) is told as well). Never throws, so the delegate tool always loads.
export async function loadNeighbours(urls = NEIGHBOURS, { waitMs = 10_000, base = import.meta.url, onLate } = {}) {
  const out = {};
  const names = Object.keys(urls);
  for (const name of names) out[name] = null;
  await Promise.all(names.map(async name => {
    let timer;
    try {
      const loading = import(new URL(urls[name], base).href);
      // A neighbour that hangs (two modules waiting for each other) must not keep the tool from loading.
      loading.then(mod => {
        out[name] ??= mod;
        onLate?.(name, mod);
      }, () => {});
      const late = new Promise(resolve => {
        timer = setTimeout(() => resolve(null), waitMs);
        timer.unref?.();
      });
      out[name] = await Promise.race([loading, late]);
    } catch {
      out[name] = null;
    } finally {
      clearTimeout(timer);
    }
  }));
  return out;
}

// ---------- the job notes (section 8): the server's memory, per project and job; nothing is written into the project folder ----------

export function createNotes({ jobs = LIMITS.jobs, perJob = LIMITS.notesPerJob } = {}) {
  const map = new Map();
  const keyOf = (project, job) => `${String(project ?? '')}\n${String(job ?? '')}`;
  return {
    add(project, job, text, provider = '') {
      const line = head(oneLine(text), 2 * LIMITS.note);
      if (!given(job) || !line) return;
      const key = keyOf(project, job);
      const list = map.get(key) ?? [];
      // Asked for again, so it is the newest job: the oldest job is the one that goes when there are too many.
      map.delete(key);
      list.push({ text: line, provider: String(provider ?? '') });
      while (list.length > perJob) list.shift();
      map.set(key, list);
      while (map.size > jobs) map.delete(map.keys().next().value);
    },
    list: (project, job) => (map.get(keyOf(project, job)) ?? []).map(n => ({ ...n })),
    providers: (project, job) => [...new Set((map.get(keyOf(project, job)) ?? []).map(n => n.provider).filter(Boolean))],
    // The newest notes that fit into `max` characters, the newest last.
    forBrief(project, job, max = LIMITS.notesInBrief) {
      const list = map.get(keyOf(project, job)) ?? [];
      const picked = [];
      let used = 0;
      for (let i = list.length - 1; i >= 0; i--) {
        const line = `- ${list[i].text}`;
        if (used + line.length + 1 > max) break;
        picked.unshift(line);
        used += line.length + 1;
      }
      return picked;
    },
    get size() {
      return map.size;
    },
  };
}

// ---------- one instance ----------

export function createTeamRun(deps = {}) {
  const nb = { team: null, teamLog: null, business: null, programs: null, programRun: null };
  for (const name of Object.keys(nb)) nb[name] = deps[name] ?? null;
  const runAgent = deps.runAgent ?? agentRunner;
  const now = deps.now ?? Date.now;
  const notes = deps.notes ?? createNotes();
  // Whether this build has the Team page (public/ext-team.js): the line that points to it is not said without it.
  const teamPage = deps.teamPage ?? (() => existsSync(new URL('../public/ext-team.js', import.meta.url)));
  // What runAll needs to name the subscriptions in its row: the worker of each call, by the call's own input object.
  const workers = new WeakMap();
  // The inputs that are one of several tasks of one call: their rows in the chat start with the task's title.
  const several = new WeakSet();
  // The workers of a run that are going now, per provider (pick spreads by them), and one choice at a time per run.
  const going = new WeakMap();
  const locks = new WeakMap();
  let hinted = false;

  // ----- the team, read safely -----

  const teamOn = () => {
    try {
      return nb.team?.teamOn?.() === true;
    } catch {
      return false;
    }
  };
  const kinds = () => {
    try {
      const list = nb.team?.get?.()?.kinds;
      if (Array.isArray(list)) {
        const good = list.filter(k => isObject(k) && given(k.id) && given(k.agent));
        if (good.length) return good;
      }
    } catch {
      // A team that cannot be read leaves the built-in kinds.
    }
    return FALLBACK_KINDS;
  };
  const kindById = work => kinds().find(k => k.id === String(work).trim().toLowerCase()) ?? null;
  const kindOf = (input, type) => {
    if (given(input?.work)) return kindById(input.work);
    const name = given(input?.agent) ? String(input.agent) : type?.name;
    return name ? kinds().find(k => k.agent === name) ?? null : null;
  };
  const answerMaxOf = kind => (Number.isFinite(kind?.answerMax) && kind.answerMax >= 200 ? Math.min(24_000, Math.floor(kind.answerMax)) : LIMITS.answerMax);
  const classify = (text, stopped) => {
    try {
      const cls = nb.team?.classifyFailure?.(String(text ?? ''), stopped);
      return typeof cls === 'string' ? cls : 'failed';
    } catch {
      return 'failed';
    }
  };
  const noteOutcome = (ref, cls, ok) => {
    if (!ref) return;
    try {
      const done = nb.team?.noteOutcome?.({ ref, cls, ok });
      if (done && typeof done.catch === 'function') done.catch(() => {});
    } catch {
      // What the team learns must not change the answer.
    }
  };
  const log = entry => {
    try {
      const done = nb.teamLog?.append?.(entry);
      if (done && typeof done.catch === 'function') done.catch(() => {});
    } catch {
      // A log that cannot be written must not lose the worker's answer.
    }
  };
  // The name the Team page uses for a subscription (PROVIDER_LABELS of lib/team-log.mjs), else the catalog's.
  const subscription = provider => {
    try {
      const name = nb.teamLog?.PROVIDER_LABELS?.[provider];
      if (typeof name === 'string' && name) return name;
    } catch {
      // The catalog's name is used.
    }
    return providerName(provider);
  };
  const overlayFor = async project => {
    try {
      const o = await nb.business?.overlayFor?.(project?.id);
      return isObject(o) ? o : null;
    } catch {
      return null;
    }
  };

  // ----- the definition (7.1, 15.2) -----

  function agentForWork(work) {
    try {
      return given(work) ? kindById(work)?.agent ?? undefined : undefined;
    } catch {
      return undefined;
    }
  }

  function withTeamFields(def) {
    try {
      let programText = '';
      try {
        programText = String(nb.programs?.toolText?.() ?? '').trim();
      } catch {
        programText = '';
      }
      const added = {};
      for (const [name, make] of Object.entries(FIELDS)) added[name] = make(Boolean(programText));
      const sentences = [
        `Name the kind of work in \`work\` (kinds: ${kinds().map(k => k.id).join(', ')})${teamOn() ? ' and leave `model` out: the owner\'s team picks the model' : ''}.`,
        'Say in `done_when` how to tell it is finished.',
        'Name files by path instead of pasting them.',
        'For several tasks at once put the others in `tasks`: every answer comes back in this one answer.',
        'Bundle many small items of one kind into one task, because every worker start has a fixed cost.',
        'To have a result checked, hand over a `review` task with the same `job`.',
      ];
      if (programText) sentences.push(programText);
      return {
        ...def,
        description: `${def.description} ${sentences.join(' ')}`,
        input_schema: { ...def.input_schema, properties: { ...def.input_schema.properties, ...added } },
      };
    } catch {
      return def;
    }
  }

  function describeTail(input) {
    try {
      let tail = '';
      if (given(input?.program)) {
        let label = '';
        try {
          label = String(nb.programs?.labelOf?.(String(input.program)) ?? '').trim();
        } catch {
          label = '';
        }
        tail += ` in ${head(label || oneLine(input.program), 60)}`;
      }
      if (Array.isArray(input?.tasks) && input.tasks.length) tail += ` (+${input.tasks.length} more)`;
      return tail;
    } catch {
      return '';
    }
  }

  // ----- the brief (7.2) -----

  // The instructions the worker gets, and whether the lead's own text was cut to make them fit.
  function briefOf(input, kind, project, overlay = null) {
    const own = String(input?.instructions ?? '').trim();
    // No instructions is runAgent's refusal to give; nothing is added to an empty brief.
    if (!own) return { text: '', cut: false };
    const parts = [];
    if (given(input.done_when)) parts.push(`DONE WHEN: ${head(oneLine(input.done_when), LIMITS.doneWhen)}`);
    if (given(input.job)) {
      const lines = notes.forBrief(project?.id, jobOf(input));
      if (lines.length) parts.push(['NOTES FROM THIS JOB (what other workers found so far; do not repeat their work):', ...lines].join('\n'));
    }
    if (given(overlay?.rule)) parts.push(`RULE: ${head(oneLine(overlay.rule), 300)}`);
    if (kind) {
      const reply = oneLine(kind.reply);
      parts.push(`${reply ? `${head(reply, 300)}\n` : ''}Keep your reply under ${num(answerMaxOf(kind))} characters.`);
    }
    const tail = parts.length ? `\n\n${parts.join('\n\n')}` : '';
    const room = Math.max(200, LIMITS.brief - tail.length);
    const cut = own.length > room;
    return { text: `${cut ? head(own, room) : own}${tail}`, cut };
  }
  const jobOf = input => head(oneLine(input?.job), LIMITS.job);

  // ----- events -----

  // One nested step row under the call. A call with no parent has no row to nest under, and a tool event without a parent would be
  // counted as a tool step of the agent that asked, so the same sentence goes out as a notice.
  function row(args, text) {
    const emit = args?.emit;
    if (typeof emit !== 'function') return;
    try {
      if (args.parent) {
        const id = `team-${randomUUID()}`;
        emit({ type: 'tool', id, name: 'team', summary: text, parent: args.parent });
        // The row cuts a long sentence at its width; opened, it shows the whole of it.
        emit({ type: 'tool_result', id, ok: true, summary: text, parent: args.parent });
      } else {
        emit({ type: 'notice', kind: 'team', text });
      }
    } catch {
      // A broken stream must not change the answer.
    }
  }

  // Once per server run, while the owner's team is off: where to find it (5.3). Not for an agent that hands on.
  function hint(args) {
    if (hinted || !nb.team || args?.caller?.role === 'agent' || typeof args?.emit !== 'function') return;
    hinted = true;
    try {
      if (!teamPage()) return;
    } catch {
      return;
    }
    try {
      args.emit({ type: 'notice', kind: 'team-off', text: TEXT.teamOff });
    } catch {
      // A broken stream must not change the answer.
    }
  }

  // ----- the choice -----

  const countsOf = run => {
    const map = isObject(run) ? going.get(run) : null;
    return map ? Object.fromEntries(map) : {};
  };
  const bump = (run, provider, by) => {
    if (!isObject(run) || !provider) return;
    const map = going.get(run) ?? new Map();
    const n = (map.get(provider) ?? 0) + by;
    if (n > 0) map.set(provider, n);
    else map.delete(provider);
    going.set(run, map);
  };
  // One choice at a time per run: tasks that start together must see each other's places, or all of them take the first model.
  const serial = (run, fn) => {
    if (!isObject(run)) return fn();
    const next = (locks.get(run) ?? Promise.resolve()).then(fn, fn);
    locks.set(run, next.catch(() => {}));
    return next;
  };
  // Asks the team. The place of the chosen model is taken before the next choice of this run is made.
  const choose = (q, run) => serial(run, async () => {
    // Asked in the background and never waited for (at most every 10 minutes, lib/team.mjs): a hand-over that is refused also brings a
    // fresh plan-use reading for the next one.
    try {
      nb.team.refreshPlanUse?.()?.catch?.(() => {});
    } catch {
      // The choice does not depend on it.
    }
    const p = await nb.team.pick({ ...q, counts: countsOf(run) });
    const out = isObject(p) ? p : { ref: null, error: '', skipped: [] };
    if (given(out.ref)) bump(run, providerOf(out.ref), 1);
    return out;
  });
  // The models that were passed over on the way to the chosen one. The team lists every model of the kind that cannot run now; one that
  // stands after the chosen model in the owner's list was not skipped, and one already tried is told by the line of its move.
  const skippedWords = (skipped, chosen, list) => (Array.isArray(skipped) ? skipped : [])
    .filter(s => isObject(s) && given(s.ref) && s.code !== 'tried')
    .filter(s => !Array.isArray(list) || !list.includes(chosen) || !list.includes(s.ref) || list.indexOf(s.ref) < list.indexOf(chosen))
    .map(s => `${given(s.label) ? s.label : labelOf(s.ref)} was skipped (${oneLine(s.reason).replace(/^is /i, '').replace(/\.$/, '') || 'cannot run now'})`);

  // ----- what a program hand-off gets from this module (7.4 step 0), so that neither module imports the other -----

  function hooksFor(args, overlay = null) {
    return {
      runAgent,
      kindOf: input => kindOf(input, args?.type),
      briefOf: (input, kind) => briefOf(input, kind ?? null, args?.project, overlay).text,
      noteJob: (project, job, text) => notes.add(isObject(project) ? project.id : project, head(oneLine(job), LIMITS.job), text, ''),
      log,
    };
  }

  async function runProgram(input, ctx, args) {
    const run = nb.programRun?.runProgramTask;
    if (typeof run !== 'function') return refuse(TEXT.noProgramsBuild);
    try {
      const r = await run(input, ctx, args, hooksFor(args, await overlayFor(args?.project)));
      return isObject(r) ? r : refuse(`The hand-off to ${head(oneLine(input.program), 60)} gave no result.`);
    } catch (err) {
      return refuse(`The hand-off to ${head(oneLine(input.program), 60)} could not start: ${err?.message || String(err)}`);
    }
  }

  // ----- one task (7.4) -----

  async function runTeamTask(input, ctx, args) {
    const inp = isObject(input) ? input : {};
    const remember = r => {
      if (isObject(input)) workers.set(input, { ref: r?.model ?? null, ok: r?.ok === true, program: given(inp.program) ? String(inp.program) : '' });
      return r;
    };

    // 0. A program: handed to lib/program-run.mjs and returned as it is. Never chosen by the team and never moved.
    if (given(inp.program)) return remember(await runProgram(inp, ctx, args));

    // 1. Legacy: the team is off and no new argument is used. runAgent and its result, untouched.
    const on = teamOn();
    if (!on) hint(args);
    if (!on && !NEW_ARGS.some(k => given(inp[k]))) return remember(await runAgent(args));

    // 2. The kind.
    const type = args?.type ?? null;
    const project = args?.project ?? null;
    const kind = kindOf(inp, type);
    if (given(inp.work) && !kind) {
      return remember(refuse(`There is no kind of work called ${head(oneLine(inp.work), 40)}. Kinds: ${kinds().map(k => k.id).join(', ')}.`));
    }
    const level = given(inp.level) ? String(inp.level).trim().toLowerCase() : '';
    if (level && !LEVELS.includes(level)) return remember(refuse(TEXT.badLevel));
    const job = jobOf(inp);
    const lines = [];
    const rowOf = text => row(args, `${isObject(input) && several.has(input) ? `${head(oneLine(inp.title), 60)} · ` : ''}${text}`);
    const kindLabel = given(kind?.label) ? kind.label : kind?.id ?? '';
    let whose = 'your team';

    // 3. The model. A model the lead named wins and is never swapped. Team off, or a type with no kind: the type's own, as before.
    const named = inp.model ?? inp.coder;
    const teamPicks = on && !given(named) && kind !== null && typeof nb.team?.pick === 'function';
    const overlay = await overlayFor(project);
    // A business may have its own list for a kind (BUSINESS-DESIGN.md section 2): the sentences then name that list.
    if (kind && Array.isArray(overlay?.kinds?.[kind.id]?.workers) && overlay.kinds[kind.id].workers.length) whose = "this business's list";
    const tried = [];
    const moved = [];
    let query = null;
    let picked = null;
    let skips = [];
    if (teamPicks) {
      const avoid = kind.id === 'review' && job ? notes.providers(project?.id, job) : [];
      query = { work: kind.id, ...(level ? { level } : {}), overlay, mode: args?.mode, project, avoidProviders: avoid };
      try {
        picked = await choose({ ...query, exclude: [] }, args?.run);
      } catch (err) {
        return remember(refuse(`Your team could not choose a model: ${err?.message || String(err)} Name a model, or try again.`));
      }
      if (!given(picked.ref) && picked.empty === true) {
        // The list in force for this kind holds no model (lib/team.mjs pick answers empty: true): the team has no say, and the task
        // runs on the model of its agent type, as with the team off.
        picked = null;
      } else if (!given(picked.ref)) {
        return remember(refuse(given(picked.error) ? String(picked.error) : `No model in ${whose} for ${kindLabel} can run now. Open Settings > Agents > Team, or name a model.`));
      } else {
        const own = overlay?.kinds?.[kind.id]?.workers;
        skips = skippedWords(picked.skipped, picked.ref, Array.isArray(own) && own.length ? own : kind.workers);
        if (avoid.length && avoid.includes(providerOf(picked.ref))) {
          lines.push(`TEAM: Every model in ${whose} for ${kindLabel} that can run now is on a subscription that already worked on this job. ${labelOf(picked.ref)} did the check.`);
        }
        rowOf(`${given(picked.label) ? picked.label : labelOf(picked.ref)}: ${lowerFirst(oneLine(picked.why)) || `first in ${whose} for ${kindLabel} that can run now.`}`);
      }
    } else if (!on && level) {
      lines.push(TEXT.levelUnused);
    }

    // 4. The brief, the kind's effort unless the lead named one, the chosen model, and every other field as it came.
    const brief = briefOf(inp, kind, project, overlay);
    if (brief.cut) lines.push(TEXT.briefCut);
    const effort = given(inp.effort) ? inp.effort : given(picked?.effort) ? picked.effort : given(kind?.effort) ? kind.effort : args?.effortOverride;
    const argsFor = ref => ({
      ...args,
      task: { ...args?.task, ...(brief.text ? { instructions: brief.text } : {}) },
      effortOverride: effort,
      ...(ref ? { modelOverride: ref } : {}),
    });

    // 6 and 7. Run, and move to the next model in the owner's list when the conditions of 7.4 step 7 all hold.
    let ref = picked?.ref ?? null;
    let r;
    let cls = '';
    for (;;) {
      try {
        r = await runAgent(argsFor(ref));
      } finally {
        if (ref) bump(args?.run, providerOf(ref), -1);
      }
      // A start that was refused or denied before the agent began is the answer as it is.
      if (!isObject(r) || r.refused || r.denied) return remember(r);
      const worker = r.model ?? ref;
      cls = r.ok ? '' : classify(r.error, r.stopped);
      // Only while the team is on: what it learns makes it ask for the plan-use reading in the background.
      if (on) noteOutcome(worker, cls, r.ok === true);
      const cause = CAUSE[cls];
      const pressedStop = Boolean(args?.signal?.aborted || args?.run?.signal?.aborted || r.stopped === 'user' || r.stopped === 'parent');
      const movable = !r.ok && Boolean(cause) && (MOVE_ALWAYS.has(cls) || (cls === 'slow' && type?.kind !== 'edit' && !type?.commands));
      if (!movable || pressedStop) break;
      if (!picked) {
        // The lead named the model: it is never swapped, and the lead is told why nothing else ran.
        if (on && given(named) && MOVE_ALWAYS.has(cls)) lines.push(`TEAM: ${labelOf(worker)} could not run: it ${cause[0]}. Plenum did not use another model, because you named this one. Leave model out to let the team choose.`);
        break;
      }
      const touched = (r.changed?.length ?? 0) + (r.outOfScope?.length ?? 0);
      if (touched || r.unchecked) {
        lines.push(touched
          ? `TEAM: ${labelOf(worker)} stopped ${cause[1]} after changing ${touched} ${touched === 1 ? 'file' : 'files'}. Plenum did not start another model on half-done work. The files are listed; Rewind can undo them.`
          : `TEAM: ${labelOf(worker)} stopped ${cause[1]}, and Plenum could not check whether it changed files. It did not start another model on work that may be half done.`);
        break;
      }
      if (moved.length >= LIMITS.moves) {
        lines.push(`TEAM: ${labelOf(worker)} ${cause[0]}. Plenum moved this task ${LIMITS.moves} times and stopped there.`);
        break;
      }
      tried.push(ref);
      let next;
      try {
        next = await choose({ ...query, exclude: [...tried] }, args?.run);
      } catch {
        next = { ref: null, error: '' };
      }
      if (!given(next.ref)) {
        lines.push(`TEAM: ${labelOf(worker)} ${cause[0]}. ${given(next.error) ? String(next.error) : `No other model in ${whose} for ${kindLabel} can run now.`}`);
        break;
      }
      const sentence = `${labelOf(worker)} ${cause[0]}, so this task went to ${given(next.label) ? next.label : labelOf(next.ref)}, next in ${whose} for ${kindLabel}.`;
      rowOf(sentence);
      lines.push(`TEAM: ${sentence}`);
      moved.push({ from: ref, why: cls });
      ref = next.ref;
    }

    const worker = r.model ?? ref;
    // Said only when a model was passed over: who it was, why, and who did the work instead (7.3).
    if (skips.length) {
      const first = given(picked.label) ? picked.label : labelOf(picked.ref);
      lines.unshift(`TEAM: ${skips.slice(0, 3).join('. ')}${skips.length > 3 ? `. ${skips.length - 3} more were skipped` : ''}. ${first} ${r.ok && !moved.length ? 'did the work' : 'took the task'}.`);
    }
    // What a move to a coder that cannot ask means for the files (section 9).
    const cannotAsk = CANNOT_ASK[providerOf(worker)];
    if (moved.length && cannotAsk && type?.kind === 'edit' && !openMode(args?.mode) && r.changed?.length) {
      lines.push(`TEAM: ${cannotAsk} cannot ask before it writes: it edited inside the scope by itself.`);
    }

    // 8. The record: the log line, and with a job the first 300 characters of the answer.
    const answer = typeof r.summary === 'string' && kind ? cutAnswer(r.summary, answerMaxOf(kind)) : r.summary;
    log({
      v: 1,
      at: now(),
      project: String(project?.id ?? ''),
      job,
      work: kind?.id ?? '',
      agent: String(type?.name ?? ''),
      title: head(oneLine(args?.task?.title ?? inp.title), 120),
      lead: String(args?.caller?.ref ?? ''),
      worker: String(worker ?? ''),
      provider: providerOf(worker),
      program: '',
      picked: Boolean(picked),
      moved,
      ok: r.ok === true,
      state: r.ok ? 'done' : r.stopped ? 'stopped' : 'not finished',
      cls,
      ms: Number(r.elapsedMs) || 0,
      steps: Number(r.turns) || 0,
      changed: r.changed?.length ?? 0,
      usage: { billing: r.usage?.billing ?? '', input: Number(r.usage?.input) || 0, output: Number(r.usage?.output) || 0, dollars: Number.isFinite(r.cost) ? r.cost : null },
    });
    if (job) {
      const said = r.ok ? oneLine(r.summary) : `not finished: ${oneLine(r.error)}`;
      if (said) notes.add(project?.id, job, `${type?.label ?? 'Agent'}, ${labelOf(worker)}: ${head(said, LIMITS.note)}`, providerOf(worker));
    }

    const usage = usageWords(r.usage, r.cost);
    return remember({ ...r, summary: answer, team: { lines, summaryTail: `${worker ? ` · ${labelOf(worker)}` : ''}${usage ? ` · ${usage}` : ''}` } });
  }

  // ----- several tasks in one call (7.4) -----

  // A further task as the input of a call of its own. What it leaves out it takes from the call: job, model, level and effort, and
  // the kind of work (with the call's type) when it names none.
  function taskInput(entry, input) {
    const out = {};
    for (const k of ['title', 'instructions', 'work', 'scope', 'done_when', 'program', 'agent', 'model', 'level', 'effort']) if (entry[k] !== undefined) out[k] = entry[k];
    for (const k of ['job', 'model', 'coder', 'level', 'effort']) if (out[k] === undefined && input[k] !== undefined && !(k === 'coder' && out.model !== undefined)) out[k] = input[k];
    if (!given(out.work) && !given(out.agent)) {
      if (input.work !== undefined) out.work = input.work;
      if (input.agent !== undefined) out.agent = input.agent;
    }
    return out;
  }

  async function runAll(input, ctx, runOne) {
    const more = input?.tasks;
    if (more === undefined || more === null || (Array.isArray(more) && more.length === 0)) return runOne(input, ctx);
    if (!Array.isArray(more)) return { ok: false, summary: 'tasks is not a list', output: TEXT.tasksNotList };
    if (more.length > LIMITS.tasks) return { ok: false, summary: `${more.length + 1} tasks in one call are too many`, output: TEXT.tooMany };
    const { tasks: _tasks, ...own } = input;
    void _tasks;
    const inputs = [own, ...more.map(entry => (isObject(entry) ? taskInput(entry, input) : null))];
    const total = inputs.length;
    for (const one of inputs) if (one) several.add(one);
    // All of them start now, with the same ctx: one run, its limits and its Stop.
    const results = await Promise.all(inputs.map(async (one, i) => {
      if (!one) return { ok: false, summary: '', output: `Not finished: task ${i + 1} is not an object with a title and instructions.` };
      try {
        const res = await runOne(one, ctx);
        return isObject(res) ? res : { ok: false, summary: '', output: 'Not finished: no answer came back.' };
      } catch (err) {
        return { ok: false, summary: '', output: `Not finished: ${err?.message || String(err)}` };
      }
    }));
    const share = Math.floor(LIMITS.joined / total);
    const output = results.map((res, i) => `[${i + 1} of ${total}]\n${cutAnswer(String(res.output ?? ''), share)}`).join('\n\n');
    const done = results.filter(res => res.ok === true).length;
    const by = new Map();
    inputs.forEach(one => {
      const w = one ? workers.get(one) : null;
      const provider = providerOf(w?.ref);
      if (provider) by.set(provider, (by.get(provider) ?? 0) + 1);
    });
    const who = [...by].map(([provider, n]) => `${subscription(provider)} ${n}`).join(', ');
    const parts = [done ? `${done} done` : '', total - done ? `${total - done} not finished` : ''].filter(Boolean).join(', ');
    return {
      ok: done === total,
      ...(results.every(res => res.denied === true) ? { denied: true } : {}),
      summary: `${total} tasks: ${parts}${who ? ` · ${who}` : ''}`,
      output,
    };
  }

  return { withTeamFields, agentForWork, describeTail, runTeamTask, runAll, hooksFor, neighbours: nb, notes };
}

// ---------- the default instance: what lib/tools/40-delegate.mjs imports ----------

// The one top-level await of the new modules (see NEIGHBOURS at the top of this file).
let instance = null;
const defaults = createTeamRun(await loadNeighbours(NEIGHBOURS, { onLate: (name, mod) => { if (instance) instance.neighbours[name] ??= mod; } }));
instance = defaults;

export const { withTeamFields, agentForWork, describeTail, runTeamTask, runAll } = defaults;
// The live object the default instance reads its neighbours from on every call (the tests put stand-ins here).
export const neighbours = defaults.neighbours;
export const jobNotes = defaults.notes;
