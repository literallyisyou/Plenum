// The team (wave 3, DELEGATION-DESIGN.md sections 5 and 6): a model registry, and for each kind of work the owner's own ordered list of
// models across his subscriptions. A lead names the kind of work; the first model in the owner's list that can run now does it. Off until
// the owner turns it on, and with no file the defaults apply and nothing is written.
//
// THE CONTRACT (other packages build to it; build/v06/ultra-w3-team pins each part):
//   createTeam(deps) -> an instance; the default instance's functions are exported below under the same names.
//     deps: dir (the data folder), now, catalog, providers (the provider snapshot, null before the first one), keys ([{ id, configured }]),
//           readQuota, billingFor, canRun; and, for tests, labelFor, parseRef, infoFor, imageSupport, agentTypes, listStates,
//           codersCannotAsk, projectById, readiness, write, onCatalogChange, onProvidersChange. A value or a function is taken for each.
//   get()                    -> { v, on, saved, kinds, sizes, limits, updatedAt }   (newer: true for a file of a newer version;
//                               unreadable: true while a file that is there could not be read and the defaults are in force)
//   save(patch)              -> the record; throws an Error with status 400 and one plain sentence for a bad record
//        patch.kinds is the WHOLE list of the owner's own kinds: one of his that the list leaves out is removed. A built-in kind that
//        the list leaves out is kept as it is, and a kind sent without `workers` keeps the list it has.
//   suggested()              -> { kinds: [{ id, workers: [ref] }] } | null           (null before the first provider snapshot)
//   teamOn()                 -> boolean
//   kindFor({ work, agent }) -> the kind with that id, else the first kind whose agent is that type, else null
//   registry()               -> [{ ref, label, provider, billing, size, sizeFrom, price, context, tools, vision, discovered, avail }]
//   availability(ref, { lines } = {}) -> { state, why, usedPercent }
//        state: ready | unknown | not-installed | sign-in | no-key | not-offered | limit; why reads after the model's name ("needs sign-in")
//   planUse()                -> { [provider]: usedPercent | null }                   (the cached reading; null once it is 30 minutes old)
//   canReadPlanUse(provider) -> boolean: the provider's plan use can be read without sending a prompt (lib/quota.mjs reader table)
//   availability(ref, { lines, last: true }) also counts the LAST reading that was a number when no fresh one is there, until its plan
//        window resets (unattended runs ask so; why then reads "was at N% of its plan M minutes ago ..."). Without `last` nothing changes.
//   pick({ work, level, exclude, counts, overlay, mode, project, avoidProviders })
//        -> a promise of { ref, label, effort, why, skipped: [{ ref, label, reason, code }] } | { ref: null, error, skipped }
//           | { ref: null, empty: true, error, skipped: [] } when the list in force for that kind holds no model. That is not a refusal:
//           the team has no say for such a kind, and the runner gives the task to the model of its agent type, as with the team off.
//        With an overlay (a business), per-token models follow overlay.allowApi alone; without one, limits.allowApi.
//   pick({ ..., auto }) (wave 6): auto is lib/auto-context.mjs forTeam's { task, ctx }. With the kind's `auto` on, lib/auto-route.mjs
//        route() chooses among the models that passed: -> { ref, label, effort, why, auto: why ("Auto: ..."), alternatives, skipped },
//        effort the kind's own when pinEffort is set. When route() steps back, the choice is made as without auto and carries
//        autoNote (the step-back sentence). Without auto, or with the kind's Auto off, the answer is exactly as before. So it is
//        when the business's own list is in force and the overlay says autoLeads: false (the business's switch covers its own lists).
//   noteOutcome({ ref, cls, ok, kind })   what a finished task taught: cls is a class of classifyFailure, or '' (or ok: true) for a task
//        that ran; kind is the failure's CLI error kind (errorKind of the agent result), which says a "sign-in" came from the CLI itself
//   clearSignIn(provider) -> boolean     the provider's "needs sign-in" mark goes at once (wave 4): called when the program is seen
//        signed in (onSignedIn of lib/signin-windows.mjs, deps.onSignedIn) and when the person starts its sign-in in Accounts
//   classifyFailure(text, stopped, kind) -> 'limit' | 'sign-in' | 'refused' | 'not-offered' | 'not-installed' | 'slow' | 'failed'
//     ('refused': the program's sign-in was refused for that one run while its own check says it is signed in; the task may move on,
//     and the provider is NOT marked "needs sign-in")
//   migrate(raw), DEFAULT_KINDS, SIZE_HINTS
//   Beside the contract: ready() (waits, briefly, for how each model is billed and which keys are saved: the routes call it),
//   refreshPlanUse() (asks for the plan-use reading in the background, at most every 10 minutes), providersNow(), hints().
// The file: team.json in store.HOME, { v: 1, on, kinds: [{ id, label, about, agent, workers: [ref], prefer: [provider], effort, reply,
//   answerMax, builtIn, auto?, pinEffort? }], sizes: { ref: size }, limits: { perProviderAtOnce, skipAbovePercent, allowApi }, updatedAt }.
//   auto (default true) and pinEffort (default false) are written only when they differ from the default; get() always has both.
//
// RULES THIS MODULE KEEPS: everything a choice reads is memory (no CLI, no network; the plan-use reader, which can start a program, is
// asked only from noteOutcome and refreshPlanUse, never from get, registry, availability, suggested or pick). A model that is not in the
// owner's list is never returned. A model billed per token is never chosen until the owner allows it: pick asks how each model of the
// list is billed on EVERY choice (billingFor reads memory, the key store and one settings file, and starts no program), because a route
// changed in Accounts does not change the provider snapshot; what is kept per model is for the registry, and is asked again after a
// minute. A plan-use reading older than 30 minutes counts as not known, so an old reading never keeps a model out. It imports nothing from
// lib/team-run.mjs, lib/tools/40-delegate.mjs, lib/routes/index.mjs or lib/business.mjs (the business's overlay and plan lines arrive as
// arguments), and awaits no import at its top.
import fs, { promises as fsp } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';
import { CATALOG, EFFORTS, billingFor, labelFor, onCatalogChange, onProvidersChange, parseRef } from './providers.mjs';
import { knownProviders } from './provider-status.mjs';
import { infoFor, readinessFrom } from './model-info.mjs';
import { SIGN_IN_REFUSED_WORDS } from './cli-errors.mjs';
import { imageSupport } from './capabilities.mjs';
import { canRun, effectiveAgents } from './agents.mjs';
import { API_PROVIDERS } from './api-providers.mjs';
import { keyStatus } from './keys.mjs';
import { defaultReaders, readQuota } from './quota.mjs';
import { codexModelsState } from './codex-models.mjs';
import { museModelsState } from './muse-models.mjs';
import { antigravityModelsState } from './antigravity.mjs';
import { codersCannotAskOf } from './projects.mjs';
import { termsAccepted } from './legal.mjs';
import { onSignedIn } from './signin-windows.mjs';
import { route as autoRoute } from './auto-route.mjs';
import * as store from './store.mjs';

export const VERSION = 1;
export const SIZES = ['small', 'mid', 'top'];
// A whole word of a model id (the id is split at - . : / _) that says how large the model is. One table; a new family adds one word.
export const SIZE_HINTS = Object.freeze({
  haiku: 'small', luna: 'small', terra: 'small', flash: 'small', lite: 'small', spark: 'small', mini: 'small', small: 'small',
  sonnet: 'mid', sol: 'mid', pro: 'mid', large: 'mid',
  opus: 'top', fable: 'top', astra: 'top', wonder: 'top', argon: 'top', hydrogen: 'top', neon: 'top',
});
// The published input price, in dollars per million tokens, up to which a model counts as small and as mid.
export const SMALL_UP_TO = 0.8;
export const MID_UP_TO = 3;
export const CEILINGS = Object.freeze({ kinds: 24, ownKinds: 17, workers: 12, label: 40, about: 200, reply: 300, sizes: 400, answerMin: 400, answerMax: 24_000, atOnce: 16 });
export const DEFAULT_LIMITS = Object.freeze({ perProviderAtOnce: 3, skipAbovePercent: 90, allowApi: false });
const LIMIT_MARK_MS = 15 * 60_000;
const QUOTA_GAP_MS = 10 * 60_000;
// A plan-use reading counts for this long. The reader is asked again only when a task is handed over or ends, so on a quiet morning the
// evening's reading would otherwise keep every model of a kind out for ever; after this it is "not known", and not known is tried.
const QUOTA_KEEP_MS = 30 * 60_000;
// The last reading that was a number is kept for the stop line of unattended runs until its window resets; with no reset time, this long.
const LAST_READING_MS = 5 * 60 * 60_000;
// How a model is billed is kept this long for the registry (the page). A choice never reads what was kept: see billedNow.
const BILLING_KEEP_MS = 60_000;
const READY_WAIT_MS = 1500;

const kind = (id, label, about, agent, prefer, effort, reply = '', answerMax = 2400) =>
  Object.freeze({ id, label, about, agent, workers: Object.freeze([]), prefer: Object.freeze(prefer), effort, reply, answerMax, builtIn: true });
// The seven kinds of work that are built in (section 5.3). Their lists are empty until the owner saves a team: nothing here names a model.
export const DEFAULT_KINDS = Object.freeze([
  kind('find', 'Find', 'Look through files and say where things are and how they work.', 'researcher', ['anthropic', 'codex', 'gemini', 'muse'], 'low'),
  kind('research', 'Research', 'Read a lot, compare and summarise sources.', 'researcher', ['gemini', 'anthropic', 'codex', 'antigravity', 'muse'], 'medium'),
  kind('code', 'Code', 'Make one well-defined change inside a scope.', 'coder', ['anthropic', 'codex', 'gemini', 'muse'], 'high'),
  kind('test', 'Test', 'Run the named checks and report pass or fail.', 'tester', ['anthropic', 'codex', 'gemini', 'muse'], 'medium'),
  kind('write', 'Write', 'Draft text: reports, messages, listings, answers.', 'researcher', ['anthropic', 'muse', 'codex', 'gemini'], 'medium',
    'Reply with the finished text only. The findings layout does not apply to this task.', 8000),
  kind('data', 'Data', 'Bulk structured work: classify, score, extract, compare rows.', 'researcher', ['codex', 'anthropic', 'gemini', 'muse'], 'low',
    'Reply with the rows or the table asked for, then OPEN: and what you could not settle.', 8000),
  kind('review', 'Review', 'Check another model\'s result.', 'reviewer', ['anthropic', 'codex', 'gemini', 'muse'], 'high'),
]);
const BUILT_IN = new Map(DEFAULT_KINDS.map(k => [k.id, k]));

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const KIND_ID = /^[a-z0-9-]{1,24}$/;
const PROVIDER_ID = /^[a-z0-9-]{1,40}$/;
// A ref as a saved file may hold it: a provider, a colon and an id with no spaces or control characters.
const LOOSE_REF = /^[a-z0-9-]{1,40}:[^\s\u0000-\u001f\u007f]{1,160}$/;
const hasControl = text => /[\u0000-\u001f\u007f-\u009f]/.test(text);
const copyKind = k => ({ ...k, workers: [...k.workers], prefer: [...k.prefer] });
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const splitRef = ref => {
  const text = String(ref ?? '');
  const i = text.indexOf(':');
  return i < 0 ? { provider: text, id: '' } : { provider: text.slice(0, i), id: text.slice(i + 1) };
};
const rank = size => (size === 'small' ? 0 : size === 'top' ? 2 : 1);

// ---------- the record ----------

function cleanLimits(raw) {
  const r = isObject(raw) ? raw : {};
  const at = Number.isInteger(r.perProviderAtOnce) && r.perProviderAtOnce >= 1 && r.perProviderAtOnce <= CEILINGS.atOnce ? r.perProviderAtOnce : DEFAULT_LIMITS.perProviderAtOnce;
  const line = typeof r.skipAbovePercent === 'number' && r.skipAbovePercent >= 1 && r.skipAbovePercent <= 100 ? r.skipAbovePercent : DEFAULT_LIMITS.skipAbovePercent;
  return { perProviderAtOnce: at, skipAbovePercent: line, allowApi: r.allowApi === true };
}

function cleanKind(raw, base) {
  const r = isObject(raw) ? raw : {};
  const text = (v, fallback, max) => (typeof v === 'string' && v.trim() && !hasControl(v) ? v.trim().slice(0, max) : fallback);
  const seen = new Set();
  const workers = [];
  for (const w of Array.isArray(r.workers) ? r.workers : base?.workers ?? []) {
    if (typeof w !== 'string' || !LOOSE_REF.test(w) || seen.has(w) || workers.length >= CEILINGS.workers) continue;
    seen.add(w);
    workers.push(w);
  }
  const prefer = (Array.isArray(r.prefer) ? r.prefer : base?.prefer ?? []).filter(p => typeof p === 'string' && PROVIDER_ID.test(p)).slice(0, 20);
  const effort = r.effort === '' || EFFORTS.includes(r.effort) ? r.effort : base?.effort ?? '';
  return {
    id: base?.id ?? r.id,
    label: text(r.label, base?.label ?? String(r.id), CEILINGS.label),
    about: text(r.about, base?.about ?? '', CEILINGS.about),
    agent: typeof r.agent === 'string' && KIND_ID.test(r.agent) ? r.agent : base?.agent ?? 'researcher',
    workers,
    prefer: [...new Set(prefer)],
    effort,
    reply: typeof r.reply === 'string' && !hasControl(r.reply) ? r.reply.trim().slice(0, CEILINGS.reply) : base?.reply ?? '',
    answerMax: Number.isInteger(r.answerMax) && r.answerMax >= CEILINGS.answerMin && r.answerMax <= CEILINGS.answerMax ? r.answerMax : base?.answerMax ?? 2400,
    builtIn: BUILT_IN.has(base?.id ?? r.id),
    ...autoFields(r.auto, r.pinEffort, base, effort),
  };
}

// Auto routing (wave 6, AUTOROUTE-BRIEF.md section 2): `auto` (on unless the owner turned it off) and `pinEffort` (the kind's effort is
// the owner's choice, also under Auto; never without an effort). A field that is missing or not a boolean takes the default.
function autoFields(auto, pinEffort, base, effort) {
  const on = typeof auto === 'boolean' ? auto : base?.auto !== false;
  const pin = typeof pinEffort === 'boolean' ? pinEffort : base?.pinEffort === true;
  return { auto: on, pinEffort: pin && effort !== '' };
}

// The kinds as team.json holds them: `auto` and `pinEffort` only where they are not the default, so the file of an owner who never
// changed them stays as it was (and reads the same in a build from before Auto).
const kindForFile = k => {
  const { auto, pinEffort, ...rest } = k;
  return { ...rest, ...(auto === false ? { auto: false } : {}), ...(pinEffort === true ? { pinEffort: true } : {}) };
};

// A v1 record from anything: an older file, a damaged one, or a newer one. It never throws. What does not check out is dropped or takes
// its default, every built-in kind is there, and a file from a newer version keeps its version and its unknown fields (this build reads
// it and never writes it).
export function migrate(raw) {
  const r = isObject(raw) ? raw : {};
  const newer = Number.isInteger(r.v) && r.v > VERSION;
  const given = new Map();
  for (const k of Array.isArray(r.kinds) ? r.kinds : []) {
    if (!isObject(k) || typeof k.id !== 'string' || !KIND_ID.test(k.id) || given.has(k.id)) continue;
    given.set(k.id, k);
  }
  const kinds = DEFAULT_KINDS.map(b => {
    const own = given.get(b.id);
    return newer && own ? { ...own, ...cleanKind(own, b) } : cleanKind(own, b);
  });
  for (const [id, k] of given) {
    if (BUILT_IN.has(id) || kinds.length >= CEILINGS.kinds) continue;
    kinds.push(newer ? { ...k, ...cleanKind(k, null) } : cleanKind(k, null));
  }
  const sizes = {};
  for (const [ref, size] of Object.entries(isObject(r.sizes) ? r.sizes : {})) {
    if (LOOSE_REF.test(ref) && SIZES.includes(size) && Object.keys(sizes).length < CEILINGS.sizes) sizes[ref] = size;
  }
  const known = { on: r.on === true, kinds, sizes, limits: cleanLimits(r.limits), updatedAt: Number.isFinite(r.updatedAt) && r.updatedAt > 0 ? r.updatedAt : 0 };
  return newer ? { ...r, ...known, v: r.v } : { v: VERSION, ...known };
}

// ---------- failures ----------

// The same words as the page's limit banner (LIMIT_RE in public/ext-quota.js); a test compares the two.
export const LIMIT_RE = /\b(usage|rate|plan|weekly|5-hour|five-hour|hourly|daily|monthly|session)[ -]limit\b|\blimit (reached|exceeded|hit)\b|\bout of (credits|quota)\b|\btoo many requests\b|\b429\b|resource[_ ]exhausted|exceeded your (current )?quota/i;
const NOT_OFFERED_RE = /does not exist or you lack access|\bmodel\b.{0,60}\b(not found|does not exist|is not (available|supported|offered)|no longer (available|offered)|has been (retired|deprecated))|\b(unknown|unsupported|invalid) model\b|model_not_found|is not in your .{1,40} list/i;
// A program that is missing, not a file a task could not open: ENOENT counts only as the error of a start ("spawn codex ENOENT").
const NOT_INSTALLED_RE = /\bis not installed\b|\bnot installed\b|is not recognized as an internal or external command|command not found|\bspawn\b.{0,80}\bENOENT\b|was not found on (your |the )?PATH/i;
// A sign-in failure is carried by its kind (kind 'not-signed-in' of lib/cli-errors.mjs, which reads only the CLI's own report), not read
// from free text again: a file name, a log line or a reply with "401" or "unauthorized" in it is not a sign-in failure. With no kind
// (a caller that has only the sentence) the exact sentences Plenum writes itself count, and nothing else: "<Provider> is not signed in."
// from lib/cli-errors.mjs and the providers, and "Codex could not use the saved OpenAI key." (lib/providers.mjs codexKeyRefused).
const OWN_SIGN_IN_RE = /\b(?:Claude Code|Codex|Gemini CLI|Muse Code|Cursor|Grok Build|Antigravity) is not signed in\.|\bcould not use the saved \w+ key\./;
// The lists of files that runAgent writes into the error (lib/agent-run.mjs): their words are file names, never a cause.
const FILE_LIST_RE = /^(Changed outside the scope: |A read-only agent changed files: )/;
// Plenum's own sentence for a sign-in that was refused for one run while the program's own check says it is signed in (kind
// sign-in-refused in lib/cli-errors.mjs). It is read before the sign-in words, which its text also holds: the program IS signed in, so
// the provider must not be marked "needs sign-in" for the next tasks.
const REFUSED_RE = new RegExp(`\\b${SIGN_IN_REFUSED_WORDS}\\b`, 'i');
const SLOW_STOPS = new Set(['timeout', 'time', 'idle']);
const PERSON_STOPS = new Set(['user', 'parent', 'denied']);

// One table for what a failed task was, used by the team runner and by routines. `stopped` is runAgent's stop reason ('timeout' and
// 'idle' are its time and idle limits; 'user' and 'parent' are Stop). A stop by the person is never a class that moves a task.
// `kind` is the failure's CLI error kind when it had one (agent result errorKind): 'not-signed-in' is a sign-in and 'sign-in-refused' is
// 'refused'; any other kind is never a sign-in, whatever its detail says.
export function classifyFailure(text, stopped, kind) {
  const why = typeof stopped === 'string' ? stopped : '';
  if (PERSON_STOPS.has(why)) return 'failed';
  if (SLOW_STOPS.has(why)) return 'slow';
  const t = String(text ?? '');
  if (FILE_LIST_RE.test(t)) return 'failed';
  const named = typeof kind === 'string' && kind ? kind : '';
  if (named === 'sign-in-refused') return 'refused';
  if (named === 'not-signed-in') return 'sign-in';
  if (REFUSED_RE.test(t)) return 'refused';
  if (LIMIT_RE.test(t)) return 'limit';
  if (NOT_OFFERED_RE.test(t)) return 'not-offered';
  if (NOT_INSTALLED_RE.test(t)) return 'not-installed';
  if (!named && OWN_SIGN_IN_RE.test(t)) return 'sign-in';
  return 'failed';
}

// ---------- the instance ----------

const asFn = v => (typeof v === 'function' ? v : () => v);
const twinOf = ref => {
  const { provider, id } = splitRef(ref);
  if (provider === 'codex') return `openai:${id}`;
  if (provider === 'gemini' || provider === 'antigravity') return `googleai:${id}`;
  return null;
};
// The providers whose headless coder cannot ask before it writes (lib/agent-run.mjs CANNOT_ASK).
const CANNOT_ASK = new Set(['codex', 'gemini']);
const openMode = mode => mode === 'auto' || mode === 'all';
const LIST_PROVIDERS = ['codex', 'muse', 'antigravity'];

export function createTeam(deps = {}) {
  const d = {
    dir: deps.dir ?? store.HOME,
    now: deps.now ?? (() => Date.now()),
    catalog: asFn(deps.catalog ?? CATALOG),
    providers: asFn(deps.providers ?? knownProviders),
    keys: asFn(deps.keys ?? (() => Promise.all(API_PROVIDERS.map(async p => ({ id: p.id, configured: (await keyStatus(p.id)).configured === true }))))),
    // The plan-use reading. Codex's comes from its app server, which reaches OpenAI, so it waits for the License Agreement.
    readQuota: deps.readQuota ?? (async () => (termsAccepted(store.get()) ? readQuota() : null)),
    // The reader table of lib/quota.mjs: which providers have a plan-use reading that can be asked for without sending a prompt.
    planReaders: deps.planReaders ?? defaultReaders,
    billingFor: deps.billingFor ?? billingFor,
    canRun: deps.canRun ?? canRun,
    labelFor: deps.labelFor ?? labelFor,
    parseRef: deps.parseRef ?? parseRef,
    infoFor: deps.infoFor ?? infoFor,
    imageSupport: deps.imageSupport ?? imageSupport,
    readiness: deps.readiness ?? readinessFrom,
    // The agent types in force (Settings > Agents): [{ name, label, kind, buildOnly }].
    agentTypes: deps.agentTypes ?? (project => effectiveAgents(store.get(), project ?? null).types),
    listStates: asFn(deps.listStates ?? (() => ({ codex: codexModelsState(), muse: museModelsState(), antigravity: antigravityModelsState() }))),
    codersCannotAsk: deps.codersCannotAsk ?? codersCannotAskOf,
    projectById: deps.projectById ?? (id => store.get()?.projects?.find(p => p.id === id) ?? null),
    write: deps.write ?? writeFileAtomic,
    onCatalogChange: deps.onCatalogChange ?? (deps.catalog === undefined ? onCatalogChange : null),
    onProvidersChange: deps.onProvidersChange ?? (deps.providers === undefined ? onProvidersChange : null),
    // Who says that a program was seen signed in (lib/signin-windows.mjs, wave 4): its "needs sign-in" mark is cleared at once.
    onSignedIn: deps.onSignedIn === undefined ? onSignedIn : deps.onSignedIn,
  };
  const file = path.join(d.dir, 'team.json');

  // ----- the saved record -----
  let rec = null; // the record in force
  let saved = false; // a file exists
  let damaged = false; // the file could not be read as a team: the defaults are in force and the first save keeps a copy of it
  let newer = false; // the file is from a newer version: read, never written
  let unreadable = false; // the file is there but the last try could not read it: the defaults are in force and the next call tries again
  let queue = Promise.resolve();

  function load() {
    if (rec) return rec;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      const fresh = migrate(null);
      // No file: the defaults, and nothing is written. A file that is there but cannot be read now is tried again next time, and the
      // page is told (hints). A record that was read once stays in force for the whole run, so only a first read can meet this.
      if (err?.code === 'ENOENT') rec = fresh;
      saved = err?.code !== 'ENOENT';
      unreadable = saved;
      return fresh;
    }
    unreadable = false;
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

  const publicRecord = r => ({
    ...r,
    v: r.v,
    on: r.on,
    saved,
    kinds: r.kinds.map(copyKind),
    sizes: { ...r.sizes },
    limits: { ...r.limits },
    updatedAt: r.updatedAt,
    ...(newer ? { newer: true } : {}),
    ...(damaged ? { damaged: true } : {}),
    ...(unreadable ? { unreadable: true } : {}),
  });

  const get = () => publicRecord(load());
  const teamOn = () => load().on === true;

  function kindFor({ work, agent } = {}) {
    const kinds = load().kinds;
    const hit = (typeof work === 'string' && kinds.find(k => k.id === work)) || (typeof agent === 'string' && kinds.find(k => k.agent === agent)) || null;
    return hit ? copyKind(hit) : null;
  }

  // ----- what is known about the models, all of it kept in memory -----
  const billing = new Map(); // ref -> { value, known, at, flight }: for the registry; a choice asks again (billedNow)
  let keyList = null; // [{ id, configured }] once read
  let keyFlight = null;
  let provSig = null;
  let catSig = null;
  let wired = false;
  const marks = { limit: new Map(), signIn: new Map(), missing: new Map(), notOffered: new Map() };
  // The providers whose sign-in mark came with the CLI's own kind (not-signed-in), not from Plenum's sentence alone.
  const signInSaid = new Set();
  // last: per provider, the last reading that was a number, with when it was read and when its fullest window resets. It is kept past
  // QUOTA_KEEP_MS for one use only: the stop line of an unattended run (availability(ref, { last: true })).
  const quota = { byProvider: {}, at: 0, askedAt: null, flight: null, last: {} };

  const typesFor = project => {
    try {
      const list = d.agentTypes(project);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };
  const typeOf = (name, project) => typesFor(project).find(t => t?.name === name) ?? null;
  const catalogNow = () => {
    const list = d.catalog();
    return Array.isArray(list) ? list : [];
  };
  const label = ref => {
    const { provider, id } = splitRef(ref);
    const hit = catalogNow().find(c => c.provider === provider && c.id === id);
    if (hit?.label) return hit.label;
    try {
      return d.labelFor(ref);
    } catch {
      return String(ref);
    }
  };

  function forgetProviders() {
    billing.clear();
    marks.signIn.clear();
    signInSaid.clear();
    marks.missing.clear();
    keyList = null;
  }

  // What changed since the last look. The snapshot and the catalog are compared by their content, so nothing depends on being told; the
  // two subscriptions only make the next look see the change at once.
  function sync() {
    if (!wired) {
      wired = true;
      try {
        d.onCatalogChange?.(() => { catSig = null; });
        d.onProvidersChange?.(() => { provSig = null; forgetProviders(); });
      } catch {
        // Without the subscriptions the comparison below still sees every change.
      }
      try {
        if (typeof d.onSignedIn === 'function') d.onSignedIn(provider => { clearSignIn(provider); });
      } catch {
        // Without it the mark still ends after 15 minutes, or when the snapshot shows the sign-in.
      }
    }
    let p = 'none';
    try {
      p = JSON.stringify(d.providers() ?? null);
    } catch {
      // A snapshot that cannot be read counts as unknown.
    }
    if (p !== provSig) {
      if (provSig !== null) forgetProviders();
      provSig = p;
    }
    const c = catalogNow().map(e => `${e.provider}:${e.id}${e.offered === false ? '!' : ''}`).join('|');
    if (c !== catSig) {
      marks.notOffered.clear();
      catSig = c;
    }
  }

  const billed = v => (v === 'api' || v === 'plan' ? v : null);
  const keepBilling = (ref, value) => {
    const entry = billing.get(ref) ?? { value: null, known: false, at: 0, flight: null };
    entry.value = value;
    entry.known = true;
    entry.at = d.now();
    billing.set(ref, entry);
  };

  // How a model is billed, as the registry shows it: asked once, kept, and asked again in the background when the answer is older than
  // maxAgeMs (the old answer stays until the new one is there). An ask that failed is made again at the next call.
  function askBilling(ref, maxAgeMs = Infinity) {
    let entry = billing.get(ref);
    if (!entry) {
      entry = { value: null, known: false, at: 0, flight: null };
      billing.set(ref, entry);
    }
    if (!entry.flight && (!entry.known || d.now() - entry.at >= maxAgeMs)) {
      const mine = entry;
      mine.flight = Promise.resolve()
        .then(() => d.billingFor(ref))
        .then(v => { mine.value = billed(v); mine.known = true; mine.at = d.now(); }, () => {})
        .finally(() => { mine.flight = null; });
    }
    return entry;
  }

  // How each of these models is billed, asked NOW, for a choice. Rule 4 is never decided from what was kept: a route changed in Accounts
  // (a Gemini model's own route, a key route switched on) does not change the provider snapshot, so nothing would forget the old answer.
  // billingFor reads memory, the key store and one settings file; it starts no program. A model whose ask failed is asked once more; a
  // model whose answer is not there inside the wait is not in the map, and the choice passes it over.
  async function billedNow(refs) {
    const answers = new Map();
    const ask = ref => Promise.resolve()
      .then(() => d.billingFor(ref))
      .then(v => { answers.set(ref, billed(v)); keepBilling(ref, billed(v)); }, () => {});
    const all = async () => {
      await Promise.all(refs.map(ask));
      const again = refs.filter(ref => !answers.has(ref));
      if (again.length) await Promise.all(again.map(ask));
    };
    await within(all(), READY_WAIT_MS);
    // A copy: an answer that comes after the wait does not change a choice that is already being made.
    return new Map(answers);
  }

  function askKeys() {
    if (keyList || keyFlight) return keyFlight;
    keyFlight = Promise.resolve()
      .then(() => d.keys())
      .then(list => { keyList = Array.isArray(list) ? list : []; }, () => {})
      .finally(() => { keyFlight = null; });
    return keyFlight;
  }

  const within = (promise, ms) => {
    let timer;
    return Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
  };

  // Waits, briefly, until Plenum knows how the given models (all of them when none are named) are billed and which API keys are saved.
  // Both readers read memory and the key store; neither starts a program. An answer older than a minute is asked for again here, so
  // the page shows a route that was changed in Accounts.
  async function ready(refs) {
    sync();
    const list = Array.isArray(refs) ? refs : allRefs();
    const waits = list.map(ref => askBilling(ref, BILLING_KEEP_MS).flight).filter(Boolean);
    const keys = askKeys();
    if (keys) waits.push(keys);
    if (waits.length) await within(Promise.all(waits), READY_WAIT_MS);
  }

  // ----- sizes -----
  function priceOf(ref) {
    try {
      const own = d.infoFor(ref)?.price;
      if (own && Number.isFinite(own.input)) return { input: own.input, output: Number.isFinite(own.output) ? own.output : null };
      const twin = twinOf(ref);
      const other = twin ? d.infoFor(twin)?.price : null;
      if (other && Number.isFinite(other.input)) return { input: other.input, output: Number.isFinite(other.output) ? other.output : null };
    } catch {
      // No price.
    }
    return null;
  }

  function sizeOf(ref, price = priceOf(ref)) {
    const own = load().sizes[ref];
    if (SIZES.includes(own)) return { size: own, sizeFrom: 'owner' };
    if (price) return { size: price.input <= SMALL_UP_TO ? 'small' : price.input <= MID_UP_TO ? 'mid' : 'top', sizeFrom: 'price' };
    // Whole words only: "gemini" is not "mini". The last word that says a size wins, because the qualifier trails ("pro-mini").
    const words = splitRef(ref).id.toLowerCase().split(/[-.:/_]+/);
    for (let i = words.length - 1; i >= 0; i--) if (Object.hasOwn(SIZE_HINTS, words[i])) return { size: SIZE_HINTS[words[i]], sizeFrom: 'name' };
    return { size: 'unknown', sizeFrom: 'none' };
  }

  // ----- can it run now -----
  const providerLabel = provider => {
    try {
      return d.readiness({}, [])?.[provider]?.label ?? provider;
    } catch {
      return provider;
    }
  };

  // What a failed task taught about a provider's sign-in or its program holds until the provider snapshot changes (forgetProviders), or 15
  // minutes. Only a provider whose snapshot carries a sign-in value (Claude Code, Gemini CLI, Cursor, Grok Build, Antigravity) shows a new
  // sign-in that way; for Codex and Muse Code the snapshot knows "installed" only, so their mark lasts the 15 minutes, and the next task
  // then tries the model once more. A mark that came from Plenum's sentence alone, without the CLI's own kind, never outranks a snapshot
  // that says the provider is signed in (snapshotSignedIn).
  const held = (map, provider) => {
    const at = map.get(provider);
    if (at === undefined) return false;
    if (d.now() - at < LIMIT_MARK_MS) return true;
    map.delete(provider);
    return false;
  };

  // It is the program that is missing, not the model: the words say so, and read after the model's name.
  const missing = provider => ({ state: 'not-installed', why: `needs the ${providerLabel(provider)} program, which is not installed` });

  // Whether the provider snapshot carries a sign-in value for the provider and says it is signed in.
  const snapshotSignedIn = (snap, provider) => {
    const raw = snap?.[provider];
    if (!raw) return false;
    return provider === 'anthropic' ? raw.route === 'cli' && raw.credentials === true : raw.signedIn === true;
  };

  // The provider's own state, without plan use: ready, unknown, not-installed, sign-in or no-key.
  function providerBase(provider) {
    const snap = d.providers();
    if (provider === 'echo') return { state: 'ready', why: '' };
    if (held(marks.missing, provider)) return missing(provider);
    if (held(marks.signIn, provider)) {
      if (signInSaid.has(provider) || !snapshotSignedIn(snap, provider)) return { state: 'sign-in', why: 'needs sign-in' };
      marks.signIn.delete(provider);
    }
    if (!snap) return { state: 'unknown', why: '' };
    const raw = snap[provider];
    // A snapshot that is still being filled holds nulls where a CLI's state is not known yet.
    if (raw && (raw.installed === null || (provider === 'anthropic' && (raw.credentials === null || raw.credentials === undefined)))) return { state: 'unknown', why: '' };
    let row = null;
    try {
      row = d.readiness(snap, keyList ?? [])?.[provider] ?? null;
    } catch {
      row = null;
    }
    if (!row) return { state: 'unknown', why: '' };
    if (row.ready) return { state: 'ready', why: '' };
    const why = String(row.why ?? '');
    if (/key/i.test(why)) return keyList ? { state: 'no-key', why: 'needs an API key' } : { state: 'unknown', why: '' };
    if (/sign/i.test(why)) return { state: 'sign-in', why: 'needs sign-in' };
    return missing(provider);
  }

  // The plan use of a provider as last read, or null when there is no reading or the reading is older than QUOTA_KEEP_MS: an old
  // percentage is not shown as if it were current and keeps no model out (not known is tried, section 5.2).
  const usedOf = provider => (Number.isFinite(quota.byProvider[provider]) && d.now() - quota.at < QUOTA_KEEP_MS ? quota.byProvider[provider] : null);

  // How long ago, in words, for the age of a kept reading.
  const ago = ms => {
    const min = Math.max(1, Math.round(ms / 60_000));
    if (min < 60) return `${min} ${min === 1 ? 'minute' : 'minutes'} ago`;
    const h = Math.round(min / 60);
    return h < 48 ? `${h} ${h === 1 ? 'hour' : 'hours'} ago` : `${Math.round(h / 24)} days ago`;
  };
  // The last reading of a provider that still counts for the stop line: it is kept until the plan's window has reset (the reset time the
  // reader gave for its fullest window), or for LAST_READING_MS when the reader gave no reset time.
  const lastOf = provider => {
    const r = quota.last[provider];
    if (!r) return null;
    const over = Number.isFinite(r.resetsAt) ? d.now() >= r.resetsAt : d.now() - r.at >= LAST_READING_MS;
    return over ? null : r;
  };

  // last: true (an unattended run asks so) also counts the last reading when no fresh one is there.
  function limitOf(provider, lines, last = false) {
    const used = usedOf(provider);
    const own = isObject(lines) && Number.isFinite(lines[provider]) ? lines[provider] : null;
    const line = own ?? load().limits.skipAbovePercent;
    if (used !== null && used >= line) return { state: 'limit', why: `is at ${Math.round(used)}% of its plan (your line is ${Math.round(line)}%)` };
    const old = last && used === null ? lastOf(provider) : null;
    if (old && old.used >= line) return { state: 'limit', why: `was at ${Math.round(old.used)}% of its plan ${ago(d.now() - old.at)} (your line is ${Math.round(line)}%), and no newer reading could be had`, readAt: old.at };
    const at = marks.limit.get(provider);
    if (at !== undefined && d.now() - at < LIMIT_MARK_MS) return { state: 'limit', why: 'is at its plan limit' };
    return null;
  }

  function availability(ref, { lines, last = false } = {}) {
    sync();
    return availNow(ref, lines, last === true);
  }

  function availNow(ref, lines, last = false) {
    const { provider, id } = splitRef(ref);
    const usedPercent = usedOf(provider);
    const base = providerBase(provider);
    if (base.state !== 'ready' && base.state !== 'unknown') return { ...base, usedPercent };
    const name = providerLabel(provider);
    const gone = { state: 'not-offered', why: `is not in your ${name} list right now`, usedPercent };
    if (marks.notOffered.has(ref)) return gone;
    const entry = catalogNow().find(c => c.provider === provider && c.id === id);
    if (entry?.offered === false) return gone;
    if (!entry && LIST_PROVIDERS.includes(provider) && id !== 'default') {
      let read = false;
      try {
        read = d.listStates()?.[provider]?.ok === true;
      } catch {
        read = false;
      }
      if (read) return gone;
    }
    const limit = limitOf(provider, lines, last);
    if (limit) return { ...limit, usedPercent };
    return { ...base, usedPercent };
  }

  // ----- the registry -----
  function allRefs() {
    const refs = [];
    const seen = new Set();
    const add = ref => {
      if (typeof ref !== 'string' || seen.has(ref)) return;
      seen.add(ref);
      refs.push(ref);
    };
    for (const c of catalogNow()) add(`${c.provider}:${c.id}`);
    const r = load();
    for (const k of r.kinds) for (const w of k.workers) add(w);
    for (const ref of Object.keys(r.sizes)) add(ref);
    return refs;
  }

  function entryOf(ref) {
    const { provider, id } = splitRef(ref);
    const cat = catalogNow().find(c => c.provider === provider && c.id === id) ?? null;
    const price = priceOf(ref);
    let info = null;
    let vision = false;
    try {
      info = d.infoFor(ref);
    } catch {
      info = null;
    }
    try {
      vision = d.imageSupport(ref)?.ok === true;
    } catch {
      vision = false;
    }
    const bill = askBilling(ref);
    return {
      ref,
      label: label(ref),
      provider,
      billing: bill.known ? bill.value : null,
      ...sizeOf(ref, price),
      price,
      context: info?.context ?? null,
      tools: info?.tools ?? 'no',
      vision,
      discovered: cat?.discovered === true,
      listed: cat !== null,
      avail: availNow(ref),
    };
  }

  function registry() {
    sync();
    askKeys();
    return allRefs().map(entryOf);
  }

  // One line per provider the registry holds, for the page: its state, the reason in words and its plan use.
  function providersNow() {
    sync();
    const out = [];
    const seen = new Set();
    for (const ref of allRefs()) {
      const { provider } = splitRef(ref);
      if (seen.has(provider)) continue;
      seen.add(provider);
      const base = providerBase(provider);
      const limit = base.state === 'ready' || base.state === 'unknown' ? limitOf(provider) : null;
      out.push({ id: provider, label: providerLabel(provider), ...(limit ?? base), usedPercent: usedOf(provider) });
    }
    return out;
  }

  // ----- the plan-use reading -----
  // Asked in the background, at most every 10 minutes, and only when a task was handed over (noteOutcome) or a caller asks: the runner
  // calls refreshPlanUse() when it hands a task over, without waiting for it, so a hand-over that was refused also brings a fresh reading
  // for the next one. The reader can start a program (Codex's app server), so no read of the team and no choice ever calls it. A reading
  // counts for 30 minutes (usedOf).
  function refreshPlanUse() {
    if (quota.flight) return quota.flight;
    if (quota.askedAt !== null && d.now() - quota.askedAt < QUOTA_GAP_MS) return Promise.resolve();
    quota.askedAt = d.now();
    quota.flight = Promise.resolve()
      .then(() => d.readQuota())
      .then(answer => {
        if (!isObject(answer?.providers)) return;
        for (const [provider, entry] of Object.entries(answer.providers)) {
          const used = Number.isFinite(entry?.usedPercent) ? entry.usedPercent : null;
          quota.byProvider[provider] = used;
          if (used === null) continue;
          // When the fullest window resets (the latest of them when several are equally full), or null when the reader did not say.
          const resets = (Array.isArray(entry.windows) ? entry.windows : []).filter(w => w?.usedPercent === used && Number.isFinite(w?.resetsAt)).map(w => w.resetsAt);
          quota.last[provider] = { used, at: d.now(), resetsAt: resets.length ? Math.max(...resets) : null };
        }
        quota.at = d.now();
      }, () => {})
      .finally(() => { quota.flight = null; });
    return quota.flight;
  }

  const planUse = () => Object.fromEntries(Object.keys(quota.byProvider).map(provider => [provider, usedOf(provider)]));

  // Whether a provider's plan use can be read now without sending a prompt, by a reader that can report a number: a row of the reader
  // table (lib/quota.mjs) that never sends a request and keeps a free reading. It starts nothing and reads nothing: the table only.
  function canReadPlanUse(provider) {
    try {
      const table = d.planReaders();
      const row = typeof provider === 'string' && isObject(table) && Object.hasOwn(table, provider) ? table[provider] : null;
      return Boolean(row && row.sends === false && Number.isFinite(row.cacheMs) && row.cacheMs > 0 && typeof row.fresh === 'function');
    } catch {
      return false;
    }
  }

  function noteOutcome({ ref, cls, ok, kind } = {}) {
    if (typeof ref !== 'string' || !ref) return;
    sync();
    const { provider } = splitRef(ref);
    if (cls === 'limit') marks.limit.set(provider, d.now());
    else if (cls === 'sign-in') {
      marks.signIn.set(provider, d.now());
      if (kind === 'not-signed-in') signInSaid.add(provider);
      else signInSaid.delete(provider);
    }
    else if (cls === 'not-installed') marks.missing.set(provider, d.now());
    else if (cls === 'not-offered') marks.notOffered.set(ref, true);
    else if (ok === true || (ok === undefined && (!cls || cls === 'ok'))) {
      // The model just ran: what an earlier failure said about its sign-in and its place in the list is out of date.
      marks.signIn.delete(provider);
      signInSaid.delete(provider);
      marks.missing.delete(provider);
      marks.notOffered.delete(ref);
    }
    refreshPlanUse().catch(() => {});
  }

  // The program was seen signed in (its own check said so anywhere in Plenum, onSignedIn of lib/signin-windows.mjs), or the person
  // started its sign-in in Accounts (lib/routes/cli-accounts.mjs): the "needs sign-in" mark of that provider goes at once, not after its
  // 15 minutes, so the next task may use its models again. True when a mark was there. Never throws.
  function clearSignIn(provider) {
    if (typeof provider !== 'string' || !provider) return false;
    const had = marks.signIn.has(provider) || signInSaid.has(provider);
    marks.signIn.delete(provider);
    signInSaid.delete(provider);
    return had;
  }

  // ----- the suggested team -----
  function suggested() {
    sync();
    if (!d.providers()) return null;
    const r = load();
    const reg = registry();
    const order = [];
    for (const e of reg) if (!order.includes(e.provider)) order.push(e.provider);
    const usable = reg.filter(e => {
      if (!e.listed || splitRef(e.ref).id === 'default' || e.provider === 'echo' || e.size === 'unknown') return false;
      if (providerBase(e.provider).state !== 'ready' || e.avail.state === 'not-offered') return false;
      return e.billing === 'plan' || (e.billing === 'api' && r.limits.allowApi);
    });
    const kinds = r.kinds.map(k => {
      const type = typeOf(k.agent);
      const can = usable.filter(e => {
        try {
          return d.canRun(e.ref, type?.kind ?? 'read')?.ok !== false;
        } catch {
          return false;
        }
      });
      const providers = [...k.prefer.filter(p => order.includes(p)), ...order.filter(p => !k.prefer.includes(p))];
      const wanted = k.id === 'review' || k.agent === 'reviewer' ? ['mid', 'top'] : ['small', 'mid'];
      const workers = [];
      for (const size of wanted) {
        for (const provider of providers) {
          const mine = can.filter(e => e.provider === provider && e.size === size);
          if (!mine.length) continue;
          // The one with the lowest known input price, else the first in the catalog.
          const priced = mine.filter(e => e.price).sort((a, b) => a.price.input - b.price.input);
          const best = priced[0] ?? mine[0];
          if (workers.length < CEILINGS.workers) workers.push(best.ref);
        }
      }
      return { id: k.id, workers };
    });
    return { kinds };
  }

  // ----- the choice (section 6) -----
  async function pick(q = {}) {
    const r = load();
    sync();
    const k = r.kinds.find(x => x.id === q.work) ?? null;
    if (!k) return { ref: null, error: `There is no kind of work called ${String(q.work ?? '').slice(0, 40) || '(none)'}. Kinds: ${r.kinds.map(x => x.id).join(', ')}.`, skipped: [] };
    const overlay = isObject(q.overlay) ? q.overlay : null;
    const own = overlay && isObject(overlay.kinds) && Array.isArray(overlay.kinds[k.id]?.workers) ? overlay.kinds[k.id].workers.filter(w => typeof w === 'string') : null;
    const fromBusiness = Boolean(own?.length);
    const workers = fromBusiness ? [...new Set(own)] : k.workers;
    const whose = fromBusiness ? 'this business\'s list' : 'your team';
    // An empty list is not a refusal. The team has no say for this kind (the built-in kinds start empty and the switch can be turned on
    // by hand), and `empty` tells the runner to give the task to the model of its agent type, as with the team off.
    if (!workers.length) return { ref: null, empty: true, error: `Your team has no model for ${k.label}. Open Settings > Agents > Team, or name a model.`, skipped: [] };
    const keys = askKeys();
    const [bills] = await Promise.all([billedNow(workers), keys ? within(keys, READY_WAIT_MS) : null]);

    const project = isObject(q.project) ? q.project : typeof q.project === 'string' && q.project ? d.projectById(q.project) : null;
    const type = typeOf(k.agent, project);
    const typeKind = type?.kind ?? 'read';
    const level = SIZES.includes(q.level) ? q.level : null;
    const exclude = new Set(Array.isArray(q.exclude) ? q.exclude : []);
    // A business decides for itself (BUSINESS-DESIGN.md 2.1: with allowApi false "no model billed per token is used for this business
    // by routines or by the team"), so the team's own switch does not open per-token models for a business that says no.
    const allowApi = overlay ? overlay.allowApi === true : r.limits.allowApi === true;
    let refuses = false;
    try {
      refuses = typeKind === 'edit' && !openMode(q.mode) && d.codersCannotAsk(project) === 'refuse';
    } catch {
      refuses = typeKind === 'edit' && !openMode(q.mode);
    }

    const skipped = [];
    const passed = [];
    for (const ref of workers) {
      const { provider } = splitRef(ref);
      const skip = (code, reason) => skipped.push({ ref, label: label(ref), reason, code });
      if (exclude.has(ref)) { skip('tried', 'was already tried for this task'); continue; }
      if (level && rank(sizeOf(ref).size) < rank(level)) { skip('size', `is smaller than the size asked for (${level})`); continue; }
      let can = { ok: true, why: '' };
      try {
        can = d.canRun(ref, typeKind) ?? can;
      } catch {
        can = { ok: false, why: '' };
      }
      if (can.ok === false) { skip('cannot-run', typeKind === 'edit' ? 'cannot edit files here' : 'cannot do this kind of work here'); continue; }
      if (!bills.has(ref)) { skip('billing', 'cannot be used yet: Plenum does not know how it is billed'); continue; }
      if (bills.get(ref) === 'api' && !allowApi) { skip('per-token', `is billed per token, which ${overlay ? 'this business does' : 'your team does'} not allow`); continue; }
      const avail = availNow(ref, overlay?.lines);
      if (avail.state !== 'ready' && avail.state !== 'unknown') { skip(avail.state, avail.why); continue; }
      if (refuses && CANNOT_ASK.has(provider)) { skip('cannot-ask', 'cannot ask before it writes, and this project refuses such coders'); continue; }
      passed.push(ref);
    }

    if (!passed.length) {
      const reasons = skipped.map(s => `${s.label} ${s.reason}`).join('; ');
      return { ref: null, error: `No model in ${whose} for ${k.label} can run now: ${reasons}. Open Settings > Agents > Team, or name a model.`, skipped };
    }
    const counts = isObject(q.counts) ? q.counts : {};
    const avoid = new Set(Array.isArray(q.avoidProviders) ? q.avoidProviders : []);

    // Auto (wave 6, AUTOROUTE-BRIEF.md section 3): with the kind's Auto on and the task's features in q.auto (lib/auto-context.mjs
    // forTeam), route() picks among the models that passed, by the task and the room left in each plan; the owner's order breaks ties.
    // Nothing is added to the list. When route() steps back, or cannot answer, the choice below is made as before and says so.
    // A business's own list follows the business's switch (AUTOROUTE-BRIEF.md section 2: autoLeads "covers the business's leads and
    // its own kind lists"): with it off, that list is used in the owner's order, exactly as before. Only a plain false turns it off.
    let autoNote = '';
    if (k.auto !== false && !(fromBusiness && overlay.autoLeads === false) && isObject(q.auto)) {
      let routed = null;
      try {
        const candidates = passed.map(ref => {
          const a = availNow(ref, overlay?.lines);
          return { ref, label: label(ref), provider: splitRef(ref).provider, size: sizeOf(ref).size, billing: bills.get(ref) ?? null, avail: { state: a.state, usedPercent: a.usedPercent ?? null } };
        });
        const ctx = isObject(q.auto.ctx) ? q.auto.ctx : {};
        routed = autoRoute(q.auto.task, {
          ...ctx,
          candidates,
          // This instance's own reading and line, so the choice and the reasons it gives read the same numbers.
          planUse: planUse(),
          teamLine: r.limits.skipAbovePercent,
          lines: isObject(overlay?.lines) ? overlay.lines : null,
          allowApi,
          counts,
          atOnce: r.limits.perProviderAtOnce,
          avoid: [...avoid],
          exclude: [],
        });
      } catch {
        routed = null;
      }
      if (routed && typeof routed.ref === 'string' && passed.includes(routed.ref)) {
        const effort = k.pinEffort === true && k.effort ? k.effort : routed.effort ?? null;
        return { ref: routed.ref, label: label(routed.ref), effort, why: routed.why, auto: routed.why, alternatives: Array.isArray(routed.alternatives) ? routed.alternatives : [], skipped };
      }
      if (routed?.stepBack && typeof routed.why === 'string') autoNote = routed.why;
    }

    const full = provider => (Number(counts[provider]) || 0) >= r.limits.perProviderAtOnce;
    const free = passed.find(ref => {
      const { provider } = splitRef(ref);
      return !full(provider) && !avoid.has(provider);
    });
    const ref = free ?? passed[0];
    let why = ref === workers[0] ? `First in ${whose} for ${k.label}.` : `Next in ${whose} for ${k.label} that can run now.`;
    if (ref !== passed[0]) {
      // The first model that could run was passed by for its subscription, not for itself: the sentence says which, so it stays true.
      const first = splitRef(passed[0]).provider;
      const n = Number(counts[first]) || 0;
      why = full(first)
        ? `Next in ${whose} for ${k.label}, because ${providerLabel(first)} already has ${n} ${n === 1 ? 'worker' : 'workers'} of this run.`
        : `Next in ${whose} for ${k.label}, because ${providerLabel(first)} already worked on this job.`;
    }
    return { ref, label: label(ref), effort: k.effort, why, skipped, ...(autoNote ? { autoNote } : {}) };
  }

  // ----- saving -----
  function checkKinds(input, cur) {
    if (!Array.isArray(input)) throw bad('Send the kinds of work as a list.');
    const types = typesFor(null);
    const typeNames = types.filter(t => t && !t.buildOnly).map(t => t.name);
    const given = new Map();
    for (const raw of input) {
      if (!isObject(raw) || typeof raw.id !== 'string' || !KIND_ID.test(raw.id)) throw bad('A kind of work needs a short name: 1 to 24 lower-case letters, digits or hyphens.');
      if (given.has(raw.id)) throw bad(`Two kinds of work are named "${raw.id}".`);
      given.set(raw.id, raw);
    }
    const out = [];
    const one = (raw, base) => {
      const id = base?.id ?? raw.id;
      const pickField = (name, fallback) => (raw && raw[name] !== undefined ? raw[name] : fallback);
      if (!base && (raw.label === undefined || raw.agent === undefined)) throw bad(`There is no kind of work called "${id}". Give a new kind a label, one sentence and an agent type.`);
      const lbl = pickField('label', base?.label);
      if (typeof lbl !== 'string' || !lbl.trim() || lbl.trim().length > CEILINGS.label || hasControl(lbl)) throw bad(`Give the kind "${id}" a label of 1 to ${CEILINGS.label} characters.`);
      const name = lbl.trim();
      const about = pickField('about', base?.about ?? '');
      if (typeof about !== 'string' || about.trim().length > CEILINGS.about || hasControl(about) || (!base && !about.trim())) throw bad(`Describe "${name}" in one sentence of at most ${CEILINGS.about} characters.`);
      const agent = pickField('agent', base?.agent);
      const type = types.find(t => t?.name === agent && !t.buildOnly) ?? null;
      if (typeof agent !== 'string' || !type) throw bad(`"${String(agent).slice(0, 40)}" is not an agent type. Add it in Settings > Agents first, or use one of: ${typeNames.join(', ')}.`);
      const list = pickField('workers', base?.workers ?? []);
      if (!Array.isArray(list)) throw bad(`The models of "${name}" must be a list of model names.`);
      if (list.length > CEILINGS.workers) throw bad(`A kind of work holds at most ${CEILINGS.workers} models. "${name}" has ${list.length}.`);
      const kept = new Set(base?.workers ?? []);
      const workers = [];
      for (const w of list) {
        // The page may send a worker back as it got it: { ref, label, ... }.
        const text = typeof w === 'string' ? w : isObject(w) && typeof w.ref === 'string' ? w.ref : null;
        if (text === null) throw bad(`The models of "${name}" must be a list of model names.`);
        let ref = text;
        // A model the team already holds stays valid when its list no longer has it; a new one must be a model Plenum knows.
        if (!kept.has(text)) {
          try {
            ref = d.parseRef(text);
          } catch {
            // parseRef's own words point at a chat command (/models); this sentence is read on a Settings page.
            ref = null;
          }
        }
        if (typeof ref !== 'string' || !LOOSE_REF.test(ref)) throw bad(`${name}: "${String(text).slice(0, 60)}" is not a model Plenum knows. Pick one from the list under Add.`);
        if (workers.includes(ref)) throw bad(`${label(ref)} is in "${name}" twice.`);
        let can = { ok: true, why: '' };
        try {
          can = d.canRun(ref, type.kind) ?? can;
        } catch {
          can = { ok: true, why: '' };
        }
        if (can.ok === false) throw bad(can.why ? `${can.why} Take it out of "${name}".` : `${label(ref)} cannot do ${name} work here. Take it out of "${name}".`);
        workers.push(ref);
      }
      const prefer = pickField('prefer', base?.prefer ?? []);
      if (!Array.isArray(prefer) || prefer.length > 20 || prefer.some(p => typeof p !== 'string' || !PROVIDER_ID.test(p))) throw bad(`The preferred subscriptions of "${name}" must be a list of provider names.`);
      const effort = pickField('effort', base?.effort ?? '');
      if (effort !== '' && !EFFORTS.includes(effort)) throw bad(`The effort of "${name}" must be one of ${EFFORTS.join(', ')}, or empty.`);
      const reply = pickField('reply', base?.reply ?? '');
      if (typeof reply !== 'string' || reply.trim().length > CEILINGS.reply || hasControl(reply)) throw bad(`The reply sentence of "${name}" must be at most ${CEILINGS.reply} characters.`);
      const answerMax = pickField('answerMax', base?.answerMax ?? 2400);
      if (!Number.isInteger(answerMax) || answerMax < CEILINGS.answerMin || answerMax > CEILINGS.answerMax) throw bad(`The answer limit of "${name}" must be a whole number from 400 to 24,000 characters.`);
      const auto = pickField('auto', base?.auto !== false);
      if (typeof auto !== 'boolean') throw bad(`The Auto switch of "${name}" must be true or false.`);
      const pinEffort = pickField('pinEffort', base?.pinEffort === true);
      if (typeof pinEffort !== 'boolean') throw bad(`Whether "${name}" keeps the effort you chose must be true or false.`);
      return { id, label: name, about: about.trim(), agent, workers, prefer: [...new Set(prefer)], effort, reply: reply.trim(), answerMax, builtIn: BUILT_IN.has(id), ...autoFields(auto, pinEffort, null, effort) };
    };
    const curById = new Map(cur.kinds.map(k => [k.id, k]));
    // The built-in kinds first, in their order, whether the request names them or not; then the owner's, in the order given.
    for (const b of DEFAULT_KINDS) out.push(one(given.get(b.id) ?? null, curById.get(b.id) ?? b));
    for (const [id, raw] of given) if (!BUILT_IN.has(id)) out.push(one(raw, curById.get(id) ?? null));
    if (out.length > CEILINGS.kinds) throw bad(`A team holds at most ${CEILINGS.kinds} kinds of work: the 7 built in and ${CEILINGS.ownKinds} of your own.`);
    return out;
  }

  function checkSizes(input) {
    if (!isObject(input)) throw bad('Send the sizes as an object of model and size.');
    const out = {};
    for (const [ref, size] of Object.entries(input)) {
      if (size === null || size === '') continue;
      if (!LOOSE_REF.test(ref)) throw bad(`"${ref.slice(0, 60)}" is not a model Plenum knows.`);
      if (!SIZES.includes(size)) throw bad('A size must be small, mid or top.');
      out[ref] = size;
    }
    if (Object.keys(out).length > CEILINGS.sizes) throw bad(`At most ${CEILINGS.sizes} models can have a size of your own.`);
    return out;
  }

  function checkLimits(input, cur) {
    if (!isObject(input)) throw bad('Send the limits as an object.');
    const out = { ...cur };
    if (input.perProviderAtOnce !== undefined) {
      if (!Number.isInteger(input.perProviderAtOnce) || input.perProviderAtOnce < 1 || input.perProviderAtOnce > CEILINGS.atOnce) throw bad(`Workers per subscription at once must be a whole number from 1 to ${CEILINGS.atOnce}.`);
      out.perProviderAtOnce = input.perProviderAtOnce;
    }
    if (input.skipAbovePercent !== undefined) {
      if (typeof input.skipAbovePercent !== 'number' || !(input.skipAbovePercent >= 1 && input.skipAbovePercent <= 100)) throw bad('The plan line must be a number from 1 to 100 percent.');
      out.skipAbovePercent = input.skipAbovePercent;
    }
    if (input.allowApi !== undefined) {
      if (typeof input.allowApi !== 'boolean') throw bad('The switch for models billed per token must be true or false.');
      out.allowApi = input.allowApi;
    }
    return out;
  }

  async function doSave(patch) {
    if (!isObject(patch)) throw bad('Send an object with on, kinds, sizes or limits.');
    const cur = load();
    if (!rec) throw bad('Plenum could not read your team file just now. Try again in a moment.', 503);
    if (newer) throw bad('This team was saved by a newer version of Plenum. Update Plenum to change it.', 409);
    if (patch.on !== undefined && typeof patch.on !== 'boolean') throw bad('The team switch must be true or false.');
    const next = {
      v: VERSION,
      on: patch.on !== undefined ? patch.on : cur.on,
      kinds: patch.kinds !== undefined ? checkKinds(patch.kinds, cur) : cur.kinds.map(copyKind),
      sizes: patch.sizes !== undefined ? checkSizes(patch.sizes) : { ...cur.sizes },
      limits: patch.limits !== undefined ? checkLimits(patch.limits, cur.limits) : { ...cur.limits },
      updatedAt: d.now(),
    };
    await fsp.mkdir(d.dir, { recursive: true });
    if (damaged) {
      // The file that could not be read is kept beside the new one, once, so nothing the owner had is lost.
      await fsp.copyFile(file, path.join(d.dir, 'team.damaged.json')).catch(() => {});
    }
    await d.write(file, `${JSON.stringify({ ...next, kinds: next.kinds.map(kindForFile) }, null, 2)}\n`);
    rec = next;
    saved = true;
    damaged = false;
    return publicRecord(rec);
  }

  // One write at a time; a save that failed does not hold up the next one.
  function save(patch) {
    const run = queue.then(() => doSave(patch));
    queue = run.catch(() => {});
    return run;
  }

  // Short lines for the page about what the owner should know now.
  function hints() {
    sync();
    const out = [];
    if (!d.providers()) out.push('Plenum is still checking your sign-ins.');
    load();
    if (unreadable) out.push('Plenum could not read your saved team just now, so delegated work runs as it does with the team off. It tries again at the next task.');
    if (newer) out.push('This team was saved by a newer version of Plenum. It is shown here and cannot be changed until Plenum is updated.');
    if (damaged) out.push('The saved team could not be read, so the built-in kinds are shown. Saving keeps a copy of the old file as team.damaged.json.');
    const seen = new Set();
    for (const k of load().kinds) {
      for (const ref of k.workers) {
        if (seen.has(ref)) continue;
        seen.add(ref);
        if (availNow(ref).state !== 'not-offered') continue;
        const name = providerLabel(splitRef(ref).provider);
        out.push(`${label(ref)} is not in your ${name} list right now. Press Refresh under ${name} in Accounts.`);
      }
    }
    return out;
  }

  return { get, save, suggested, teamOn, kindFor, registry, availability, planUse, canReadPlanUse, pick, noteOutcome, clearSignIn, classifyFailure, migrate, ready, refreshPlanUse, providersNow, hints, labelOf: label, file };
}

// ---------- the default instance ----------

// Made on first use, never on the start path: it reads the file once, subscribes twice, and starts no timer.
let instance = null;
const team = () => (instance ??= createTeam());

export const get = () => team().get();
export const save = patch => team().save(patch);
export const suggested = () => team().suggested();
export const teamOn = () => team().teamOn();
export const kindFor = q => team().kindFor(q);
export const registry = () => team().registry();
export const availability = (ref, opts) => team().availability(ref, opts);
export const planUse = () => team().planUse();
export const pick = q => team().pick(q);
export const noteOutcome = outcome => team().noteOutcome(outcome);
export const ready = refs => team().ready(refs);
export const refreshPlanUse = () => team().refreshPlanUse();
export const canReadPlanUse = provider => team().canReadPlanUse(provider);
export const providersNow = () => team().providersNow();
export const hints = () => team().hints();
export const labelOf = ref => team().labelOf(ref);
// Clears a provider's "needs sign-in" mark (see clearSignIn in createTeam). No instance is made for it: before the first use there is
// no mark to clear. True when a mark was there.
export const clearSignIn = provider => instance?.clearSignIn(provider) ?? false;
// The four facts behind the suggested orders, each one line for the page (section 5.3).
export const FACTS = Object.freeze([
  'Claude asks before every write when it runs through Plenum, so it leads Code and Test.',
  'Your own ladder uses Luna for bulk work and Terra for scoring, so Codex leads Data.',
  'Gemini has the largest published context window, so it leads Research.',
  'A model from a second vendor is an independent checker, so Review takes a subscription that did not do the work.',
]);
