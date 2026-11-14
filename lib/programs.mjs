// Programs (wave 3, DELEGATION-DESIGN.md section 15): the record of the programs a lead can hand a task to. A program is one of the
// command-line agents Plenum drives on this PC (Claude Code, Codex, Muse Code, Gemini CLI, Antigravity, Cursor, Grok Build), or an agent
// the owner added by its name on Plenum Hub. Each has one line that says what it is best at; the lead reads those lines and the owner
// edits them (Settings > Agents > Programs). With no file the defaults apply and nothing is written until the owner saves.
//
// THE CONTRACT (lib/team-run.mjs, lib/program-run.mjs, lib/routes/programs.mjs and the page build to it; build/v06/ultra-w3-programs
// pins each part):
//   createPrograms(deps) -> an instance; the default instance's functions are exported below under the same names.
//     deps: dir (the data folder), now, catalog, providers (the provider snapshot, null before the first one), readiness, claudeRoute,
//           parseRef, labelFor, hubOn (is Connect agents on: synchronous), hub (lib/hub.mjs or a stand-in, or a function that gives a
//           promise of it), team (the same for lib/team.mjs), claudeTools ('own' | 'type'), write. A value or a function for each.
//   get()                                  -> { v, programs, limits, updatedAt, saved }   (newer: true for a file of a newer version)
//   save({ programs?, limits? })           -> a promise of the record; throws an Error with status 400 and one plain sentence
//   byId(id) -> entry | null               labelOf(id) -> text                 (synchronous, memory only)
//   toolText()                             -> the sentence of 15.2 for the delegate tool's description, or ''   (synchronous)
//   state(id, { type, lead, project })     -> a promise of { state, why }
//        state: ready | unknown | off | not-installed | sign-in | limit | other-route | no-files | hub-off | hub-down | hub-agent-missing | hub-agent-paused | hub-agent-killed | no-place | none
//        why: one whole sentence for the page ('' when ready or unknown)
//   whyNot(id, { type, lead, project })    -> a promise of null when the program can be tried, else { state, error }: the sentence of
//                                             15.9 for the lead, with the programs that can run now in the owner's order
//   modelFor(id, { type, lead, named })    -> a promise of { ref, label, why } | { ref: null, error }
//   others(id, { type, lead, project })    -> a promise of [label] that can run now, in the owner's order
//   abilities(id)                          -> the fixed sentence of 15.4 for that program
//   claudeTools()                          -> 'own' when lib/claude-cli.mjs has the two-line edit (PROGRAM_TOOLS), else 'type'
//   mayShare(businessId)                   -> true only when the owner switched on "Share results in the business room" for that business
//                                             (record field shareRooms: [businessId], default none); nothing is posted to a hub room otherwise
//   noteHubAgent(agent, 'ready' | 'missing', info?) what a hand-off or a look at the hub's own agent list learned of an agent on the hub
//                                          ({ status: active|paused|killed, online, wakeable, canStart } from hubInfoFrom), kept in memory for the page
//   hubAgentInfo(agent) -> { status, online, wakeable, canStart, at } | null;  hubNote(agent, handsOff) -> the one sentence about being started ('' when unknown)
//   cannotAsk(id)                          -> true for a program on this PC whose own steps never come to Plenum (not in GATED): Codex,
//                                             Gemini CLI and Muse Code. In Ask first such a program starts only after the owner's yes:
//   askStart({ program, model, folder, project, scope, title, text, type, lead, routine, signal })
//                                          -> a promise of { ok: true } after the owner's yes, else { ok: false, why: 'denied' | 'timeout' |
//                                             'stopped' | 'full' | 'long', error }: one card waits in memory (START.waitMs, then "not
//                                             started"; Stop ends it at once). No answer is never a yes.
//   starts()                               -> the cards that wait: [{ id, program, label, model, folder, project, scope, title, text, type,
//                                             lead, routine, sha256, askedAt, until }]
//   answerStart(id, { allow, seen })       -> the card; an Error with status 404 (it no longer waits), 400 or 409 (a yes whose `seen` is
//                                             not the sha256 of the card that waits). Only POST /api/programs/starts/answer calls it:
//                                             no tool, hook, routine or hub call does, and a phone below Full cannot make that POST.
//   Events: { type: 'program-start', action: 'asked' | 'answered' | 'timeout' | 'stopped', id, waiting }.
//   migrate(raw), BUILT_IN, LAYOUTS, CEILINGS, DEFAULT_LIMITS, VERSION
// The file: programs.json in store.HOME,
//   { v: 1, programs: [{ id, label, via: 'local', provider, on, best, model, builtIn: true }
//                     | { id: 'hub:<agent>', label, via: 'hub', agent, on, best, waitMin, builtIn: false }],
//     limits: { hubAtOnce }, shareRooms: [businessId], updatedAt }. The order of the array is the owner's order ("the next one").
//
// RULES THIS MODULE KEEPS. Everything it answers is read from memory: no CLI is started and the network is not reached by any export.
// Models cannot change the record (no tool; the routes need the page's token; the file is in Plenum's data folder). It imports nothing
// from lib/team-run.mjs, lib/tools/40-delegate.mjs or lib/routes/index.mjs and awaits no import at its top; its two neighbours
// (lib/team.mjs for plan limits, lib/hub.mjs for the hub's state) are loaded on first use inside a try, and it works without them.
//
// ADDING TO IT LATER. A CLI that Plenum learns to drive is one line in BUILT_IN and one in ABILITIES. A new state is one entry in the
// table inside whyNot and one word on the page. A new field of an entry is one line in builtEntry or hubEntry with its default (and its check in save); the version goes up
// only when an old file can no longer be read as it is, and migrate() then gets the step.
import fs, { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { publish as publishEvent } from './events.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { CATALOG, labelFor, parseRef } from './providers.mjs';
import { knownProviders } from './provider-status.mjs';
import { readinessFrom } from './model-info.mjs';
import * as claudeCli from './claude-cli.mjs';
import * as store from './store.mjs';

export const VERSION = 1;
export const CEILINGS = Object.freeze({ entries: 24, best: 120, label: 40, agent: 32, waitMin: 1, waitMax: 60, hubAtOnce: 8, shareRooms: 200, businessId: 64 });
export const DEFAULT_LIMITS = Object.freeze({ hubAtOnce: 3 });
export const DEFAULT_WAIT_MIN = 10;
// A start that waits for the owner's yes (a program that cannot ask before it acts, in Ask first): how long the card waits (as long as
// a chat card waits), how much task text a card shows (a longer one is refused, because a yes is tied to the whole text shown) and how
// many cards may wait at once.
export const START = Object.freeze({ waitMs: 5 * 60_000, textMax: 60_000, most: 12, title: 200, scope: 40 });

// One line for each CLI Plenum drives. The first `best` lines say only what the code makes true (15.3).
export const BUILT_IN = Object.freeze([
  { id: 'claude-code', label: 'Claude Code', provider: 'anthropic', best: 'Careful changes in a code base: asks Plenum before each write and command.' },
  { id: 'codex', label: 'Codex', provider: 'codex', best: 'Long coding and bulk work on its own in a sandbox; reads AGENTS.md. Cannot ask before it writes.' },
  { id: 'muse-code', label: 'Muse Code', provider: 'muse', best: 'A second vendor\'s coder with its own workspace tools and your Muse Code settings. Plenum lists what it changed.' },
  { id: 'gemini-cli', label: 'Gemini CLI', provider: 'gemini', best: 'Reading and comparing a lot of material at once; its own extensions and MCP servers. Cannot ask before it writes.' },
  { id: 'antigravity', label: 'Antigravity', provider: 'antigravity', best: 'Google\'s agent on your Antigravity account\'s models; asks Plenum before each step. Editing tasks only.' },
  { id: 'cursor', label: 'Cursor', provider: 'cursor', best: 'Cursor\'s agent with your Cursor rules; asks Plenum before each step. Editing tasks only.' },
  { id: 'grok-build', label: 'Grok Build', provider: 'grok', best: 'xAI\'s coding agent; asks Plenum before each step. Editing tasks only.' },
].map(Object.freeze));
const BUILT = new Map(BUILT_IN.map(b => [b.id, b]));
// A built-in line of an earlier build that is no longer true in every approval mode (in Ask first Codex now runs without the owner's
// Codex settings file). A saved record that still holds it word for word gets the line of this build; a line the owner wrote stays.
const OLD_BEST = Object.freeze({ codex: ['Long coding and bulk work on its own in a sandbox; reads AGENTS.md and your Codex config. Cannot ask before it writes.'] });

// What is switched on for each program in a hand-off (15.4), as the page says it.
const ABILITIES = Object.freeze({
  'claude-code': 'Runs as Claude Code with the tools of the task\'s agent type and nothing else: your own Claude Code settings, MCP servers and skills are not loaded. Each write and command comes to Plenum first.',
  codex: 'Runs as Codex in its own sandbox with AGENTS.md. No web search. It cannot ask before it acts, so Plenum lists what it changed. In Ask first it waits for your yes before it starts, and Plenum starts it with --ignore-user-config, so your Codex settings file and the MCP servers set in it are not loaded. In Auto-approve and Approve all it starts at once, with your Codex config and its MCP servers.',
  'muse-code': 'Runs as Muse Code with its workspace tools and your Muse Code settings. Writing is off in a task that only reads, and commands are off unless the agent type runs them. Its own steps do not come to Plenum, so in Ask first it waits for your yes before it starts.',
  'gemini-cli': 'Runs as Gemini CLI with its tools, extensions, MCP servers and GEMINI.md. It cannot ask before it acts, so Plenum lists what it changed, and in Ask first it waits for your yes before it starts.',
  antigravity: 'Runs as Antigravity\'s own agent on your account\'s models. Each step it asks for comes to Plenum first. Editing tasks only.',
  cursor: 'Runs as Cursor\'s own agent with your Cursor rules and models. Each step it asks for comes to Plenum first. Editing tasks only.',
  'grok-build': 'Runs as Grok Build\'s own agent. Each step it asks for comes to Plenum first. Editing tasks only.',
  hub: 'Runs where that agent lives. If the hub\'s helper starts it on this PC, it has the hub\'s tools only (no shell, no files on this PC, no web) and works for 10 minutes at most; an agent that is open in its own program, or on another computer, can do what that program allows there. Plenum opens nothing on this PC to it, and waits for its answer on the hub.',
});

// The reply layout of each kind of agent type, word for word as lib/agents.mjs has it (its constant is not exported and that file is
// not edited). A test fails when one of these is no longer part of typeSystem(type).
export const LAYOUTS = Object.freeze({
  summary: 'When you are done, reply with a short plain summary: what you changed, and anything left undone or uncertain.',
  findings: 'Reply in this layout:\nFINDINGS:\n- <one finding per line, with file paths and line numbers where you can>\nOPEN:\n- <what you could not settle, or "none">',
  verdict: 'Reply in exactly this layout:\nVERDICT: approve or changes\nSUMMARY: <one or two sentences>\nISSUES:\n- SEVERITY: high, medium or low | FILE: <path, or -> | ISSUE: <one line>\nIf you find no issues, write "ISSUES: none" and set VERDICT to approve.',
});

// The programs whose every step comes to Plenum's gate (a card, the scope, the deny list), and the ones Plenum runs in an empty folder
// for a task that only reads (lib/agent-run.mjs).
export const GATED = Object.freeze(['anthropic', 'cursor', 'grok', 'antigravity']);
const EMPTY_FOLDER_READS = new Set(['cursor', 'grok', 'antigravity']);
// The name a lead's provider has on the hub: the map lib/providers.mjs uses when it opens the bridge.
export const HUB_CLI = Object.freeze({ anthropic: 'claude', codex: 'codex', gemini: 'gemini', cursor: 'cursor', grok: 'grok', antigravity: 'antigravity' });

export const TEXT = Object.freeze({
  hubOff: 'Plenum is not connected to Plenum Hub. Turn on Connect agents in Settings > Agents > Plenum Hub, or pick a program on this PC.',
  hubDown: 'Plenum Hub is not answering. Start it in Settings > Background services.',
  noPlace: 'This chat\'s model has no place on Plenum Hub (Muse Code and API-only models are not connected yet). Use a lead on Claude, Codex, Gemini CLI, Cursor, Grok Build or Antigravity, or pick a program on this PC.',
  otherRoute: 'Claude runs through your API key in Plenum, not through Claude Code. Set Claude to the Claude Code sign-in in Accounts, or pick another program.',
  toolHead: 'To run a task inside a program, the way that program works by itself (its own tools and abilities, as listed for each program), name it in `program`:',
  toolTail: 'Use a program when the task needs what only it has; otherwise leave `program` out. If the owner named a program, use that one and tell him if it cannot run.',
  hubAgent: 'an agent on Plenum Hub; answers in minutes',
  staleWindow: 'Another window changed the programs. Reload the page, then make your change again.',
  // What the page says of an agent on the hub from the hub's own list (presence.wakeable, and the hub's hands-off mode).
  starts: 'The hub\'s helper can start it by itself when a task arrives, inside the hub\'s hourly limits. A run it starts has the hub\'s tools only and ends within 10 minutes.',
  noHelperStart: 'The hub\'s helper cannot start it now. It answers only while it is open in its own program or on its own computer.',
  handsOffOff: 'Hands-off mode is off on the hub, so nothing starts it by itself. When a task is handed to it, Plenum asks the hub\'s helper to start it, which works only if the helper knows this agent.',
  startUnknown: 'Plenum cannot tell whether the hub\'s helper can start it.',
  // From presence.helper_can_start (the hub, 13 Nov 2026): a helper can start this agent whatever hands-off says. No promise: the hub can
  // still answer that everything is paused or that the hourly limit is reached.
  handsOffCan: 'Hands-off mode is off on the hub, so nothing starts it by itself. When a task is handed to it, Plenum asks the hub\'s helper to start it. The helper can start this agent, unless everything is paused or the hub\'s hourly limit is reached.',
  handsOffCannot: 'Hands-off mode is off on the hub, and the hub\'s helper cannot start this agent now. It answers only while it is open in its own program or on its own computer.',
  canStart: 'The hub\'s helper can start this agent when Plenum asks, unless everything is paused or the hub\'s hourly limit is reached.',
  // A start that waits for the owner's yes (askStart). startAsk is the notice in the chat; the next five are what the lead reads; the
  // last three are what the page is told.
  startAsk: (label, min) => `${label} cannot ask before it acts, so it waits for your yes before it starts. The card is in Businesses, at the top of Today. With no answer in ${min} minutes it is not started.`,
  startNo: label => `The owner said no to starting ${label} for this task. Nothing was started and nothing was sent to it. Do not retry it; ask what they want instead.`,
  startTimeout: (label, min) => `Nobody answered the card within ${min} minutes, so ${label} was not started and nothing was sent to it. In Ask first a program that cannot ask before it acts starts only after the owner's yes. Do the task with your own tools, or hand it to a program whose steps come to Plenum's cards, or leave it for the owner.`,
  startStopped: label => `Stopped before ${label} started. Nothing was sent to it.`,
  startFull: n => `${n} hand-offs already wait for the owner's yes, the most at once. Wait for an answer before you hand over more.`,
  startLong: (label, n) => `The task text is too long to show in full on the card the owner answers (${n.toLocaleString('en-US')} characters; the most is ${START.textMax.toLocaleString('en-US')}), so ${label} was not started. Put the long part in a file of the folder and name the file in the task.`,
  startNoCard: label => `${label} cannot ask before it acts, and this build of Plenum has no card for its start, so it was not started in Ask first.`,
  startGone: 'That card no longer waits. It was answered, it timed out or the reply was stopped.',
  startUnseen: 'Read the task text on the card before you say yes.',
  startChanged: 'This is not the text of the card that waits. The list was read again: read the card, then answer.',
});

const AGENT_OK = /^[a-z][a-z0-9_-]{0,31}$/;
const AGENT_RULE = 'An agent\'s name on the hub has only a-z, 0-9, - and _, starts with a letter and is at most 32 characters.';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const asFn = v => (typeof v === 'function' ? v : () => v);
const hasControl = s => /[\u0000-\u001f\u007f]/.test(s);
const oneLine = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const providerOf = ref => {
  const s = String(ref ?? '');
  const i = s.indexOf(':');
  return i < 0 ? '' : s.slice(0, i);
};
// "grok-bot" reads as "Grok Bot" until the owner writes a name.
const nameFrom = agent => agent.split(/[-_]+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || agent;

// ---------- the record ----------

const builtEntry = (b, own = {}) => ({
  id: b.id,
  label: b.label,
  via: 'local',
  provider: b.provider,
  on: own.on !== false,
  best: typeof own.best === 'string' && !hasControl(own.best) && !(OLD_BEST[b.id] ?? []).includes(own.best.trim()) ? own.best.trim().slice(0, CEILINGS.best) : b.best,
  model: typeof own.model === 'string' && providerOf(own.model) === b.provider && !hasControl(own.model) ? own.model.trim().slice(0, 160) : '',
  builtIn: true,
});

function hubEntry(raw) {
  if (!isObject(raw)) return null;
  const agent = typeof raw.agent === 'string' ? raw.agent : typeof raw.id === 'string' && raw.id.startsWith('hub:') ? raw.id.slice(4) : '';
  if (!AGENT_OK.test(agent)) return null;
  const label = typeof raw.label === 'string' && raw.label.trim() && !hasControl(raw.label) ? raw.label.trim().slice(0, CEILINGS.label) : nameFrom(agent);
  return {
    id: `hub:${agent}`,
    label,
    via: 'hub',
    agent,
    on: raw.on !== false,
    best: typeof raw.best === 'string' && !hasControl(raw.best) ? raw.best.trim().slice(0, CEILINGS.best) : '',
    waitMin: Number.isInteger(raw.waitMin) && raw.waitMin >= CEILINGS.waitMin && raw.waitMin <= CEILINGS.waitMax ? raw.waitMin : DEFAULT_WAIT_MIN,
    builtIn: false,
  };
}

const cleanLimits = raw => {
  const r = isObject(raw) ? raw : {};
  return { hubAtOnce: Number.isInteger(r.hubAtOnce) && r.hubAtOnce >= 1 && r.hubAtOnce <= CEILINGS.hubAtOnce ? r.hubAtOnce : DEFAULT_LIMITS.hubAtOnce };
};

// The businesses whose hub room a program's result may be posted to (the owner's switch per business; none by default).
const cleanShare = raw => {
  const out = [];
  for (const v of Array.isArray(raw) ? raw : []) {
    if (typeof v !== 'string' || !v.trim() || hasControl(v) || v.trim().length > CEILINGS.businessId || out.includes(v.trim()) || out.length >= CEILINGS.shareRooms) continue;
    out.push(v.trim());
  }
  return out;
};

// A v1 record from anything: no file, an older file, a damaged one, or a newer one. It never throws. What does not check out is dropped
// or takes its default; every built-in program is there (in the owner's order where he gave one, else at the end in the table's order);
// a file from a newer version keeps its version and its unknown fields (this build reads it and never writes it).
export function migrate(raw) {
  const r = isObject(raw) ? raw : {};
  const newer = Number.isInteger(r.v) && r.v > VERSION;
  const programs = [];
  const seen = new Set();
  for (const p of Array.isArray(r.programs) ? r.programs : []) {
    if (!isObject(p) || typeof p.id !== 'string' || programs.length >= CEILINGS.entries) continue;
    const b = BUILT.get(p.id);
    const entry = b ? builtEntry(b, p) : hubEntry(p);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    programs.push(newer ? { ...p, ...entry } : entry);
  }
  for (const b of BUILT_IN) if (!seen.has(b.id)) programs.push(builtEntry(b));
  const known = { programs, limits: cleanLimits(r.limits), shareRooms: cleanShare(r.shareRooms), updatedAt: Number.isFinite(r.updatedAt) && r.updatedAt > 0 ? r.updatedAt : 0 };
  return newer ? { ...r, ...known, v: r.v } : { v: VERSION, ...known };
}

// ---------- the instance ----------

export function createPrograms(deps = {}) {
  const d = {
    dir: deps.dir ?? store.HOME,
    now: deps.now ?? (() => Date.now()),
    catalog: asFn(deps.catalog ?? CATALOG),
    providers: asFn(deps.providers ?? knownProviders),
    readiness: deps.readiness ?? readinessFrom,
    claudeRoute: deps.claudeRoute ?? claudeCli.claudeRoute,
    parseRef: deps.parseRef ?? parseRef,
    labelFor: deps.labelFor ?? labelFor,
    // Connect agents (Settings > Agents > Plenum Hub), read from the state in memory.
    hubOn: deps.hubOn ?? (() => store.get()?.hub?.agents === true),
    claudeTools: asFn(deps.claudeTools ?? (() => (typeof claudeCli.PROGRAM_TOOLS === 'string' && claudeCli.PROGRAM_TOOLS ? 'own' : 'type'))),
    write: deps.write ?? writeFileAtomic,
    publish: deps.publish ?? publishEvent,
    setTimer: deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }),
    clearTimer: deps.clearTimer ?? (t => clearTimeout(t)),
    newId: deps.newId ?? randomUUID,
  };
  // The two neighbours, loaded on first use and kept. A stand-in may be the module itself or a function that gives it (or a promise).
  const lazy = (given, url) => {
    let p;
    if (given !== undefined) return () => (p ??= Promise.resolve(typeof given === 'function' ? given() : given).then(m => m ?? null, () => null));
    return () => (p ??= import(new URL(url, import.meta.url).href).then(m => m, () => null));
  };
  const hub = lazy(deps.hub, './hub.mjs');
  const team = lazy(deps.team, './team.mjs');
  const file = path.join(d.dir, 'programs.json');

  let rec = null; // the record in force
  let saved = false; // a file exists
  let damaged = false; // the file could not be read as a record: the defaults are in force and the first save keeps a copy of it
  let newer = false; // the file is from a newer version: read, never written
  let queue = Promise.resolve();

  function load() {
    if (rec) return rec;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      const fresh = migrate(null);
      // No file: the defaults, and nothing is written. A file that is there but cannot be read now is tried again next time.
      if (err?.code === 'ENOENT') rec = fresh;
      saved = err?.code !== 'ENOENT';
      return fresh;
    }
    let raw = null;
    try {
      raw = JSON.parse(text);
    } catch {
      // Damaged: handled below.
    }
    damaged = !isObject(raw);
    rec = migrate(raw);
    saved = true;
    newer = !damaged && rec.v > VERSION;
    return rec;
  }

  const copy = r => ({
    ...r,
    programs: r.programs.map(p => ({ ...p })),
    limits: { ...r.limits },
    shareRooms: [...(r.shareRooms ?? [])],
    saved,
    ...(newer ? { newer: true } : {}),
    ...(damaged ? { damaged: true } : {}),
  });
  const get = () => copy(load());
  const byId = id => {
    const want = String(id ?? '').trim().toLowerCase();
    const hit = want ? load().programs.find(p => p.id === want) : null;
    return hit ? { ...hit } : null;
  };
  const labelOf = id => byId(id)?.label ?? String(id ?? '');
  const abilities = id => {
    const entry = byId(id);
    return entry ? (entry.via === 'hub' ? ABILITIES.hub : ABILITIES[entry.id] ?? '') : '';
  };
  const claudeTools = () => (d.claudeTools() === 'own' ? 'own' : 'type');
  const mayShare = businessId => typeof businessId === 'string' && load().shareRooms.includes(businessId);
  // What Plenum learned of an agent on the hub, in memory only: from a hand-off (ready after an answer, missing after "no such agent")
  // and from the hub's own list of agents (status, online, presence.wakeable; see hubInfoFrom). The page says "Not checked yet" for an
  // agent nothing has been learned about.
  const hubSeen = new Map();
  const noteHubAgent = (agent, what, info) => {
    if (typeof agent !== 'string' || !AGENT_OK.test(agent)) return;
    if (what !== 'ready' && what !== 'missing') return;
    const prev = hubSeen.get(agent);
    const next = { what, status: '', online: null, wakeable: null, canStart: null, at: d.now() };
    if (what === 'ready' && !isObject(info) && prev && prev.what === 'ready') Object.assign(next, { status: prev.status, online: prev.online, wakeable: prev.wakeable, canStart: prev.canStart });
    if (isObject(info)) {
      if (['active', 'paused', 'killed'].includes(info.status)) next.status = info.status;
      if (typeof info.online === 'boolean') next.online = info.online;
      if (typeof info.wakeable === 'boolean') next.wakeable = info.wakeable;
      if (typeof info.canStart === 'boolean') next.canStart = info.canStart;
    }
    hubSeen.set(agent, next);
  };
  const hubAgentInfo = agent => {
    const got = hubSeen.get(agent);
    return got && got.what === 'ready' ? { status: got.status, online: got.online, wakeable: got.wakeable, canStart: got.canStart, at: got.at } : null;
  };
  // The one sentence the page shows under an agent on the hub about being started (hands-off is the hub's state: true, false or null).
  const hubNote = (agent, handsOff) => {
    const got = hubSeen.get(agent);
    if (!got || got.what !== 'ready' || got.status === 'paused' || got.status === 'killed') return '';
    // wakeable is the hub's word while hands-off is on (the helper starts it by itself); canStart (presence.helper_can_start) is its word
    // for a start Plenum asks for. A hub that does not send canStart yet gets the sentences from before it.
    if (got.wakeable === true) return TEXT.starts;
    if (handsOff === true) return got.wakeable === false ? TEXT.noHelperStart : '';
    if (got.canStart === true) return handsOff === false ? TEXT.handsOffCan : TEXT.canStart;
    if (got.canStart === false) return handsOff === false ? TEXT.handsOffCannot : TEXT.noHelperStart;
    if (got.wakeable === null) return '';
    return handsOff === false ? TEXT.handsOffOff : TEXT.startUnknown;
  };

  // ----- a start that waits for the owner's yes -----
  // Codex, Gemini CLI and Muse Code take their steps without asking Plenum (they are not in GATED), so a card for each step cannot be
  // shown. In Ask first the one thing Plenum can still ask is the start: the owner reads the program's name, the folder and the whole
  // task text, and the program starts only after his yes to that very text (its sha256 comes back as `seen`). The cards live in memory:
  // a card belongs to a reply that is waiting right now, and a restart ends that reply.
  const waitingStarts = new Map(); // id -> { card, settle }
  const cannotAsk = id => {
    const entry = byId(id);
    return Boolean(entry) && entry.via === 'local' && !GATED.includes(entry.provider);
  };
  const line = (v, max) => oneLine(v).slice(0, max);
  const tellStarts = (action, id) => {
    try {
      d.publish({ type: 'program-start', action, id, waiting: waitingStarts.size });
    } catch {
      // A window that cannot be told asks again when it opens.
    }
  };
  const starts = () => [...waitingStarts.values()].map(w => ({ ...w.card, scope: [...w.card.scope] }));

  function askStart(req) {
    const r = isObject(req) ? req : {};
    const entry = byId(r.program);
    if (!entry) return Promise.resolve({ ok: false, why: 'stopped', error: `There is no program called ${line(r.program, 60)}.` });
    const label = entry.label;
    const text = typeof r.text === 'string' ? r.text : '';
    const min = Math.max(1, Math.round(START.waitMs / 60_000));
    if (r.signal?.aborted) return Promise.resolve({ ok: false, why: 'stopped', error: TEXT.startStopped(label) });
    if (text.length > START.textMax) return Promise.resolve({ ok: false, why: 'long', error: TEXT.startLong(label, text.length) });
    if (waitingStarts.size >= START.most) return Promise.resolve({ ok: false, why: 'full', error: TEXT.startFull(waitingStarts.size) });
    const scope = (Array.isArray(r.scope) ? r.scope : []).filter(x => typeof x === 'string' && x).slice(0, START.scope).map(x => line(x, 260));
    // Everything the card shows about the task. A yes names the hash of exactly this, so a yes is tied to what was on screen.
    const shown = {
      program: entry.id,
      label,
      model: line(r.model, 120),
      folder: typeof r.folder === 'string' ? r.folder.slice(0, 520) : '',
      scope,
      title: line(r.title, START.title) || 'Task',
      text,
      type: line(r.type, 60),
    };
    const now = d.now();
    const card = {
      id: String(d.newId()),
      ...shown,
      project: line(r.project, 200),
      lead: line(r.lead, 120),
      routine: line(r.routine, 80),
      sha256: createHash('sha256').update(JSON.stringify(shown)).digest('hex'),
      askedAt: now,
      until: now + START.waitMs,
    };
    return new Promise(resolve => {
      let over = false;
      let timer = null;
      const onAbort = () => settle('stopped', { ok: false, why: 'stopped', error: TEXT.startStopped(label) });
      function settle(action, out) {
        if (over) return;
        over = true;
        d.clearTimer(timer);
        r.signal?.removeEventListener?.('abort', onAbort);
        waitingStarts.delete(card.id);
        tellStarts(action, card.id);
        resolve(out);
      }
      timer = d.setTimer(() => settle('timeout', { ok: false, why: 'timeout', error: TEXT.startTimeout(label, min) }), START.waitMs);
      waitingStarts.set(card.id, { card, settle });
      r.signal?.addEventListener?.('abort', onAbort, { once: true });
      tellStarts('asked', card.id);
    });
  }

  // The owner's answer, from POST /api/programs/starts/answer and from nowhere else. A yes must name the hash of the card as it waits.
  function answerStart(id, { allow, seen } = {}) {
    const w = waitingStarts.get(String(id ?? ''));
    if (!w) throw bad(TEXT.startGone, 404);
    if (typeof allow !== 'boolean') throw bad('Send allow: true or allow: false.');
    if (allow) {
      if (typeof seen !== 'string' || !seen) throw bad(TEXT.startUnseen, 409);
      if (seen !== w.card.sha256) throw bad(TEXT.startChanged, 409);
    }
    const card = { ...w.card, scope: [...w.card.scope] };
    w.settle('answered', allow ? { ok: true } : { ok: false, why: 'denied', error: TEXT.startNo(card.label) });
    return card;
  }

  // ----- what the lead reads (15.2): synchronous and from memory only -----

  const snapshot = () => {
    try {
      const s = d.providers();
      return isObject(s) ? s : null;
    } catch {
      return null;
    }
  };
  const hubIsOn = () => {
    try {
      return d.hubOn() === true;
    } catch {
      return false;
    }
  };
  // Whether the last provider snapshot shows the program's CLI. Before the first snapshot, and while a part of it is still being
  // filled, the answer is yes: the program is tried, and says so itself if it cannot run.
  function installedNow(entry) {
    const snap = snapshot();
    if (!snap) return true;
    const row = snap[entry.provider];
    if (!isObject(row)) return true;
    // Claude on the API key is not the program Claude Code (state other-route), so the lead is not offered it.
    return entry.provider === 'anthropic' ? row.cliInstalled !== false && row.route !== 'api' : row.installed !== false;
  }

  function toolText() {
    try {
      const parts = [];
      for (const p of load().programs) {
        if (!p.on) continue;
        if (p.via === 'hub') {
          if (!hubIsOn()) continue;
          const own = oneLine(p.best).replace(/[.;\s]+$/, '');
          parts.push(`${p.id} (${TEXT.hubAgent}${own ? `: ${own}` : ''})`);
        } else if (installedNow(p)) {
          parts.push(`${p.id} (${oneLine(p.best).replace(/[.;\s]+$/, '') || p.label})`);
        }
      }
      return parts.length ? `${TEXT.toolHead} ${parts.join('; ')}. ${TEXT.toolTail}` : '';
    } catch {
      return '';
    }
  }

  // ----- can it run now (15.3): memory only -----

  const leadRef = lead => String((isObject(lead) ? lead.ref : lead) ?? '');

  // The CLI's own state from the last snapshot: ready, unknown, not-installed or sign-in.
  function fromSnapshot(entry) {
    const snap = snapshot();
    if (!snap) return 'unknown';
    const row = snap[entry.provider];
    if (!isObject(row)) return 'unknown';
    if (entry.provider === 'anthropic') {
      if (row.cliInstalled === false) return 'not-installed';
      if (row.cliInstalled !== true) return 'unknown';
      if (row.route === 'cli' && row.credentials === false) return 'sign-in';
      return row.route === 'cli' && row.credentials === true ? 'ready' : 'unknown';
    }
    // A snapshot that is still being filled holds null where a CLI's state is not known yet.
    if (row.installed === null || row.installed === undefined) return 'unknown';
    let r = null;
    try {
      r = d.readiness(snap, [])?.[entry.provider] ?? null;
    } catch {
      r = null;
    }
    if (!r) return 'unknown';
    if (r.ready) return 'ready';
    return /sign/i.test(String(r.why ?? '')) ? 'sign-in' : 'not-installed';
  }

  // What the team knows beyond the snapshot (a plan at its line, a sign-in or a missing CLI learned from a failed task), when the team
  // module is in this build. { state, why } or null.
  async function fromTeam(entry) {
    const t = await team();
    if (typeof t?.availability !== 'function') return null;
    try {
      const first = d.catalog().find(c => c.provider === entry.provider && c.offered !== false);
      const ref = entry.provider === 'anthropic' ? (first ? `${first.provider}:${first.id}` : null) : `${entry.provider}:default`;
      if (!ref) return null;
      const a = t.availability(ref);
      if (!isObject(a)) return null;
      if (a.state === 'limit') return { state: 'limit', why: `${entry.label} ${oneLine(a.why) || 'is at its plan limit'}.` };
      if (a.state === 'sign-in' || a.state === 'not-installed') return { state: a.state, why: '' };
      return null;
    } catch {
      return null;
    }
  }

  const noFiles = (entry, type, project) => {
    if (!isObject(type)) return false;
    if (type.files === false) return true;
    if (type.kind === 'edit') return false;
    if (EMPTY_FOLDER_READS.has(entry.provider)) return true;
    return entry.provider === 'muse' && project?.settings?.museReadsProject === false;
  };

  const WHY = {
    off: e => `${e.label} is switched off for hand-offs.`,
    'not-installed': e => `${e.label} is not installed on this computer.`,
    'sign-in': e => `${e.label} needs sign-in.`,
    limit: e => `${e.label} is at its plan limit.`,
    'other-route': () => 'Claude runs through your API key in Plenum, not through Claude Code.',
    'no-files': (e, type) => (isObject(type) && type.files === false
      ? `A ${type.label ?? 'task'} of this type has no file access, so ${e.label} could not see this folder.`
      : `${e.label} cannot read this folder in a task that only reads.`),
    'hub-off': () => 'Plenum is not connected to Plenum Hub.',
    'hub-down': () => 'Plenum Hub is not answering.',
    'hub-agent-paused': e => `${e.agent} is paused in Plenum Hub, so it will not work a task until it is resumed there.`,
    'hub-agent-killed': e => `${e.agent} was stopped for good in Plenum Hub.`,
    'no-place': () => 'This chat\'s model has no place on Plenum Hub.',
  };
  const is = (entry, state, type, why) => ({ state, why: why || WHY[state]?.(entry, type) || '' });

  async function hubState(entry, { lead } = {}) {
    if (!hubIsOn()) return is(entry, 'hub-off');
    const h = await hub();
    let health = '';
    try {
      health = String(h?.status?.()?.health?.state ?? '');
    } catch {
      health = '';
    }
    if (health === 'down') return is(entry, 'hub-down');
    const ref = leadRef(lead);
    if (ref) {
      const cli = await hubCliOf(ref);
      let identity = null;
      try {
        identity = cli ? h?.identityFor?.(cli, ref) ?? null : null;
      } catch {
        identity = null;
      }
      if (!identity) return is(entry, 'no-place');
    }
    // Whether the agent exists, is paused or has a starter is learned at a hand-off, so until one has answered it is not "Ready".
    const learned = hubSeen.get(entry.agent);
    if (learned?.what === 'missing') return is(entry, 'hub-agent-missing', null, `There was no agent called ${entry.agent} on the hub the last time Plenum tried. Check the name, or add the agent in Plenum Hub.`);
    if (learned?.status === 'killed') return is(entry, 'hub-agent-killed');
    if (learned?.status === 'paused') return is(entry, 'hub-agent-paused');
    return { state: health === 'up' && learned?.what === 'ready' ? 'ready' : 'unknown', why: '' };
  }

  // The name of the lead's CLI on the hub, or '' when the lead has no place there (Muse Code, an API model, Claude on the API key).
  async function hubCliOf(ref) {
    const provider = providerOf(ref);
    const cli = HUB_CLI[provider];
    if (!cli) return '';
    if (provider === 'anthropic') {
      let route = 'api';
      try {
        route = await d.claudeRoute();
      } catch {
        route = 'api';
      }
      if (route !== 'cli') return '';
    }
    return cli;
  }

  async function state(id, opts = {}) {
    const entry = byId(id);
    if (!entry) return { state: 'none', why: `There is no program called ${oneLine(id).slice(0, 60)}.` };
    if (!entry.on) return is(entry, 'off');
    if (entry.via === 'hub') return hubState(entry, opts);
    if (entry.provider === 'anthropic') {
      let route = 'cli';
      try {
        route = await d.claudeRoute();
      } catch {
        route = 'cli';
      }
      if (route === 'api') return is(entry, 'other-route');
    }
    const base = fromSnapshot(entry);
    if (base === 'not-installed' || base === 'sign-in') return is(entry, base);
    const learned = await fromTeam(entry);
    if (learned) return is(entry, learned.state, null, learned.why);
    if (noFiles(entry, opts.type, opts.project)) return is(entry, 'no-files', opts.type);
    return { state: base, why: '' };
  }

  // A hub agent that was missing at the last try can be tried again: the owner may have added it since.
  // A paused or stopped agent is tried too (the hub's answer at the hand-off is the true one, and it may have been resumed since), but the
  // lead is not told it "can run now".
  const runnable = s => s === 'ready' || s === 'unknown' || s === 'hub-agent-missing' || s === 'hub-agent-paused' || s === 'hub-agent-killed';
  const canRunNow = s => runnable(s) && s !== 'hub-agent-paused' && s !== 'hub-agent-killed';

  async function others(id, opts = {}) {
    const own = byId(id)?.id ?? null;
    const out = [];
    for (const p of load().programs) {
      if (p.id === own || !p.on) continue;
      if (canRunNow((await state(p.id, opts)).state)) out.push(p.label);
    }
    return out;
  }

  // The sentence the lead reads when the program cannot be tried (15.9), or null when it can. Plenum never picks another one.
  async function whyNot(id, opts = {}) {
    const entry = byId(id);
    if (!entry) {
      const ids = load().programs.filter(p => p.on).map(p => p.id);
      return { state: 'none', error: `There is no program called ${oneLine(id).slice(0, 60)}. Programs: ${ids.join(', ') || 'none is switched on'}.` };
    }
    const s = await state(entry.id, opts);
    if (runnable(s.state)) return null;
    if (s.state === 'hub-off') return { state: s.state, error: TEXT.hubOff };
    if (s.state === 'hub-down') return { state: s.state, error: TEXT.hubDown };
    if (s.state === 'no-place') return { state: s.state, error: TEXT.noPlace };
    if (s.state === 'other-route') return { state: s.state, error: TEXT.otherRoute };
    if (s.state === 'no-files') {
      const fix = isObject(opts.type) && opts.type.files === false ? 'Leave program out, or use an agent type that reads files.' : 'Hand it over as code work with a scope, or pick another program.';
      return { state: s.state, error: `${s.why} ${fix}` };
    }
    const can = await others(entry.id, opts);
    const list = can.length ? `Programs that can run this now: ${can.join(', ')}.` : 'No other program can run this now.';
    const pick = can.length ? 'pick one of those' : 'leave program out';
    const tail = {
      off: `If the owner asked for ${entry.label}, tell him instead of choosing another.`,
      'not-installed': `Install it from Accounts, or ${pick}.`,
      'sign-in': `Sign in under Accounts, or ${pick}.`,
      limit: 'Plenum did not choose one for you.',
    }[s.state] ?? '';
    const head = s.state === 'off' ? `${entry.label} is switched off for hand-offs (Settings > Agents > Programs).` : WHY[s.state]?.(entry) ?? s.why;
    return { state: s.state, error: `${head} Not started. ${list} ${tail}`.trim() };
  }

  // ----- the model of a local program (15.3) -----

  const offered = provider => d.catalog().filter(c => c.provider === provider && c.offered !== false);
  const labelRef = ref => {
    try {
      return d.labelFor(ref);
    } catch {
      return String(ref);
    }
  };
  const got = (ref, why) => ({ ref, label: labelRef(ref), why });

  async function modelFor(id, { type, lead, named } = {}) {
    const entry = byId(id);
    if (!entry) return { ref: null, error: `There is no program called ${oneLine(id).slice(0, 60)}.` };
    if (entry.via !== 'local') return { ref: null, error: '' };
    if (named !== undefined && named !== null && String(named).trim() !== '') {
      let ref;
      try {
        ref = d.parseRef(String(named));
      } catch (err) {
        return { ref: null, error: err?.message || `${oneLine(named).slice(0, 80)} is not a model Plenum knows.` };
      }
      if (providerOf(ref) !== entry.provider) return { ref: null, error: `${ref} is not a model of ${entry.label}. Leave model out, or name one of its models.` };
      return got(ref, 'named by the lead');
    }
    if (entry.model) return got(entry.model, 'your choice in Settings');
    const own = leadRef(lead);
    if (own && providerOf(own) === entry.provider) return got(own, 'the lead\'s model');
    if (typeof type?.model === 'string' && providerOf(type.model) === entry.provider) return got(type.model, `the ${type.label ?? 'agent'} type's model`);
    const list = offered(entry.provider);
    if (list.some(c => c.id === 'default')) return got(`${entry.provider}:default`, 'the program\'s default');
    if (list.length) return got(`${entry.provider}:${list[0].id}`, 'the first model in its list');
    return { ref: null, error: `Plenum knows no model of ${entry.label} right now. Refresh its list in Accounts, or pick another program.` };
  }

  // ----- saving -----

  function checkModel(model, b) {
    if (model === undefined || model === null || model === '') return '';
    if (typeof model !== 'string' || hasControl(model)) throw bad(`The model of ${b.label} must be the id of one of its models, or empty.`);
    let ref;
    try {
      ref = d.parseRef(model);
    } catch (err) {
      throw bad(err?.message || `${oneLine(model).slice(0, 80)} is not a model Plenum knows.`);
    }
    if (providerOf(ref) !== b.provider) throw bad(`${ref} is not a model of ${b.label}. Leave model out, or name one of its models.`);
    return ref;
  }
  function checkBest(value, label) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || hasControl(value)) throw bad(`What ${label} is best at must be one line of text.`);
    const text = value.trim();
    if (text.length > CEILINGS.best) throw bad(`What ${label} is best at can be ${CEILINGS.best} characters at most. This line has ${text.length}.`);
    return text;
  }
  const checkOn = (value, label) => {
    if (value === undefined) return true;
    if (typeof value !== 'boolean') throw bad(`The switch of ${label} must be true or false.`);
    return value;
  };

  function checkPrograms(input) {
    if (!Array.isArray(input)) throw bad('programs must be a list of programs.');
    if (input.length > CEILINGS.entries) throw bad(`Plenum keeps ${CEILINGS.entries} programs at most. Remove an agent from Plenum Hub first.`);
    const out = [];
    const seen = new Set();
    for (const p of input) {
      if (!isObject(p) || typeof p.id !== 'string') throw bad('Each program is an object with an id.');
      const id = p.id.trim();
      if (seen.has(id.toLowerCase())) throw bad(`${id.slice(0, 60)} is in the list twice.`);
      seen.add(id.toLowerCase());
      const b = BUILT.get(id);
      if (b) {
        const best = checkBest(p.best, b.label);
        out.push({ id: b.id, label: b.label, via: 'local', provider: b.provider, on: checkOn(p.on, b.label), best: best ?? b.best, model: checkModel(p.model, b), builtIn: true });
        continue;
      }
      if (p.builtIn === true || p.via === 'local' || !id.startsWith('hub:')) {
        throw bad(`There is no built-in program called ${id.slice(0, 60)}. An agent from Plenum Hub has the id hub:<its name>.`);
      }
      const agent = id.slice(4);
      if (!AGENT_OK.test(agent) || (p.agent !== undefined && p.agent !== agent)) throw bad(AGENT_RULE);
      let label = nameFrom(agent);
      if (p.label !== undefined && p.label !== null && p.label !== '') {
        if (typeof p.label !== 'string' || hasControl(p.label) || !p.label.trim()) throw bad('What to call an agent must be one line of text.');
        if (p.label.trim().length > CEILINGS.label) throw bad(`What to call an agent can be ${CEILINGS.label} characters at most.`);
        label = p.label.trim();
      }
      let waitMin = DEFAULT_WAIT_MIN;
      if (p.waitMin !== undefined && p.waitMin !== null) {
        if (!Number.isInteger(p.waitMin) || p.waitMin < CEILINGS.waitMin || p.waitMin > CEILINGS.waitMax) throw bad(`How long Plenum waits for ${label} must be a whole number of minutes from ${CEILINGS.waitMin} to ${CEILINGS.waitMax}.`);
        waitMin = p.waitMin;
      }
      out.push({ id: `hub:${agent}`, label, via: 'hub', agent, on: checkOn(p.on, label), best: checkBest(p.best, label) ?? '', waitMin, builtIn: false });
    }
    const gone = BUILT_IN.find(b => !seen.has(b.id));
    if (gone) throw bad(`${gone.label} is built in and cannot be removed. Switch it off instead.`);
    return out;
  }

  function checkLimits(input, cur) {
    if (!isObject(input)) throw bad('limits must be an object.');
    const out = { ...cur };
    if (input.hubAtOnce !== undefined) {
      if (!Number.isInteger(input.hubAtOnce) || input.hubAtOnce < 1 || input.hubAtOnce > CEILINGS.hubAtOnce) throw bad(`Hub hand-offs at once must be a whole number from 1 to ${CEILINGS.hubAtOnce}.`);
      out.hubAtOnce = input.hubAtOnce;
    }
    return out;
  }

  function checkShare(input) {
    if (!Array.isArray(input)) throw bad('The businesses that may share results must be a list.');
    if (input.length > CEILINGS.shareRooms) throw bad(`At most ${CEILINGS.shareRooms} businesses can be listed.`);
    const out = [];
    for (const v of input) {
      if (typeof v !== 'string' || !v.trim() || hasControl(v) || v.trim().length > CEILINGS.businessId) throw bad('A business is named by its id, one line of text.');
      if (!out.includes(v.trim())) out.push(v.trim());
    }
    return out;
  }

  async function doSave(patch) {
    if (!isObject(patch)) throw bad('Send an object with programs or limits.');
    const cur = load();
    if (!rec) throw bad('Plenum could not read your programs file just now. Try again in a moment.', 503);
    if (newer) throw bad('These programs were saved by a newer version of Plenum. Update Plenum to change them.', 409);
    // A window that last read an older record than the one in force may not write over it: the change in the other window would vanish.
    if (patch.updatedAt !== undefined && patch.updatedAt !== null && patch.updatedAt !== cur.updatedAt) throw bad(TEXT.staleWindow, 409);
    const next = {
      v: VERSION,
      programs: patch.programs !== undefined ? checkPrograms(patch.programs) : cur.programs.map(p => ({ ...p })),
      limits: patch.limits !== undefined ? checkLimits(patch.limits, cur.limits) : { ...cur.limits },
      shareRooms: patch.shareRooms !== undefined ? checkShare(patch.shareRooms) : [...cur.shareRooms],
      updatedAt: d.now(),
    };
    await fsp.mkdir(d.dir, { recursive: true });
    // The file that could not be read is kept beside the new one, once, so nothing the owner had is lost.
    if (damaged) await fsp.copyFile(file, path.join(d.dir, 'programs.damaged.json')).catch(() => {});
    await d.write(file, `${JSON.stringify(next, null, 2)}\n`);
    rec = next;
    saved = true;
    damaged = false;
    return copy(rec);
  }

  // One write at a time; a save that failed does not hold up the next one.
  function save(patch) {
    const run = queue.then(() => doSave(patch));
    queue = run.catch(() => {});
    return run;
  }

  return { get, save, byId, labelOf, state, whyNot, modelFor, toolText, others, abilities, claudeTools, hubCliOf, mayShare, noteHubAgent, hubAgentInfo, hubNote, cannotAsk, askStart, starts, answerStart, migrate, file };
}

// ---------- the default instance ----------

// Made on first use, never on the start path: it reads the file once and starts nothing.
let instance = null;
const programs = () => (instance ??= createPrograms());

export const get = () => programs().get();
export const save = patch => programs().save(patch);
export const byId = id => programs().byId(id);
export const labelOf = id => programs().labelOf(id);
export const state = (id, opts) => programs().state(id, opts);
export const whyNot = (id, opts) => programs().whyNot(id, opts);
export const modelFor = (id, opts) => programs().modelFor(id, opts);
export const toolText = () => programs().toolText();
export const others = (id, opts) => programs().others(id, opts);
export const abilities = id => programs().abilities(id);
export const claudeTools = () => programs().claudeTools();
export const hubCliOf = ref => programs().hubCliOf(ref);
export const mayShare = businessId => programs().mayShare(businessId);
export const noteHubAgent = (agent, what, info) => programs().noteHubAgent(agent, what, info);
export const hubAgentInfo = agent => programs().hubAgentInfo(agent);
export const hubNote = (agent, handsOff) => programs().hubNote(agent, handsOff);
export const cannotAsk = id => programs().cannotAsk(id);
export const askStart = req => programs().askStart(req);
export const starts = () => programs().starts();
export const answerStart = (id, answer) => programs().answerStart(id, answer);

// The part of one item of the hub's agent list (GET /api/v1/agents, or the tool hub_list_agents) that Plenum keeps: { status, online,
// wakeable, canStart } (canStart is presence.helper_can_start: null from a hub that does not send it). Text the agents wrote (description, display name, profile) is never read here.
export function hubInfoFrom(item) {
  if (!isObject(item)) return null;
  const presence = isObject(item.presence) ? item.presence : {};
  return {
    status: ['active', 'paused', 'killed'].includes(item.status) ? item.status : '',
    online: typeof presence.online === 'boolean' ? presence.online : typeof item.online === 'boolean' ? item.online : null,
    wakeable: typeof presence.wakeable === 'boolean' ? presence.wakeable : null,
    canStart: typeof presence.helper_can_start === 'boolean' ? presence.helper_can_start : null,
  };
}
