// The Bridge, assembled: startRemote() / stopRemote() / remoteState() (MOBILE.json desktop.new_files). Owned by mob-03.
//
// What starts. Nothing until server.mjs starts it once it listens (startPhones, when state.json phones.enabled is on) or the first
// /api/phones request asks for it (lib/routes/remote.mjs), and then only when phones.enabled is on. start() loads the registry (the desktop's encrypted store, or phones.json under plain node), makes
// this computer's static key on first use, binds 127.0.0.1:<port> (random 49152 to 65535 the first time, remembered in state.phones.port,
// another free one when that is taken), and wires the pieces:
//   registry   keys, path key, the paired phones                       (registry.mjs)
//   pairing    the offer state machine and the Allow/Deny gesture        (pairing.mjs)
//   handshaker Noise IK / IKpsk2, DoS controls, HELLO                    (listener.mjs)
//   listener   the http.Server, the upgrade at /b/<pathKey>, the LAN shell (listener.mjs)
//   proxy      REQ to the loopback server, tiers, guards, adapters      (proxy.mjs)
//   stop       STOP on the priority lane, idempotent by id               (stop.mjs)
// It also follows the server's own /api/events stream on loopback (as any window does), which gives it the server's start time and
// generation for HELLO, the approval cards waiting (for the first-line check and for push), runs finishing, and drives.
//
// What it gives the rest of the app:
//   events.publish({ type: 'phone', kind: 'presence', connected: [{ id, name, carrier, form }] }) when a phone connects or goes (form is
//   'browser' for a device paired through Add a browser, else 'phone'),
//   { type: 'phone', kind: 'pairing', state, expiresInS } while an offer lives, { kind: 'revoked', id }, { kind: 'tier', id, tier, caps },
//   { kind: 'activity', device, text } ('via <device>: approved a card'),
//   the shell message phones-indicator { connected: [names], devices: [{ name, form }] } and, under the desktop app, phones-pair-show for
//   the pairing window (mode 'phone' or 'browser'; a browser offer also carries its claim code and the /pair/ addresses).
// The same presence goes to every connected phone as an EVENT frame, so a phone can see the others.
//
// Carriers. A way of reaching this computer other than the loopback port is a module lib/remote/carriers/<kind>.mjs ('lan',
// 'tailscale', 'relay') that exports { start(ctx), stop(), status(), hints() } (each may return a promise). A module that is missing, or
// that fails to load, counts as off. ctx = { kind, settings(), listener: { setLan({ enabled, anyAddress }), status(), port() },
// handshaker: { accept({ carrier, source, transport }) }, registry: { relay(), ensureRelay(), pathKey(), publicKey(), on(name, fn) },
// clock, publish(event), hostname, upstreamPort() }. status() answers { on, ...whatever the panel shows, origins?: string[],
// name?: string (the ts.net name), addresses?: string[] }; hints() answers [{ kind, on, label, urls?: string[] (ws://... for 'lan'),
// url?: string (wss://... for 'tailscale' and 'relay'), web?: string (the page a phone opens: http://<ip>:<port>/p/<pathKey>/ or
// https://<name>/p/<pathKey>/) }].
//
// Pairing links under plain node. There is no capture-protected window, so POST /api/phones/pair/start answers the link itself (to the
// token holder only) and GET /api/phones shows the check code, and POST /api/phones/pair/confirm is the Allow. Under the desktop app the
// link and the code go only to the pairing window (shell message phones-pair-show) and Allow/Deny are buttons in it.
//
// Nothing here logs a token, a key, a link, a payload or a name.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';
import { token as authToken } from '../auth.mjs';
import * as eventsLib from '../events.mjs';
import { APP_ROOT } from '../overlay.mjs';
import { onShellMessage, shellAvailable, shellPost, shellRequest } from '../shell.mjs';
import * as storeLib from '../store.mjs';
import { createHandshaker, createListener } from './listener.mjs';
import { createPairing } from './pairing.mjs';
import { createProxy } from './proxy.mjs';
import { createFileStorage, createRegistry, createShellStorage, cleanName } from './registry.mjs';
import { createPusher, firstLineOf, normalizeSubscription, programOf } from './push.mjs';
import { stopEverything } from './stop.mjs';
import { deviceId as noiseDeviceId } from './noise.mjs';
import { ACTIVITY_MAX, capsForTier, isTier, phonesShape } from './tiers.mjs';

// Answering from a notification (lib/phone-answer.mjs, wave 8). Loaded without a static import, as lib/remote/push.mjs loads the
// notification hub: a module that fails to load never stops a push, which then goes out with a name and a count as before.
let phoneAnswer = null;
import('../phone-answer.mjs').then(m => { phoneAnswer = m; }, () => {});

export { phonesShape };

export const CARRIER_KINDS = Object.freeze(['lan', 'tailscale', 'relay']);
export const PROTOCOL = Object.freeze({ major: 1, minor: 1 });
const STOP_CACHE = 64;
const SWEEP_MS = 3_600_000;
const CARRIER_STATUS_MS = 30_000;
// While Plenum runs, a carrier that can check its own link (Tailscale's serve handler) is asked to look again this often.
const CARRIER_CHECK_MS = 120_000;
const INFO_WAIT_MS = 1000;
const PUSH_KINDS_OF_DRIVE = Object.freeze(['computer', 'browser']);
// A push that could not reach a phone after every try is written to the phone activity log at most this often per phone.
const GAVE_UP_EVERY_MS = 3_600_000;

// A monotonic clock whose timers never keep the process alive.
export function monotonicClock() {
  const unref = t => {
    t?.unref?.();
    return t;
  };
  return {
    now: () => performance.now(),
    setTimeout: (fn, ms) => unref(setTimeout(fn, ms)),
    clearTimeout: h => clearTimeout(h),
    setInterval: (fn, ms) => unref(setInterval(fn, ms)),
    clearInterval: h => clearInterval(h),
  };
}

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clip = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const randomPort = () => randomInt(49152, 65536);

// The id a phone keeps this computer's record under: sha256 of the static public key (noise.mjs deviceId), '' until an identity exists.
const phoneRecordId = registry => {
  try {
    const identity = registry.identity();
    return identity?.publicKey ? noiseDeviceId(identity.publicKey) : '';
  } catch {
    return '';
  }
};

// true when two push addresses are the same URL. A subscription is stored as its normalised URL; both sides are normalised here all the
// same, so an address kept by an older build still compares equal.
const sameEndpoint = (a, b) => {
  const norm = value => {
    try {
      return new URL(value).href;
    } catch {
      return value;
    }
  };
  return typeof a === 'string' && typeof b === 'string' && norm(a) === norm(b);
};

// What stopped a run, when it was a limit: the project's spend cap (lib/budget.mjs throws 'Spend cap reached: ...') is 'spend'; a
// plan or rate limit that a model CLI or API reports is 'plan'. Anything else is an ordinary failure (null).
export function limitKindOf(message) {
  const text = String(message ?? '');
  if (/^\s*spend cap reached/i.test(text)) return 'spend';
  if (/\b(usage limit|rate[ -]limit(ed)?|hit your limit|limit reached|(5[- ]hour|weekly|daily|monthly|session) limit|out of (extra )?usage|quota (exceeded|reached)|too many requests)\b/i.test(text)) return 'plan';
  return null;
}

/**
 * Builds a Bridge. Every dependency can be replaced (tests do); the defaults are the running server's own.
 * @param {object} [options]
 * @param {number|(() => number)} [options.port]   the server's real listen port (default PORT or 4317, which routes/remote.mjs overrides with the socket's)
 * @param {object} [options.settings]  { get(): state.phones object, save(): Promise<void> }
 * @param {Map} [options.running]      the server's running map
 * @param {(opts?: object) => object} [options.publicState]
 * @param {string} [options.host]      the loopback bind host (default 127.0.0.1)
 * @param {string[]} [options.lanHosts]
 * @param {(req) => string} [options.remoteAddress]
 * @param {string|null} [options.shellRoot]
 * @param {(line: string) => void} [options.log]   writes one fixed sentence (never key material); default none
 */
export function createRemote(options = {}) {
  const o = options;
  const shell = o.shell ?? { available: shellAvailable, request: shellRequest, post: shellPost, on: onShellMessage };
  const events = o.events ?? { publish: ev => eventsLib.publish(ev) };
  const clock = o.clock ?? monotonicClock();
  const wallNow = o.wallNow ?? Date.now;
  const random = o.random ?? (n => new Uint8Array(randomBytes(n)));
  const getToken = o.getToken ?? authToken;
  const loadCarrierModule = o.loadCarrier ?? (kind => import(`./carriers/${kind}.mjs`));
  const loadPush = o.createPusher ?? createPusher;
  const loadUiManifest = o.loadUiManifest ?? (() => import('./ui-manifest.mjs'));
  const hostname = clip(o.hostname ?? os.hostname(), 60) || 'this computer';
  // The key of the routines' run in a thread (lib/routines.mjs runKey), asked at a run's start. A Night shift job's run ('s:nj_…') sends
  // no 'finished' or 'failed' push of its own and holds none for the morning summary: the job's notice (key job:<id>) tells it. The
  // routines module is loaded once, here, without a static import; until it is there (or when it cannot be loaded) every run is plain.
  let routinesRunKey = typeof o.runKey === 'function' ? o.runKey : null;
  if (!routinesRunKey && o.runKey !== null) {
    import('../routines.mjs').then(m => { if (typeof m?.runKey === 'function') routinesRunKey = m.runKey; }, () => {});
  }
  const jobRunOf = (project, thread) => {
    try {
      const key = routinesRunKey?.(project, thread);
      return typeof key === 'string' && key.startsWith('s:nj_');
    } catch {
      return false;
    }
  };
  let serverPort = o.port;
  let running = o.running ?? null;
  let publicState = o.publicState ?? null;
  const upstreamPort = () => {
    const value = typeof serverPort === 'function' ? serverPort() : serverPort;
    return Number.isInteger(value) ? value : (Number(process.env.PORT) || 4317);
  };
  const settings = o.settings ?? { get: () => (storeLib.get().phones ??= {}), save: () => storeLib.saveOrFail() };
  const phones = () => phonesShape(settings.get());
  const storage = o.storage ?? (shell.available()
    ? createShellStorage({ request: (type, payload) => shell.request(type, payload) })
    : createFileStorage({ dir: o.home ?? storeLib.HOME }));
  const registry = createRegistry({ storage, wallNow, random, monotonic: () => clock.now() });

  const sessions = new Map(); // device id -> Set of session records
  const cards = new Map(); // approval id -> { id, project, summary, defaultDeny, blocked, kind, at }
  const runs = new Map(); // run id -> { project, error, errorKind, model, kind, routine, verdict, limited?, job? }
  const drives = new Map(); // drive id -> summary
  const handovers = new Map(); // drive id -> the note of the hand-over already pushed
  const handoverProjects = new Map(); // drive id -> the project of its hand-over
  // The projects whose approval (or hand-over) notification is on the phone: a clear takes it down once nothing of it waits.
  const pushedApprovals = new Set();
  const pushedHandovers = new Set();
  let waitingNow = 0; // approvalsWaiting, as the server's last hello or state said
  let resynced = 0; // the cards a hello found missed and told the phone of, until none waits
  const projectNames = new Map();
  const stopCache = new Map();
  const loggedOnce = new Set(); // fixed log sentences already written
  const carriers = {}; // kind -> loaded module
  const carrierStatus = {}; // kind -> last status
  const carrierHints = {}; // kind -> last hints
  let info = { desktopVersion: '', generation: null, startedAt: o.startedAt ?? 0 };
  let infoReady = null;
  let infoResolve = null;
  let started = null;
  let wanted = false; // start() was asked for and stop() has not been
  let retryTimer = null;
  let pusher = null;
  let listener = null;
  let handshaker = null;
  let pairing = null;
  let proxy = null;
  let sse = null;
  let timers = [];
  let lastPresence = '';
  let manifestCache = { generation: undefined, hash: '' };
  let stopped = true;
  let unsubscribe = [];

  const publish = ev => {
    try {
      events.publish(ev);
    } catch {
      // The events channel is a courtesy to the windows.
    }
  };

  // ----- presence -----

  const connectedList = () => {
    const out = [];
    for (const [id, set] of sessions) {
      const rec = [...set][0];
      if (rec) out.push({ id, name: registry.get(id)?.name ?? rec.device?.name ?? 'Phone', carrier: rec.carrier, form: registry.get(id)?.form === 'browser' ? 'browser' : 'phone' });
    }
    return out;
  };

  function broadcast(event, only = null) {
    for (const [id, set] of sessions) {
      if (only && id !== only) continue;
      for (const rec of set) {
        try {
          if (!rec.frames.isClosed) rec.frames.event(event);
        } catch {
          // A session that is closing misses the event.
        }
      }
    }
  }

  function presenceChanged() {
    const connected = connectedList();
    const key = JSON.stringify(connected);
    if (key === lastPresence) return;
    lastPresence = key;
    const event = { type: 'phone', kind: 'presence', connected };
    publish(event);
    broadcast(event);
    // connected: the names (as before); devices: each one's name and form, so the notification and the tray can say "browser".
    shell.post({ type: 'phones-indicator', connected: connected.map(c => c.name), devices: connected.map(c => ({ name: c.name, form: c.form })) });
  }

  function addActivity(device, text) {
    const entry = { at: wallNow(), device: clip(device, 60), text: clip(text, 120) };
    const p = phones();
    p.activity.unshift(entry);
    p.activity.length = Math.min(p.activity.length, ACTIVITY_MAX);
    publish({ type: 'phone', kind: 'activity', device: entry.device, text: entry.text });
    Promise.resolve(settings.save()).catch(() => {});
  }

  // ----- events from the server's own stream -----

  function handleEvent(ev) {
    if (!isObject(ev) || typeof ev.type !== 'string') return;
    if (ev.type === 'hello') {
      const restarted = info.startedAt && Number(ev.startedAt) && Number(ev.startedAt) !== info.startedAt;
      info = { desktopVersion: clip(ev.version, 40), generation: ev.generation ?? null, startedAt: Number(ev.startedAt) || info.startedAt };
      infoResolve?.();
      syncProjects(ev.state);
      syncDrives(ev.state);
      dropStaleRuns(ev.state, restarted);
      syncWaiting(ev.state, true);
      return;
    }
    if (ev.type === 'state') {
      syncProjects(ev.state);
      syncDrives(ev.state);
      syncWaiting(ev.state, false);
      return;
    }
    // A card answered, expired or stopped (lib/events.mjs approval action): it leaves, and its notification is taken down on the phone.
    if (ev.type === 'approval') {
      cardGone(String(ev.approvalId ?? ''));
      return;
    }
    if (ev.type === 'drive') {
      const d = ev.drive;
      if (!isObject(d) || typeof d.id !== 'string') return;
      if (d.state === 'stopped') drives.delete(d.id);
      else drives.set(d.id, d);
      // A model asking the person to do a step: told once per ask, however many times the drive reports the same pause.
      if (d.state === 'paused' && d.pausedBy === 'model' && d.note) {
        if (handovers.get(d.id) !== d.note) {
          handovers.set(d.id, d.note);
          handoverProjects.set(d.id, String(d.projectId ?? ''));
          const note = d.note;
          const projectId = String(d.projectId ?? '');
          pushEvent({ kind: 'handover', projectId: d.projectId, approvalId: d.id, firstLine: note }, { stillWanted: () => handovers.get(d.id) === note }).then(results => {
            if (!anySent(results)) return;
            // Sent: kept until the step is done. A step done while the push was on its way is taken down at once.
            if (handovers.get(d.id) === note) pushedHandovers.add(projectId);
            else if (![...handoverProjects.values()].includes(projectId)) pushClear({ kind: 'handover', projectId });
          });
        }
      } else if (handovers.has(d.id)) {
        handovers.delete(d.id);
        // The step was done (or the drive went on or stopped): the hand-over notification is taken down.
        const projectId = handoverProjects.get(d.id) ?? String(d.projectId ?? '');
        handoverProjects.delete(d.id);
        if (![...handoverProjects.values()].includes(projectId) && pushedHandovers.delete(projectId)) pushClear({ kind: 'handover', projectId });
      }
      return;
    }
    // A business left new items on the owner's list (lib/setup.mjs): the phone is told the business's name and a count, nothing else.
    if (ev.type === 'needs-you') {
      const count = Math.floor(Number(ev.count));
      // quick (wave 8): the newest item that waits for that business, when it is a simple yes/no ({ id, title, more }). The push shows it,
      // with Yes and No, only where the owner allowed the first line in notifications (lib/remote/push.mjs buildPushText).
      if (count >= 1) pushEvent({ kind: 'needs', projectId: '', businessName: clip(ev.name, 60), count, businessId: businessIdOf(ev.business), ...quickPart(ev.business) });
      return;
    }
    // A notice stamped by the notification hub (lib/notify.mjs): needs-you is a 'needs' push, problem a 'failed' one, fyi none. A repeat
    // or a quiet one is not pushed; silent is sent without sound; clear takes the notification of that key down.
    if (ev.type === 'notice') {
      handleNotice(ev.notice);
      return;
    }
    // A plan will run short or is used up (lib/plan-watch.mjs): the phone is told the computer's own sentence, under the limits switch.
    // An event without an alert only says that a reading changed.
    if (ev.type === 'plan-watch') {
      const a = ev.alert;
      // notice: the alert in one line for a channel that shows no title of its own (its title leads when it is about a business).
      const words = isObject(a) ? [a.notice, a.text].find(t => typeof t === 'string' && t.trim()) : undefined;
      const said = words === undefined ? '' : clip(words, 240);
      if (said) pushEvent({ kind: 'limit', limitKind: 'plan', projectId: '', text: said, alertId: clip(typeof a.id === 'string' ? a.id : '', 80) });
      return;
    }
    if (ev.type === 'run' && isObject(ev.event)) handleRunEvent(ev);
  }

  const businessIdOf = value => (typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : '');
  // o.quickFor is for a test; otherwise lib/phone-answer.mjs quickFor, and nothing when that module did not load.
  const quickPart = business => {
    try {
      const quick = (typeof o.quickFor === 'function' ? o.quickFor : phoneAnswer?.quickFor)?.(businessIdOf(business)) ?? null;
      return quick ? { quick } : {};
    } catch {
      return {};
    }
  };

  function handleNotice(n) {
    if (!isObject(n)) return;
    const key = clip(n.key, 120);
    if (!key) return;
    if (n.clear === true) {
      const replaced = noticeReplaces.get(key);
      noticeReplaces.delete(key);
      pushClear({ kind: 'notice', noticeKey: key });
      // The run's notification the notice stood in for goes too, unless a newer failed run of that project has taken its tag since.
      if (replaced && !failedPushAt.has(replaced.projectId)) pushClear(replaced);
      return;
    }
    if (n.repeat === true || n.quiet === true) return;
    // Wave 8: the morning or evening brief (lib/brief-notify.mjs, key 'brief:...') is the one fyi a phone is pushed, because the owner
    // asked for it at that time. It goes as a 'needs' with the notice's own words, so it follows the approvals switch and "only when
    // away" like every pushed notice, and a tap opens Businesses (route 'today'). Every other fyi is never pushed, as before.
    const kind = n.level === 'needs-you' ? 'needs' : n.level === 'problem' ? 'failed' : key.startsWith('brief:') ? 'needs' : '';
    if (!kind) return;
    const business = businessIdOf(n.business);
    const project = typeof n.project === 'string' && projectNames.has(n.project) ? n.project : '';
    // A routine runs as a plain chat run (lib/routines.mjs), so its failure would be told twice: by the run's 'failed' push and by the
    // routine's own notice. The notice is the word: one that comes within ROUTINE_JOIN_MS of a failed run of its project takes that push's
    // tag and replaces it on the phone (a browser too); later notices of the same routine keep that tag until it is cleared.
    let replaces = noticeReplaces.get(key) ?? null;
    const runProject = typeof n.project === 'string' ? n.project : '';
    if (!replaces && key.startsWith('routine:') && runProject && failedPushAt.has(runProject)) {
      const age = wallNow() - failedPushAt.get(runProject);
      if (age >= 0 && age < ROUTINE_JOIN_MS) {
        replaces = { kind: 'failed', projectId: runProject };
        failedPushAt.delete(runProject);
        noticeReplaces.set(key, replaces);
      }
    }
    pushEvent({
      kind,
      projectId: project,
      businessId: business,
      notice: { key, title: clip(n.title, 60), text: clip(n.text, 240), route: typeof n.route === 'string' ? n.route : '', business, project },
      ...(n.silent === true ? { silent: true } : {}),
      ...(replaces ? { replaces } : {}),
    });
  }
  const ROUTINE_JOIN_MS = 120_000;
  const failedPushAt = new Map(); // project id -> when a run's 'failed' push for it was sent last, until a routine notice stands in for it
  const noticeReplaces = new Map(); // notice key -> the run's 'failed' target its push replaced

  // B-125: the server's own hello and state events list the live drives (publicState drives). A stop missed while the stream was down, or a
  // server restart, would otherwise leave a drive in the map for ever and every HELLO would say a model is driving.
  function syncDrives(state) {
    if (!Array.isArray(state?.drives)) return;
    drives.clear();
    for (const d of state.drives) if (isObject(d) && typeof d.id === 'string' && d.state !== 'stopped') drives.set(d.id, d);
  }

  function syncProjects(state) {
    if (!Array.isArray(state?.projects)) return;
    projectNames.clear();
    for (const p of state.projects) if (isObject(p) && typeof p.id === 'string') projectNames.set(p.id, clip(p.name, 60));
  }

  // A run whose done was missed while the stream was down (or that died with a restart) would wait in `runs` for ever. On every hello a
  // run of a project the state no longer shows busy (projectThreads[id].busy) is dropped; after a restart, every run is.
  function dropStaleRuns(state, restarted) {
    if (restarted) {
      runs.clear();
      return;
    }
    const threads = isObject(state?.projectThreads) ? state.projectThreads : null;
    if (!threads) return;
    for (const [id, run] of runs) if (threads[run.project]?.busy !== true) runs.delete(id);
  }

  // The number of cards the server says are waiting. None waiting: every card is gone, and so are their notifications. On a hello (the
  // stream came back), cards the Bridge never saw (they came while the stream was down) get one approval push for the difference.
  function syncWaiting(state, hello) {
    const n = Number(state?.approvalsWaiting);
    if (!Number.isFinite(n)) return;
    waitingNow = Math.max(0, Math.floor(n));
    if (waitingNow === 0) {
      cards.clear();
      resynced = 0;
      for (const projectId of [...pushedApprovals]) pushClear({ kind: 'approval', projectId });
      pushedApprovals.clear();
      return;
    }
    // Told once per number: a stream that comes back again with the same cards missed does not ring the phone again.
    if (hello && waitingNow - cards.size > resynced) {
      const missed = waitingNow - cards.size;
      resynced = missed;
      pushEvent({ kind: 'approval', projectId: '', count: missed }, { stillWanted: () => waitingNow > cards.size }).then(results => {
        if (!anySent(results)) return;
        if (waitingNow > 0) pushedApprovals.add('');
        else pushClear({ kind: 'approval', projectId: '' });
      });
    }
  }

  // A card left (answered, expired, stopped or closed): its project's approval notification is taken down once no card of that project waits.
  function cardGone(id) {
    const card = cards.get(id);
    cards.delete(id);
    if (!card) return;
    const projectId = String(card.project ?? '');
    if ([...cards.values()].some(c => String(c.project ?? '') === projectId)) return;
    if (pushedApprovals.delete(projectId)) pushClear({ kind: 'approval', projectId });
  }

  // Run kinds (lib/events.mjs tag) that are housekeeping: they never push.
  const QUIET_RUN_KINDS = new Set(['compact', 'restore', 'rewind', 'check', 'screenshot', 'worktree', 'worktree-merge']);

  function handleRunEvent(ev) {
    const e = ev.event;
    const runId = String(ev.runId ?? '');
    const runKind = typeof ev.kind === 'string' ? ev.kind : '';
    // A run the server marks as one of lib/routines.mjs's (server.mjs routineMarkOf: a routine, a follow-up, a setup step or a Night shift
    // job) carries a bare true, ev.routine (or the start event's routine): it names nothing, and the run sends no 'finished' or 'failed' push
    // of its own, since the routine's notice (routine:<id>) or the job's (job:<id>) is the word on it (w7 notify-3). A routine that names
    // itself on its start event (a name, or { id, name }) is pushed as before, with its name in the words.
    const routineOf = value => (typeof value === 'string' || isObject(value) ? clip(isObject(value) ? value.name : value, 60) : '');
    // A run is known from its start (a council's is council-start). A run the Bridge never saw start sends nothing, as before.
    if (e.type === 'start' || e.type === 'council-start') {
      const run = runs.get(runId) ?? { project: ev.project, error: '', errorKind: '', model: '', kind: runKind, routine: '', verdict: false };
      if (typeof e.model === 'string' && e.model) run.model = e.model;
      if (!run.routine) run.routine = routineOf(ev.routine ?? e.routine);
      if (ev.routine === true || e.routine === true) run.routineRun = true;
      if (!run.kind && runKind) run.kind = runKind;
      // A Night shift job's run: the server marks it (ev.job), and the routines' key of the thread says so too.
      if (ev.job === true) run.job = true;
      else if (!run.job && (run.kind || runKind) === 'chat' && typeof e.thread === 'string' && e.thread) run.job = jobRunOf(String(ev.project ?? ''), e.thread);
      runs.set(runId, run);
      return;
    }
    if (e.type === 'approval') {
      const id = String(e.approvalId ?? '');
      if (!id) return;
      // Only the headline of a card is kept (its detail can hold file contents), with its line breaks, because the first line is what a notification shows.
      const summary = String(e.summary ?? '').slice(0, 600);
      cards.set(id, { id, project: ev.project, summary, defaultDeny: e.defaultDeny === true, blocked: e.blocked === true, kind: e.kind ?? '', at: wallNow() });
      const projectId = String(ev.project ?? '');
      pushEvent({ kind: 'approval', projectId: ev.project, approvalId: id, count: cards.size, firstLine: firstLineOf(summary), defaultDeny: e.defaultDeny === true }, { stillWanted: () => cards.has(id) }).then(results => {
        if (!anySent(results)) return;
        // Sent: kept until no card of the project waits. A card answered while the push was on its way is taken down at once.
        if ([...cards.values()].some(c => String(c.project ?? '') === projectId)) pushedApprovals.add(projectId);
        else pushClear({ kind: 'approval', projectId });
      });
    } else if (e.type === 'approval-closed') cardGone(String(e.approvalId ?? ''));
    else if (e.type === 'consensus') {
      const run = runs.get(runId);
      if (run) run.verdict = true;
    } else if (e.type === 'error') {
      const run = runs.get(runId);
      if (!run) return;
      run.error = clip(e.message, 200);
      if (typeof e.kind === 'string' && e.kind) run.errorKind = clip(e.kind, 40);
      // A spend cap or a plan limit that stops a run is its own ping (the 'limits' switch), and it replaces the 'failed' one for that run.
      // A council says what became of it instead: a seat's limit is one line of its error, not the council's end.
      const limitKind = run.kind === 'council' ? null : limitKindOf(e.message);
      if (limitKind && !run.limited && !QUIET_RUN_KINDS.has(run.kind)) {
        run.limited = true;
        pushEvent({ kind: 'limit', limitKind, projectId: run.project });
      }
    } else if (e.type === 'done') {
      const run = runs.get(runId);
      runs.delete(runId);
      if (!run || e.aborted === true) return;
      if (run.limited || QUIET_RUN_KINDS.has(run.kind || runKind)) return;
      // A Night shift job's run: its notice (job:<id>, lib/jobs.mjs) is the word, now and in the morning summary. A routine's run the
      // server marked: the routine's notice is (nothing is held for the summary either).
      if (run.job || run.routineRun) return;
      const about = {
        projectId: run.project,
        runKind: run.kind || runKind,
        ...(run.routine ? { routineName: run.routine } : {}),
      };
      const failed = run.kind === 'council' ? !run.verdict : Boolean(run.error);
      if (failed) {
        failedPushAt.set(String(run.project ?? ''), wallNow());
        pushEvent({ kind: 'failed', ...about, firstLine: run.error, errorKind: run.errorKind, program: programOf(run.model) });
      } else pushEvent({ kind: 'finished', ...about });
    }
  }

  // Sends one event to every phone (the pusher is called at once). Resolves to the results (never rejects); [] without a pusher.
  function pushEvent(event, opts = {}) {
    if (!pusher) return Promise.resolve([]);
    const withName = { ...event, projectName: projectNames.get(event.projectId) ?? '', computerName: hostname };
    let sending;
    try {
      sending = pusher.sendEvent(withName, opts);
    } catch {
      return Promise.resolve([]);
    }
    return Promise.resolve(sending).then(results => (Array.isArray(results) ? results : []), () => []);
  }
  const anySent = results => Array.isArray(results) && results.some(r => r?.outcome === 'sent');

  // Takes one notification down on the phone (kind 'clear'): target names it the way its push was tagged.
  function pushClear(target) {
    pushEvent({ kind: 'clear', projectId: String(target.projectId ?? ''), target });
  }

  // One line in the phone activity log when a push to a phone failed after every try, at most once an hour per phone.
  const gaveUpAt = new Map();
  function onPushGaveUp({ deviceId, name = '' }) {
    const at = wallNow();
    if (at - (gaveUpAt.get(deviceId) ?? -Infinity) < GAVE_UP_EVERY_MS) return;
    gaveUpAt.set(deviceId, at);
    addActivity(name || registry.get(deviceId)?.name || 'Phone', 'a notification could not reach this phone');
  }

  function followEvents() {
    let closed = false;
    let req = null;
    let timer = null;
    let backoff = 1000;
    const retry = () => {
      if (closed || timer !== null) return;
      timer = clock.setTimeout(() => {
        timer = null;
        connect();
      }, backoff);
      backoff = Math.min(10_000, backoff * 2);
    };
    function connect() {
      if (closed) return;
      const port = upstreamPort();
      let token = '';
      try {
        token = getToken();
      } catch {
        token = '';
      }
      req = http.request({ host: '127.0.0.1', port, path: '/api/events', method: 'GET', agent: false, headers: { host: `127.0.0.1:${port}`, 'x-plenum-token': token, accept: 'text/event-stream' } });
      req.on('response', res => {
        if (res.statusCode !== 200) {
          res.resume();
          return retry();
        }
        backoff = 1000;
        res.setEncoding('utf8');
        let buffer = '';
        res.on('data', chunk => {
          buffer += chunk;
          if (buffer.length > 8_000_000) {
            buffer = '';
            res.destroy();
            return;
          }
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const line = block.split('\n').find(l => l.startsWith('data:'));
            if (!line) continue;
            try {
              handleEvent(JSON.parse(line.slice(5)));
            } catch {
              // A line that is not an event is skipped.
            }
          }
        });
        // 'close' comes after every ending of the response: the server ended it, the connection broke, or the destroy() above (which
        // gives neither 'end' nor 'error'; before wave 7 the follower then stayed dead until Plenum was restarted). 'error' keeps its
        // listener so that a broken connection is not an uncaught error. Each response asks for one new connection, once.
        let over = false;
        const again = () => {
          if (over) return;
          over = true;
          retry();
        };
        res.on('end', again);
        res.on('error', again);
        res.on('close', again);
        return undefined;
      });
      req.on('error', retry);
      req.end();
    }
    connect();
    return {
      close() {
        closed = true;
        if (timer !== null) clock.clearTimeout(timer);
        req?.destroy();
      },
    };
  }

  // ----- HELLO -----

  async function uiManifestHash() {
    if (manifestCache.generation === info.generation && manifestCache.hash) return manifestCache.hash;
    try {
      const mod = await loadUiManifest();
      const fn = mod.manifest ?? mod.uiManifest;
      const value = typeof fn === 'function' ? await fn(uiContext()) : null;
      const hash = typeof value?.hash === 'string' ? value.hash : '';
      manifestCache = { generation: info.generation, hash };
      return hash;
    } catch {
      return '';
    }
  }

  const uiContext = () => ({ desktopVersion: info.desktopVersion, generation: info.generation, startedAt: info.startedAt });

  async function waitForInfo() {
    if (!infoReady) return;
    await Promise.race([infoReady, new Promise(resolve => clock.setTimeout(resolve, INFO_WAIT_MS))]);
  }

  function pendingNow() {
    const driving = [...drives.values()].find(d => PUSH_KINDS_OF_DRIVE.includes(d.kind) && d.state !== 'stopped');
    return {
      approvals: cards.size,
      running: running ? running.size : runs.size,
      ...(driving ? { driving: { kind: driving.kind, app: clip(driving.label, 60), step: Number(driving.steps) || 0, of: Number.isInteger(driving.limits?.steps) ? driving.limits.steps : null } } : {}),
    };
  }

  function carriersInHello() {
    const out = [];
    for (const kind of CARRIER_KINDS) {
      for (const hint of carrierHints[kind] ?? []) {
        if (!hint?.on) continue;
        const url = hint.url ?? hint.urls?.[0];
        if (typeof url === 'string' && url) out.push({ kind, url });
      }
    }
    return out;
  }

  // The VAPID public key (public by design: the browser needs it to subscribe), only when this Bridge has a pusher. Never the private half.
  function vapidField() {
    let key = null;
    try {
      key = pusher?.vapidPublicKey?.() ?? null;
    } catch {
      key = null;
    }
    return typeof key === 'string' && key ? { vapidPublicKey: key } : {};
  }

  async function helloFor({ device, kind, payload, carrier, refused, stopKeyNew }) {
    await waitForInfo();
    let stopAck;
    if (kind === 'session' && payload?.stop) {
      try {
        stopAck = (await runStop({ id: payload.stop }, device.name)).id;
      } catch {
        stopAck = undefined;
      }
    }
    const tier = registry.tierOf(device.id) ?? device.tier;
    return {
      v: '1.0',
      protocol: { ...PROTOCOL },
      desktopVersion: info.desktopVersion,
      generation: info.generation,
      startedAt: info.startedAt,
      desktopName: hostname,
      deviceId: device.id,
      tier,
      uiManifestHash: await uiManifestHash(),
      ...vapidField(),
      caps: capsForTier(tier),
      minShell: '1.0.0',
      pending: pendingNow(),
      carriers: carriersInHello(),
      ...(stopAck ? { stopAck } : {}),
      ...(refused ? { refused } : {}),
      // The desktop keeps this session's Stop key for a phone that asked for one (listener.mjs startSession); the phone derives the same key.
      ...(stopKeyNew ? { stopKeyNew: true } : {}),
    };
  }

  // ----- stop -----

  async function countCards() {
    if (publicState) return Number(publicState({ messages: false })?.approvalsWaiting) || 0;
    const port = upstreamPort();
    return new Promise(resolve => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/state', method: 'GET', agent: false, headers: { host: `127.0.0.1:${port}`, 'x-plenum-token': getToken() } }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(Number(JSON.parse(Buffer.concat(chunks).toString('utf8')).approvalsWaiting) || 0);
          } catch {
            resolve(0);
          }
        });
      });
      req.on('error', () => resolve(0));
      req.setTimeout(2000, () => req.destroy());
      req.end();
    });
  }

  function runStop(value, deviceName) {
    const id = typeof value?.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value.id) ? value.id : '';
    if (id && stopCache.has(id)) return stopCache.get(id);
    const project = typeof value?.project === 'string' && value.project ? value.project : null;
    const work = stopEverything({
      project, running, port: upstreamPort(), token: getToken, countCards, by: deviceName,
      publish: ev => {
        publish(ev);
      },
      ...(o.stopDeps ?? {}),
    }).then(counts => ({ id, ...counts }));
    if (id) {
      stopCache.set(id, work);
      while (stopCache.size > STOP_CACHE) stopCache.delete(stopCache.keys().next().value);
      work.catch(() => stopCache.delete(id));
    }
    return work;
  }

  // ----- pairing, and the window that shows it -----

  async function collectHints() {
    const hints = [];
    for (const kind of CARRIER_KINDS) {
      const mod = carriers[kind];
      if (!mod) continue;
      try {
        const list = await mod.hints();
        carrierHints[kind] = Array.isArray(list) ? list.filter(isObject) : [];
      } catch {
        carrierHints[kind] = [];
      }
      hints.push(...carrierHints[kind]);
    }
    if (process.env.PLENUM_REMOTE_LOOPBACK_HINT === '1' && listener) {
      const key = registry.pathKey();
      const port = listener.port();
      hints.push({ kind: 'lan', on: true, label: 'This computer (test)', urls: [`ws://127.0.0.1:${port}/b/${key}`], web: `http://127.0.0.1:${port}/p/${key}/` });
    }
    return hints;
  }

  // The short addresses a browser on another computer opens for Add a browser (the code page, /pair/ on the listener): Tailscale's secure
  // name first, then each same-network address. They never hold the path key. At most four.
  function pairAddressesOf(list) {
    const out = [];
    const add = (url, kind) => {
      if (out.length < 4 && !out.some(a => a.url === url)) out.push({ url, kind });
    };
    const on = (Array.isArray(list) ? list : []).filter(h => isObject(h) && h.on === true);
    for (const h of on.filter(x => x.kind === 'tailscale')) {
      try {
        const u = new URL(String(h.web ?? h.url ?? ''));
        if (u.hostname) add(`https://${u.hostname}/pair/`, 'tailscale');
      } catch {
        // A hint without an address offers none.
      }
    }
    for (const h of on.filter(x => x.kind === 'lan')) {
      for (const ws of Array.isArray(h.urls) ? h.urls : []) {
        try {
          const u = new URL(String(ws));
          if (u.host && (u.protocol === 'ws:' || u.protocol === 'http:')) add(`http://${u.host}/pair/`, 'lan');
        } catch {
          // Skipped.
        }
      }
    }
    return out;
  }

  // The hints as last read, with the test-only loopback hint (as collectHints adds it), for the address row of Settings > Phones.
  function knownHints() {
    const list = CARRIER_KINDS.flatMap(kind => carrierHints[kind] ?? []);
    if (process.env.PLENUM_REMOTE_LOOPBACK_HINT === '1' && listener) {
      list.push({ kind: 'lan', on: true, label: 'This computer (test)', urls: [`ws://127.0.0.1:${listener.port()}/b/${registry.pathKey()}`] });
    }
    return list;
  }

  function windowHints(list) {
    return list.map(h => ({ label: clip(h.label ?? (h.kind === 'lan' ? 'Same network' : h.kind === 'tailscale' ? 'Tailscale' : 'Your relay'), 120), on: h.on === true })).slice(0, 6);
  }

  let lastHints = [];

  // The tier the phone on screen gets if it is allowed: its stored tier on a re-pair, else Full (D6: the owner's default). null when nobody is shown.
  function shownTier() {
    const key = pairing?.shownPublicKey?.() ?? null;
    if (!key) return null;
    const id = registry.idOfPublic(key);
    return (id && registry.tierOf(id)) || 'full';
  }

  function onPairingChange(view, change) {
    publish({ type: 'phone', kind: 'pairing', state: view.state, expiresInS: view.expiresInS });
    if (!shell.available()) return;
    if (change === 'cancelled') {
      shell.post({ type: 'phones-pair-close' });
      return;
    }
    if (['offer', 'confirm', 'allowed', 'denied', 'expired', 'failed3', 'no-carrier'].includes(view.state)) {
      Promise.resolve(shell.request('phones-pair-show', {
        state: view.state,
        offer: pairing.offerId(),
        name: hostname,
        hints: windowHints(lastHints),
        expiresInS: view.expiresInS,
        code: view.code ?? '',
        device: view.device ?? null,
        second: view.second === true,
        tried: view.tried === true,
        left: view.left === true,
        qrKind: pairing.qrKind(),
        tier: shownTier(),
        link: pairing.link(),
        // Add a browser: which window to show, the claim code (drawn as a picture by the desktop, never sent to the page), the short
        // addresses to open, and whether a browser has typed the right code.
        mode: view.form === 'browser' ? 'browser' : 'phone',
        ...(view.form === 'browser' ? { claim: pairing.claimCode(), addresses: pairAddressesOf(lastHints).map(a => a.url) } : {}),
        claimed: view.claimed === true,
      })).catch(() => {});
    }
  }

  // Add phone ({ form: 'phone' }, the default) or Add a browser ({ form: 'browser' }). A new offer ends the one before, whatever its form.
  async function pairStart({ form = 'phone' } = {}) {
    await start();
    if (!registry.available()) throw Object.assign(new Error(registry.status().message), { status: 503 });
    lastHints = await collectHints();
    const hints = lastHints.filter(h => h.on === true);
    const browser = form === 'browser';
    const made = pairing.start({ name: hostname, pub: registry.publicKeyHex(), hints, form: browser ? 'browser' : 'phone' });
    if (!made.ok) return { ok: false, state: made.state };
    return {
      ok: true,
      state: 'offer',
      offer: made.offer,
      expiresInS: made.expiresInS,
      form: browser ? 'browser' : 'phone',
      // Without a window the link (and for a browser the claim code and the addresses) is the only way to show the code, and only the
      // token holder asks.
      ...(shell.available() ? {} : {
        link: made.link,
        hints: windowHints(lastHints),
        ...(browser ? { claim: pairing.claimCode(), addresses: pairAddressesOf(lastHints).map(a => a.url) } : {}),
      }),
    };
  }

  async function onWindowAnswer(msg) {
    const action = typeof msg?.action === 'string' ? msg.action : '';
    const offer = typeof msg?.offer === 'string' ? msg.offer : '';
    if (!pairing) return;
    const live = pairing.offerId();
    if (action === 'new-code') {
      // A new code of the same kind: New code in the Add a browser window makes a browser code again.
      await pairStart({ form: pairing.view().form }).catch(() => {});
      return;
    }
    if (offer && live && offer !== live) return;
    if (action === 'allow') await pairing.allow();
    else if (action === 'deny') pairing.deny();
    else if (action === 'cancel') pairing.cancel();
    else if (action === 'copy') {
      const text = pairing.link();
      if (text) await shell.request('phones-clipboard', { text, clearAfterMs: Math.max(5000, pairing.view().expiresInS * 1000) }).catch(() => {});
    }
  }

  // ----- carriers -----

  async function loadCarrier(kind) {
    if (carriers[kind]) return carriers[kind];
    try {
      const mod = await loadCarrierModule(kind);
      const api = mod?.default ?? mod;
      if (api && typeof api.start === 'function' && typeof api.stop === 'function' && typeof api.status === 'function' && typeof api.hints === 'function') {
        carriers[kind] = api;
        return api;
      }
    } catch {
      // A carrier that is not there, or does not load, is off.
    }
    return null;
  }

  function carrierCtx(kind) {
    return {
      kind,
      settings: () => phones()[kind],
      // A carrier keeps a small fact it must recall after a restart (the Tailscale name it served) in state.phones; nothing secret goes here.
      remember: patch => {
        const target = phones()[kind];
        if (!target || typeof patch !== 'object' || patch === null) return;
        Object.assign(target, patch);
        Promise.resolve(settings.save()).catch(() => {});
      },
      listener: { setLan: next => listener.setLan(next), status: () => listener.status(), port: () => listener.port() },
      handshaker: { accept: a => handshaker.accept(a) },
      registry: {
        relay: () => registry.relay(), ensureRelay: () => registry.ensureRelay(), pathKey: () => registry.pathKey(),
        publicKey: () => registry.publicKeyHex(), on: (name, fn) => registry.on(name, fn),
      },
      clock,
      publish,
      hostname,
      upstreamPort,
    };
  }

  async function refreshCarrierStatus() {
    for (const kind of CARRIER_KINDS) {
      const mod = carriers[kind];
      if (!mod) continue;
      try {
        carrierStatus[kind] = (await mod.status()) ?? {};
      } catch {
        carrierStatus[kind] = {};
      }
      try {
        const list = await mod.hints();
        carrierHints[kind] = Array.isArray(list) ? list.filter(isObject) : [];
      } catch {
        carrierHints[kind] = [];
      }
    }
  }

  // A carrier with a check() looks at its own link again (the Tailscale carrier reads what Tailscale serves). Only for carriers that are on.
  async function checkCarriers() {
    if (stopped) return;
    const p = phones();
    for (const kind of CARRIER_KINDS) {
      const mod = carriers[kind];
      if (!mod || typeof mod.check !== 'function' || !p[kind]?.enabled) continue;
      try {
        await mod.check();
      } catch {
        // A carrier that cannot check reports it through its own status().
      }
    }
    await refreshCarrierStatus();
  }

  // Starts or stops each carrier module to match state.phones. A module that is not there stays off.
  async function applyCarriers() {
    const p = phones();
    for (const kind of CARRIER_KINDS) {
      const mod = await loadCarrier(kind);
      if (!mod) continue;
      try {
        // A context is given on stop too: a carrier that must undo what it set (LAN mode, a Tailscale serve config) needs the listener.
        if (p[kind].enabled) await mod.start(carrierCtx(kind));
        else await mod.stop(carrierCtx(kind));
      } catch {
        // A carrier that fails to start reports it through its own status().
      }
    }
    await refreshCarrierStatus();
  }

  // ----- the listener -----

  async function bindListener() {
    const p = phones();
    const tries = [];
    if (Number.isInteger(p.port)) tries.push(p.port);
    while (tries.length < 8) tries.push(randomPort());
    let last = null;
    for (const port of tries) {
      if (port === upstreamPort()) continue;
      const candidate = createListener({
        handshaker,
        getPathKey: () => registry.pathKey(),
        clock,
        host: o.host ?? '127.0.0.1',
        port,
        lanHosts: o.lanHosts,
        remoteAddress: o.remoteAddress,
        getTailscaleName: () => carrierStatus.tailscale?.name ?? p.tailscale.name ?? '',
        getOrigins: () => CARRIER_KINDS.flatMap(kind => (Array.isArray(carrierStatus[kind]?.origins) ? carrierStatus[kind].origins : [])),
        shellRoot: o.shellRoot === undefined ? path.join(APP_ROOT, 'mobile', 'www') : o.shellRoot,
        uiPull: (req, res, pathname, search) => proxy.serveUi(req, res, pathname, search),
        // Add a browser: a code typed at /pair/ (POST /pair/claim) is checked by the offer itself.
        claim: (code, { kind, origin }) => (pairing ? pairing.checkClaim(code, kind, origin) : { ok: false, error: 'none' }),
      });
      try {
        await candidate.start();
        listener = candidate;
        if (p.port !== candidate.port()) {
          p.port = candidate.port();
          await Promise.resolve(settings.save()).catch(() => {});
        }
        return;
      } catch (err) {
        last = err;
        if (err?.code !== 'EADDRINUSE' && err?.code !== 'EACCES') throw err;
      }
    }
    throw last ?? new Error('Plenum could not find a free port for phones.');
  }

  // ----- lifecycle -----

  function build() {
    // A phone allowed now gets the auto-expire setting that is in force.
    const pairingRegistry = { add: input => registry.add({ expiresAfterDays: phones().autoExpireDays, ...input }), remove: id => registry.remove(id), idOfPublic: pub => registry.idOfPublic(pub) };
    pairing = createPairing({ registry: pairingRegistry, clock, random, onChange: onPairingChange, pathKey: () => registry.pathKey() });
    proxy = createProxy({
      upstreamPort,
      getToken,
      registry,
      clock,
      loadUiManifest,
      cards: { get: id => cards.get(id) ?? null },
      uiContext,
      onStop: (rec, value) => runStop(value, rec.device?.name ?? 'a phone').then(ack => {
        addActivity(rec.device?.name ?? 'Phone', 'stopped everything');
        return ack;
      }),
      onActivity: ({ rec, text }) => addActivity(rec.device?.name ?? 'Phone', text),
      ...(o.proxy ?? {}),
    });
    handshaker = createHandshaker({
      registry,
      pairing,
      identity: () => registry.identity(),
      clock,
      random,
      helloFor,
      makeHandlers: rec => proxy.attach(rec),
      // A signed STOP_ONLY from a phone that did not unlock (listener.mjs onStopOnly): the same function as the STOP frame, cached by id.
      onStopOnly: async ({ deviceId, stopId }) => {
        const name = registry.get(deviceId)?.name ?? 'a phone';
        const out = await runStop({ id: stopId }, name);
        addActivity(name, 'stopped everything');
        return out;
      },
      // A fixed sentence, once: a storage that fails to save fails every time, and the line holds no key material. This module never
      // writes to the console itself (the logging test); the server hands it a writer in options.log (lib/routes/remote.mjs).
      log: line => {
        if (loggedOnce.has(line)) return;
        loggedOnce.add(line);
        try {
          o.log?.(line);
        } catch {
          // A writer that throws changes nothing.
        }
      },
      onSession: rec => {
        if (!sessions.has(rec.deviceId)) sessions.set(rec.deviceId, new Set());
        sessions.get(rec.deviceId).add(rec);
        presenceChanged();
      },
      onClose: rec => {
        const set = sessions.get(rec.deviceId);
        if (set) {
          set.delete(rec);
          if (set.size === 0) sessions.delete(rec.deviceId);
        }
        presenceChanged();
      },
      ...(o.handshaker ?? {}),
    });
    unsubscribe.push(registry.on('removed', ({ id }) => {
      const set = sessions.get(id);
      for (const rec of set ? [...set] : []) {
        try {
          rec.frames.event({ type: 'phone', kind: 'revoked', id });
          rec.frames.close('revoked');
        } catch {
          // The phone was already going.
        }
      }
      publish({ type: 'phone', kind: 'revoked', id });
    }));
    unsubscribe.push(registry.on('reset', () => {
      pairing.cancel();
      listener?.closeConnections('revoked');
    }));
    unsubscribe.push(registry.on('tier', ({ id, tier }) => {
      // The caps travel with the tier (the same list HELLO carries), so a phone that is connected keeps the right controls when it is lowered.
      const event = { type: 'phone', kind: 'tier', id, tier, caps: capsForTier(tier) };
      broadcast(event, id);
      publish(event);
    }));
  }

  async function doStart(retryNow = false) {
    stopped = false;
    const status = await registry.ready({ force: retryNow });
    if (!status.ok) throw Object.assign(new Error(status.message || 'Phone keys cannot be kept on this computer right now.'), { status: 503 });
    await registry.ensureIdentity();
    if (registry.list().some(d => d.expiresAfterDays !== phones().autoExpireDays)) await registry.updateAll({ expiresAfterDays: phones().autoExpireDays }).catch(() => {});
    build();
    // HELLO waits (up to a second) for the server's own hello event, but only when this Bridge is following the events stream.
    infoReady = o.followEvents === false ? null : new Promise(resolve => {
      infoResolve = resolve;
    });
    try {
      pusher = loadPush({
        devices: {
          list: () => registry.list().map(d => ({ id: d.id, tier: d.tier, approveFromNotifications: d.approveFromNotifications, pushSubscription: registry.pushSubscriptionOf(d.id) })),
        },
        onGiveUp: onPushGaveUp,
        // A push service said an address is gone (404 or 410). Only that address is removed: a phone that has registered a new one in
        // the meantime (a send to the old one can be in flight or waiting for its second try for half a minute) keeps the new one.
        removeSubscription: (id, endpoint) => {
          if (endpoint !== undefined && !sameEndpoint(registry.pushSubscriptionOf(id)?.endpoint, endpoint)) return undefined;
          return registry.update(id, { pushSubscription: null }).catch(() => {});
        },
        presence: shell.available() ? () => shell.request('phones-presence', {}, { timeoutMs: 2000 }) : undefined,
        // A session whose tab said it is hidden (POST /_bridge/presence) is not in front, however often it polls.
        foreground: id => Math.max(0, ...[...(sessions.get(id) ?? [])].filter(rec => rec.hidden !== true).map(rec => rec.lastReq || 0)),
        // B-117: a notification names this computer by the id the phone keeps its record under (sha256 of the static public key, the same
        // value a pairing stores), so Stop all, Deny and Approve reach this computer and not whichever one the phone has open.
        settings: () => ({ push: phones().push, computer: { id: phoneRecordId(registry) || registry.computerId(), name: hostname } }),
        vapidStore: registry.vapidStore,
        now: wallNow,
        allowLocalEndpoints: o.allowLocalPushEndpoints === true,
        ...(o.push ?? {}),
      });
    } catch {
      pusher = null;
    }
    await bindListener();
    if (shell.available()) {
      unsubscribe.push(shell.on('phones-pair-answer', msg => onWindowAnswer(msg).catch(() => {})));
    }
    await applyCarriers();
    if (o.followEvents !== false) sse = followEvents();
    timers.push(clock.setInterval(() => {
      registry.sweepExpired({ connected: id => sessions.has(id) }).catch(() => {});
    }, SWEEP_MS));
    timers.push(clock.setInterval(() => {
      refreshCarrierStatus().catch(() => {});
    }, CARRIER_STATUS_MS));
    timers.push(clock.setInterval(() => {
      checkCarriers().catch(() => {});
    }, CARRIER_CHECK_MS));
    registry.sweepExpired({ connected: id => sessions.has(id) }).catch(() => {});
  }

  // A start that failed because the phones file could not be read is tried again by itself: the registry names the wait (2, 5, 15, then
  // 60 seconds), so phones come back without a restart and without Settings being open. stop() ends it.
  function planRetry() {
    // A file that waits for the person's "Start fresh" is not read again by a timer.
    if (!wanted || retryTimer !== null || registry.status().ok || !registry.status().loaded || registry.status().askFirst) return;
    retryTimer = clock.setTimeout(() => {
      retryTimer = null;
      // Only while "Let phones connect" is still on: a switch that was turned off again (Settings does that when the start fails) is
      // never turned on by a timer.
      if (phones().enabled !== true) wanted = false;
      else if (wanted && !started) start().catch(() => {});
    }, registry.retryInMs() + 50);
    retryTimer?.unref?.();
  }

  // start() and stop() take turns (wave 7): each one's work runs after the one asked for before it has finished. A start asked for
  // while a stop was still letting go (a carrier undoing its bind, the listener closing) used to run beside it: it bound a second
  // listener on a new port, the old teardown then closed that one, and phones stayed off until Plenum was restarted.
  let turn = Promise.resolve();
  const inTurn = fn => {
    const run = turn.then(fn);
    turn = run.catch(() => {});
    return run;
  };

  // Starts the Bridge once; later calls wait for or return the first. { retryNow: true } is a person asking (the switch in Settings): a
  // phones file that could not be read is read again now, not after the wait.
  function start(next = {}) {
    if (next.running) running = next.running;
    if (next.publicState) publicState = next.publicState;
    if (next.port !== undefined && o.port === undefined) serverPort = next.port;
    wanted = true;
    if (!started) {
      const mine = inTurn(async () => {
        try {
          await doStart(next.retryNow === true);
        } catch (err) {
          // A stop() or a newer start() may have come meanwhile: only this start's own record is cleared.
          if (started === mine) started = null;
          stopped = true;
          await teardown().catch(() => {});
          planRetry();
          throw err;
        }
      });
      started = mine;
    }
    return started;
  }

  // Lets go of everything start() made. Safe to call at any point of a start, and twice.
  async function teardown() {
    for (const fn of unsubscribe.splice(0)) {
      try {
        fn();
      } catch {
        // Nothing to undo.
      }
    }
    for (const h of timers.splice(0)) {
      clock.clearInterval(h);
      clock.clearTimeout(h);
    }
    sse?.close();
    sse = null;
    pairing?.shutdown();
    for (const kind of CARRIER_KINDS) {
      try {
        await carriers[kind]?.stop();
      } catch {
        // A carrier that cannot stop is dropped with the process.
      }
    }
    // Only the listener this teardown found is stopped and forgotten (the carriers above still needed it to undo their bind).
    const bound = listener;
    await bound?.stop();
    if (listener === bound) listener = null;
    sessions.clear();
    cards.clear();
    drives.clear();
    handovers.clear();
    handoverProjects.clear();
    pushedApprovals.clear();
    pushedHandovers.clear();
    runs.clear();
    waitingNow = 0;
    resynced = 0;
    lastPresence = '';
    await registry.flush().catch(() => {});
  }

  // Lets go of everything, after a start that is still under way has had its turn (it ran before this one, and whether it worked or
  // failed, what it made is let go here).
  function stop() {
    wanted = false;
    if (retryTimer !== null) {
      clock.clearTimeout(retryTimer);
      retryTimer = null;
    }
    started = null;
    stopped = true;
    return inTurn(async () => {
      stopped = true;
      await teardown();
    });
  }

  // ----- the view GET /api/phones answers -----

  async function state() {
    const p = phones();
    const plain = !shell.available();
    // The paired phones are listed even while phones are off, so a person can see and remove them.
    if (!started) await registry.ready();
    const reg = registry.status();
    if (started && !stopped) await refreshCarrierStatus();
    const lanStatus = carrierStatus.lan ?? {};
    const tsStatus = carrierStatus.tailscale ?? {};
    const relayStatus = carrierStatus.relay ?? {};
    const view = pairing ? pairing.view() : { active: false, state: 'idle', expiresInS: 0, second: false, name: '' };
    return {
      available: true,
      enabled: p.enabled,
      running: !stopped && listener !== null,
      port: listener?.port() || p.port || 0,
      storage: reg.loaded ? reg.storage : (plain ? 'file' : 'keychain'),
      storageNote: reg.loaded && !reg.ok ? reg.message : '',
      saveProblem: reg.saveProblem || '',
      plainNode: plain,
      carriers: {
        lan: { on: p.lan.enabled, anyAddress: p.lan.anyAddress, addresses: Array.isArray(lanStatus.addresses) ? lanStatus.addresses : [], available: Boolean(carriers.lan), error: String(lanStatus.error ?? ''), firewall: String(lanStatus.firewall ?? '') },
        tailscale: { on: p.tailscale.enabled, name: tsStatus.name ?? p.tailscale.name ?? '', available: Boolean(carriers.tailscale), installed: tsStatus.installed, message: String(tsStatus.message ?? '') },
        relay: { on: p.relay.enabled, url: p.relay.url, connected: relayStatus.connected === true, available: Boolean(carriers.relay), reason: String(relayStatus.reason ?? '') },
      },
      devices: registry.list().map(d => ({ ...d, connected: sessions.has(d.id) })),
      offer: {
        active: view.active,
        state: view.state,
        expiresInS: view.expiresInS,
        second: view.second === true,
        tried: view.tried === true,
        left: view.left === true,
        form: view.form === 'browser' ? 'browser' : 'phone',
        claimed: view.claimed === true,
        ...(plain && view.code ? { code: view.code } : {}),
        ...(plain && view.device ? { device: view.device } : {}),
      },
      // The short addresses of the code page for Add a browser (no key in them): [{ url, kind: 'tailscale' | 'lan' }], Tailscale first.
      pairAddresses: pairAddressesOf(knownHints()),
      push: { ...p.push },
      autoExpireDays: p.autoExpireDays,
      askFirst: reg.askFirst === true,
      // The names only, as before: the forms are in devices[] (each record's form) and in the shell's phones-indicator message.
      indicator: { connected: connectedList().map(c => c.name) },
    };
  }

  return {
    start,
    stop,
    state,
    registry,
    get pairing() {
      return pairing;
    },
    get listener() {
      return listener;
    },
    get handshaker() {
      return handshaker;
    },
    get proxy() {
      return proxy;
    },
    cards: () => [...cards.values()],
    // Feeds one event of the server's own stream (what the SSE follower does with each line). For tests.
    handleEvent,
    sessions: () => sessions,
    isRunning: () => !stopped && listener !== null,
    configure(next = {}) {
      if (next.running) running = next.running;
      if (next.publicState) publicState = next.publicState;
      if (next.port !== undefined && o.port === undefined) serverPort = next.port;
    },
    applyCarriers,
    pairStart,
    pairCancel: () => pairing?.cancel() ?? { ok: true },
    pairConfirm: allow => (allow ? pairing.allow() : Promise.resolve(pairing.deny())),
    async setLan(next) {
      return listener?.setLan(next);
    },
    async removeDevice(id) {
      return registry.remove(id);
    },
    async removeAll() {
      // A phones file that could not be read waits for a yes: this is that yes (the page's "Start fresh" posts remove-all).
      if (registry.status().askFirst) await registry.startFresh();
      return registry.removeAll({ rotate: true });
    },
    // A new relay room id and host secret (D9). The relay carrier follows the registry's 'relay-room' event; applyCarriers makes sure one runs.
    async newRelayRoom() {
      await registry.newRelayRoom();
      if (!stopped && listener) await applyCarriers();
      return state();
    },
    async setTier(id, tier) {
      if (!isTier(tier)) throw Object.assign(new Error('The tier must be full, approve or read.'), { status: 400 });
      return registry.update(id, { tier });
    },
    async setApproveFromNotifications(id, value) {
      return registry.update(id, { approveFromNotifications: value === true });
    },
    async setSubscription(id, subscription) {
      let normalized = null;
      if (subscription !== null) normalized = normalizeSubscription(subscription, { allowLocalEndpoints: o.allowLocalPushEndpoints === true });
      return registry.update(id, { pushSubscription: normalized });
    },
    async setAutoExpire(days) {
      return registry.updateAll({ expiresAfterDays: days });
    },
    async testPush(only = null) {
      if (!pusher) throw Object.assign(new Error('Notifications are not available in this build.'), { status: 503 });
      const results = await pusher.sendEvent({ kind: 'test', computerName: hostname });
      return results.filter(r => !only || r.deviceId === only);
    },
    activity: () => phones().activity.slice(),
    addActivity,
    hello: helloFor,
    runStop,
    cleanName,
    firstLineOf,
    wallNow,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The one Bridge of this process

let current = null;

// Starts (or returns) the Bridge. `next` may carry { running, publicState, port } from the server.
export async function startRemote(next = {}) {
  current ??= createRemote(next.options ?? {});
  await current.start(next);
  return current;
}

export async function stopRemote() {
  const was = current;
  current = null;
  if (was) await was.stop();
}

export function getRemote(next = {}) {
  current ??= createRemote(next.options ?? {});
  current.configure(next);
  return current;
}

export async function remoteState() {
  return current ? current.state() : null;
}

// The paired phone with that id as the running Bridge's registry keeps it ({ id, tier, approveFromNotifications, ... }), or null. It never
// creates or starts a Bridge and asks no carrier (review of wave 8: lib/routes/phone-answer.mjs asks it whether the phone that sent a Yes
// from a notification has Approve from notifications, as the Bridge asks for Approve).
export function deviceOf(id) {
  try {
    return typeof id === 'string' && id ? current?.registry?.get?.(id) ?? null : null;
  } catch {
    return null;
  }
}
