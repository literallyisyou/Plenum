// The shell's state and actions (mob-10, waves 104 and 107). This file is the bundle entry (scripts/build-mobile.mjs writes it as shell.js).
// It owns the flow: launch and lock, pairing from a link, connecting a computer, the connection state, Stop, the debug console,
// the phone settings, ?selftest and ?demo. The screens (screens/*.js) render what it exports; they never touch the channel, the store or the keys.
//
//   const shell = createShell({ store, lock, ... });   // or startShell() in the page; a release build sets no global (see "The page" below)
//   shell.state()             the current state (no keys, no tokens): route, locked, computers, connection, hello, stop, pairing, prefs
//   shell.subscribe(fn)       -> unsubscribe; fn(state) on every change
//   shell.pair(text)          a pairing link; resolves with the final pairing state
//   shell.connect(id)         opens the channel for a computer (refused while locked)
//   shell.stop(project?)      Stop: stops everything on the active computer (in demo mode, the replay answers). While the app is locked it
//                             still goes out when this phone holds the computer's Stop key (state().lockStop.ready), without unlocking
//   shell.forget(id)          removes this phone's keys for a computer (the computer keeps its entry until Remove there)
//   shell.unlock(method, arg) method: 'biometric' | 'pin' | 'passkey'; resolves with { ok, reason, waitSec? }
//   shell.lockNow()           closes the channel and drops the keys from memory; { ok:false, reason:'no-lock' } (and nothing closes) when no lock is set
//   shell.runSelftest()       the ?selftest steps; the report is in state().selftest and in the debug log
//   shell.debug               the debug console (log, lines, sendToComputer, clear)
//   Phone security round: confirmPair() (the pairing link that waits for review), pageLog(line) (a redacted line from the UI page).
//   Wave 107 (phone settings and demo): rename(id, name), moveWay(id, kind, 'up'|'down'), testWays(id), setPush(patch),
//   setApprove(value), testPush(), enableNotifications(), enableLock(mode), setPin(pin), lockOff(pin), setPrefs(patch),
//   cancelConnect(), cancelPairing(), demoDecide(id, 'approve'|'deny'), demoReset(). Each answers { ok, reason }.
//   Stabilising (H3, H7, M6, M7, M9, M11, M15, L18): showUi({ force }), useCopy(), openShell(hash), takeRoute(), scan(), pushAndroid(), dictation().
//   Wave 4 (m2, notifications): openNotificationSettings(), awaitPushApp(), ackPushRepaired(); state().notifySetup is the last turn-on
//   ({ seq, ok, reason, auto, testSent }), state().pushRepaired the one-time "turned them back on" line, state().androidPush the status row.
//   Wave 4 (m3, phone feel): leavingPage() (pagehide: the app keeps a biometric unlock in its memory for the next page), the status bar
//   follows Plenum's theme (SystemBars), and the shell page shows its kept theme before the first paint (earlyTheme).
//   Wave 5 (brb, a browser on another computer): POST /_bridge/presence { visible } at every HELLO and visibility change (sendPresence);
//   navigator.storage.persist() after the first pairing on a secure Chromium page (persistStorage); two tabs of one browser on one computer
//   (createTabGuard; state().tab is { state: 'elsewhere' | 'moved', computer } or null, and connect(id) is the tab's Use it here); the code
//   page at /pair/ (isClaimPage: no service worker, no UI host, nothing connected; state().claim.paired lists the computers paired through
//   this host); confirmPair({ name }) for a browser offer (payload form 'browser'); a launch link acts once (wireAppPlugin, LAUNCH_KEY). The
//   'online' event already reconnects (w4-m1 wireNetwork).
//   state().screenRequest is { screen: 'settings' | 'computers', seq } or null: the shell page was asked for one of its own screens (#settings,
//   #computers) and the screens open it once the app is unlocked; seq is 1 for the first request and rises by one for each later one.
//
// The page. The same bundle runs on two pages: the shell's own screens (index.html, data-shell-page) and the desktop's UI (data-surface="phone",
// where boot.js is the shim). Neither gets the shell through a global in a release build (plan D2): the shell page's screens take the full core once
// through globalThis.__plenumTakeShellCore, and the UI page's shim gets a frozen facade through the one-shot slot boot.js installs
// (window.__plenumAttachShell). Only a --dev build also sets window.plenumShellCore and window.plenumNative, for the test harnesses. On the shell page, once the computer has said hello, the UI is pulled and the page is handed to it (ui-host.js);
// on the UI page the shell keeps the channel, the lock and the notification links, and sends the person back to the shell page when there is
// nothing for the UI to show (no computer, a revoked phone, an update needed).

import { b64uToBytes, bytesToB64u, defaultCreateWorker, openChannel, sendLockedStop } from './channel.js';
import { createPlatformStore, publicComputer } from './store.js';
import { createBiometricGate, createLock, createPasskeyGate, createUnlockMemory } from './lock.js';
import { pageCandidates, parsePairingText, startPairing } from './pairing.js';
import { carrierUrlOk, hostLabel, usableCarriers } from './carriers.js';
import { createStopController, STOP_DONE_MS, STOP_NEEDS_UNLOCK } from './stop.js';
import { ANSWER_TEXT, answerFromNotification, isAnswerLink } from './answer.js';
import { createDebugLog } from './debug.js';
import { createAndroidPush, dropWebPush, endpointHash, isRouteLink, parseNotificationHash, subscribeWebPush } from './push.js';
import { NOTIFY_REPAIRED, NOTIFY_TEST_ON_WAY } from './screens/copy2.js';
import { appKindFor, capsFor, isLanPage, isNative, pageKindFor, platformFor } from './device.js';
import { createUiHost, SHELL_LINK_KEY, SHELL_QUERY } from './ui-host.js';
import { createReplay } from './screens/demo.js';
import * as S from './screens/settings.js';
import demoSession from './demo/session.json' with { type: 'json' };

const APP_VERSION = typeof __PLENUM_SHELL_VERSION__ !== 'undefined' ? __PLENUM_SHELL_VERSION__ : '0.0.0';
const LINK_VERSION = typeof __PLENUM_PROTOCOL__ !== 'undefined' ? __PLENUM_PROTOCOL__ : '1.0';

// The release gate (plan C7): true for the unbundled sources the Node suites import and for --dev builds, false in a release build. Dev builds
// only: ?selftest, the ?debug=1 hooks, the fixture screens, window.plenumShellCore and window.plenumNative, and the &ci-confirm=1 pairing marker.
export const DEV_BUILD = typeof __PLENUM_DEV_BUILD__ !== 'undefined' ? __PLENUM_DEV_BUILD__ === true : true;

// The page starts the shell once. Any script of the same origin can import this module (the same evaluated namespace) and call startShell on
// the page global, so the first start on globalThis wins and a later one resolves null without touching anything. The flag is also a
// non-configurable property of the page global, so a second evaluation of the module (the same file under another query string) refuses too.
// A start on any other object (the Node suites) is not a page start and is not counted.
let pageStarted = false;
const PAGE_STARTED_KEY = '__plenumPageStarted';
function takePageStart() {
  if (pageStarted || Object.getOwnPropertyDescriptor(globalThis, PAGE_STARTED_KEY) !== undefined) return false;
  pageStarted = true;
  try {
    Object.defineProperty(globalThis, PAGE_STARTED_KEY, { value: true });
  } catch { /* the module's own flag still holds */ }
  return true;
}

// The UI page's one-shot slot: boot.js installs window.__plenumAttachShell before this module runs. It is taken, and removed, while the module is
// evaluated, so no later script can call it; startShell calls it once, with the facade.
const attachShim = (() => {
  const f = globalThis.__plenumAttachShell;
  try { delete globalThis.__plenumAttachShell; } catch { /* not configurable */ }
  return typeof f === 'function' ? f : null;
})();

// The shell page's hand-over (plan C6a): defined only on a document whose <html> has data-shell-page, synchronously while this module is
// evaluated. screens/main.js calls it once at mount (it deletes itself); the Promise resolves to the full core when startShell has made it,
// or to null when the start failed or was refused.
let giveShellCore = () => {};
if (typeof document !== 'undefined' && document.documentElement?.hasAttribute?.('data-shell-page') && !globalThis.__PLENUM_SHELL_NO_AUTOSTART__) {
  const handed = new Promise(resolve => { giveShellCore = resolve; });
  Object.defineProperty(globalThis, '__plenumTakeShellCore', {
    configurable: true,
    enumerable: false,
    value: () => {
      try { delete globalThis.__plenumTakeShellCore; } catch { /* not configurable */ }
      return handed;
    },
  });
}

const ACTIVE_META = 'active';
const PREFS_META = 'prefs';
const DEMO_COMPUTER = Object.freeze({ id: 'demo', name: 'Demo computer', carriers: [], lastCarrier: null, lastSeen: null, pairedAt: null, counter: 0 });
const utf8 = new TextEncoder();
const utf8Read = new TextDecoder();
const STOP_RETRY_MS = 60 * 1000;   // the channel's STOP retry window (channel.js rejects after 60 s without an answer)
const APPROVE_META = 'approve';    // this phone's copy of its Approve-from-notifications switch; the computer keeps the real one
const STOP_NOTICE = new Set(['done', 'queued', 'failed']);
const APPROVE_OFF_META = 'approve-off-pending'; // set when the opt-out of Approve-from-notifications could not reach the computer; retried at every HELLO
const UP_PENDING_META = 'up-pending'; // an Android UnifiedPush endpoint the computer has not accepted yet (push.js createAndroidPush pendingStore)
// Wave 4 (m2): which computers hold this phone's Android endpoint (push.js postedStore; no key, only a short hash), when the last notification
// arrived, and the one-time "turned them back on" line Phone settings shows.
const UP_POSTED_META = 'up-posted';
const PUSH_LAST_META = 'push-last-at';
const PUSH_REPAIRED_META = 'push-repaired';
// The approval, handover and needs notifications this phone heard of (push.js seenStore: tag, kind, computer id, card id; no text), and
// which endpoint (short hash) each computer was last sent again by a repair and when, so a computer that keeps dropping the same address is
// not reported as fixed each time.
const UP_SEEN_META = 'up-seen';
const PUSH_REPAIRS_META = 'push-repairs';
const REPAIR_SAME_MS = 24 * 60 * 60 * 1000;
const STOP_META = 'pending-stop';   // a Stop the UI page left for the shell page (createParkedStop)
const LINK_META = 'shell-link';       // the link the UI page left for the shell page on the apps (ui-host.js openShell), in the store's meta
const LINK_TTL_MS = 120 * 1000;
const NOTIFICATION_LINK_MAX_AGE_MS = 60 * 1000;
export const NOTIFICATION_OLD = 'That notification is more than a minute old. Open the approval to answer it.';
const OPEN_SHELL_HASHES = Object.freeze(['', '#settings', '#computers']);
// The plugins the UI page's facade answers for (plan C6b).
const FACADE_PLUGINS = Object.freeze(['App', 'TextZoom', 'Haptics', 'Dictation', 'IsolatedPreview', 'Browser', 'Share', 'Filesystem']);
const INTENT_KEY = 'plenum-intent'; // sessionStorage: a notification route that arrived on the shell page, for the UI page to show
const SW_REGISTRATION_WAIT_MS = 3000;
// w4-m1: the line the shell says when a computer that asked for a Plenum update connects again (it was updated). It waits for the UI page in
// sessionStorage under NOTE_KEY for NOTE_TTL_MS (the computer's name is the only thing in it; no key, no link).
export const updatedLine = name => `Plenum on ${String(name || 'your computer').slice(0, 60)} was updated. Connected again.`;
export const UPDATED_LINE_PATTERN = /^Plenum on [^\n]{1,60} was updated\. Connected again\.$/;
const NOTE_KEY = 'plenum-note';
const NOTE_TTL_MS = 60 * 1000;
// Wave 4 (m3): how recent a biometric unlock must be for the next page of the app to start unlocked when the lock time is Immediately.
export const PAGE_SWITCH_FRESH_MS = 60 * 1000;
// Wave 4 (m3): the shell page's copy of the chosen theme ('dark' or 'light'; nothing for Follow phone), in localStorage so it can be read
// synchronously before the first paint. Only the theme: no key, no lock state.
export const THEME_KEY = 'plenum-theme';
if (typeof document !== 'undefined' && document.documentElement?.hasAttribute?.('data-shell-page') && !globalThis.__PLENUM_SHELL_NO_AUTOSTART__) {
  earlyTheme(globalThis);
}
export const CARD_CHANGED = 'That card changed. Open it to answer.';
// B-117: a notification names the computer that sent it. 64 hex characters is the id this phone keeps that computer's record under (the
// computer sends sha256 of its static public key, lib/remote/index.mjs phoneRecordId); anything else is an older computer's own short id,
// which cannot be matched, and the link acts on the open computer as it always did.
const RECORD_ID = /^[0-9a-f]{64}$/;
export const UNKNOWN_COMPUTER = 'That computer is not paired on this phone. Answer it at that computer.';
export const UNKNOWN_COMPUTER_STOP = 'That computer is not paired on this phone. Press Stop at that computer.';
// B-130: the lock settings could not be read, so no unlock can run, and this phone has no readable Stop key to send without one.
export const STOP_NO_KEY = 'This phone cannot read its Stop key, so it cannot send Stop from here. Press Stop on your computer.';

// The page mode from its query: 'selftest' only in a dev build (the self-test answers a card), 'demo' for the replay, else 'normal'.
export function modeFor(search, devBuild = DEV_BUILD) {
  const params = new URLSearchParams(String(search ?? ''));
  if (devBuild === true && params.has('selftest')) return 'selftest';
  return params.has('demo') ? 'demo' : 'normal';
}

function frozenCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = frozenCopy(item);
    return Object.freeze(out);
  }
  return value;
}

// The state the UI page may see (plan C6b): a frozen copy of only these fields. No pairing, no review hosts, no self-test, no key material.
export function safeState(state) {
  const s = state ?? {};
  const hello = s.hello;
  return frozenCopy({
    page: s.page,
    locked: s.locked === true,
    lock: { mode: s.lock?.mode, locked: s.lock?.locked, failures: s.lock?.failures, waitSec: s.lock?.waitSec },
    lockStop: { ready: s.lockStop?.ready === true, computerName: String(s.lockStop?.computerName ?? '') },
    connection: { status: s.connection?.status, carrier: s.connection?.carrier, desktopName: s.connection?.desktopName, lastSeen: s.connection?.lastSeen },
    hello: hello
      ? { desktopName: hello.desktopName, desktopVersion: hello.desktopVersion, deviceId: hello.deviceId, tier: hello.tier, pending: hello.pending }
      : null,
    stop: { state: s.stop?.state, text: s.stop?.text, seq: s.stop?.seq, ack: s.stop?.ack },
    activeId: s.activeId ?? null,
    computers: (Array.isArray(s.computers) ? s.computers : []).map(c => ({ id: c.id, name: c.name })),
    notice: s.notice ?? null,
    prefs: {
      theme: s.prefs?.theme,
      textSize: s.prefs?.textSize,
      stopSide: s.prefs?.stopSide,
      dictationAllowService: s.prefs?.dictationAllowService,
      dictationOnDevice: s.prefs?.dictationOnDevice,
    },
    intent: s.intent ?? null,
    device: { platform: s.device?.platform, app: s.device?.app, appVersion: s.device?.appVersion, protocol: s.device?.protocol },
    // Wave 5 (brb): another tab of this browser holds this computer (boot.js draws the card with Use it here, which is connect(computer)).
    // The field is there only while that is so: the listed fields of plan C6b are unchanged otherwise.
    ...(s.tab ? { tab: { state: s.tab.state, computer: s.tab.computer } } : {}),
  });
}

// Wave 4 (m3): what the UI page's shim gets of SystemBars: setStyle with 'DARK' or 'LIGHT' only (no hide, no show), so the status bar can
// follow Plenum's theme on the UI page and nothing there can hide the bar.
function barsForPage(plugin) {
  if (typeof plugin?.setStyle !== 'function') return null;
  return Object.freeze({ setStyle: options => plugin.setStyle({ style: options?.style === 'DARK' ? 'DARK' : 'LIGHT' }) });
}

// The facade the UI page's shim gets (plan C6b): a frozen object with exactly these members and nothing else.
export function makeFacade(shell, plugins) {
  const bars = barsForPage(plugins?.SystemBars);
  return Object.freeze({
    state: () => safeState(shell.state()),
    subscribe: fn => shell.subscribe(state => fn(safeState(state))),
    request: (spec, body = null, opts = {}) => {
      const channel = shell.channel;
      if (!channel) return Promise.reject(Object.assign(new Error('offline'), { code: 'offline' }));
      return channel.request(spec, body, { signal: opts?.signal ?? null, scope: 'page' });
    },
    stop: project => shell.stop(project ?? null),
    lock: () => shell.lockNow(),
    unlock: (method, pin = null) => shell.unlock(method, pin),
    connect: id => shell.connect(id),
    openShell: hash => (OPEN_SHELL_HASHES.includes(hash) ? shell.openShell(hash) : Promise.resolve(false)),
    takeRoute: () => shell.takeRoute(),
    log: line => shell.pageLog(line),
    plugin: name => (name === 'SystemBars' ? bars : FACADE_PLUGINS.includes(name) ? plugins?.[name] ?? null : null),
  });
}

// w7: whether the UI page may move to a copy from the computer now, from the app's built-in screens or (w7 follow-up) from an older copy
// (ui-host.js refresh, mayMove): the HELLO
// counts no run going on that computer, and no Stop is sending or queued on this page. The move reloads the page, so a reply that is streaming
// or a Stop on its way is never cut. A HELLO without a count says nothing, so it is not quiet.
export function uiMayMove(hello, stopState = 'idle') {
  const pending = hello?.pending;
  if (!pending || typeof pending !== 'object') return false;
  const running = Number(pending.running ?? pending.runs);
  if (!Number.isFinite(running) || running !== 0) return false;
  return stopState !== 'sending' && stopState !== 'queued';
}

// A link for the shell page that waits in the store's meta for a moment: the UI page leaves it (ui-host.js openShell) and the shell page takes it
// out once, if it is under two minutes old. A pairing link holds the pairing secret, so it never goes through sessionStorage or any web storage.
export function createLinkStore(meta, now = () => Date.now()) {
  return {
    async put(text) {
      await meta.put(LINK_META, { text: String(text).slice(0, 8192), at: now() });
    },
    async take() {
      let kept = null;
      try {
        kept = await meta.get(LINK_META);
        if (kept !== undefined && kept !== null) await meta.remove(LINK_META);
      } catch {
        return null;
      }
      return kept && typeof kept.text === 'string' && typeof kept.at === 'number' && now() - kept.at < LINK_TTL_MS ? kept.text : null;
    },
  };
}

// B-120: a Stop that was still queued or sending on the UI page when it handed the page to the shell page. The channel worker that held it ends
// with the page, so the page leaves a note in the store's meta ({ at, computer }) and the shell page sends the Stop again if the note is under a
// minute old (STOP_RETRY_MS, the window a Stop is retried for). The note is taken out once; a Stop is safe to send twice.
export function createParkedStop(meta, now = () => Date.now()) {
  return {
    async put(pending) {
      await meta.put(STOP_META, { at: Number(pending?.at) || now(), computer: String(pending?.computer ?? '').slice(0, 80) });
    },
    async unpark() {
      await meta.remove(STOP_META);
    },
    async take() {
      let kept = null;
      try {
        kept = await meta.get(STOP_META);
        if (kept !== undefined && kept !== null) await meta.remove(STOP_META);
      } catch {
        return null;
      }
      const age = kept && typeof kept.at === 'number' ? now() - kept.at : Infinity;
      return age >= 0 && age < STOP_RETRY_MS ? { at: kept.at, computer: typeof kept.computer === 'string' ? kept.computer : '' } : null;
    },
  };
}

// The name typed for this phone: control and bidirectional characters out, trimmed, 60 characters at most ('' when nothing is left).
export function cleanName(name) {
  return String(name ?? '').replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '').trim().slice(0, 60).trim();
}

// Takes the fragment out of the address bar. replaceState adds no history entry and does not fire hashchange.
export function clearAddressHash(env = globalThis) {
  try {
    const loc = env.location;
    if (!loc || !env.history?.replaceState) return;
    env.history.replaceState(null, '', `${loc.pathname}${loc.search}`);
  } catch { /* the address bar stays as it is */ }
}

// What this phone says about itself in the handshake. The app and the caps come from device.js, which boot.js uses too, so a LAN page is
// 'lan-web' with a picture for artifacts and no push in both places (it used to be found by a path here and by the origin in boot.js).
export function deviceFor(env = globalThis) {
  const native = isNative(env);
  const kind = appKindFor(env);
  return {
    device: { name: kind.name, platform: platformFor(env), app: kind.app, appVersion: APP_VERSION, uiHash: '' },
    caps: capsFor(env),
    native,
  };
}

// The HELLO the demo shows: the replay's own drive and approvals, so the lock line and the strips agree with the demo screens.
function demoHello(replayView) {
  const drive = replayView?.drive && replayView.drive.state === 'driving' ? replayView.drive : null;
  const waiting = (replayView?.approvals ?? []).filter(a => a.state === 'waiting').length;
  const running = (replayView?.runs ?? []).filter(r => r.state === 'running').length;
  return {
    desktopName: replayView?.computer?.name ?? 'Demo computer',
    desktopVersion: replayView?.computer?.desktopVersion || '1.4.2',
    protocol: LINK_VERSION,
    deviceId: 'demo',
    tier: 'full',
    caps: ['demo'],
    pending: {
      approvals: waiting,
      running, // the computer's name for the count (lib/remote/index.mjs pendingNow)
      driving: drive ? { app: drive.app, step: drive.step, of: drive.of } : null,
    },
    minShell: null,
  };
}

// Reads a channel response body as text (bounded: the settings answers are small).
async function readText(body, cap = 64 * 1024) {
  if (!body || typeof body.getReader !== 'function') return '';
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { reader.cancel?.().catch?.(() => {}); break; }
    chunks.push(value);
  }
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return utf8Read.decode(all);
}

// The service worker's registration for a push subscription: the one the page already has, or the one that becomes ready within a few
// seconds. Never waits forever (navigator.serviceWorker.ready does when nothing registered a worker).
export async function registrationOf(serviceWorker, { wait = SW_REGISTRATION_WAIT_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!serviceWorker) return null;
  try {
    const found = await serviceWorker.getRegistration?.();
    if (found) return found;
  } catch {
    // Fall through to ready.
  }
  if (!serviceWorker.ready) return null;
  let timer = null;
  const gave = new Promise(resolve => { timer = setTimer(() => resolve(null), wait); });
  try {
    return await Promise.race([Promise.resolve(serviceWorker.ready).catch(() => null), gave]);
  } finally {
    clearTimer(timer);
  }
}

// Registers sw.js for the PWA (F1): web pages in a secure context only, never the plain-http LAN page (no service worker there) and never a
// native app (it has no service worker, and its UI comes from the app). The worker serves the cached UI, shows pushes and runs the
// notification actions. The scope is the origin's root; the listener sends Service-Worker-Allowed for sw.js, and the relay serves it at /.
// A failure leaves the page working without it. Resolves the registration or null.
export async function registerServiceWorker(env = globalThis) {
  const sw = env.navigator?.serviceWorker;
  if (!sw || typeof sw.register !== 'function') return null;
  if (isNative(env) || env.isSecureContext !== true || isLanPage(env)) return null;
  try {
    return (await sw.register(new URL('sw.js', String(env.location?.href ?? 'https://localhost/')).href, { scope: '/' })) ?? null;
  } catch {
    return null;
  }
}

// Wave 5 (brb): two tabs of one browser on one computer. They share one device and one handshake counter (store.js serialises the counter
// within a page only), so only one tab holds the channel. Tabs talk over BroadcastChannel('plenum-tab'): before a tab connects by itself (at
// start, after an unlock) it asks whether another tab holds that computer and waits TAB_ASK_MS for an answer; a tab that holds it answers busy,
// and the asking tab shows "Plenum is open in another tab of this browser." with Use it here. Use it here (and any connect the person asks for)
// tells the other tab to let go: it closes its channel and shows "Plenum moved to another tab." with its own Use it here. A page without
// BroadcastChannel runs as before (both tabs connect). Messages carry a random tab id and the computer id, nothing else.
export const TAB_CHANNEL = 'plenum-tab';
export const TAB_ASK_MS = 300;
export function createTabGuard({ env = globalThis, BroadcastChannelCtor = env?.BroadcastChannel, tabId = null, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let bc = null;
  try { bc = typeof BroadcastChannelCtor === 'function' ? new BroadcastChannelCtor(TAB_CHANNEL) : null; } catch { bc = null; }
  if (!bc) return null;
  // Node's BroadcastChannel (a suite that starts the shell on its own global) keeps the process alive unless it is unref'd; browsers have no unref.
  try { bc.unref?.(); } catch { /* not Node */ }
  const self = tabId ?? (() => {
    try {
      const bytes = new Uint8Array(8);
      env.crypto.getRandomValues(bytes);
      return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return Math.random().toString(16).slice(2);
    }
  })();
  let held = null;           // the computer this tab holds the channel for
  let onTaken = () => {};
  const waiting = new Map(); // ask id -> resolve(true) when another tab answers busy
  let askSeq = 0;
  const post = msg => { try { bc.postMessage({ ...msg, tab: self }); } catch { /* closed */ } };
  bc.onmessage = event => {
    const m = event?.data;
    if (!m || typeof m !== 'object' || m.tab === self || typeof m.computer !== 'string') return;
    if (m.op === 'ask' && held === m.computer) post({ op: 'busy', to: m.tab, ask: m.ask, computer: m.computer });
    else if (m.op === 'busy' && m.to === self) waiting.get(m.ask)?.(true);
    else if (m.op === 'take' && held === m.computer) {
      held = null;
      try { onTaken(m.computer); } catch { /* the shell is gone */ }
    }
  };
  return {
    id: self,
    // Resolves true when another tab of this browser holds the computer now.
    ask(computer) {
      const ask = ++askSeq;
      return new Promise(resolve => {
        let timer = null;
        const done = value => {
          if (!waiting.has(ask)) return;
          waiting.delete(ask);
          if (timer !== null) clearTimer(timer);
          resolve(value);
        };
        waiting.set(ask, done);
        timer = setTimer(() => done(false), TAB_ASK_MS);
        timer?.unref?.();
        post({ op: 'ask', ask, computer: String(computer) });
      });
    },
    take(computer) { post({ op: 'take', computer: String(computer) }); },
    hold(computer) { held = computer ? String(computer) : null; },
    holding: () => held,
    onTaken(fn) { onTaken = typeof fn === 'function' ? fn : () => {}; },
    close() {
      held = null;
      for (const done of [...waiting.values()]) done(false);
      try { bc.close(); } catch { /* closed */ }
    },
  };
}

// Wave 5 (brb): the code page (/pair/, the listener serves the shell's files there without the same-network cookie). It registers no service
// worker, makes no UI host and connects nothing: it claims a code and goes to the link the computer answers with.
export function isClaimPage(env = globalThis) {
  return /^\/pair\/(index\.html)?$/.test(String(env?.location?.pathname ?? ''));
}

// Wave 5 (brb): keep this browser's keys when the browser runs short of space. Asked once, after the first pairing, on a secure page of a
// Chromium browser, where it is granted or refused without a prompt. Firefox asks the person, so it is not asked there. Resolves true when
// it was asked.
export async function persistStorage(env = globalThis) {
  if (isNative(env) || env?.isSecureContext !== true) return false;
  const storage = env?.navigator?.storage;
  if (typeof storage?.persist !== 'function') return false;
  const ua = String(env?.navigator?.userAgent ?? '');
  const brands = Array.isArray(env?.navigator?.userAgentData?.brands) ? env.navigator.userAgentData.brands.map(b => String(b?.brand ?? '')) : [];
  const chromium = brands.some(b => /chromium/i.test(b)) || (/\bChrome\//.test(ua) && !/\bFirefox\//.test(ua));
  if (!chromium || /\bFirefox\//.test(ua)) return false;
  try {
    if (typeof storage.persisted === 'function' && (await storage.persisted()) === true) return false;
    await storage.persist();
    return true;
  } catch {
    return false;
  }
}

// Wave 5 (brb): the shell's page on this computer for each paired computer whose way in is this page's own host (the code page's "Open
// Plenum"): '/p/<key>/' from a carrier URL ws(s)://<host>/b/<key> with host === location.host. Records with no such URL are left out.
export function pagesHere(records, host) {
  const out = [];
  for (const record of Array.isArray(records) ? records : []) {
    let path = null;
    for (const c of Array.isArray(record?.carriers) ? record.carriers : []) {
      for (const url of Array.isArray(c?.urls) ? c.urls : c?.url ? [c.url] : []) {
        try {
          const u = new URL(String(url));
          const m = /^\/b\/([0-9a-f]{32})$/.exec(u.pathname);
          if (m && (u.protocol === 'ws:' || u.protocol === 'wss:') && u.host === host) path = `/p/${m[1]}/`;
        } catch { /* not a URL */ }
        if (path) break;
      }
      if (path) break;
    }
    if (path) out.push({ id: String(record.id ?? ''), name: String(record.name ?? '') || 'your computer', path });
  }
  return out;
}

// A plugin-less secure storage for a phone whose plugins did not load: every call fails, so a key is never written anywhere else.
const NO_SECURE_STORAGE = Object.freeze({
  async getItem() { throw new Error('secure storage is not available'); },
  async setItem() { throw new Error('secure storage is not available'); },
  async removeItem() { throw new Error('secure storage is not available'); },
  async keys() { throw new Error('secure storage is not available'); },
});

// Builds the shell. Every input is injectable so the Node suites run the same flow on a fake worker and a fake clock.
export function createShell({
  store,
  lock = null,
  createWorker = defaultCreateWorker,
  device = { name: 'Test phone', platform: 'web', app: 'pwa', appVersion: '0.0.0', uiHash: '' },
  caps = ['ui-from-desktop'],
  pageUrl = null,
  mode = 'normal',
  debug = createDebugLog(),
  selftestFn = null, // the dev build loads ./selftest.js on first use; a release bundle never imports it
  stopClock = globalThis,
  onFatal = () => {},
  notifications = globalThis.Notification ?? null,
  serviceWorker = null,
  pushEnv = globalThis,
  clearHash = () => {},
  native = null,
  uiHost = null,
  pageKind = 'shell',
  stay = false,
  initialIntent = null,
  initialLink = null,
  onIntent = () => {},
  onReload = () => {},
  devBuild = DEV_BUILD,
  storage = 'ok',
  parkedStop = null,
  // w4-m1: { put(text) } where the "was updated" line waits for the UI page the shell page hands over to, and initialNote, the line that page
  // took out at start (runStart: sessionStorage, the line has no secret in it). Both optional.
  noteCarry = null,
  initialNote = null,
  // Wave 4 (m3): the app's SystemBars plugin on the shell page of the Android app (null elsewhere: the UI page's shim sets the bars there),
  // the page's prefers-color-scheme query (a MediaQueryList, or null), and { put(theme) }, which shows the chosen theme ('dark', 'light' or
  // null for Follow phone) and keeps a copy the shell page reads synchronously at its next start (earlyTheme). All optional.
  systemBars = null,
  colorScheme = null,
  themeCarry = null,
  // Wave 5 (brb): createTabGuard() (two tabs of one browser), null where there is none. claimPage: the code page at /pair/ (it connects nothing,
  // and its state carries the computers paired through this host). host: location.host, for that list. persist: persistStorage after the
  // first pairing (runStart passes the page's).
  tabGuard = null,
  claimPage = false,
  host = '',
  persist = null,
} = {}) {
  if (!store) throw new TypeError('createShell needs a store');
  let computers = [];
  let activeId = null;
  let channel = null;
  let channelState = { status: 'idle', carrier: null, desktopName: '', lastSeen: null, since: 0, nextRetryAt: null, failedRounds: 0, failure: null };
  let hello = null;
  let stopCtl = null;
  let stopView = { state: 'idle', ack: null, error: null, text: '', seq: 0 };
  // The toast the screens show: { seq, text, tone }. A new notice takes the next seq, so the same text can show again.
  let notice = null;
  let noticeSeq = 0;
  let stopSeq = 0;
  // A link the page was opened with while the app was locked (#pair=..., #stop, #deny=<id>, #approve=<id>): { text, at }. It runs once the app
  // unlocks; a parked Stop runs at once (it needs no unlock), and an approve or deny older than a minute is dropped.
  let pendingLink = null;
  // A pairing link from outside the app that waits for the person's Pair (the review screen). Closure only: the link holds the pairing secret,
  // so it is never in state().
  let pendingPair = null;
  // True once a #connect=<id> link asked the shell page to show that computer's UI even though the page was opened for its own screens (?shell).
  let forceUi = false;
  // The screen the shell page was asked to open (#settings, #computers): { screen, seq } or null. seq counts the requests.
  let screenRequest = null;
  let screenSeq = 0;
  let pairing = null;
  let pairingFlow = null;
  let lockStatus = { mode: 'off', locked: false, failures: 0, waitSec: 0 };
  // Whether a Stop can go out without unlocking: the computer a Stop would go to has a Stop key on this phone (plan C6d).
  let lockStop = { ready: false, computerName: '' };
  let lockedCtl = null;
  let lockedFor = null;   // the id of the computer lockedCtl sends to
  let selftest = null;
  let booted = false;
  // Resolves once boot has read the lock. A link that arrives while the app is starting waits for it, so a locked app never runs it early;
  // a lock that could not be read counts as locked.
  let lockKnown = () => {};
  const lockRead = new Promise(resolve => { lockKnown = resolve; });
  let lockUnreadable = false;
  let loaded = false;
  let started = false;
  let prefs = S.normalisePrefs(null);
  let pushKnown = null;
  let approveStored = false;
  let hiddenAt = null;
  // w4-m1: the id of the computer that asked for a Plenum update (status update-desktop). When the phone connects to it again, the shell says
  // updatedLine(name) once. Kept across channels: Try again opens a new one.
  let updateAskedBy = null;
  // Counts the pairings this page finished (from the link or the paste), so the screens start the onboarding once per pairing.
  let pairedSeq = 0;
  let pairedId = null;
  // The UI hand-over (ui-host.js): idle, loading, navigating (the page is leaving for the UI) or failed. w7: versions is
  // { app, desktop, update } when the failure is that the built-in screens are for another release (cause 'version').
  let ui = { state: 'idle', cause: null, progress: null, hasCopy: false };
  // w7: which screens this phone uses for its computer (ui-host.js uiSource): { kind: 'bundled' | 'computer', computerId, ... } or null.
  let uiSource = null;
  let loadedUiHash;
  let refreshingUi = false;
  // True from a finished pairing until the screens say the onboarding (app lock, notifications) is over: the page is not handed to the UI
  // in between, or the person would never see those two steps.
  let holdUi = false;
  let leaving = false;
  // A route a notification named (#waiting, #handover, #chat, #settings=limit, #home): the UI shows it. seq counts them; taken is true once shown.
  let intent = initialIntent && typeof initialIntent === 'object' ? { ...initialIntent, seq: 1, taken: false } : null;
  let intentSeq = intent ? 1 : 0;
  let dictationState = null;
  let androidPushState = null;
  // Wave 4 (m2): the time of the last notification this phone heard of, the one-time repaired line, the step a turn-on waits for when Plenum
  // comes back to the front ('no-distributor' after Get ntfy, 'denied' after the notification settings), the reason of the last turn-on,
  // and the outcome of the last turn-on for the screens ({ seq, ok, reason, auto, testSent }).
  let pushLastAt = null;
  let pushRepaired = false;
  let fixWaiting = null;
  let lastEnableReason = null;
  let notifySetup = null;
  let notifySeq = 0;
  let rechecking = false;
  // Wave 5 (brb): another tab of this browser holds this computer: { state: 'elsewhere' (it held it first) | 'moved' (it took it), computer }.
  let tab = null;
  // Wave 5 (brb): on the code page, the computers paired through this host ([{ id, name, path }]), read at boot.
  let claimHere = [];
  const replay = mode === 'demo' ? createReplay(demoSession) : null;
  const unlockedKeys = new Map();
  const subs = new Set();
  const wall = () => (typeof stopClock?.now === 'function' ? stopClock.now() : Date.now());
  const parked = parkedStop ?? createParkedStop(store.meta, wall);
  // B-120: when the Stop that is queued or sending was pressed, and for which computer. The UI page hands this over when it leaves.
  let stopPressedAt = null;
  let stopComputer = '';
  function notePress(id) {
    if (stopView.state === 'sending' || stopView.state === 'queued') return;
    stopPressedAt = wall();
    stopComputer = id ?? '';
  }
  const androidPush = native && device.platform === 'android' && native.UnifiedPush
    ? createAndroidPush({
      native,
      requestOf: () => channel?.request,
      vapidOf: () => (typeof hello?.vapidPublicKey === 'string' ? hello.vapidPublicKey : null),
      isVisible: () => pushEnv?.document?.visibilityState !== 'hidden',
      onLink: (link, computer) => { api.handleHash(link, computer).catch(() => {}); },
      pendingStore: {
        load: () => store.meta.get(UP_PENDING_META),
        save: body => store.meta.put(UP_PENDING_META, body),
        clear: () => store.meta.remove(UP_PENDING_META),
      },
      postedStore: {
        load: () => store.meta.get(UP_POSTED_META),
        save: record => store.meta.put(UP_POSTED_META, record),
      },
      seenStore: {
        load: () => store.meta.get(UP_SEEN_META),
        save: record => store.meta.put(UP_SEEN_META, record),
      },
      computerOf: () => activeId ?? '',
      // Plenum in front: a finished run, a failure, a limit or a list of things is the toast, not a system notification.
      onNotice: note => {
        say(note.text, note.tone);
        refresh();
      },
      isShowing: payload => cardShowing(payload),
      onReceived: at => {
        pushLastAt = at;
        store.meta.put(PUSH_LAST_META, at).catch(() => {});
        if (androidPushState) {
          androidPushState = { ...androidPushState, lastAt: at };
          refresh();
        }
      },
      // A renewal at start or at a HELLO posts later, when the push app answers: the status row is read again then.
      onState: () => {
        readAndroidPush().then(refresh, () => {});
      },
      log: line => debug.log(line, 'warn'),
    })
    : null;

  // The approval card a notification is about is on screen now (the UI page draws it with data-approval-id): no system notification then.
  function cardShowing(payload) {
    const doc = pushEnv?.document;
    const id = String(payload?.ids?.approval ?? '');
    if (!doc || doc.visibilityState === 'hidden' || typeof doc.querySelector !== 'function' || !/^[A-Za-z0-9_.-]{1,80}$/.test(id)) return false;
    try {
      const node = doc.querySelector(`[data-approval-id="${id}"]`);
      if (!node) return false;
      return typeof node.getClientRects !== 'function' || node.getClientRects().length > 0;
    } catch {
      return false;
    }
  }

  // The Android status the screens draw (push.js status() plus the last notification's time and the last turn-on's reason).
  async function readAndroidPush() {
    if (!androidPush) return;
    const st = await androidPush.status().catch(() => null);
    if (st) androidPushState = { ...st, lastAt: pushLastAt, lastReason: lastEnableReason };
  }

  // Takes a notification down after its Stop, Deny or Approve was handled: the one named by the route's &nt=<tag>. A route without one came
  // from a notification without a tag of its own (the plugin then uses the tag 'plenum'), so that one goes, and for a Deny or an Approve the
  // approval notification this phone heard of for that card on that computer. Nothing else: not a handover, not another computer's card.
  async function clearNotification(link, computer = '') {
    if (!androidPush || !link) return false;
    if (link.nt) return androidPush.clear({ tag: link.nt }).catch(() => false);
    const done = await androidPush.clear({ tag: 'plenum' }).catch(() => false);
    if ((link.kind === 'deny' || link.kind === 'approve') && link.id) {
      await androidPush.clearApprovals({ computer: computer || link.computer || activeId || '', approval: link.id }).catch(() => 0);
    }
    return done;
  }

  const view = () => ({
    mode,
    route: route(),
    page: pageKind,
    stay,
    locked: lockStatus.locked,
    lock: { ...lockStatus },
    computers: computers.map(c => ({ ...c })),
    activeId,
    connection: { ...channelState },
    hello: hello ? publicHello(hello) : null,
    stop: { ...stopView },
    lockStop: { ...lockStop },
    storage: storage === 'unavailable' ? 'unavailable' : 'ok',
    pairing: pairing ? { ...pairing, ...(pairing.review ? { review: { name: pairing.review.name, hosts: pairing.review.hosts.map(h => ({ ...h })), ...(pairing.review.form === 'browser' ? { form: 'browser' } : {}) } } : {}) } : null,
    selftest,
    debugLines: debug.lines().length,
    prefs: { ...prefs },
    pushKnown: pushKnown ? { ...pushKnown } : null,
    approveStored,
    device: { appVersion: APP_VERSION, protocol: LINK_VERSION, platform: device.platform, app: device.app },
    demo: replay ? replay.view() : null,
    paired: { seq: pairedSeq, id: pairedId },
    notice: notice ? { ...notice } : null,
    ui: { ...ui, kind: uiHost?.kind ?? null, source: uiSource ? { ...uiSource } : null },
    intent: intent ? { ...intent } : null,
    screenRequest: screenRequest ? { ...screenRequest } : null,
    dictation: dictationState ? { ...dictationState } : null,
    androidPush: androidPushState ? { ...androidPushState } : null,
    pushRepaired,
    notifySetup: notifySetup ? { ...notifySetup } : null,
    tab: tab ? { ...tab } : null,
    claim: claimPage ? { paired: claimHere.map(c => ({ ...c })) } : null,
  });

  let snapshot = view();
  const refresh = () => {
    if (replay) hello = demoHello(replay.view());
    snapshot = view();
    for (const fn of Array.from(subs)) {
      try { fn(snapshot); } catch { /* a screen error must not stop the others */ }
    }
    leaveForShellIfNeeded();
    return snapshot;
  };

  function say(text, tone = 'info') {
    noticeSeq += 1;
    notice = { seq: noticeSeq, text: String(text ?? ''), tone };
  }

  function route() {
    if (mode === 'demo') return 'demo';
    if (lockStatus.locked) return 'locked';
    if (pairing && !['allowed', 'denied', 'expired', 'mismatch', 'failed'].includes(pairing.state)) return 'code';
    if (mode === 'selftest') return 'selftest';
    if (!computers.length) return 'welcome';
    if (computers.length > 1 && !channel) return 'computers';
    return channel ? 'connected' : 'computers';
  }

  // The hello without anything a screen should not show: the protocol, the phone's own id and tier, and the computer's name, plus what is running.
  function publicHello(h) {
    return {
      desktopName: String(h.desktopName ?? ''),
      desktopVersion: String(h.desktopVersion ?? ''),
      protocol: h.protocol ?? null,
      deviceId: typeof h.deviceId === 'string' ? h.deviceId : '',
      tier: h.tier ?? null,
      caps: Array.isArray(h.caps) ? [...h.caps] : [],
      pending: h.pending ?? null,
      minShell: h.minShell ?? null,
    };
  }

  async function loadComputers() {
    try {
      const list = await store.publicList();
      computers = list.map(c => ({ ...c }));
      // A phone paired before the Stop cards existed gets them now (store.js createStopCards).
      store.syncStopCards?.().catch(() => {});
    } finally {
      // Also when the store cannot be read: the lock screen's Stop may then come from a Stop card.
      await refreshLockStop();
    }
  }

  // The computer a Stop sent from the lock screen would go to: the active one, else the saved active one, else the only one. It works while
  // `computers` is still empty (a cold start from a notification arrives before loadComputers). Resolves the stored record or null.
  // When the store cannot be read, the Stop card stands in for the record (store.js createStopCards): it holds the Stop key, this phone's
  // id and the ways, which is all a Stop without unlocking sends, so the floor's "Stop from the phone always works" holds then too.
  async function lockStopTarget() {
    let id = activeId;
    if (!id) id = await store.meta.get(ACTIVE_META).catch(() => null);
    try {
      let record = id ? await store.get(id) : null;
      if (!record) {
        const list = await store.publicList();
        if (list.length === 1) record = await store.get(list[0].id);
      }
      return record ?? null;
    } catch (err) {
      const cards = store.stopCards?.read() ?? [];
      const card = (id ? cards.find(c => c.id === id) : null) ?? (cards.length === 1 ? cards[0] : null);
      if (card) return card;
      throw err;
    }
  }

  async function refreshLockStop() {
    let next = { ready: false, computerName: '' };
    try {
      const target = await lockStopTarget();
      if (target) next = { ready: publicComputer(target)?.stopReady === true, computerName: String(target.name ?? '') };
    } catch {
      // Not ready: the Stop then waits for the unlock.
    }
    lockStop = next;
  }

  function keyedRecord(record) {
    if (typeof record.myPriv === 'string') return record;
    const key = unlockedKeys.get(record.id);
    if (!key) return null;
    return { ...record, myPriv: bytesToB64u(key) };
  }

  function applyStopView(v) {
    const changed = v.state !== stopView.state;
    // The sequence moves when a Stop reaches a result (done, queued or failed): the toast and the sheet show once for each result.
    const seq = changed && STOP_NOTICE.has(v.state) ? ++stopSeq : stopView.seq;
    stopView = { ...v, seq };
    if (changed && v.state === 'done') say(v.text, 'ok');
    if (changed && v.state === 'queued') say(v.text, 'warn');
    refresh();
  }

  // B-119: a Stop still queued or sending on the channel being left keeps its controller, so its result (done or failed) still reaches the
  // sheet and the toast; the new controller's first view (idle) must not replace that pending Stop. A controller that is no longer the
  // current one reports only the result of its own press and the idle that follows it, not its progress.
  let stopOwner = null;
  function bindStop(ch, name) {
    const busy = stopCtl?.state === 'sending' || stopCtl?.state === 'queued';
    if (!busy) stopCtl?.dispose();
    const ctl = createStopController({ channel: ch, clock: stopClock, computerName: name });
    stopCtl = ctl;
    let first = true;
    ctl.subscribe(view => {
      if (first) {
        first = false;
        if (busy) return;
      }
      if (stopCtl !== ctl && view.state !== 'done' && view.state !== 'failed' && !(view.state === 'idle' && stopOwner === ctl)) return;
      if (view.state === 'done' || view.state === 'failed') stopOwner = ctl;
      applyStopView(view);
    });
  }

  // Stop while the app is locked (or its lock could not be read): when this phone holds the computer's Stop key, one signed STOP_ONLY goes out on
  // its own worker (channel.js sendLockedStop) and the result shows as for a live Stop. Otherwise the Stop waits for the unlock.
  // computerId (B-117) names the computer a notification came from; '' is the one a Stop would go to anyway (lockStopTarget).
  async function lockedStop(project, computerId = '') {
    if (lockedCtl && (stopView.state === 'sending' || stopView.state === 'queued') && (!computerId || computerId === lockedFor)) return lockedCtl.press(project);
    // A store that cannot be read is stood in for by the computer's Stop card, as in lockStopTarget.
    const target = computerId
      ? await store.get(computerId).catch(() => store.stopCards?.get(computerId) ?? null)
      : await lockStopTarget().catch(() => null);
    if (computerId && !target) {
      say(UNKNOWN_COMPUTER_STOP, 'warn');
      refresh();
      return { ...stopView, state: 'idle', reason: 'unknown-computer' };
    }
    if (!target || publicComputer(target)?.stopReady !== true) {
      // B-130: with the lock settings unreadable nothing can unlock, so the Stop does not wait for an unlock that cannot come.
      if (lockUnreadable) {
        say(STOP_NO_KEY, 'warn');
        refresh();
        return { ...stopView, state: 'idle', reason: 'no-key' };
      }
      say(STOP_NEEDS_UNLOCK, 'warn');
      pendingLink = { text: '#stop', at: wall(), ...(computerId ? { computer: computerId } : {}) };
      refresh();
      return { ...stopView, state: 'idle', reason: 'needs-unlock' };
    }
    lockedFor = target.id;
    const listeners = new Set();
    const viaLockedWorker = {
      stop: () => sendLockedStop({ record: target, store, createWorker, onStopState: view => { for (const fn of Array.from(listeners)) fn(view); } }),
      onStopState: fn => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
    lockedCtl?.dispose();
    lockedCtl = createStopController({ channel: viaLockedWorker, clock: stopClock, computerName: String(target.name ?? '') });
    lockedCtl.subscribe(applyStopView);
    notePress(target.id);
    const out = await lockedCtl.press(project);
    refresh();
    return out;
  }

  // B-117: a notification answer for a computer that is not the open one. The open computer keeps its channel when it can: a Stop goes out as
  // a signed STOP_ONLY when this phone holds the named computer's Stop key; otherwise (and for Deny and Approve) that computer is opened. On
  // the UI page, whose UI belongs to one computer, the link goes to the shell page, which opens it (the same rule as connect()).
  async function openComputerFor(id, link) {
    if (pageKind === 'ui' && uiHost) {
      const uiFor = await uiComputerOf();
      if (uiFor !== 'any' && uiFor !== id) {
        leaving = true;
        const done = await uiHost.openShell(link).catch(() => false);
        if (!done) leaving = false;
        return done ? { ok: true, reason: null, opening: true } : { ok: false, reason: 'unavailable' };
      }
    }
    const opened = await connectNow(id, { take: true });
    refresh();
    return opened;
  }

  async function stopOn(id, project = null) {
    const record = await store.get(id).catch(() => null);
    if (!record) {
      say(UNKNOWN_COMPUTER_STOP, 'warn');
      refresh();
      return { ...stopView, state: 'idle', reason: 'unknown-computer' };
    }
    if (publicComputer(record)?.stopReady === true) return lockedStop(project, id);
    const opened = await openComputerFor(id, `#stop&computer=${id}`);
    if (opened.opening) return { ...stopView, state: 'idle', reason: 'opening' };
    if (!opened.ok) {
      say('Could not open that computer to stop it. Press Stop on that computer.', 'warn');
      refresh();
      return { ...stopView, state: 'idle', reason: opened.reason ?? 'failed' };
    }
    return api.stop(project);
  }

  function attachChannel(ch, name) {
    channel = ch;
    bindStop(ch, name);
    // B-119: only the channel in use feeds the shell's state. A retired channel (kept open for a queued Stop) must not overwrite the live
    // connection, the HELLO or the events of the computer the phone has moved to.
    const live = () => channel === ch;
    ch.onState(s => {
      if (!live()) return;
      channelState = { ...s };
      if (s.status !== 'connected') {
        hello = null;
      }
      // w4-m1: the computer was updated while the phone waited on "Update Plenum on your computer": say so once it connects.
      if (s.status === 'update-desktop') updateAskedBy = ch.id ?? activeId;
      else if (s.status === 'connected' && updateAskedBy && updateAskedBy === (ch.id ?? activeId)) {
        updateAskedBy = null;
        const line = updatedLine(s.desktopName || name);
        say(line, 'ok');
        try { noteCarry?.put(line); } catch { /* the UI page then does not repeat it */ }
      }
      refresh();
    });
    ch.onEvent(event => {
      if (!live()) return;
      if (event && event.type === 'phone' && event.kind === 'revoked') refresh();
      // B-125: a tier the computer lowered (or raised) while the phone is connected changes what the HELLO said, caps included, so a later
      // snapshot does not bring the old controls back.
      if (event && event.type === 'phone' && event.kind === 'tier' && hello && typeof event.tier === 'string' && (!hello.deviceId || event.id === hello.deviceId)) {
        hello = { ...hello, tier: event.tier, ...(Array.isArray(event.caps) ? { caps: event.caps.filter(c => typeof c === 'string') } : {}) };
        refresh();
      }
    });
    ch.onHello(h => {
      if (!live()) return;
      hello = h;
      refresh();
      sendPresence();
      syncPush(h).catch(() => {});
      retryApproveOff();
      // A Stop key the computer just gave this phone (HELLO stopKeyNew) is in the store by now: the lock screen can send Stop without the unlock.
      // The ways the HELLO listed (B-122) are in the record too: the list is read again, so the Ways screen shows them.
      (Array.isArray(h?.carriers) ? loadComputers() : refreshLockStop()).then(refresh).catch(() => {});
      afterHello();
    });
    refresh();
  }

  // Retires a channel. A Stop still queued or sending keeps its worker for the retry window, so the Stop is not dropped by a lock,
  // a Cancel, a Forget or a switch to another computer.
  function retireChannel(ch) {
    if (!ch) return;
    if (stopView.state === 'queued' || stopView.state === 'sending') {
      stopClock.setTimeout(() => ch.close(), STOP_RETRY_MS + 1000);
      return;
    }
    ch.close();
  }

  // Reads the computer's notification switches once a computer says hello. POST /api/phones/push with no change answers them.
  // Resolves the answer ({ ok, json, ... }) or null.
  async function loadPush() {
    if (replay || !channel) return null;
    const out = await postJson('/api/phones/push', {});
    if (out.ok && out.json?.push && typeof out.json.push === 'object') {
      pushKnown = { ...out.json.push };
      refresh();
    }
    return out;
  }

  // At every HELLO (wave 4, m2): an Android endpoint the computer did not get goes first (B-129), then the switches are read. The answer says
  // whether the computer holds this phone's subscription (subscribed, and endpoint: the first 16 hex of its sha256). When this phone takes
  // notifications to be on and the computer has lost them (or holds another endpoint), they are sent again quietly and Phone settings says so
  // once; otherwise the push app hands the endpoint again (renew), so a key set the computer lost comes back without a word. With no approval
  // waiting, the approval notifications still showing are taken down.
  async function syncPush(h) {
    if (replay) return;
    const ch = channel;
    if (androidPush) await androidPush.resend().catch(() => null);
    const out = await loadPush();
    // A channel that changed meanwhile has its own HELLO, which runs this again.
    if (!channel || channel !== ch) return;
    const json = out?.ok ? out.json : null;
    const subscribed = typeof json?.subscribed === 'boolean' ? json.subscribed : typeof json?.push?.subscribed === 'boolean' ? json.push.subscribed : null;
    const held = typeof json?.endpoint === 'string' && /^[0-9a-f]{16}$/.test(json.endpoint) ? json.endpoint : null;
    if (androidPush) {
      await checkAndroidPush(subscribed, held).catch(() => {});
      // Nothing waits on this computer: its approval notifications go (only those: a handover, a needs list or another computer's card stays).
      if (h?.pending && h.pending.approvals === 0) await androidPush.clearApprovals({ computer: activeId ?? '' }).catch(() => 0);
      await readAndroidPush();
      refresh();
    } else if (subscribed === false) {
      await repostWebPush().catch(() => {});
    }
  }

  async function checkAndroidPush(subscribed, held) {
    if (!(await androidPush.believedOn())) return;
    const mine = held ? await androidPush.endpointHash() : null;
    if (subscribed === false || (held && mine && held !== mine)) {
      const fixed = await androidPush.repair();
      if (fixed.ok) await notePushRepaired(fixed.hash ?? null);
      else debug.log(`push: repair ${fixed.reason ?? 'failed'}`, 'warn');
      return;
    }
    if (subscribed === true && held) await androidPush.adopt(held);
    await androidPush.renew();
  }

  // Web: the computer lost the subscription this browser made for it (its record kept the endpoint). The computer drops one mostly when the
  // push service called the address gone, so sending the same one back would only be dropped again: the browser's subscription is replaced
  // by a fresh one (no prompt: the permission is already granted) and that one goes to the computer. A subscription that belongs to another
  // computer (B-128) is never touched. When the fresh one cannot be made or sent, the record says so (pushLost) and the next HELLO tries again.
  async function repostWebPush() {
    const key = typeof hello?.vapidPublicKey === 'string' ? hello.vapidPublicKey : null;
    if (!activeId || !channel || !key || notifications?.permission !== 'granted' || !serviceWorker) return;
    const forId = activeId;
    const record = await store.get(forId).catch(() => null);
    const endpoint = typeof record?.pushEndpoint === 'string' ? record.pushEndpoint : '';
    if (!endpoint && record?.pushLost !== true) return;
    const registration = await registrationOf(serviceWorker).catch(() => null);
    if (!registration?.pushManager) return;
    const held = await Promise.resolve(registration.pushManager.getSubscription?.()).catch(() => null);
    if (held) {
      if (!endpoint || held.endpoint !== endpoint) return;
      const gone = await Promise.resolve(held.unsubscribe?.()).catch(() => false);
      if (gone !== true) return;
    }
    await store.patchComputer(forId, { pushEndpoint: null, pushLost: true }).catch(() => {});
    const out = await subscribeWebPush({
      registration,
      applicationServerKey: key,
      request: channel.request,
      deviceId: typeof hello?.deviceId === 'string' && hello.deviceId ? hello.deviceId : forId,
      notification: notifications,
      env: pushEnv,
    });
    if (out.ok && out.endpoint) {
      await store.patchComputer(forId, { pushEndpoint: out.endpoint, pushLost: null }).catch(() => {});
      await notePushRepaired(await endpointHash(out.endpoint), forId);
      return;
    }
    // Another computer took the browser's one subscription meanwhile, or notifications were blocked: nothing to try again.
    if (out.state !== 'failed') await store.patchComputer(forId, { pushLost: null }).catch(() => {});
    debug.log(`push: could not make a new subscription (${out.state})`, 'warn');
  }

  // A repair went through. The one-time line shows only when it sent something that may work: a computer that dropped this same address
  // again within a day of the last repair is not reported as fixed again (it is noted in the debug log instead).
  async function notePushRepaired(hash = null, forId = activeId ?? '') {
    const key = String(forId ?? '');
    const kept = await store.meta.get(PUSH_REPAIRS_META).catch(() => null);
    const repairs = kept && typeof kept === 'object' && !Array.isArray(kept) ? { ...kept } : {};
    const last = repairs[key];
    const again = Boolean(hash) && last?.hash === hash && wall() - (Number(last.at) || 0) < REPAIR_SAME_MS;
    repairs[key] = { hash: hash ?? null, at: wall() };
    await store.meta.put(PUSH_REPAIRS_META, repairs).catch(() => {});
    if (again) {
      debug.log('push: the computer dropped this phone\'s notifications again; the same address went again', 'warn');
      return;
    }
    pushRepaired = true;
    debug.log('push: the computer had lost this phone\'s notifications; sent again', 'info');
    await store.meta.put(PUSH_REPAIRED_META, true).catch(() => {});
    refresh();
  }

  // The phone's copy of the Approve-from-notifications switch (the computer keeps the real one; a demo changes nothing on disk).
  async function keepApprove(on) {
    approveStored = on === true;
    if (!replay) await store.meta.put(APPROVE_META, approveStored).catch(() => {});
  }

  // Runs the link the page was opened with, once the app is unlocked: a pairing link or a notification link. A Stop parked while locked runs at once
  // (through stop(), which parks it again when this phone cannot send it without the unlock); every other link stays parked until the unlock.
  async function runPendingLink() {
    const link = pendingLink;
    if (!link) return null;
    const parsed = parseNotificationHash(link.text);
    if (lockStatus.locked || lockUnreadable) {
      if (parsed?.kind !== 'stop') return null;
      pendingLink = null;
      return api.stop(null, link.computer ?? parsed.computer ?? '');
    }
    pendingLink = null;
    // An approval or a denial that waited behind the lock for more than a minute is not sent: the person answers it from the open card.
    if ((parsed?.kind === 'approve' || parsed?.kind === 'deny') && wall() - link.at > NOTIFICATION_LINK_MAX_AGE_MS) {
      say(NOTIFICATION_OLD, 'warn');
      emitRoute({ kind: 'waiting', id: parsed.id });
      await clearNotification(parsed, link.computer ?? parsed.computer ?? '');
      return { ok: false, reason: 'expired', kind: parsed.kind };
    }
    // Wave 8: the same for the Yes or No of a business's yes/no item (answer.js): an old one is not sent, and Today is opened instead.
    if (isAnswerLink(parsed) && wall() - link.at > NOTIFICATION_LINK_MAX_AGE_MS) {
      say(ANSWER_TEXT.old, 'warn');
      emitRoute({ kind: 'today' });
      await clearNotification(parsed, link.computer ?? parsed.computer ?? '');
      return { ok: false, reason: 'expired', kind: parsed.kind };
    }
    return api.handleHash(link.text, link.computer ?? '');
  }

  // Approve-from-notifications was on when the lock went off but the computer was not told (offline, or it refused): the opt-out is sent at the next HELLO.
  async function retryApproveOff() {
    if (replay) return;
    const waiting = await store.meta.get(APPROVE_OFF_META).catch(() => null);
    if (waiting !== true) return;
    const out = await postJson('/api/phones/push', { approveFromNotifications: false });
    if (!out.ok) return;
    await keepApprove(false);
    await store.meta.remove(APPROVE_OFF_META).catch(() => {});
    refresh();
  }

  // B-119 (and B-127): a connect that is still reading the store when another starts, or when the person cancels, locks or forgets, is superseded
  // and opens nothing, so two overlapping connects never leave a worker nobody closes.
  let connectSeq = 0;
  // take (wave 5, brb): the person asked for this computer here (Use it here, a computer chosen, Try again, Stop), so another tab of this
  // browser that holds it lets go. Without it (a connect the shell makes by itself) the tab asks first and stays out when another holds it.
  async function connectNow(id, { take = false } = {}) {
    const seq = ++connectSeq;
    const record = await store.get(id);
    if (!record) return { ok: false, reason: 'unknown' };
    const keyed = keyedRecord(record);
    if (!keyed) return { ok: false, reason: 'locked' };
    if (tabGuard && !take && tabGuard.holding() !== id && await tabGuard.ask(id)) {
      if (seq !== connectSeq) return { ok: false, reason: 'superseded' };
      if (channel) {
        retireChannel(channel);
        channel = null;
      }
      hello = null;
      activeId = id;
      tab = { state: 'elsewhere', computer: id };
      channelState = { ...channelState, status: 'closed', desktopName: String(keyed.name ?? '') };
      refresh();
      return { ok: false, reason: 'other-tab' };
    }
    if (seq !== connectSeq) return { ok: false, reason: 'superseded' };
    if (tabGuard) {
      if (take) tabGuard.take(id);
      tabGuard.hold(id);
    }
    tab = null;
    if (channel) {
      retireChannel(channel);
      channel = null;
    }
    hello = null;
    activeId = id;
    await store.meta.put(ACTIVE_META, id).catch(() => {});
    await refreshLockStop();
    if (seq !== connectSeq) return { ok: false, reason: 'superseded' };
    const ch = openChannel({
      computer: keyed,
      store,
      device,
      caps,
      createWorker,
      onWorkerError: line => debug.log(`channel: ${line}`, 'warn'),
    });
    attachChannel(ch, keyed.name);
    return { ok: true, id };
  }

  // A JSON request to the computer over the channel (the phone's own settings routes). Resolves with { ok, status, json, reason }.
  async function postJson(path, body, headers = {}) {
    if (!channel) return { ok: false, status: 0, json: null, reason: 'offline' };
    try {
      const res = await channel.request({ method: 'POST', path, headers: { 'content-type': 'application/json', ...headers } }, JSON.stringify(body ?? {}), { scope: 'shell' });
      const text = await readText(res.body);
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      const ok = res.status >= 200 && res.status < 300;
      return { ok, status: res.status, json, reason: ok ? null : (json?.error ?? 'failed') };
    } catch (err) {
      return { ok: false, status: 0, json: null, reason: String(err?.code ?? 'offline') };
    }
  }

  // channel.request as the shell's own call: the worker lets a shell-scope request reach /_bridge/log.
  const shellRequest = ch => (spec, body, opts) => ch.request(spec, body, { ...(opts ?? {}), scope: 'shell' });

  // Wave 5 (brb): tells the computer whether this page is in front (POST /_bridge/presence { visible }, shell scope). A hidden tab that keeps
  // polling then still gets its notifications (the computer skips a device it takes to be in front). Sent at every HELLO and on every
  // visibility change; an older computer without the path answers 404, and every error is ignored.
  function pageVisible() {
    return pushEnv?.document?.visibilityState !== 'hidden';
  }
  function sendPresence(visible = pageVisible()) {
    const ch = channel;
    if (!ch || replay || typeof ch.request !== 'function') return;
    try {
      Promise.resolve(ch.request({ method: 'POST', path: '/_bridge/presence', headers: { 'content-type': 'application/json' } }, JSON.stringify({ visible: visible === true }), { scope: 'shell' }))
        .then(answer => answer?.cancel?.(), () => {});
    } catch { /* not sent */ }
  }

  // Resolves true once the computer has said hello (or at once if it has), false when there is no channel or it does not come within ms.
  // A notification link that opens the app cold arrives before the channel is up: Deny and Approve wait a moment for it, they do not fail.
  function whenConnected(ms = 8000) {
    if (!channel) return Promise.resolve(false);
    if (hello) return Promise.resolve(true);
    return new Promise(resolve => {
      let timer = null;
      let off = () => {};
      const done = value => {
        if (timer !== null) stopClock.clearTimeout(timer);
        off();
        resolve(value);
      };
      timer = stopClock.setTimeout(() => done(false), ms);
      off = api.subscribe(() => {
        if (hello) done(true);
        else if (!channel) done(false);
      });
    });
  }

  async function savePrefs(next) {
    prefs = S.normalisePrefs(next);
    await store.meta.put(PREFS_META, prefs).catch(() => {});
    applyTheme();
    return refresh();
  }

  // Wave 4 (m3): the theme as the page draws it (Plenum's own Theme setting, else the phone's), for the status bar and the next start.
  function themeNow() {
    if (prefs.theme === 'dark' || prefs.theme === 'light') return prefs.theme;
    return colorScheme?.matches === true ? 'dark' : 'light';
  }

  // Capacitor's SystemBars follows the phone's theme, not Plenum's, so Dark in Plenum on a light phone drew dark icons on the dark page. The
  // style names the bars' background: DARK gives light icons (SystemBars.java: setAppearanceLightStatusBars(!style.equals("DARK"))). Set
  // once per change; a phone without the plugin is left as it is.
  let appliedBars = null;
  function applyBars() {
    if (typeof systemBars?.setStyle !== 'function') return;
    const style = themeNow() === 'dark' ? 'DARK' : 'LIGHT';
    if (style === appliedBars) return;
    appliedBars = style;
    try {
      Promise.resolve(systemBars.setStyle({ style })).catch(() => { if (appliedBars === style) appliedBars = null; });
    } catch {
      appliedBars = null;
    }
  }

  // The status bar, and the chosen theme where the shell page reads it before its first paint at the next start (earlyTheme).
  function applyTheme() {
    applyBars();
    try {
      themeCarry?.put(prefs.theme === 'dark' || prefs.theme === 'light' ? prefs.theme : null);
    } catch { /* not kept: the next start follows the phone until the preferences are read */ }
  }
  if (typeof colorScheme?.addEventListener === 'function') colorScheme.addEventListener('change', () => applyBars());
  else if (typeof colorScheme?.addListener === 'function') colorScheme.addListener(() => applyBars());

  // "Hide content in the app switcher" controls the Recents thumbnail on Android 13+ through the PlenumPrivacy plugin. The
  // setting is also kept natively, so the flag is on from the first frame; this keeps the two in step with the phone's preference. The
  // web page keeps its CSS cover (screens/main.js).
  let appliedHide = null;
  async function applyPrivacy() {
    if (device.platform !== 'android' || !native?.PlenumPrivacy?.setHideInSwitcher) return;
    const enabled = prefs.hideSwitcher !== false;
    if (appliedHide === enabled) return;
    try {
      await native.PlenumPrivacy.setHideInSwitcher({ enabled });
      appliedHide = enabled;
    } catch (err) {
      debug.log(`privacy: ${err?.code ?? 'failed'}`, 'warn');
    }
  }

  // L18: what the phone's dictation can do, for the settings screen. Only the native apps have the plugin.
  async function loadDictation() {
    if (!native?.Dictation?.available) return;
    try {
      const out = await native.Dictation.available();
      dictationState = { available: out?.available === true, onDevice: out?.onDevice === true, permission: String(out?.permission ?? 'prompt') };
    } catch {
      dictationState = { available: false, onDevice: false, permission: 'prompt' };
    }
    refresh();
  }

  async function loadAndroidPush() {
    if (!androidPush) return;
    await androidPush.start();
    const last = await store.meta.get(PUSH_LAST_META).catch(() => null);
    pushLastAt = Number.isFinite(last) && last > 0 ? last : null;
    pushRepaired = (await store.meta.get(PUSH_REPAIRED_META).catch(() => null)) === true;
    await readAndroidPush();
    refresh();
    // Wave 4 (m2): at every start the push app hands the endpoint and its key set again while this listener is attached (the HELLO sends it).
    if (mode === 'normal') await androidPush.renew().catch(() => false);
  }

  // Turn on, for the screens and for the re-check when Plenum comes back to the front. On success the test notification is sent and the
  // toast says it is on its way. The outcome is kept for the screens in state().notifySetup.
  async function turnOnNotifications({ auto = false } = {}) {
    const out = await api.enableNow();
    let testSent = false;
    if (out.ok && !replay) {
      const sent = await postJson('/api/phones/test-push', {});
      testSent = sent.ok;
      if (testSent) say(NOTIFY_TEST_ON_WAY, 'ok');
    }
    lastEnableReason = out.ok ? null : out.reason;
    if (androidPush) {
      fixWaiting = !out.ok && (out.reason === 'no-distributor' || out.reason === 'denied') ? out.reason : null;
      await readAndroidPush();
    }
    notifySeq += 1;
    notifySetup = { seq: notifySeq, ok: out.ok, reason: out.ok ? null : out.reason, auto, testSent };
    refresh();
    return out;
  }

  // Back in front after "Get ntfy" or "Open notification settings": when the missing piece is there now, notifications are turned on again
  // without another tap. Nothing happens while it is still missing.
  async function recheckNotifications() {
    if (!androidPush || !fixWaiting || rechecking || lockStatus.locked) return;
    rechecking = true;
    try {
      const ready = fixWaiting === 'no-distributor' ? await androidPush.hasDistributor() : await androidPush.permitted();
      if (!ready) {
        await readAndroidPush();
        refresh();
        return;
      }
      fixWaiting = null;
      await turnOnNotifications({ auto: true });
    } finally {
      rechecking = false;
    }
  }

  // ----- the UI hand-over (H3) -----

  function afterHello() {
    if (!uiHost || replay || mode !== 'normal') return;
    if (pageKind === 'ui') {
      // w7: an Android UI page (the built-in screens, or an older copy) moves to the computer's newer copy only when nothing is running there
      // (ui-host.js refreshStaged).
      refreshUi({ reason: 'hello', mayMove: uiMayMove(hello, stopCtl?.state ?? 'idle') });
      return;
    }
    if (lockStatus.locked || holdUi) return;
    // A #connect=<id> link asks for that computer's UI even on a page opened for the shell's own screens (?shell).
    if (forceUi) {
      forceUi = false;
      showUi({ force: true });
      return;
    }
    if (stay) return;
    showUi();
  }

  async function showUi({ force = false } = {}) {
    if (!uiHost || pageKind !== 'shell' || !hello || replay) return { ok: false, reason: 'unavailable' };
    if (ui.state === 'loading' || ui.state === 'navigating') return { ok: true, reason: null };
    if (stay && !force) return { ok: false, reason: 'stay' };
    ui = { state: 'loading', cause: null, progress: { done: 0, total: 1 }, hasCopy: false };
    refresh();
    const out = await uiHost.show({
      hello,
      computerId: activeId,
      loadedHash: null,
      onProgress: progress => { ui = { ...ui, progress }; refresh(); },
    });
    if (out.ok) {
      ui = { ...ui, state: 'navigating', progress: { done: 1, total: 1 } };
    } else {
      ui = {
        state: 'failed',
        cause: out.cause ?? 'checksum',
        progress: null,
        hasCopy: await uiHost.hasCopy().catch(() => false),
        versions: out.versions && typeof out.versions === 'object' ? { app: out.versions.app ?? null, desktop: out.versions.desktop ?? null, update: out.versions.update ?? null } : null,
      };
    }
    refresh();
    loadUiSource();
    return { ok: out.ok, reason: out.ok ? null : out.cause };
  }

  // w7: reads which screens the phone uses for its computer (Phone settings and About show it). A host without uiSource has none.
  function loadUiSource() {
    if (typeof uiHost?.uiSource !== 'function') return;
    Promise.resolve(uiHost.uiSource()).then(source => {
      uiSource = source && typeof source === 'object' ? { ...source } : null;
      refresh();
    }, () => {});
  }

  // On the UI page: the HELLO says whether the computer has a newer UI. The page reloads once per new UI (ui-loader shouldReload).
  // w7: reason 'hello' or 'resume', and mayMove (uiMayMove), for the page on the app's built-in screens (ui-host.js refresh).
  async function refreshUi({ reason = 'hello', mayMove = false } = {}) {
    if (!uiHost || refreshingUi) return;
    refreshingUi = true;
    try {
      if (loadedUiHash === undefined) loadedUiHash = await uiHost.loadedHash();
      const out = await uiHost.refresh({ hello, loadedHash: loadedUiHash, computerId: activeId, reason, mayMove: mayMove === true });
      if (out.ok && out.reload) onReload();
    } finally {
      refreshingUi = false;
    }
  }

  // Which computer the UI on this page came from: its id, null when unknown, 'any' where the page cannot tell (the LAN page, the iPhone's copy).
  async function uiComputerOf() {
    return typeof uiHost?.uiComputerId === 'function' ? uiHost.uiComputerId() : 'any';
  }

  // The UI page has nothing to show for these states, so the shell's screens take over: no computer paired (forgotten, or this phone was
  // removed), a computer that revoked this phone, or an update that must come first. The lock is not one of them: boot.js draws its own.
  function leaveForShellIfNeeded() {
    if (pageKind !== 'ui' || !uiHost || leaving || !loaded || mode !== 'normal') return;
    const status = channelState.status;
    const needs = computers.length === 0 || ['revoked', 'not-known', 'update-app', 'update-desktop'].includes(status);
    if (!needs) return;
    leaving = true;
    Promise.resolve(uiHost.openShell()).catch(() => { leaving = false; });
  }

  function emitRoute(link) {
    intentSeq += 1;
    intent = { ...link, seq: intentSeq, taken: false };
    if (pageKind === 'shell') onIntent({ ...link });
    refresh();
  }

  // Wave 5 (brb): another tab of this browser took this computer (its Use it here): this tab lets go of its channel and says where it went.
  tabGuard?.onTaken(computer => {
    if (computer !== activeId) return;
    connectSeq += 1;
    if (channel) {
      retireChannel(channel);
      channel = null;
    }
    hello = null;
    tab = { state: 'moved', computer };
    channelState = { ...channelState, status: 'closed' };
    refresh();
  });

  // w4-m1: the "was updated" line the shell page said just before it handed this page the UI.
  if (typeof initialNote === 'string' && UPDATED_LINE_PATTERN.test(initialNote)) say(initialNote, 'ok');

  const api = {
    state: () => snapshot,
    subscribe(fn) {
      subs.add(fn);
      try { fn(snapshot); } catch { /* listener error */ }
      return () => subs.delete(fn);
    },
    get channel() { return channel; },
    debug,

    // Launch: reads the lock, the saved computers, the saved active computer and the phone's own preferences. Idempotent.
    async boot() {
      if (booted) return snapshot;
      booted = true;
      prefs = S.normalisePrefs(await store.meta.get(PREFS_META).catch(() => null));
      applyTheme();
      approveStored = (await store.meta.get(APPROVE_META).catch(() => null)) === true;
      try {
        if (lock) {
          // Wave 4 (m3): a page of this app unlocked within the person's lock time (one minute for page switches when it is Immediately; a
          // real return from the background still locks at once, visibility() below) does not ask for the fingerprint again.
          await lock.lockOnLaunch({ freshMs: S.lockAfter(prefs.lockAfter).ms || PAGE_SWITCH_FRESH_MS });
          lockStatus = { ...lockStatus, ...(await lock.status()) };
        }
      } catch {
        // The lock settings could not be read: the app stays locked (mode 'unknown', no way to unlock), and Stop still works through lockStop.
        lockUnreadable = true;
        lockStatus = { ...lockStatus, mode: 'unknown', locked: true };
      } finally {
        lockKnown();
      }
      try {
        await loadComputers();
      } catch {
        computers = [];
      }
      loaded = true;
      applyPrivacy();
      loadDictation();
      loadAndroidPush();
      if (pageKind === 'shell') loadUiSource();
      if (mode === 'demo') {
        computers = [{ ...DEMO_COMPUTER }];
        activeId = DEMO_COMPUTER.id;
        channelState = { ...channelState, status: 'connected', carrier: 'lan', desktopName: 'Demo computer', since: Date.now() };
        return refresh();
      }
      // Wave 5 (brb): the code page connects nothing. It lists the computers paired through this host, for its Open Plenum.
      if (claimPage) {
        const records = [];
        for (const c of computers) {
          const record = await store.get(c.id).catch(() => null);
          if (record) records.push(record);
        }
        claimHere = pagesHere(records, host);
        return refresh();
      }
      const saved = await store.meta.get(ACTIVE_META).catch(() => null);
      if (lockStatus.locked) return refresh();
      if (mode === 'selftest' || computers.length) {
        // A #connect=<id> link the page was opened with names the computer to show, ahead of the saved one.
        const asked = /^#connect=([0-9a-f]{64})$/.exec(pendingLink?.text ?? '')?.[1] ?? null;
        const target = computers.find(c => c.id === asked) ?? computers.find(c => c.id === saved) ?? computers[0];
        if (target) {
          // One UI per computer: a UI page whose UI came from another computer hands the person to the shell page, which connects this one
          // and pulls its UI. No channel is opened here.
          if (pageKind === 'ui' && uiHost) {
            const uiFor = await uiComputerOf();
            if (uiFor !== 'any' && uiFor !== target.id) {
              await api.openShell(`#connect=${target.id}`);
              return refresh();
            }
          }
          const opened = await connectNow(target.id);
          if (!opened.ok) debug.log(`connect: ${opened.reason}`, 'warn');
        }
      }
      return refresh();
    },

    // Pairing from a link. The final state is returned (allowed, denied, expired, mismatch or failed).
    async pair(text, options = {}) {
      // Pairing is refused while the app is locked: a new record is stored only as the lock keeps it (wrapped in PIN mode).
      if (mode === 'demo') {
        pairing = { state: 'failed', code: null, tried: [], reason: 'demo' };
        refresh();
        return { ...pairing };
      }
      if (lockStatus.locked) {
        pairing = { state: 'failed', code: null, tried: [], reason: 'locked' };
        refresh();
        return { ...pairing };
      }
      let payload;
      try {
        payload = parsePairingText(text);
      } catch (err) {
        pairing = { state: 'failed', code: null, tried: [], reason: err?.code ?? 'not-plenum' };
        refresh();
        return { ...pairing };
      }
      // An Add a browser offer keeps its form on every pairing state, so the code, denied and expired screens use the browser's words.
      const form = payload.form === 'browser' ? { form: 'browser' } : {};
      pairing = { state: 'starting', code: null, tried: [], reason: null, ...form };
      refresh();
      // The key of a record the lock wrapped stays in memory for this unlocked session, so the new computer can connect now.
      let wrapped = null;
      // The name typed on Welcome is the name this phone pairs under (the computer shows it in Phones and in the connected line).
      const typed = cleanName(options?.name);
      const flow = startPairing({
        payload,
        store,
        createWorker,
        device: typed ? { ...device, name: typed } : device,
        caps,
        pageUrl,
        prepareRecord: async record => {
          const kept = lock ? await lock.protect(record) : record;
          if (kept !== record) wrapped = { id: record.id, key: b64uToBytes(record.myPriv) };
          return kept;
        },
        onState: s => {
          pairing = { ...s, ...form };
          refresh();
        },
      });
      pairingFlow = flow;
      const final = await flow.done;
      if (pairingFlow === flow) pairingFlow = null;
      if (final.state === 'allowed') {
        await loadComputers();
        const id = final.computerId ?? computers.at(-1)?.id;
        pairing = null;
        pairedSeq += 1;
        pairedId = id ?? null;
        holdUi = true;
        if (wrapped) unlockedKeys.set(wrapped.id, wrapped.key);
        // Wave 5 (brb): the first computer this browser pairs with: ask the browser to keep the keys when it runs short of space.
        if (computers.length === 1 && typeof persist === 'function') Promise.resolve().then(persist).catch(() => {});
        // Connects only when the app is still unlocked (the lock can come on while the pairing is open).
        if (id && !lockStatus.locked) await connectNow(id, { take: true });
        refresh();
        return { ...final, computerId: id ?? null };
      }
      refresh();
      return { ...final };
    },

    async connect(id) {
      if (lockStatus.locked) return { ok: false, reason: 'locked' };
      // One UI per computer: the UI on this page is another computer's, so the shell page connects this one and pulls its UI.
      if (pageKind === 'ui' && uiHost) {
        const uiFor = await uiComputerOf();
        if (uiFor !== 'any' && uiFor !== id) {
          await api.openShell(`#connect=${id}`);
          return { ok: true, reason: 'opening' };
        }
      }
      const result = await connectNow(id, { take: true });
      refresh();
      return result;
    },

    async stop(project = null, computer = '') {
      if (replay) {
        const out = replay.stop();
        stopView = { state: 'done', ack: out.ack, error: null, text: out.text, seq: ++stopSeq };
        say(out.text, 'ok');
        refresh();
        // The demo's Stop answers like the live one: the result shows for a moment, then the Stop is idle again (stop.js does the same).
        stopClock.setTimeout(() => {
          if (stopView.state !== 'done') return;
          stopView = { state: 'idle', ack: null, error: null, text: '', seq: stopView.seq };
          refresh();
        }, STOP_DONE_MS);
        return { ...stopView };
      }
      // B-117: a Stop for a named computer (a notification's Stop all) goes to that computer, whichever one is open.
      const named = RECORD_ID.test(String(computer ?? '')) ? String(computer) : '';
      // Locked, or the lock could not be read: Stop does not wait for an unlock when this phone can send it without one.
      if (lockStatus.locked || lockUnreadable) return lockedStop(project, named);
      if (named && (named !== activeId || !channel)) return stopOn(named, project);
      // Wave 5 (brb): another tab of this browser holds the computer: Stop moves it here and stops (Stop always works from the tab in front).
      if (tab && !channel && tab.computer) {
        const opened = await connectNow(tab.computer, { take: true });
        if (!opened.ok) {
          say('Could not reach your computer from this tab. Press Stop in the other tab or on your computer.', 'warn');
          refresh();
          return { ...stopView, state: 'idle', reason: opened.reason ?? 'failed' };
        }
      }
      if (!stopCtl) return { ...stopView, state: 'idle', text: 'Nothing to stop: no computer is connected.' };
      notePress(activeId);
      const out = await stopCtl.press(project);
      refresh();
      return out;
    },

    async forget(id) {
      if (replay) return { ...refresh(), ok: false, reason: 'demo' };
      if (activeId === id) {
        connectSeq += 1;   // a connect to this computer that is still starting opens nothing
        tabGuard?.hold(null);
        tab = null;
        if (channel) {
          retireChannel(channel);
          channel = null;
          hello = null;
          channelState = { ...channelState, status: 'closed' };
        }
        activeId = null;
        await store.meta.remove(ACTIVE_META).catch(() => {});
      }
      unlockedKeys.delete(id);
      await store.remove(id);
      await loadComputers();
      return { ...refresh(), ok: true, reason: null };
    },

    // Phone settings: the name on this phone only (the computer keeps its own).
    async rename(id, name) {
      if (replay) return { ok: false, reason: 'demo' };
      const clean = cleanName(name);
      if (!id || !clean) return { ok: false, reason: 'name' };
      const saved = await store.patchComputer(id, { name: clean });
      if (!saved) return { ok: false, reason: 'unknown' };
      await loadComputers();
      if (activeId === id) hello = hello ? { ...hello } : null;
      refresh();
      return { ok: true, reason: null };
    },

    // Ways to reach: Move up and Move down reorder the carriers the record holds. The order is used at the next connection.
    async moveWay(id, kind, dir) {
      if (replay) return { ok: false, reason: 'demo' };
      const record = await store.get(id);
      if (!record) return { ok: false, reason: 'unknown' };
      const current = (Array.isArray(record.carriers) ? record.carriers : []).map(c => c.kind);
      const order = S.orderedWays(current);
      const next = S.moveWay(order, kind, dir);
      if (next.join() === order.join()) return { ok: true, reason: null, order: next };
      const sorted = [...record.carriers].sort((a, b) => next.indexOf(a.kind) - next.indexOf(b.kind));
      await store.patchComputer(id, { carriers: sorted });
      await loadComputers();
      refresh();
      return { ok: true, reason: null, order: next };
    },

    // Test them now: the phone reconnects and the carrier that answers is shown in the connection state.
    async testWays(id) {
      if (replay) return { ok: false, reason: 'demo' };
      if (!channel || activeId !== id) return { ok: false, reason: 'offline' };
      // B-131: a connected phone is already using a way; a reconnect would only ping the live session. The answer says which one.
      if (channelState.status === 'connected') return { ok: false, reason: 'connected', carrier: channelState.carrier ?? null };
      channel.reconnect?.();
      refresh();
      return { ok: true, reason: null };
    },

    // Notifications kept on the computer (POST /api/phones/push). A switch the computer refuses stays where it was.
    async setPush(patch) {
      if (replay) {
        pushKnown = { ...S.pushValues(pushKnown), ...patch };
        refresh();
        return { ok: true, reason: null };
      }
      // Turning the first line off turns Approve from notifications off in the same request: the approval needs that line.
      const sent = patch.firstLine === false ? { ...patch, approveFromNotifications: false } : { ...patch };
      const out = await postJson('/api/phones/push', sent);
      if (out.ok) {
        pushKnown = { ...S.pushValues(pushKnown), ...patch };
        if (sent.approveFromNotifications !== undefined) await keepApprove(sent.approveFromNotifications === true);
      }
      refresh();
      return { ok: out.ok, reason: out.reason };
    },

    // Approve from notifications: asked of the computer, which checks the first line itself (409 when it is off).
    async setApprove(value) {
      const on = value === true;
      if (on && !(pushKnown?.firstLine === true)) return { ok: false, reason: 'first-line' };
      if (replay) {
        approveStored = on;
        refresh();
        return { ok: true, reason: null };
      }
      const out = await postJson('/api/phones/push', { approveFromNotifications: on });
      if (out.ok) await keepApprove(on);
      refresh();
      return { ok: out.ok, reason: out.reason };
    },

    async testPush() {
      if (replay) return { ok: true, reason: null };
      const out = await postJson('/api/phones/test-push', {});
      refresh();
      return { ok: out.ok, reason: out.reason };
    },

    // Turn on notifications: the browser's permission (the user gesture is the tap on the screen). The native app asks through its plugin.
    // Web: the permission, then the push subscription, which the computer keeps: "Allowed" means a subscription is on the computer. The
    // computer's VAPID public key comes in its HELLO (vapidPublicKey); without it nothing is subscribed and the answer says so.
    // Android: UnifiedPush through the person's push app (push.js createAndroidPush); the endpoint it gives goes to the computer.
    // Wave 4 (m2): on success the test notification goes out too (turnOnNotifications), and a missing push app or a blocked permission is
    // checked again when Plenum comes back to the front.
    async enableNotifications() {
      if (replay) return { ok: true, reason: null };
      return turnOnNotifications();
    },

    // Wave 4 (m2): Android's notification settings for Plenum (the PlenumPrivacy plugin). An app without that method answers unavailable, and
    // the screen says where to find the page. Plenum checks the permission again when it comes back to the front.
    async openNotificationSettings() {
      const privacy = native?.PlenumPrivacy;
      if (!privacy || typeof privacy.openNotificationSettings !== 'function') return { ok: false, reason: 'unavailable' };
      try {
        const out = await privacy.openNotificationSettings();
        if (out?.opened === false) return { ok: false, reason: 'unavailable' };
        if (androidPush) fixWaiting = 'denied';
        return { ok: true, reason: null };
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    },

    // After "Get ntfy": Plenum checks for the push app when it comes back to the front.
    awaitPushApp() {
      if (!androidPush) return { ok: false, reason: 'unavailable' };
      fixWaiting = 'no-distributor';
      return { ok: true, reason: null };
    },

    // Phone settings showed the "turned them back on" line: it is not shown again.
    ackPushRepaired() {
      if (!pushRepaired) return { ok: true, reason: null };
      pushRepaired = false;
      store.meta.remove(PUSH_REPAIRED_META).catch(() => {});
      refresh();
      return { ok: true, reason: null };
    },

    // The one turn-on for every platform; turnOnNotifications wraps it. Kept in the api for the closures it reads.
    async enableNow() {
      if (androidPush) {
        const out = await androidPush.enable();
        return { ok: out.ok === true, reason: out.ok === true ? null : (out.reason ?? 'failed') };
      }
      const key = typeof hello?.vapidPublicKey === 'string' ? hello.vapidPublicKey : null;
      if (!key || !channel || !serviceWorker || !notifications) return { ok: false, reason: 'unavailable' };
      const registration = await registrationOf(serviceWorker);
      if (!registration) return { ok: false, reason: 'unavailable' };
      const forId = activeId;
      const out = await subscribeWebPush({
        registration,
        applicationServerKey: key,
        request: channel.request,
        deviceId: typeof hello?.deviceId === 'string' && hello.deviceId ? hello.deviceId : activeId,
        notification: notifications,
        env: pushEnv,
      });
      // B-128: this computer's record keeps the endpoint of the browser subscription it made, so turning notifications off removes that one and
      // never another computer's.
      if (out.ok && out.endpoint && forId) await store.patchComputer(forId, { pushEndpoint: out.endpoint, pushLost: null }).catch(() => {});
      refresh();
      if (out.ok) return { ok: true, reason: null };
      if (out.state === 'denied') return { ok: false, reason: 'denied' };
      if (out.state === 'other-computer') return { ok: false, reason: 'other-computer' };
      if (out.state === 'unsupported') return { ok: false, reason: 'unavailable' };
      return { ok: false, reason: 'failed' };
    },

    notificationPermission() {
      return notifications?.permission ?? 'unknown';
    },

    // Android: the person chooses the push app (the system chooser). The settings line reads the answer from state().androidPush.
    async chooseDistributor() {
      if (!androidPush) return { ok: false, reason: 'unavailable' };
      const out = await androidPush.chooseDistributor();
      await readAndroidPush();
      refresh();
      return out;
    },

    // Turn the notifications of this phone off at the computer (the subscription is dropped there).
    async disableNotifications() {
      if (replay) return { ok: true, reason: null };
      if (androidPush) {
        const out = await androidPush.disable();
        fixWaiting = null;
        await readAndroidPush();
        refresh();
        return out;
      }
      const out = await postJson('/api/phones/push', { subscription: null });
      // B-128: the browser keeps one subscription per address, so this computer's goes too (only the one it made), or no other computer behind
      // the same address could turn notifications on.
      if (out.ok && activeId) {
        const record = await store.get(activeId).catch(() => null);
        const endpoint = typeof record?.pushEndpoint === 'string' ? record.pushEndpoint : '';
        // Off means off: a fresh subscription a repair still owed this computer (repostWebPush) is not made.
        if (record?.pushLost === true) await store.patchComputer(activeId, { pushLost: null }).catch(() => {});
        const key = typeof hello?.vapidPublicKey === 'string' ? hello.vapidPublicKey : null;
        if (endpoint || key) {
          const registration = await registrationOf(serviceWorker).catch(() => null);
          if (await dropWebPush({ registration, endpoint, applicationServerKey: endpoint ? null : key }) && endpoint) await store.patchComputer(activeId, { pushEndpoint: null }).catch(() => {});
        }
      }
      refresh();
      return { ok: out.ok, reason: out.reason };
    },

    // App lock on: biometric (native), a passkey (web) or a PIN (web, through setPin).
    async enableLock(mode) {
      if (!lock) return { ok: false, reason: 'unavailable' };
      let result;
      if (mode === 'biometric') result = await lock.enableBiometric();
      else if (mode === 'passkey') result = await lock.enablePasskey();
      else return { ok: false, reason: 'mode' };
      lockStatus = { ...lockStatus, ...(await lock.status()) };
      refresh();
      return { ok: result?.ok === true, reason: result?.reason ?? null };
    },

    async setPin(pin) {
      if (!lock) return { ok: false, reason: 'unavailable' };
      const result = await lock.setPin(String(pin ?? ''));
      if (result?.ok) for (const [id, key] of result.keys ?? []) unlockedKeys.set(id, key);
      lockStatus = { ...lockStatus, ...(await lock.status()) };
      refresh();
      return { ok: result?.ok === true, reason: result?.reason ?? null };
    },

    async lockOff(pin = null) {
      if (!lock) return { ok: false, reason: 'unavailable' };
      const result = await lock.disable({ pin: pin === null ? null : String(pin) });
      lockStatus = { ...lockStatus, ...(await lock.status()) };
      // Approve from notifications needs the app lock: with the lock off, the computer's opt-in goes off as well. When the computer cannot be
      // reached (or refuses), the opt-out is kept and sent at the next HELLO.
      if (result?.ok && approveStored && !replay) {
        let told = false;
        if (channel) {
          const out = await postJson('/api/phones/push', { approveFromNotifications: false });
          if (out.ok) {
            await keepApprove(false);
            told = true;
          }
        }
        if (!told) await store.meta.put(APPROVE_OFF_META, true).catch(() => {});
      }
      refresh();
      return { ok: result?.ok === true, reason: result?.reason ?? (result?.ok ? null : 'pin') };
    },

    // The phone's own preferences (theme, text size, Stop side, haptics, switcher, lock time, dictation, the LAN strip).
    async setPrefs(patch) {
      await savePrefs({ ...prefs, ...(patch ?? {}) });
      applyPrivacy();
      return { ok: true, reason: null };
    },

    cancelConnect() {
      connectSeq += 1;
      tabGuard?.hold(null);
      tab = null;
      if (channel) {
        retireChannel(channel);
        channel = null;
        hello = null;
        channelState = { ...channelState, status: 'closed' };
        activeId = null;
        store.meta.remove(ACTIVE_META).catch(() => {});
        refreshLockStop().then(refresh);
      }
      refresh();
      return { ok: true, reason: null };
    },

    // Drops a pairing in progress, and a pairing link that waits for review.
    cancelPairing() {
      const flow = pairingFlow;
      pairingFlow = null;
      pendingPair = null;
      try { flow?.cancel?.(); } catch { /* already done */ }
      pairing = null;
      refresh();
      return { ok: true, reason: null };
    },

    // The person pressed Pair on the review screen: the parked link starts pairing. Resolves the final pairing state, or { ok: false, reason: 'none' }.
    // Wave 5 (brb): options.name is the name typed on the review screen of a browser offer (form 'browser'); a phone offer has no field.
    async confirmPair(options = {}) {
      const parked = pendingPair;
      if (!parked) return { ok: false, reason: 'none' };
      pendingPair = null;
      const name = parked.form === 'browser' ? cleanName(options?.name) : '';
      return api.pair(parked.text, name ? { name } : {});
    },

    // A line from the UI page's console (the facade's log): redacted, kept in the phone's own console and, when connected, sent to the computer.
    pageLog(line) {
      const entry = debug.log(String(line ?? '').slice(0, 2000), 'page');
      if (entry && channel && !replay) {
        channel.request({ method: 'POST', path: '/_bridge/log', headers: { 'content-type': 'application/json' } }, JSON.stringify({ line: entry.text }), { scope: 'shell' })
          .then(answer => answer.cancel?.(), () => {});
      }
      return Boolean(entry);
    },

    debugClear() {
      debug.clear();
      refresh();
      return { ok: true, reason: null };
    },

    // Posts the most recent debug lines to the computer. A phone not connected cannot send (the screen says so).
    async debugSend() {
      if (replay) return { ok: true, reason: null, n: 0 };
      if (!channel) return { ok: false, reason: 'offline', n: 0 };
      const n = await debug.sendToComputer(shellRequest(channel), 100).catch(() => 0);
      return { ok: n > 0, reason: n > 0 ? null : 'failed', n };
    },

    async demoDecide(id, decision) {
      if (!replay) return { ok: false, reason: 'not-demo' };
      const out = replay.decide(id, decision);
      refresh();
      return out;
    },

    demoReset() {
      if (!replay) return { ok: false, reason: 'not-demo' };
      replay.reset();
      stopView = { state: 'idle', ack: null, error: null, text: '', seq: stopView.seq };
      refresh();
      return { ok: true, reason: null };
    },

    async unlock(method, arg = null) {
      if (!lock) return { ok: false, reason: 'unavailable' };
      let result;
      if (method === 'biometric') result = await lock.unlockBiometric();
      else if (method === 'pin') result = await lock.unlockPin(arg);
      else if (method === 'passkey') result = await lock.unlockPasskey();
      else return { ok: false, reason: 'method' };
      if (result.ok) {
        for (const [id, key] of result.keys ?? []) unlockedKeys.set(id, key);
        lockUnreadable = false;
        lockStatus = { ...lockStatus, ...(await lock.status()), locked: false };
        refresh();
        const saved = await store.meta.get(ACTIVE_META).catch(() => null);
        if (saved && computers.some(c => c.id === saved)) await connectNow(saved);
        // A link the page was opened with while locked runs now (a pairing, or a Stop from a notification).
        await runPendingLink();
        refresh();
      } else {
        lockStatus = { ...lockStatus, ...(await lock.status()) };
        refresh();
      }
      return { ok: result.ok, reason: result.reason ?? null, waitSec: result.waitSec ?? 0, failures: result.failures ?? 0 };
    },

    // Locks the app now. With no lock set there is nothing to unlock with, so nothing happens: the channel stays open and Stop stays reachable
    // (F4: locking without a lock used to close the channel and leave the phone locked until it was relaunched).
    async lockNow() {
      const status = lock ? await lock.status() : { mode: 'off' };
      if (!lock || status.mode === 'off') return { ok: false, reason: 'no-lock' };
      if (channel) {
        retireChannel(channel);
        channel = null;
        hello = null;
        // B-119: a retired channel no longer reports, so the state says what happened to the connection.
        channelState = { ...channelState, status: 'closed' };
      }
      connectSeq += 1;
      tabGuard?.hold(null);
      unlockedKeys.clear();
      await refreshLockStop();
      lock.lock();
      lockStatus = { ...lockStatus, ...(await lock.status()), locked: true };
      refresh();
      return { ok: true, reason: null };
    },

    // The page went to the background or came back. The lock comes on after the time the person chose (prefs.lockAfter, five
    // minutes by default); "Immediately" locks on every return. The channel reconnects at once on return.
    async visibility(visible) {
      sendPresence(visible === true);
      if (!visible) {
        hiddenAt = wall();
        return refresh();
      }
      const away = hiddenAt == null ? null : wall() - hiddenAt;
      hiddenAt = null;
      // The time is the person's (prefs.lockAfter) and this page keeps it. lock.js is not told about the background: its own fixed
      // five minutes would otherwise lock the app early (or leave it unlocked when the chosen time is longer).
      if (lock) {
        const after = S.lockAfter(prefs.lockAfter).ms;
        const locked = lockStatus.mode !== 'off' && away !== null && away >= after;
        if (locked && !lockStatus.locked) await api.lockNow();
      }
      // w4-m1: the worker hears how long the page was away; after RESUME_RACE_AFTER_MS it dials beside the probe (channel.worker.js).
      channel?.reconnect({ reason: 'resume', hiddenMs: away });
      // w7: the page on the app's built-in screens tries the computer's copy again (staged only: a resume never moves the page).
      if (pageKind === 'ui' && uiHost && hello && !replay && mode === 'normal' && !lockStatus.locked) refreshUi({ reason: 'resume', mayMove: false });
      // w4-m2: back from installing ntfy or from the notification settings: turn notifications on when that is now possible.
      if (fixWaiting) recheckNotifications().catch(() => {});
      return refresh();
    },

    // Wave 4 (m3): the page is being left (pagehide: on the apps, a switch between the shell page and the UI page). While unlocked in biometric
    // mode the app keeps the time in its memory, so the next page starts unlocked (lock.js keepUnlocked). Nothing is stored by the page.
    leavingPage() {
      if (!lock || lockStatus.locked || typeof lock.keepUnlocked !== 'function') return false;
      return lock.keepUnlocked();
    },

    // w4-m1: the phone's network came back or changed (the Network plugin's networkStatusChange with connected true, or the page's 'online'
    // event; wireNetwork). The channel tries at once and dials beside the probe of a session that is up, whose socket may be on the old network.
    networkChanged() {
      if (replay || !channel || lockStatus.locked) return false;
      channel.reconnect({ reason: 'network' });
      return true;
    },

    async runSelftest(options = {}) {
      if (!channel) return { ok: false, passed: 0, total: 5, steps: [], reason: 'not connected' };
      // Dynamic, and the define is tested directly: esbuild folds it in a release bundle, so selftest.js is left out of the bundle.
      // Plain node (no define) is a dev build, as DEV_BUILD is.
      const run = selftestFn ?? (typeof __PLENUM_DEV_BUILD__ === 'undefined' || __PLENUM_DEV_BUILD__ === true ? (await import('./selftest.js')).runSelfTest : null);
      if (!run) return { ok: false, passed: 0, total: 5, steps: [], reason: 'not in this build' };
      selftest = { running: true };
      refresh();
      const report = await run({
        channel,
        log: line => debug.log(line),
        ...options,
      });
      selftest = { ...report, running: false };
      // The report goes to the computer as the last debug line (POST /_bridge/log). The Bridge has no POST /_bridge/selftest.
      if (mode === 'selftest') await debug.sendToComputer(shellRequest(channel), 1).catch(() => 0);
      refresh();
      return report;
    },

    // A link the page was opened with, a fragment the service worker posts, a native deep link or a fragment typed into the address bar:
    // a pairing link (#pair=..., plenum://pair#...), or a notification link (see push.js parseNotificationHash). While the app is locked the
    // link waits for the unlock.
    // computerHint (B-117) is the computer a notification came from (the service worker's message carries it apart from the fragment; a
    // fragment may also end in &computer=<id>). Stop all, Deny and Approve act on that computer, not on whichever one is open.
    // Wave 4 (m2): once a Stop, Deny or Approve from a notification is handled, whatever its outcome, that notification is taken down (the one
    // named by the route's &nt=<tag>, else every approval notification). One that waits behind the lock, or that went to the shell page to be
    // answered there, stays until it is handled.
    async handleHash(hash, computerHint = '') {
      const out = await api.runHash(hash, computerHint);
      const link = parseNotificationHash(String(hash ?? ''));
      if (androidPush && link && ['stop', 'deny', 'approve', 'yes', 'no'].includes(link.kind) && out?.reason !== 'locked' && out?.reason !== 'opening' && out?.opening !== true) {
        await clearNotification(link, computerHint || link.computer || '');
      }
      return out;
    },

    // The link itself (handleHash takes the notification down after it).
    async runHash(hash, computerHint = '') {
      const text = String(hash ?? '');
      // The shell page's own screens (from the UI page's Phone settings and Computers): the screens read screenRequest once the app is unlocked.
      // The UI page has no such screens and ignores these two.
      if (pageKind === 'shell' && (text === '#settings' || text === '#computers')) {
        if (booted) await lockRead;
        if (lockStatus.locked || lockUnreadable) {
          pendingLink = { text, at: wall() };
          return { ok: false, reason: 'locked' };
        }
        screenSeq += 1;
        screenRequest = { screen: text.slice(1), seq: screenSeq };
        refresh();
        return { ok: true, reason: null, kind: 'screen' };
      }
      // A #connect=<id> link (the UI page sends it here to show another computer, plan G2.6): the shell page connects that computer and shows its UI.
      const connectId = pageKind === 'shell' ? /^#connect=([0-9a-f]{64})$/.exec(text)?.[1] ?? null : null;
      if (connectId) {
        if (booted) await lockRead;
        if (lockStatus.locked || lockUnreadable) {
          pendingLink = { text, at: wall() };
          return { ok: false, reason: 'locked' };
        }
        if (!computers.some(c => c.id === connectId)) return { ok: false, reason: 'unknown', kind: 'connect' };
        forceUi = true;
        if (channel && activeId === connectId) {
          if (hello) afterHello();
          return { ok: true, reason: null, kind: 'connect' };
        }
        const opened = await connectNow(connectId, { take: true });
        if (!opened.ok) forceUi = false;
        refresh();
        return { ...opened, kind: 'connect' };
      }
      const isPair = text.includes('pair=') || /^plenum:\/\/pair#/.test(text);
      const parsed = parseNotificationHash(text);
      const link = parsed ? { ...parsed } : null;
      const hinted = String(computerHint ?? '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || link?.computer || '';
      if (link) {
        delete link.computer;
        delete link.nt;
      }
      const named = !isPair && RECORD_ID.test(hinted) && ['stop', 'deny', 'approve', 'yes', 'no'].includes(link?.kind) ? hinted : '';
      if (!isPair && !link) return { ok: false, reason: 'no link' };
      if (booted) await lockRead;
      if (lockStatus.locked || lockUnreadable) {
        // A Stop does not wait for the unlock when this phone can send it without one (stop() parks it when it cannot).
        if (!isPair && link?.kind === 'stop') return api.stop(null, named);
        pendingLink = { text, at: wall(), ...(named ? { computer: named } : {}) };
        return { ok: false, reason: 'locked' };
      }
      if (isPair) {
        // The pairing screens are the shell page's. From the UI page, the whole link goes there (the apps keep it for the shell page).
        if (pageKind === 'ui' && uiHost) {
          leaving = true;
          await uiHost.openShell(text).catch(() => {});
          return { ok: true, reason: null, kind: 'pair' };
        }
        // A pairing link from outside the app waits on the review screen until the person taps Pair; nothing is opened before that. The
        // &ci-confirm=1 marker (dev builds only) skips the review, and a release build strips it and still shows it.
        const marked = /&ci-confirm=1$/.test(text);
        const bare = marked ? text.replace(/&ci-confirm=1$/, '') : text;
        if (replay || (marked && devBuild)) return api.pair(bare);
        let payload;
        try {
          payload = parsePairingText(bare);
        } catch (err) {
          pairing = { state: 'failed', code: null, tried: [], reason: err?.code ?? 'not-plenum' };
          refresh();
          return { ...pairing };
        }
        const hosts = [];
        const addHost = (kind, url) => {
          const host = hostLabel(url);
          if (host && !hosts.some(h => h.kind === kind && h.host === host)) hosts.push({ kind, host });
        };
        for (const c of usableCarriers(payload.carriers)) for (const url of c.urls) addHost(c.kind, url);
        for (const c of pageCandidates(pageUrl, payload)) if (carrierUrlOk(c.kind, c.url)) addHost(c.kind, c.url);
        if (!hosts.length) {
          pairing = { state: 'failed', code: null, tried: [], reason: 'no-carrier' };
          refresh();
          return { ...pairing };
        }
        pendingPair = { text: bare, form: payload.form };
        pairing = { state: 'review', code: null, tried: [], reason: null, review: { name: cleanName(payload.name) || 'Plenum computer', hosts, form: payload.form } };
        refresh();
        return { ok: true, reason: null, kind: 'review' };
      }
      if (named && !computers.some(c => c.id === named)) {
        say(link.kind === 'stop' ? UNKNOWN_COMPUTER_STOP : UNKNOWN_COMPUTER, 'warn');
        refresh();
        return { ok: false, reason: 'unknown-computer', kind: link.kind };
      }
      if (link.kind === 'stop') {
        // B-117: the computer that sent the notification, whichever one is open.
        if (named && (named !== activeId || !channel)) return api.stop(null, named);
        // Sent at once. A computer that is away gets the STOP queued by the worker, which resends it on every reconnect for 60 s.
        if (channel) return api.stop();
        say('Nothing to stop: no computer is connected.', 'warn');
        refresh();
        return { ok: false, reason: 'not connected' };
      }
      if (named && (named !== activeId || !channel)) {
        // B-117: Deny and Approve are answered on the computer whose card it is; its own checks (the first line, the opt-in) still run there.
        const opened = await openComputerFor(named, text.includes('&computer=') ? text : `${text}&computer=${named}`);
        if (opened.opening) return { ok: true, reason: null, kind: link.kind, opening: true };
        if (!opened.ok) {
          say('Could not open that computer. Open the approval to answer it.', 'warn');
          refresh();
          return { ok: false, reason: opened.reason ?? 'failed', kind: link.kind };
        }
      }
      if (link.kind === 'deny') {
        // A denial is sent as it is: the computer checks that the card still waits (a denial needs no first line).
        if (!(await whenConnected())) {
          say('Not connected. Open the approval to answer it.', 'warn');
          refresh();
          return { ok: false, reason: 'offline', kind: 'deny' };
        }
        const out = await postJson('/api/approve', { approvalId: link.id, allow: false });
        say(out.ok ? 'Denied.' : 'That card is no longer waiting. Open it to see what changed.', out.ok ? 'ok' : 'warn');
        refresh();
        return { ok: out.ok, reason: out.reason, kind: 'deny' };
      }
      if (link.kind === 'approve') {
        // An approval from a notification carries the first line the notification showed (&line=...). It is sent in the x-plenum-notify-line
        // header, with the same body an answer from the open card has; the computer approves only when this phone has the opt-in and the
        // card that waits still starts with that line, and answers 409 otherwise. Without the line it would be taken for an answer from the
        // open card, so nothing is sent: the card is opened instead.
        const reachable = link.line ? await whenConnected() : Boolean(channel);
        if (!link.line || !reachable) {
          say(reachable ? 'Open the approval to answer it.' : 'Not connected. Open the approval to answer it.', reachable ? 'info' : 'warn');
          emitRoute({ kind: 'waiting', id: link.id });
          return { ok: false, reason: reachable ? 'open-card' : 'offline', kind: 'approve' };
        }
        const out = await postJson('/api/approve', { approvalId: link.id, allow: true }, { 'x-plenum-notify-line': link.line });
        if (out.ok) {
          say('Approved.', 'ok');
          refresh();
          return { ok: true, reason: null, kind: 'approve' };
        }
        if (out.status === 409 || out.status === 403) {
          say(CARD_CHANGED, 'warn');
          emitRoute({ kind: 'waiting', id: link.id });
          return { ok: false, reason: 'changed', kind: 'approve' };
        }
        say('Could not reach your computer. Open the approval to answer it.', 'warn');
        emitRoute({ kind: 'waiting', id: link.id });
        return { ok: false, reason: out.reason, kind: 'approve' };
      }
      // Wave 8: the Yes or No of a business's simple yes/no item (answer.js): one request, and the computer decides everything.
      if (isAnswerLink(link)) return answerFromNotification(link, { whenConnected, postJson, say, emitRoute, refresh });
      if (isRouteLink(link)) {
        emitRoute(link);
        return { ok: true, reason: null, kind: link.kind };
      }
      return { ok: false, reason: 'no link' };
    },

    // The desktop UI. On the shell page: pulls what the computer has and hands the page to it (it does that by itself after HELLO; this is for
    // "Open Plenum" on /?shell and for Try again).
    showUi,

    // The screens call this when the steps after a pairing are over (or were skipped): the page may go to the UI now.
    releaseUi() {
      if (!holdUi) return;
      holdUi = false;
      if (hello) afterHello();
    },

    // "Use the copy in this app": the UI that is already on the phone, without asking the computer.
    async useCopy() {
      if (!uiHost) return { ok: false, reason: 'unavailable' };
      ui = { ...ui, state: 'loading', cause: null };
      refresh();
      const out = await uiHost.useCopy();
      if (out.ok) ui = { ...ui, state: 'navigating' };
      else ui = { state: 'failed', cause: out.cause ?? 'worker', progress: null, hasCopy: false };
      refresh();
      return { ok: out.ok, reason: out.ok ? null : out.cause };
    },

    // From the UI page back to the shell's screens (Phone settings, the computer list, pairing).
    async openShell(hash = '') {
      if (!uiHost) return false;
      leaving = true;
      const done = await uiHost.openShell(hash).catch(() => false);
      if (!done) leaving = false;
      return done;
    },

    // The route a notification named, once: { kind, id?, project?, section?, seq } or null.
    takeRoute() {
      if (!intent || intent.taken) return null;
      intent = { ...intent, taken: true };
      const out = { ...intent };
      refresh();
      return out;
    },

    // Scans a pairing code with the phone's camera (native). { ok, text } or { ok: false, reason: 'denied' | 'cancelled' | 'failed' | 'unavailable' }.
    // The text is a pairing link: the caller hands it to pair().
    async scan() {
      if (!native?.BarcodeScanner) return { ok: false, reason: 'unavailable' };
      return native.BarcodeScanner.scan();
    },

    // Turns the dictation on the phone on or off: the plugin's start/stop. Result events go to boot.js (plenumShell.dictation).
    async dictation() {
      await loadDictation();
      return dictationState ? { ...dictationState } : { available: false, onDevice: false, permission: 'prompt' };
    },

    // B-120: the Stop that is queued or sending, for the UI page to hand over when it leaves: { at, computer } or null.
    pendingStop() {
      const busy = stopView.state === 'sending' || stopView.state === 'queued';
      return busy && stopPressedAt !== null ? { at: stopPressedAt, computer: stopComputer } : null;
    },

    async start() {
      if (started) return snapshot;
      started = true;
      // B-120: a Stop the UI page left for this page (taken once, and only when it is under a minute old).
      const leftStop = mode === 'normal' ? await parked.take().catch(() => null) : null;
      const hash = String(pageUrl && pageUrl.includes('#') ? pageUrl.slice(pageUrl.indexOf('#')) : '');
      // The link is read once and taken out of the address bar, so the pairing secret does not stay in the URL or in the history.
      if (hash.length > 1) {
        clearHash();
        pendingLink = { text: hash, at: wall() };
      } else if (typeof initialLink === 'string' && initialLink) {
        // No address to carry it (the apps): the link the UI page left for this page. It waits behind the lock like the address one.
        pendingLink = { text: initialLink, at: wall() };
      }
      await api.boot();
      // A pairing link or a notification action runs now, or at the unlock when the app is locked.
      await runPendingLink();
      // The Stop goes to the computer it was pressed for (the page may have been opened for another one), without waiting for an unlock
      // when this phone holds that computer's Stop key; the Stop sheet shows it queued while the computer is away.
      if (leftStop) await api.stop(null, leftStop.computer).catch(() => {});
      return snapshot;
    },
  };
  return api;
}

// ----- the page -----

// H6: a real phone is a page with Capacitor's native bridge: the WebView carries window.androidBridge (Android) or
// window.webkit.messageHandlers.bridge (iPhone). Capacitor's registerPlugin is not a sign of one: the bridge script has none, and
// @capacitor/core sets itself up only inside the bundle, once native.js imports it.
export function hasNativeBridge(env) {
  return Boolean(env?.androidBridge || env?.webkit?.messageHandlers?.bridge);
}

// The native plugins are loaded on a phone: a native platform that has the bridge. The Electron harness stub (a Capacitor with no bridge)
// keeps the plain Capacitor.Plugins it was given.
export function wantsNativePlugins(env) {
  return isNative(env) && hasNativeBridge(env);
}

// The plugins of a native app (native.js), or null when this page is not a phone with the bridge. Not exported: the bundle's namespace can be
// imported by any script of the page, and this returns the secure-storage plugin. startShell is the one caller (the suites go through it).
async function loadNativePlugins(env) {
  if (!wantsNativePlugins(env)) return null;
  const mod = await import('./native.js');
  return mod.loadNativePlugins();
}

// A deep link of the native app to the fragment the shell runs: plenum://app/#stop|#deny=<id>|#approve=<id>&line=..., or the pairing link.
export function linkOfUrl(url) {
  const text = String(url ?? '');
  const app = /^plenum:\/\/app\/?(?:\?[^#]*)?(#.*)$/.exec(text);
  if (app) return app[1];
  if (/^plenum:\/\/pair#/.test(text)) return text;
  return null;
}

// M6: links that open the native app (a pairing QR, a notification action or tap from the push app) reach the shell, and the shell page
// handles the hardware Back button (the UI page's Back is boot.js). A link that arrives while the app is locked waits for the unlock (the
// shell's handleHash holds it). Returns afterStart(), which runs the link the app was launched with, once: call it when the shell has started.
// On iOS a plenum://app/ link (#stop, #deny, #approve) is ignored: the iPhone has no notification actions, and any web page can open the scheme.
// plenum://pair still reaches the review screen.
//
// Wave 5 (brb, the k1 follow-up): a launch link acts once. getLaunchUrl() answers the link the app was started with on every page load of
// that start (the shell page, then the UI page, then the shell page again), so the link the shell has run is remembered in sessionStorage
// (LAUNCH_KEY): a later page load of the same start never runs it again, and a shortcut or a notification acts once. Only a hash of the URL is
// kept (a pairing link carries its secret), at most LAUNCH_KEEP of them. The storage lives as long as the app's WebView, so a new start from
// the same notification runs it again, as it should. MainActivity drops a replayed intent natively (k1); this is the backstop.
export const LAUNCH_KEY = 'plenum-launch-done';
export const LAUNCH_KEEP = 20;

// A short hash of a launch URL: SHA-256 (hex, first 32) where the page has crypto.subtle, else FNV-1a.
export async function launchHash(url, env = globalThis) {
  const text = String(url ?? '');
  try {
    const subtle = env?.crypto?.subtle;
    if (subtle?.digest) {
      const digest = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(text)));
      return Array.from(digest.slice(0, 16), b => b.toString(16).padStart(2, '0')).join('');
    }
  } catch { /* the plain hash below */ }
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    h1 = Math.imul(h1 ^ text.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ text.charCodeAt(text.length - 1 - i), 0x811c9dc5) >>> 0;
  }
  return `f${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

function launchMemory(env) {
  const session = () => {
    try { return env?.sessionStorage ?? null; } catch { return null; }
  };
  const read = () => {
    try {
      const list = JSON.parse(session()?.getItem(LAUNCH_KEY) ?? '[]');
      return Array.isArray(list) ? list.filter(k => typeof k === 'string') : [];
    } catch {
      return [];
    }
  };
  return {
    has: key => read().includes(key),
    add(key) {
      try {
        const list = read().filter(k => k !== key);
        list.push(key);
        session()?.setItem(LAUNCH_KEY, JSON.stringify(list.slice(-LAUNCH_KEEP)));
      } catch { /* not kept: k1's native check still drops a replayed intent */ }
    },
  };
}

export function wireAppPlugin({ appPlugin, shell, env, pageKind, platform = null }) {
  const opened = new Set();
  let launchRan = false;
  const memory = launchMemory(env);
  const remember = url => { launchHash(url, env).then(key => memory.add(key), () => {}); };
  const wanted = link => Boolean(link) && !(platform === 'ios' && link.startsWith('#'));
  if (appPlugin?.addListener) {
    appPlugin.addListener('appUrlOpen', event => {
      const url = String(event?.url ?? '');
      const link = linkOfUrl(url);
      if (!wanted(link)) return;
      opened.add(url);
      // The system may deliver the launching link this way too: it is remembered, so the next page load does not run it again.
      remember(url);
      shell.handleHash(link).catch(() => {});
    });
    if (pageKind === 'shell') {
      appPlugin.addListener('backButton', () => {
        const event = typeof env?.CustomEvent === 'function' ? new env.CustomEvent('plenum-back', { cancelable: true }) : null;
        if (event && env.dispatchEvent?.(event) === false) return;
        if (typeof appPlugin.minimizeApp === 'function') appPlugin.minimizeApp();
        else appPlugin.exitApp?.();
      });
    }
  }
  return async function afterStart() {
    if (launchRan || !appPlugin?.getLaunchUrl) return;
    launchRan = true;
    try {
      const launched = await appPlugin.getLaunchUrl();
      const url = String(launched?.url ?? '');
      const link = linkOfUrl(url);
      // The system may also deliver the launching link as an appUrlOpen: it has run then.
      if (!wanted(link) || opened.has(url)) return;
      // An earlier page load of this start ran it already.
      const key = await launchHash(url, env);
      if (memory.has(key)) return;
      memory.add(key);
      shell.handleHash(link).catch(() => {});
    } catch { /* no launch link */ }
  };
}

// w4-m1: reconnect on a network change. The Network plugin (native.js registers it) says networkStatusChange { connected, connectionType }; a
// change that leaves the phone connected (Wi-Fi to mobile data, a new Wi-Fi, back from no signal) asks the channel to try at once, since
// the socket in use may belong to the old network. The page's 'online' event does the same on the web and as a fallback in the apps. A
// change to "not connected" does nothing: the next one will say connected. Returns a function that removes the listeners.
//
// Only a real change counts. The Android plugin (@capacitor/network) sends networkStatusChange { connected: true } on every resume (it
// registers its network callback again and Android reports the current network at once) and on every onCapabilitiesChanged while the app is
// open, with nothing changed. Each of those would dial beside a live session and put the offline cadence back to 10 s. So the last status
// is kept (seeded from getStatus) and an event asks the shell only when the phone goes from not connected to connected, or the connection
// type changes while connected. The first status seen with no seed is only recorded. A return from the background is the page's own
// visibility() call (reason 'resume' with the time away); a network that changed while the app was away still shows here as a new type.
// Bursts are folded: one call at once, then at most one more after NETWORK_QUIET_MS.
export const NETWORK_QUIET_MS = 1500;
export function wireNetwork({ network = null, env = null, shell, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let removed = false;
  let lastAsked = -Infinity;
  let pending = null;
  const ask = () => {
    lastAsked = now();
    try { shell?.networkChanged?.(); } catch { /* the shell is gone */ }
  };
  const changed = () => {
    if (removed || pending) return;
    const wait = lastAsked + NETWORK_QUIET_MS - now();
    if (wait <= 0) { ask(); return; }
    pending = setTimer(() => { pending = null; if (!removed) ask(); }, wait);
  };
  const onOnline = () => changed();
  env?.addEventListener?.('online', onOnline);
  let handle = null;
  // { connected, type } last seen; null until the seed or the first event.
  let last = null;
  let heard = false;
  const statusOf = status => ({ connected: status?.connected === true, type: String(status?.connectionType ?? '') });
  if (network?.getStatus) {
    try {
      Promise.resolve(network.getStatus()).then(status => {
        if (!heard && status && typeof status === 'object') last = statusOf(status);
      }, () => {});
    } catch { /* no seed: the first event is recorded */ }
  }
  if (network?.addListener) {
    try {
      Promise.resolve(network.addListener('networkStatusChange', status => {
        heard = true;
        const next = statusOf(status);
        const prev = last;
        last = next;
        if (!next.connected || !prev) return;
        if (!prev.connected || prev.type !== next.type) changed();
      })).then(h => {
        handle = h ?? null;
        if (removed) handle?.remove?.();
      }, () => {});
    } catch { /* no listener: the 'online' event still works */ }
  }
  return () => {
    removed = true;
    if (pending) { try { clearTimer(pending); } catch { /* gone */ } pending = null; }
    env?.removeEventListener?.('online', onOnline);
    try { handle?.remove?.(); } catch { /* already removed */ }
  };
}

// w4-m1: the "was updated" line on its way from the shell page to the UI page (sessionStorage; nothing secret is in it).
function createNoteCarry(env) {
  const session = () => {
    try { return env?.sessionStorage ?? null; } catch { return null; }
  };
  return {
    put(text) {
      try { session()?.setItem(NOTE_KEY, JSON.stringify({ text: String(text), at: Date.now() })); } catch { /* not carried */ }
    },
    take() {
      try {
        const raw = session()?.getItem(NOTE_KEY);
        if (!raw) return null;
        session().removeItem(NOTE_KEY);
        const value = JSON.parse(raw);
        const fresh = Number.isFinite(value?.at) && Date.now() - value.at >= 0 && Date.now() - value.at < NOTE_TTL_MS;
        return fresh && typeof value.text === 'string' && UPDATED_LINE_PATTERN.test(value.text) ? value.text : null;
      } catch {
        return null;
      }
    },
  };
}

// Wave 4 (m3): the page's prefers-color-scheme query, or null.
function schemeQuery(env) {
  try {
    return env?.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
  } catch {
    return null;
  }
}

// Wave 4 (m3): shows a chosen theme on the shell page's root at once ('dark', 'light'; null hands it back to the stylesheet, which follows the
// phone). It is the root's color-scheme, set through the CSSOM (the strict CSP refuses style attributes in the markup, not this), so the page
// background (the light-dark() tokens, #f6f6fb or #0a0a11) is the chosen one from the first paint. screens/main.js sets data-theme to the same
// value once the preferences are read.
export function showEarlyTheme(doc, theme) {
  const style = doc?.documentElement?.style;
  if (!style) return false;
  const value = theme === 'dark' || theme === 'light' ? theme : '';
  try {
    if (typeof style.setProperty === 'function') {
      if (value) style.setProperty('color-scheme', value);
      else style.removeProperty?.('color-scheme');
    } else {
      style.colorScheme = value;
    }
    return true;
  } catch {
    return false;
  }
}

// Wave 4 (m3): the shell page's copy of the chosen theme (THEME_KEY in localStorage). put(theme) shows it and keeps it; an unchanged value
// writes nothing. Storage that cannot be read or written keeps nothing, and the page follows the phone until the preferences are read.
function createThemeCarry(env) {
  const local = () => {
    try { return env?.localStorage ?? null; } catch { return null; }
  };
  return {
    put(theme) {
      const value = theme === 'dark' || theme === 'light' ? theme : null;
      showEarlyTheme(env?.document, value);
      const ls = local();
      if (!ls) return;
      try {
        if ((ls.getItem(THEME_KEY) ?? null) === value) return;
        if (value) ls.setItem(THEME_KEY, value);
        else ls.removeItem(THEME_KEY);
      } catch { /* not kept */ }
    },
  };
}

// Wave 4 (m3): the first thing the shell page does when this module runs, before anything is awaited: the theme kept from the last start, so
// a page in Plenum's Dark on a light phone (or Light on a dark one) does not first draw the other theme. Answers the theme shown, or null.
export function earlyTheme(env = globalThis) {
  let saved = null;
  try { saved = env?.localStorage?.getItem(THEME_KEY) ?? null; } catch { saved = null; }
  if (saved !== 'dark' && saved !== 'light') return null;
  return showEarlyTheme(env?.document, saved) ? saved : null;
}

// The one-shot slot of a page object other than globalThis (the Node suites): the function boot.js installed, taken and removed.
function takeAttachSlot(env) {
  const f = env?.__plenumAttachShell;
  try { delete env.__plenumAttachShell; } catch { /* not configurable */ }
  return typeof f === 'function' ? f : null;
}

// Starts the shell in the page: the store (secure storage on native, IndexedDB on the web), the lock, the debug console and the
// visibility handling. The shell page's screens get the full core through the hand-over (giveCore, plan C6a) and the UI page's shim gets the
// facade through the one-shot slot (attach, plan C6b); only a dev build also sets window.plenumShellCore and window.plenumNative.
// Returns the shell, or null when the page is not allowed to start one (a frame, a page a same-origin window opened, or a page that has
// started already).
// loadPlugins, devBuild, attach and giveCore are for the Node suites (a phone whose plugins did not load, a release build, the slots): they
// apply to an env that is not the page global. On the page global the first start is the module's own (no options), a later one returns null,
// and devBuild is always the build-time constant, so a script of the page can neither get a second core nor switch the test hooks on.
export async function startShell(env = globalThis, { loadPlugins = loadNativePlugins, devBuild = DEV_BUILD, attach, giveCore } = {}) {
  const ofPage = env === globalThis;
  if (ofPage) {
    if (!takePageStart()) {
      // Only a hand-over the caller supplied hears of it; the page's own hand-over (giveShellCore) is never touched by a refused start.
      giveCore?.(null);
      return null;
    }
    devBuild = DEV_BUILD;
  }
  const give = giveCore ?? (ofPage ? giveShellCore : () => {});
  const attachFn = attach !== undefined ? attach : ofPage ? attachShim : takeAttachSlot(env);
  let handed = false;
  try {
    return await runStart(env, { loadPlugins, devBuild, attach: attachFn, give: value => { handed = true; give(value); } });
  } catch (error) {
    if (!handed) give(null);
    throw error;
  }
}

async function runStart(env, { loadPlugins, devBuild, attach, give }) {
  // A page in a frame, or one a same-origin window opened, is not a Plenum page: it starts nothing and opens no store.
  let framed = false;
  try { framed = env.top !== env.self; } catch { framed = true; }
  let sameOriginOpener = false;
  try { sameOriginOpener = Boolean(env.opener) && env.opener.location.origin === env.location.origin; } catch { sameOriginOpener = false; }
  if (framed || sameOriginOpener) {
    give(null);
    return null;
  }
  const { device, caps, native } = deviceFor(env);
  const cap = env.Capacitor;
  const pageKind = pageKindFor(env);
  const lan = isLanPage(env);
  const bridge = hasNativeBridge(env);
  // Wave 5 (brb): the code page at /pair/ (a browser on another computer types the code the computer shows): no service worker, no UI host.
  const claimPage = !native && pageKind === 'shell' && isClaimPage(env);
  let plugins = null;
  let pluginFailure = false;
  if (native) {
    try {
      plugins = await loadPlugins(env);
    } catch {
      pluginFailure = true;
    }
  }
  // Keys go to the Keychain or Keystore. On a phone (the bridge is there) that is the secure-storage plugin or nothing: if the plugins did not
  // load, nothing is stored (never IndexedDB, which any script of the page can read). Without the bridge (the harness stub) the page keeps the
  // Capacitor.Plugins it was given.
  const registered = plugins?.secureStorage ?? cap?.Plugins?.SecureStorage ?? null;
  const secureStorage = native || bridge ? (pluginFailure || (bridge && (!plugins || !registered)) ? NO_SECURE_STORAGE : registered) : null;
  // localStorage holds the Stop cards (store.js createStopCards). Reading it can throw where site storage is blocked; then there are none.
  let localStorage = null;
  try { localStorage = env.localStorage ?? null; } catch { localStorage = null; }
  const store = createPlatformStore({ secureStorage, indexedDB: env.indexedDB ?? null, localStorage });
  const biometricPlugin = native ? plugins?.BiometricAuth ?? cap?.Plugins?.BiometricAuth ?? null : null;
  const lock = createLock({
    store,
    now: () => Date.now(),
    biometric: createBiometricGate({ plugin: biometricPlugin }),
    passkey: native ? null : createPasskeyGate({ credentials: env.navigator?.credentials, PublicKeyCredentialCtor: env.PublicKeyCredential, rpId: env.location?.hostname }),
    // Wave 4 (m3): the Android app remembers a biometric unlock in its memory (PlenumPrivacy), so a page switch does not ask again.
    memory: native && device.platform === 'android' && plugins?.PlenumPrivacy ? createUnlockMemory({ plugin: plugins.PlenumPrivacy }) : null,
  });
  const params = new URLSearchParams(String(env.location?.search ?? ''));
  const mode = modeFor(env.location?.search, devBuild);
  const stay = params.has(SHELL_QUERY);
  // A link for the shell page waits in the store (never in web storage); an older version left it in sessionStorage, which is cleared once.
  const linkStore = createLinkStore(store.meta);
  const parkedStop = createParkedStop(store.meta);
  try { env.sessionStorage?.removeItem(SHELL_LINK_KEY); } catch { /* no session storage */ }
  // F1: the service worker, for the PWA. Not awaited: the page does not wait for the worker to activate.
  if (!native && pageKind === 'shell' && !claimPage) registerServiceWorker(env);
  let shell = null;
  const kind = native ? (device.platform === 'android' ? 'android' : 'ios') : lan ? 'lan' : 'web';
  const uiHost = mode === 'normal' && !claimPage && env.location && (!native || plugins)
    ? createUiHost({ env, kind, native: plugins, channelOf: () => shell?.channel ?? null, log: line => shell?.debug.log(line, 'warn'), linkStore, stopHandoff: { pending: () => shell?.pendingStop?.() ?? null, park: pending => parkedStop.put(pending), unpark: () => parkedStop.unpark() } })
    : null;
  let initialIntent = null;
  try {
    const saved = pageKind === 'ui' ? env.sessionStorage?.getItem('plenum-intent') : null;
    if (saved) {
      env.sessionStorage.removeItem('plenum-intent');
      initialIntent = JSON.parse(saved);
    }
  } catch {
    initialIntent = null;
  }
  // M6: a link the UI page could not carry in an address (the apps): the shell page takes it out of the store once, then waits for the unlock.
  let initialLink = null;
  if (native && plugins && pageKind === 'shell') initialLink = await linkStore.take();
  // w4-m1: the "was updated" line the shell page left for this UI page.
  const noteCarry = createNoteCarry(env);
  const initialNote = pageKind === 'ui' ? noteCarry.take() : null;
  shell = createShell({
    store,
    lock,
    device,
    caps,
    pageUrl: env.location?.href ?? null,
    mode,
    createWorker: defaultCreateWorker,
    notifications: env.Notification ?? null,
    serviceWorker: env.navigator?.serviceWorker ?? null,
    pushEnv: env,
    clearHash: () => clearAddressHash(env),
    native: plugins,
    uiHost,
    pageKind,
    stay,
    initialIntent,
    initialLink,
    // A notification route that arrives on the shell page is kept for the UI page, and the UI is opened.
    onIntent: link => {
      try { env.sessionStorage?.setItem('plenum-intent', JSON.stringify(link)); } catch { /* the route is then not shown */ }
      shell?.showUi({ force: true });
    },
    onReload: () => { env.location?.reload?.(); },
    devBuild,
    storage: secureStorage === NO_SECURE_STORAGE ? 'unavailable' : 'ok',
    parkedStop,
    noteCarry,
    initialNote,
    // Wave 4 (m3): on the shell page the status bar follows Plenum's theme from here (on the UI page, boot.js does it), and the chosen theme is
    // kept for the next start of the shell page.
    systemBars: native && pageKind === 'shell' ? plugins?.SystemBars ?? null : null,
    colorScheme: pageKind === 'shell' ? schemeQuery(env) : null,
    themeCarry: pageKind === 'shell' ? createThemeCarry(env) : null,
    // Wave 5 (brb): two tabs of one browser on one computer (not on the apps, not on the code page), the code page itself, and the
    // browser's keep-my-keys request after the first pairing.
    tabGuard: !native && !claimPage && mode === 'normal' ? createTabGuard({ env }) : null,
    claimPage,
    host: String(env.location?.host ?? ''),
    persist: native ? null : () => persistStorage(env),
  });
  if (secureStorage === NO_SECURE_STORAGE) shell.debug.log('storage: unavailable', 'warn');
  // Test hooks, in dev builds only: the full core and the plugin registry on the page object.
  if (devBuild) {
    env.plenumShellCore = shell;
    env.plenumNative = plugins;
  }
  // The UI page's shim gets the facade; the shell page's screens get the core.
  attach?.(makeFacade(shell, plugins));
  give(shell);
  env.addEventListener?.('visibilitychange', () => {
    shell.visibility(env.document?.visibilityState !== 'hidden');
  });
  env.addEventListener?.('pagehide', () => {
    shell.leavingPage();
    shell.visibility(false);
  });
  // w4-m1: a network change reconnects at once (the Network plugin on the apps, the 'online' event everywhere).
  wireNetwork({ network: plugins?.Network ?? null, env, shell });
  // A notification action while the app is open: the service worker posts the fragment; a fragment typed into the address bar too.
  env.addEventListener?.('hashchange', () => {
    const hash = String(env.location?.hash ?? '');
    if (hash.length > 1) {
      clearAddressHash(env);
      shell.handleHash(hash).catch(() => {});
    }
  });
  env.navigator?.serviceWorker?.addEventListener?.('message', event => {
    const data = event?.data;
    if (data?.op === 'plenum-hash' && typeof data.hash === 'string') shell.handleHash(data.hash, typeof data.computer === 'string' ? data.computer : '').catch(() => {});
  });
  const afterStart = wireAppPlugin({ appPlugin: plugins?.App ?? null, shell, env, pageKind, platform: device.platform });
  await shell.start();
  await afterStart();
  if (mode === 'selftest') {
    const report = await shell.runSelftest();
    shell.debug.log(`selftest ${report.passed}/${report.total}`);
  }
  return shell;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && !globalThis.__PLENUM_SHELL_NO_AUTOSTART__) {
  startShell(globalThis).catch(err => {
    giveShellCore(null);
    console.error(String(err?.message ?? err));
  });
}
