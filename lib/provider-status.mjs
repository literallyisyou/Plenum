import { AGY_HINT, antigravityModelsState, refreshAntigravityModels } from './antigravity.mjs';
import { codexModelsState, refreshCodexModels } from './codex-models.mjs';
import { museModelsState, refreshMuseModels } from './muse-models.mjs';
import { ALIASES, CATALOG, forgetCursorReading, onCatalogChange, onProvidersChange, providerStatus } from './providers.mjs';
import { findExecutable, forgetExecutables, keyRoutesFrom } from './proc.mjs';
import { API_PROVIDERS } from './api-providers.mjs';
import { storedKey } from './keys.mjs';
import { get as stateNow } from './store.mjs';
import { installHint } from './platform/index.mjs';
import * as events from './events.mjs';

// What GET /api/status answers, and the snapshot behind it (DECISIONS item 91). On 12 Nov 2026 the installed app would not start: the
// route ran providerStatus() on every call (it looks for seven CLIs and reads sign-in files) and waited up to 4 s for the Codex model
// list, and the desktop shell's start check gives it 1.5 s a try. Now the route never waits for a CLI, a model-list read, the network or
// a slow disk scan:
//  - A snapshot of the provider status is computed in the background: at start (prewarmProviderStatus), and again, still in the
//    background and one at a time, when a request finds it older than 10 seconds.
//  - Only a request that says ?refresh=... (Accounts' Refresh) waits for a fresh one, at most 4 seconds. refresh=codex, antigravity and
//    muse also read that CLI's model list again; refresh=all reads all three.
//  - Before the first snapshot exists a request waits for it for 150 ms (the contract allows 300), then answers with what is known and says
//    statusPending: true (the providers are a shape with nulls). The page asks again when it sees that, and when it is told
//    { type: 'providers' } on the events channel.
//  - The Codex, Antigravity and Muse model lists are read in the background, only after the License Agreement is accepted and the CLI is
//    found. Each answer says { ok, count, reading }; reading is true while a list is being read.
//  - When a background refresh changes the provider status or the catalog, { type: 'providers' } is published once on the events
//    channel. Nothing is published when nothing changed, except once for a person who was told "pending" or "reading" and is waiting.

export const FRESH_MS = 10_000;
const FIRST_WAIT_MS = 150;
const REFRESH_WAIT_MS = 4000;
const SETTLE_MS = 25;
// How long a request waits for a snapshot that the person's own change (a key saved, a route chosen) made out of date.
const CHANGE_WAIT_MS = 500;
// For how long after invalidateProviderStatus a request waits for the read it started (a read that hangs is not waited for by every
// request until its 30 second give-up; later requests take the "older than 10 seconds" branch, as before).
const CHANGE_WINDOW_MS = 5000;

// The background read: Cursor's sign-in is read on its own and refreshes the snapshot when it ends (lib/providers.mjs cursorReading).
let source = () => providerStatus({ background: true });
let publisher = ev => events.publish(ev);
// The terms check: the function prewarmProviderStatus was given, else the last value a request passed.
let acceptedFn = null;
let acceptedSeen = false;
const accepted = () => (acceptedFn ? acceptedFn() : acceptedSeen);
let snapshot = null; // { providers, at }
let inflight = null;
// The read invalidateProviderStatus started, and when: { read, at }, null once it ended.
let changeRead = null;
let lastSignature = null;
// Set when an answer told the page "pending" or "reading", so the page is told once when that is over, even if nothing else changed.
let owed = false;
// Names of lists whose read has been decided but not started yet (the CLI is still being looked for), so the answer says reading.
const starting = new Set();
// Names of lists that readLists has looked at once. Only a list that is forced or not looked at yet is marked starting: a list that is not
// due is not read, and marking it made every status request during a refresh say reading and owe the page an event, and the page asked
// again on that event (wave 7, signin-1). A list that is really being read says so through its own state (listStates()[name].reading).
const looked = new Set();
let settleTimer = null;
let lastLogged = null;
// Set once a request has been answered with the lists allowed, so a License Agreement accepted later starts them on the next request.
let listsKicked = false;

// The shape of providerStatus() with nothing known yet: nulls where a CLI's state is not known, so the page shows nothing false.
function pendingProviders() {
  return {
    muse: { installed: null, metaApiKey: false },
    codex: { installed: null, route: 'sign-in', keySaved: false, keyOn: false },
    gemini: { installed: null, signedIn: null, email: null, route: 'sign-in', keySaved: false, keyOn: false, installCommand: installHint('@google/gemini-cli') },
    cursor: { installed: null, signedIn: null, email: null },
    grok: { installed: null, signedIn: null, email: null },
    antigravity: { installed: null, signedIn: null, email: null, tier: null, installCommand: AGY_HINT },
    anthropic: { route: null, choice: null, cliInstalled: null, credentials: null, source: null, customBaseUrl: false },
  };
}

const withTimeout = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
};

// ---------- the snapshot ----------

// What the status depends on that the person changes in Plenum itself: the key routes in the state, and which keys are saved. It costs a
// few reads of memory, so every request takes it; a snapshot made before a change is read again at once (see statusPayload).
async function inputsFingerprint() {
  try {
    const saved = await Promise.all([...API_PROVIDERS.map(p => p.envVar), 'ANTHROPIC_API_KEY'].map(name => storedKey(name).then(k => (k.key ? 1 : 0), () => 0)));
    return JSON.stringify([keyRoutesFrom(stateNow()), saved]);
  } catch {
    return '';
  }
}

// Computes the provider status again, one at a time. Resolves to nothing and never throws; a failed read keeps the last snapshot.
// A read that has not ended after 30 seconds is given up on (a CLI that never answers), so the next refresh can start; if it ends later
// it is ignored.
const GIVE_UP_MS = 30_000;
let inflightAt = 0;
function refreshSnapshot({ again = false } = {}) {
  // again: a change was made that a read already running may have missed, so a new read follows that one.
  if (again && inflight && Date.now() - inflightAt < GIVE_UP_MS) return inflight.then(() => refreshSnapshot());
  if (inflight && Date.now() - inflightAt < GIVE_UP_MS) return inflight;
  inflightAt = Date.now();
  const mine = inflightAt;
  inflight = (async () => {
    try {
      const fp = await inputsFingerprint();
      const providers = await source();
      if (mine === inflightAt) snapshot = { providers, at: Date.now(), fp };
      lastLogged = null;
    } catch (err) {
      // A read that fails keeps the last answer and is tried again after the next 10 seconds; the reason is logged once.
      if (snapshot && mine === inflightAt) snapshot = { ...snapshot, at: Date.now() };
      const message = String(err?.message ?? err).split('\n')[0].slice(0, 200);
      if (message !== lastLogged) {
        lastLogged = message;
        console.error(`The provider status could not be read: ${message}`);
      }
    } finally {
      if (mine === inflightAt) inflight = null;
      settleSoon();
    }
  })();
  return inflight;
}

// Starts the three model reads that are due, in the background. A list is read only after the License Agreement is accepted and its CLI
// is found (the lookup is the cached one). Each read keeps its own timing (30 minutes, 2 minutes after a failure; force reads now).
function readLists({ force = [] } = {}) {
  if (!accepted()) return [];
  const jobs = [];
  const one = (name, command, read) => {
    if (force.includes(name) || !looked.has(name)) starting.add(name);
    looked.add(name);
    jobs.push(
      findExecutable(command)
        .then(async found => {
          if (!found) return false;
          const before = JSON.stringify(listStates()[name]);
          await read({ force: force.includes(name) });
          return JSON.stringify(listStates()[name]) !== before;
        })
        .catch(() => false)
        // A list that arrived can change what the status says (Antigravity's sign-in is known from its list), so the snapshot is read
        // again before the page is told { type: 'providers' }.
        .then(read => { if (read) return refreshSnapshot({ again: true }); })
        .catch(() => {})
        .finally(() => {
          starting.delete(name);
          settleSoon();
        }),
    );
  };
  one('codex', 'codex', refreshCodexModels);
  one('antigravity', 'agy', refreshAntigravityModels);
  one('muse', 'muse', refreshMuseModels);
  return jobs;
}

// Starts the snapshot and the lists in the background. server.mjs calls it once the server listens; it never blocks and never throws.
export function prewarmProviderStatus({ accepted: check } = {}) {
  try {
    if (typeof check === 'function') acceptedFn = check;
    refreshSnapshot();
    readLists();
  } catch {
    // The first request starts it again.
  }
}

// After a sign-in route ran (or any change a sign-in could make): the kept lookups are dropped, the snapshot is refreshed at once in the
// background (Cursor's kept reading is dropped too, so it is read again), and the lists named in `lists` ('codex', 'antigravity', 'muse') are read again now instead of at their own time.
export function invalidateProviderStatus({ lists = [] } = {}) {
  forgetExecutables();
  forgetCursorReading();
  if (snapshot) snapshot = { ...snapshot, at: 0 };
  const read = refreshSnapshot({ again: true });
  changeRead = { read, at: Date.now() };
  read.finally(() => { if (changeRead?.read === read) changeRead = null; });
  readLists({ force: lists });
}

// The providers of the last snapshot, or null before the first one: for a route that wants the status without waiting for it.
export const knownProviders = () => snapshot?.providers ?? null;

// The providers for a route that needs them but not to the second (GET /api/usage, GET /api/models/info): the snapshot when there is one
// (and a read in the background when it is older than 10 seconds), else one read of its own, as before.
export async function providersQuick() {
  if (!snapshot) return providerStatus();
  if (Date.now() - snapshot.at > FRESH_MS) refreshSnapshot();
  return snapshot.providers;
}

// ---------- telling the page ----------

const listStates = () => ({
  codex: codexModelsState(),
  antigravity: antigravityModelsState(),
  muse: museModelsState(),
});
const anyReading = () => starting.size > 0 || Object.values(listStates()).some(s => s.reading);

// What the page would show, as one string: the providers, the catalog (ids, labels, flags) and what each list read found.
function signature() {
  const lists = listStates();
  return JSON.stringify({
    providers: snapshot?.providers ?? null,
    catalog: CATALOG.map(c => [c.provider, c.id, c.label, c.discovered === true, c.offered === false]),
    lists: Object.fromEntries(Object.entries(lists).map(([name, s]) => [name, [s.ok, s.count]])),
  });
}

// Compares what the page would show with what it was last told, a moment after the last change (so a list that arrives together with a
// snapshot makes one event), and publishes { type: 'providers' } once when it differs.
function settleSoon() {
  if (settleTimer) return;
  settleTimer = setTimeout(() => {
    settleTimer = null;
    const now = signature();
    const changed = lastSignature !== null && now !== lastSignature;
    lastSignature = now;
    let tell = changed;
    // A page that was told "pending" or "reading" is waiting for the answer; it is told once the snapshot exists and no list is being read.
    if (owed && snapshot && !anyReading()) {
      owed = false;
      tell = true;
    }
    if (!tell) return;
    try {
      publisher({ type: 'providers' });
    } catch {
      // A broken channel must not break a refresh.
    }
  }, SETTLE_MS);
  settleTimer.unref?.();
}
onCatalogChange(settleSoon);
// Cursor's sign-in arrived: the snapshot is read again (the reading is kept, so this costs no program start).
onProvidersChange(() => { refreshSnapshot(); });

// ---------- the answer ----------

// The JSON of GET /api/status. refresh is the ?refresh= value ('' for none). accepted (optional) is what the terms check answers when prewarmProviderStatus was given no function.
export async function statusPayload({ refresh = '', accepted: acceptedNow } = {}) {
  if (typeof acceptedNow === 'boolean') acceptedSeen = acceptedNow;
  const which = String(refresh ?? '').toLowerCase();
  if (which) {
    // Accounts' Refresh: everything is looked for again and the answer waits for it, at most 4 seconds.
    forgetExecutables();
    const names = which === 'all' ? ['codex', 'antigravity', 'muse'] : [which];
    // A refresh already running started before the kept lookups were dropped, so it is waited for and run once more.
    const again = async () => {
      if (inflight) await inflight;
      await refreshSnapshot();
    };
    await withTimeout(Promise.all([again(), ...readLists({ force: names })]), REFRESH_WAIT_MS);
  } else {
    if (!snapshot) {
      refreshSnapshot();
      readLists();
      await withTimeout(inflight, FIRST_WAIT_MS);
    } else {
      if (snapshot.at === 0 && changeRead && Date.now() - changeRead.at < CHANGE_WINDOW_MS) {
        // A sign-in route, a key save or a route change dropped the snapshot (invalidateProviderStatus): the answer waits a moment for the
        // read that started after the change, so it shows the change at once. This is checked first: a dropped snapshot is also older
        // than 10 seconds, and that branch waits for nothing, so the answer right after a change showed the state from before it
        // (signin-6). refreshSnapshot() starts nothing while that read runs, and keeps the 30 second give-up working.
        refreshSnapshot();
        await withTimeout(changeRead.read, CHANGE_WAIT_MS);
      } else if (snapshot.fp !== undefined && Date.now() - snapshot.at <= FRESH_MS && (await inputsFingerprint()) !== snapshot.fp) {
        // A key was saved or a route chosen since the snapshot was made: it is read again, and the answer waits for that a moment (the
        // slow parts of it are kept by their own readers), so the status shows the change at once. A slower read is not waited for.
        await withTimeout(refreshSnapshot({ again: true }), CHANGE_WAIT_MS);
      } else if (Date.now() - snapshot.at > FRESH_MS) {
        refreshSnapshot();
        readLists();
      }
      // A License Agreement accepted since the start lets the lists be read; each read keeps its own timing.
      if (accepted() && !listsKicked) readLists();
    }
  }
  const ready = accepted();
  if (ready) listsKicked = true;
  const providers = snapshot?.providers ?? pendingProviders();
  const pending = !snapshot;
  const reading = name => starting.has(name) || listStates()[name].reading || (pending && ready);
  const list = name => {
    const { ok, count } = listStates()[name];
    return { ok, count, reading: reading(name) };
  };
  const out = {
    providers,
    catalog: CATALOG,
    aliases: ALIASES,
    codexModels: ready && (pending || providers.codex?.installed) ? list('codex') : null,
    antigravityModels: ready ? list('antigravity') : null,
    museModels: ready ? list('muse') : null,
  };
  if (pending) out.statusPending = true;
  if (pending || (ready && ['codex', 'antigravity', 'muse'].some(n => out[`${n}Models`]?.reading))) {
    owed = true;
    // A reading answer that nothing refreshes later (the lists are done) is still closed by the next settle.
    settleSoon();
  }
  return out;
}

// For tests: use another source for the provider status and another publisher, and forget everything.
export function resetProviderStatus({ read = () => providerStatus({ background: true }), publish = ev => events.publish(ev), accepted: check = null } = {}) {
  source = read;
  publisher = publish;
  acceptedFn = check;
  acceptedSeen = false;
  snapshot = null;
  inflight = null;
  changeRead = null;
  lastSignature = null;
  owed = false;
  listsKicked = false;
  starting.clear();
  looked.clear();
  clearTimeout(settleTimer);
  settleTimer = null;
  lastLogged = null;
}
