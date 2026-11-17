// Push on the phone (mob-10, wave 104; H7, M10, M15; MOBILE.json push; MOBILE-UI 6.9 and 10).
//
//   web (PWA)    subscribeWebPush: after a tap the page asks for the permission, subscribes with the computer's VAPID public key (HELLO) and sends
//                the subscription over the channel to POST /api/phones/push. sw.js shows the notification.
//   Android      createAndroidPush: UnifiedPush through the person's push app (ntfy and others). The endpoint the push app gives, with its key set,
//                goes to POST /api/phones/push as { subscription: { kind: 'unifiedpush', endpoint, keys } } (lib/remote/push.mjs
//                normalizeSubscription). While Plenum is in front, a message becomes a local notification here (channels plenum-approvals,
//                plenum-finished, plenum-limits; Deny, Stop all and an opt-in Approve); while it is behind, the plugin's own service already
//                showed the notification, so none is shown a second time.
//
// A notification opens the app at a fragment (parseNotificationHash): #stop, #deny=<id>, #approve=<id>&line=<first line>, #waiting[=<id>],
// #handover=<id>, #chat[=<project>], #settings=limit, #home, and (wave 4) #today[=<business>], #accounts, #services. app.js runs them
// (handleHash); a Stop is sent at once, a Deny after the card is checked by the computer, and an Approve only with the first line the
// notification showed (the computer compares it with the waiting card).
// Not available on the plain LAN web page (no service worker, no push); the caller shows that copy instead.
//
// Wave 4 (m2): Plenum in front is calm. A finished, failed, limit or needs message becomes the shell's own notice (the toast); only an
// approval or a handover posts a system notification, and only when the page is not showing that card already. A test is always a system
// notification (it is the proof that Android shows one). A 'clear' message shows nothing and takes the named notification down.
// Notifications are also taken down after a Stop, Deny or Approve from one (clear()), and an approval one of a computer that says nothing
// waits (clearApprovals: only the approval notifications this phone heard of from that computer). The endpoint is handed again at every
// start and HELLO (renew), but only to a computer that already holds it, and the push app is asked again when the computer lost it (repair).
//
// Wave 6 (k3): a notification's Stop needs no unlock when the plugin holds that computer's Stop card (native.js hands the cards over): the
// plugin sends the Stop-only message itself. So in front, too, the plugin's own notifier shows an approval, handover or test when the app
// has it (showNative), and the local notification is the fallback.

import { channelForKind, NOTIFICATION_CHANNEL_LIST, NOTIFICATION_CHANNELS, parseEndpointEvent, parseMessageEvent, routeForAction } from '../plugins/unifiedpush/src/core.js';

// An id the computer made: letters, digits, dots, dashes and underscores (a UUID for an approval card, hex for a stop).
const ID = /^[A-Za-z0-9_.-]{1,80}$/;
// A notification's tag (lib/remote/push.mjs pushTag), or the plain 'plenum' a payload without one gets.
const TAG = /^plenum(?:-[0-9a-f]{32})?$/;
const FIRST_LINE_MAX = 200;
// The places a notification (or a launcher shortcut) can open that need no id or take an optional one.
const PLACES = Object.freeze(['stop', 'home', 'waiting', 'chat', 'today', 'accounts', 'services', 'night-shift']);
const ROUTE_KINDS = Object.freeze(['waiting', 'handover', 'chat', 'settings', 'home', 'today', 'accounts', 'services', 'night-shift']);

export function pushAvailable(env = globalThis) {
  const nav = env.navigator;
  return Boolean(env.isSecureContext && nav && 'serviceWorker' in nav && env.PushManager && env.Notification);
}

function cleanLine(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, FIRST_LINE_MAX);
}

// What a notification link means. Anything else is null: the shell opens the app as it is.
//   #stop                       { kind: 'stop' }
//   #deny=<id>                  { kind: 'deny', id }
//   #approve=<id>[&line=<text>] { kind: 'approve', id, line }   (line: percent-encoded, '' when absent)
//   #waiting[=<id>]             { kind: 'waiting', id? }        the Waiting card in Agents
//   #handover=<id>              { kind: 'handover', id }        a model asking the person to do a step
//   #chat[=<project>]           { kind: 'chat', project? }      the project's chat
//   #settings=limit             { kind: 'settings', section: 'limit' }
//   #home                       { kind: 'home' }
//   #today[=<business>]         { kind: 'today', id? }          wave 4: the Today list (of one business)
//   #accounts, #services        { kind: 'accounts' }, { kind: 'services' }   wave 4: those Settings pages of the UI
// B-117: any of them may end in &computer=<id>, the computer that sent the notification (the service worker adds it to a cold start, and an
// Android route may carry it): the result then has computer: <id>. Without it there is no computer key, and the shell acts on the open one.
// Wave 4: an action route may also carry &nt=<tag>, the notification it came from (the result then has nt: <tag>), so the shell can take
// that notification down once the action is handled. &line, &nt and &computer may come in any order, each once; &line only on approve.
export function parseNotificationHash(hash) {
  const text = String(hash ?? '').replace(/^#/, '');
  if (!text) return null;
  const parts = text.split('&');
  const head = parts.shift();
  const extra = {};
  for (const part of parts) {
    const m = /^(line|nt|computer)=(.*)$/.exec(part);
    if (!m || extra[m[1]] !== undefined) return null;
    extra[m[1]] = m[2];
  }
  if (extra.computer !== undefined && !ID.test(extra.computer)) return null;
  if (extra.nt !== undefined && !TAG.test(extra.nt)) return null;
  const link = headLink(head);
  if (!link) return null;
  if (link.kind === 'approve') {
    let line = '';
    try {
      line = cleanLine(decodeURIComponent(extra.line ?? ''));
    } catch {
      line = '';
    }
    link.line = line;
  } else if (extra.line !== undefined) {
    return null;
  }
  if (extra.nt !== undefined) link.nt = extra.nt;
  if (extra.computer !== undefined) link.computer = extra.computer;
  return link;
}

function headLink(head) {
  if (PLACES.includes(head)) return { kind: head };
  if (head === 'settings=limit') return { kind: 'settings', section: 'limit' };
  let m = /^(deny|approve|waiting|handover|today)=([A-Za-z0-9_.-]{1,80})$/.exec(head);
  if (m && ID.test(m[2])) return { kind: m[1], id: m[2] };
  m = /^chat=([A-Za-z0-9_.-]{1,80})$/.exec(head);
  if (m) return { kind: 'chat', project: m[1] };
  return null;
}

// True for the fragments that only name a place in the UI (the shell hands them to the UI page as a route).
export function isRouteLink(link) {
  return Boolean(link) && ROUTE_KINDS.includes(link.kind);
}

// The first 16 hex characters of sha256(endpoint), the form in which the computer says which endpoint it holds (POST /api/phones/push answers
// endpoint). Null when there is no endpoint or no WebCrypto.
export async function endpointHash(url, subtle = globalThis.crypto?.subtle) {
  if (typeof url !== 'string' || !url || typeof subtle?.digest !== 'function') return null;
  try {
    const digest = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(url)));
    return Array.from(digest.slice(0, 8), b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

// Asks for the permission (after a tap), subscribes and sends the subscription to the computer. `request` is channel.request.
// Returns { ok, state, status, endpoint? } where state is 'on' | 'denied' | 'unsupported' | 'failed' | 'other-computer'.
// B-128: a browser keeps one push subscription per address, made with one computer's key. When another computer already holds it (the PWA at a
// relay address serves every computer behind it), subscribing with this computer's key is refused by the browser; that is 'other-computer', and the
// other computer's subscription is left as it is (replacing it would silence that computer without a word).
export async function subscribeWebPush({ registration, applicationServerKey, request, deviceId, notification, env = globalThis } = {}) {
  if (!pushAvailable(env) || !registration?.pushManager) return { ok: false, state: 'unsupported', status: 0 };
  if (!applicationServerKey || typeof request !== 'function' || !deviceId) return { ok: false, state: 'failed', status: 0 };
  const permission = await (notification ?? env.Notification).requestPermission();
  if (permission !== 'granted') return { ok: false, state: 'denied', status: 0 };
  const key = bytesFromB64u(applicationServerKey);
  let held = null;
  try {
    held = (await registration.pushManager.getSubscription?.()) ?? null;
  } catch {
    held = null;
  }
  if (held && !sameKey(held.options?.applicationServerKey, key)) return { ok: false, state: 'other-computer', status: 0 };
  let subscription;
  try {
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  } catch (err) {
    return { ok: false, state: err?.name === 'InvalidStateError' ? 'other-computer' : 'failed', status: 0 };
  }
  const json = subscription.toJSON ? subscription.toJSON() : subscription;
  const body = JSON.stringify({ id: deviceId, subscription: { endpoint: json.endpoint, keys: json.keys } });
  const res = await request({ method: 'POST', path: '/api/phones/push', headers: { 'content-type': 'application/json' } }, body);
  try { await res.body?.cancel(); } catch { /* nothing to drain */ }
  if (res.status !== 200) return { ok: false, state: 'failed', status: res.status };
  return { ok: true, state: 'on', status: res.status, endpoint: typeof json.endpoint === 'string' ? json.endpoint : '' };
}

// Whether the key a held subscription was made with (an ArrayBuffer or a view, or nothing when the browser does not say) is this computer's.
// A subscription that does not say is taken to be this computer's: subscribe() then settles it, and an InvalidStateError is 'other-computer'.
function sameKey(held, key) {
  if (!held) return true;
  const a = held instanceof Uint8Array ? held : ArrayBuffer.isView(held) ? new Uint8Array(held.buffer, held.byteOffset, held.byteLength) : new Uint8Array(held);
  if (a.length !== key.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== key[i]) return false;
  return true;
}

// B-128: turning web notifications off at a computer takes this computer's subscription out of the browser as well, so another computer behind the
// same address can turn them on. Only the subscription this phone recorded for the computer (its endpoint) is removed; one that belongs to
// another computer is never touched. Resolves true when the browser's subscription was removed.
// A phone that turned notifications on before the endpoint was recorded has none stored: the subscription is then taken out only when it was made
// with this computer's own key (applicationServerKey), which no other computer shares.
export async function dropWebPush({ registration, endpoint, applicationServerKey = null } = {}) {
  if ((!endpoint && !applicationServerKey) || !registration?.pushManager) return false;
  try {
    const held = await registration.pushManager.getSubscription?.();
    if (!held) return false;
    if (endpoint ? held.endpoint !== endpoint : !(held.options?.applicationServerKey && sameKey(held.options.applicationServerKey, bytesFromB64u(applicationServerKey)))) return false;
    return (await held.unsubscribe?.()) !== false;
  } catch {
    return false;
  }
}

function bytesFromB64u(text) {
  const s = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ----- Android: UnifiedPush -----

// The channels, by the same ids, names and importance the plugin's Kotlin side uses (core.js NOTIFICATION_CHANNEL_LIST, which mirrors
// PlenumNotifier.kt and its strings.xml). Wave 4 adds 'Problems' (a failed run): Android cannot raise an existing channel's importance,
// hence a channel of its own. The plugin creates the four when it loads; creating them here again changes nothing.
export const ANDROID_CHANNELS = Object.freeze(NOTIFICATION_CHANNEL_LIST.map(c => Object.freeze({ id: c.id, name: c.name, importance: c.importance, description: c.description })));
export const APPROVALS_CHANNEL = NOTIFICATION_CHANNELS.approvals;
const ENDPOINT_WAIT_MS = 15000;
const DEFAULT_REGISTRATION = Object.freeze({ instance: 'default', messageForDistributor: 'Plenum' });

// The body of POST /api/phones/push for a UnifiedPush endpoint event (the plugin's `endpoint` event): the push app's https address and the
// key set it was given once. Null when the event has no key set (the computer could not encrypt for it).
export function unifiedPushSubscription(event) {
  const endpoint = parseEndpointEvent(event);
  if (!endpoint.keys) return null;
  return { subscription: { kind: 'unifiedpush', endpoint: endpoint.url, keys: { p256dh: endpoint.keys.pubKey, auth: endpoint.keys.auth } } };
}

// The notification a message shows: channel by kind, the actions the desktop sent (Deny, Stop all, an opt-in Approve) and the routes they open.
// Every action (Deny and Stop all too) asks for the device's own authentication first, as PlenumNotifier.kt does for the system notification.
// extra.tag is the notification's tag: an action's link carries it (&nt=<tag>), so the shell takes the notification down once it acted.
export function notificationFor(payload) {
  const names = payload.actions.map(a => a.action);
  const routes = {};
  for (const a of payload.actions) routes[a.action] = a.route;
  return {
    title: payload.title,
    body: payload.body,
    channelId: channelForKind(payload.kind),
    actionTypeId: names.length ? `plenum-${names.join('-')}` : undefined,
    actions: payload.actions.map(a => ({
      id: a.action,
      title: a.title,
      requiresAuthentication: true,
      destructive: a.action !== 'approve',
      foreground: false,
    })),
    extra: { tap: payload.tap, routes, line: payload.firstLine ?? '', computer: payload.ids?.computer ?? '', tag: payload.tag },
  };
}

// What a message says as the shell's own notice while Plenum is in front: { text, tone, kind }. The computer's title names the project or the
// business; a title that is only "Plenum" adds nothing.
export function noticeFor(payload) {
  const title = String(payload?.title ?? '');
  const body = String(payload?.body ?? '');
  const text = title && title !== 'Plenum' ? `${title}: ${body}` : body;
  const tone = payload?.kind === 'failed' || payload?.kind === 'limit' ? 'warn' : payload?.kind === 'finished' ? 'ok' : 'info';
  return { text, tone, kind: String(payload?.kind ?? '') };
}

function notificationId(tag) {
  let h = 0;
  for (const ch of String(tag ?? 'plenum')) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h) % 2147483000 + 1;
}

// The decrypted text of a message as a JSON object, or null. Read for the fields the plugin's own parser leaves out (silent, and kind 'clear').
function rawObject(text) {
  if (typeof text !== 'string' || text.trimStart()[0] !== '{') return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// native: the registry from native.js (UnifiedPush, LocalNotifications). request: channel.request (a getter, because the channel changes).
// isVisible(): true while Plenum is in front. onLink(hash, computer): runs a notification fragment (app.js handleHash). setTimer/clearTimer: for the wait.
// pendingStore (B-129, optional): { load(), save(body), clear() }, where an endpoint the computer has not accepted yet waits, so a restart of the app
// does not lose the key set the push app gave once. The body is never logged.
// Wave 4 (m2), all optional:
//   computerOf()      the id of the computer the channel goes to ('' when none): which computer a post reached, and whether an endpoint that
//                     came by itself may go there (left out: one computer, and every endpoint goes to it as before wave 4)
//   postedStore       { load(), save(record) }: which computers hold this phone's endpoint ({ v: 1, computers: { <id>: { hash, at } } }), so
//                     state().registered survives a restart. No key is in it, only the first 16 hex of the endpoint's sha256.
//   onNotice(notice)  a message while Plenum is in front that is not an approval or a handover: { text, tone, kind } for the shell's toast
//   isShowing(payload) true when the page already shows that approval card (no system notification then)
//   onReceived(at)    a message arrived (its time, for "Last notification 14:02")
//   onState()         an endpoint from the push app was handled (posted or not): the status row may have changed
//   seenStore         { load(), save(record) }: the approval, handover and needs notifications this phone heard of ({ v: 1, tags: { <tag>:
//                     { kind, computer, approval } } }), so clearApprovals takes down only approval ones of the computer that says none waits
export function createAndroidPush({
  native,
  requestOf,
  vapidOf = () => null,
  isVisible = () => true,
  onLink = () => {},
  pendingStore = null,
  postedStore = null,
  computerOf = null,
  onNotice = () => {},
  isShowing = () => false,
  onReceived = () => {},
  onState = () => {},
  seenStore = null,
  now = () => Date.now(),
  log = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = id => clearTimeout(id),
} = {}) {
  const up = native?.UnifiedPush ?? null;
  const local = native?.LocalNotifications ?? null;
  let started = false;
  const waiters = new Set();   // each resolves once with the next endpoint's outcome (enable and repair wait on one)
  let lastEndpoint = null;
  let lastBody = null;         // the last endpoint body of this run (memory only): repair() posts it again without asking the push app
  let failure = null;
  let postedFor = {};          // computer id -> { hash, at }: the computers that accepted this phone's endpoint
  let postedKnown = false;     // a posted record was read or written (an app from before wave 4 had none)
  let pending = null;          // B-129: the body of an endpoint the computer has not accepted yet; resend() sends it again
  // Whether `pending` was asked for by a turn-on or a repair (it may go to the computer the channel goes to), or came by itself (a renewal at
  // start or HELLO, or the push app moving the address): then it goes only to a computer that already holds this phone's endpoint.
  let pendingOpen = true;
  let renewing = false;
  const types = new Set();
  const shownLocal = new Map();  // tag -> { id, channelId }: the notifications this code showed while Plenum was in front
  const seen = new Map();        // tag -> { kind, computer, approval }: the approval, handover and needs notifications heard of
  const SEEN_MAX = 100;
  const SEEN_KINDS = Object.freeze(['approval', 'handover', 'needs']);

  const here = () => String(computerOf?.() ?? '');
  // The computer the channel goes to holds this phone's endpoint. With no computer named, any computer counts.
  function isPosted() {
    const key = here();
    return key ? Boolean(postedFor[key]) : Object.keys(postedFor).length > 0;
  }
  // An endpoint that came by itself may go to the computer the channel goes to: that computer holds this phone's endpoint, or (an app from
  // before the record, which never wrote one) the push app registration is kept. A computer this phone never turned notifications on for
  // is never subscribed by a renewal. A caller that does not say which computer the channel goes to (no computerOf: one computer, as before
  // wave 4) sends it as before.
  async function mayRenewHere() {
    if (typeof computerOf !== 'function') return true;
    const key = here();
    if (!key) return false;
    if (postedFor[key]) return true;
    if (postedKnown) return false;
    const kept = await savedState();
    return Boolean(kept.distributor) && kept.saved;
  }
  async function saveSeen() {
    try { await seenStore?.save({ v: 1, tags: Object.fromEntries(seen) }); } catch { /* kept in memory for this run */ }
  }
  async function noteSeen(payload) {
    if (!SEEN_KINDS.includes(payload?.kind) || typeof payload.tag !== 'string' || !TAG.test(payload.tag) || payload.tag === 'plenum') return;
    seen.delete(payload.tag);
    seen.set(payload.tag, { kind: payload.kind, computer: String(payload.ids?.computer ?? ''), approval: String(payload.ids?.approval ?? '') });
    while (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value);
    await saveSeen();
  }
  async function savePosted() {
    postedKnown = true;
    try { await postedStore?.save({ v: 1, computers: { ...postedFor } }); } catch { /* kept in memory for this run */ }
  }
  async function markPosted(url) {
    postedFor = { ...postedFor, [here()]: { hash: await endpointHash(url), at: now() } };
    await savePosted();
  }

  async function post(body) {
    const request = requestOf?.();
    if (typeof request !== 'function') return { ok: false, status: 0 };
    try {
      const res = await request({ method: 'POST', path: '/api/phones/push', headers: { 'content-type': 'application/json' } }, JSON.stringify(body));
      try { await res.body?.cancel(); } catch { /* nothing to drain */ }
      return { ok: res.status === 200, status: res.status };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  // The next endpoint's outcome: { ok, reason }. cancel() drops the wait (a register that threw).
  function waitEndpoint() {
    let done = null;
    const promise = new Promise(resolve => {
      const timer = setTimer(() => done({ ok: false, reason: 'timeout' }), ENDPOINT_WAIT_MS);
      done = value => {
        clearTimer(timer);
        waiters.delete(done);
        resolve(value);
      };
      waiters.add(done);
    });
    return { promise, cancel: () => done?.({ ok: false, reason: 'failed' }) };
  }
  function settle(value) {
    for (const w of Array.from(waiters)) w(value);
  }

  async function accepted(body) {
    failure = null;
    pending = null;
    pendingOpen = true;
    try { await pendingStore?.clear(); } catch { /* a note that stays is sent once more and replaced */ }
    await markPosted(body.subscription.endpoint);
  }

  async function onEndpoint(event) {
    let body = null;
    try {
      body = unifiedPushSubscription(event);
    } catch {
      body = null;
    }
    if (!body) {
      failure = 'endpoint';
      settle({ ok: false, reason: 'endpoint' });
      return;
    }
    // A turn-on or a repair waits for this endpoint (it was asked for here); otherwise it came by itself (a renewal, a moved address).
    const asked = waiters.size > 0;
    lastEndpoint = body.subscription.endpoint;
    lastBody = body;
    // One asked for replaces whatever waited; one that came by itself keeps an asked-for one's right to go to the open computer.
    pendingOpen = asked || (pending !== null && pendingOpen);
    pending = body;
    try { await pendingStore?.save(pendingOpen ? body : { ...body, from: 'renew' }); } catch { /* the endpoint is still held in memory */ }
    if (!pendingOpen && !(await mayRenewHere())) {
      // Kept for a computer that holds this phone's endpoint (resend at its HELLO); this one never turned notifications on here.
      try { onState(); } catch { /* the status is read again at the next HELLO */ }
      return;
    }
    const out = await post(body);
    if (out.ok) {
      await accepted(body);
    } else {
      // A new address the computer did not get: the one it holds (if any) is the old one.
      const key = here();
      const hash = await endpointHash(lastEndpoint);
      if (postedFor[key] && postedFor[key].hash !== hash) {
        const { [key]: _gone, ...rest } = postedFor;
        postedFor = rest;
        await savePosted();
      }
    }
    settle(out.ok ? { ok: true, reason: null } : { ok: false, reason: 'failed' });
    try { onState(); } catch { /* the status is read again at the next HELLO */ }
  }

  // Wave 6 (k3): while Plenum is in front, an approval, handover or test is shown by the plugin's own notifier when the app has it
  // (showNotification), so it looks and groups like one shown with Plenum closed, and its Stop is sent natively with no unlock once the
  // phone locks. An older app, or a message the plugin did not show, falls back to the local notification below.
  async function showNative(event) {
    if (typeof up?.showNotification !== 'function' || event?.decrypted !== true || typeof event?.content !== 'string') return false;
    try {
      return (await up.showNotification({ content: event.content }))?.shown === true;
    } catch {
      return false;
    }
  }

  async function showLocal(payload, event = null) {
    if (await showNative(event)) return;
    if (!local?.schedule) return;
    const note = notificationFor(payload);
    if (note.actionTypeId && !types.has(note.actionTypeId)) {
      types.add(note.actionTypeId);
      await local.registerActionTypes?.({ types: [{ id: note.actionTypeId, actions: note.actions }] });
    }
    const id = notificationId(payload.tag);
    await local.schedule({
      notifications: [{
        id,
        title: note.title,
        body: note.body,
        channelId: note.channelId,
        actionTypeId: note.actionTypeId,
        extra: note.extra,
      }],
    });
    shownLocal.set(payload.tag, { id, channelId: note.channelId });
  }

  // Takes notifications down: the one with this tag, or every one on a channel (every one when neither is given). The plugin's cancel and
  // cancelAll are used where the app has them (an older app does not: nothing happens then), and the ones this code showed go too.
  async function clear({ tag = null, channel = null } = {}) {
    const safeTag = typeof tag === 'string' && TAG.test(tag) ? tag : null;
    let done = false;
    try {
      if (safeTag && typeof up?.cancel === 'function') {
        await up.cancel({ tag: safeTag });
        done = true;
      } else if (!safeTag && typeof up?.cancelAll === 'function') {
        await up.cancelAll(channel ? { channel } : {});
        done = true;
      }
    } catch {
      done = false;
    }
    const ids = [];
    for (const [t, shown] of Array.from(shownLocal)) {
      if (safeTag ? t === safeTag : (!channel || shown.channelId === channel)) {
        ids.push({ id: shown.id });
        shownLocal.delete(t);
      }
    }
    if (ids.length && typeof local?.cancel === 'function') {
      try {
        await local.cancel({ notifications: ids });
        done = true;
      } catch { /* already gone */ }
    }
    let forgot = false;
    for (const [t, entry] of Array.from(seen)) {
      if (safeTag ? t === safeTag : (!channel || channelForKind(entry.kind) === channel)) {
        seen.delete(t);
        forgot = true;
      }
    }
    if (forgot) await saveSeen();
    return done;
  }

  // Takes down the approval notifications this phone heard of from one computer (of one card when `approval` is given), and nothing else:
  // a handover or a needs notification on the same channel stays, and so does another computer's. Resolves how many were asked to go.
  async function clearApprovals({ computer = '', approval = null } = {}) {
    const from = String(computer ?? '');
    const tags = [];
    for (const [t, entry] of seen) {
      if (entry.kind !== 'approval' || entry.computer !== from) continue;
      if (approval && entry.approval !== String(approval)) continue;
      tags.push(t);
    }
    for (const t of tags) await clear({ tag: t }).catch(() => false);
    return tags.length;
  }

  async function onMessage(event) {
    let parsed = null;
    try {
      parsed = parseMessageEvent(event);
    } catch {
      return;
    }
    const raw = rawObject(parsed.text);
    // A clear (wave 4): the computer took a card or a notice back. Nothing is shown; the notification with that tag goes (the plugin's
    // service took its own down already; a local one shown here goes too).
    if (parsed.clear === true || parsed.payload?.kind === 'clear' || (raw?.v === 1 && raw.kind === 'clear')) {
      const tag = parsed.payload?.kind === 'clear' ? parsed.payload.tag : raw?.tag;
      if (typeof tag === 'string' && TAG.test(tag) && tag !== 'plenum') await clear({ tag }).catch(() => false);
      return;
    }
    const payload = parsed.payload;
    if (!payload) return;
    try { onReceived(now()); } catch { /* the time is a nicety */ }
    // Shown or not, an approval, handover or needs notification is noted, so a HELLO that says none waits takes down only the right ones.
    await noteSeen(payload).catch(() => {});
    // The plugin's own service shows the notification while Plenum is behind (and says so: shown); showing it here too would make two.
    if (!isVisible() || parsed.shown === true) return;
    // In front: only an approval or a handover is a system notification, and only when the page is not showing that card. A test is one
    // too: it is the proof, after Turn on or Send a test notification, that Android shows Plenum's notifications (and the plugin's service
    // does not show it while Plenum is in front). The rest, and a silent one, is the shell's own notice.
    const urgent = payload.kind === 'approval' || payload.kind === 'handover' || payload.kind === 'test';
    if (!urgent || payload.silent === true || raw?.silent === true) {
      try { onNotice(noticeFor(payload)); } catch { /* the toast is a nicety */ }
      return;
    }
    let showing = false;
    try { showing = isShowing(payload) === true; } catch { showing = false; }
    if (showing) return;
    try {
      await showLocal(payload, event);
    } catch (err) {
      log(`push: local notification ${err?.code ?? 'failed'}`);
    }
  }

  function onAction(event) {
    const extra = event?.notification?.extra ?? {};
    const id = String(event?.actionId ?? 'tap');
    const route = id === 'tap' ? extra.tap : extra.routes?.[id];
    if (typeof route !== 'string') return;
    // An action's link names the notification it came from (&nt=<tag>, core.js routeForAction), so the shell takes it down once it acted.
    const where = id !== 'tap' && typeof extra.tag === 'string' && !/&nt=/.test(route) ? { tag: extra.tag } : undefined;
    const link = String(routeForAction({ action: id === 'tap' ? 'tap' : id, route }, extra.line ? String(extra.line) : '', where)).replace(/^\//, '');
    // B-117: the computer that sent the notification goes with the link (only the three actions act on a computer; a tap is a place).
    const computer = id !== 'tap' && typeof extra.computer === 'string' ? extra.computer.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) : '';
    onLink(link, computer);
  }

  async function savedState() {
    try {
      const s = await up.getState();
      return { distributor: s?.distributor ?? null, saved: Array.isArray(s?.registrations) && s.registrations.includes(DEFAULT_REGISTRATION.instance), endpoint: s?.endpoints?.[DEFAULT_REGISTRATION.instance]?.url ?? null };
    } catch {
      return { distributor: null, saved: false, endpoint: null };
    }
  }

  async function register() {
    const vapid = vapidOf();
    await up.register({ ...DEFAULT_REGISTRATION, ...(vapid ? { vapid } : {}) });
  }

  const api = {
    // Channels, action types and listeners. Safe to call again; a plugin that is missing does nothing.
    async start() {
      if (started || !up) return false;
      started = true;
      try {
        for (const c of ANDROID_CHANNELS) await local?.createChannel?.({ id: c.id, name: c.name, description: c.description, importance: c.importance, visibility: 0 });
        await up.addListener('endpoint', onEndpoint);
        await up.addListener('message', onMessage);
        await up.addListener('registrationFailed', event => { failure = String(event?.reason ?? 'INTERNAL_ERROR'); settle({ ok: false, reason: 'registration' }); });
        await up.addListener('unregistered', () => {
          postedFor = {};
          lastEndpoint = null;
          lastBody = null;
          pending = null;
          pendingOpen = true;
          savePosted().catch(() => {});
          Promise.resolve(pendingStore?.clear?.()).catch(() => {});
        });
        await local?.addListener?.('localNotificationActionPerformed', onAction);
        // An endpoint the last run could not hand to the computer is still waiting (resend sends it at the next HELLO).
        if (!pending && pendingStore) {
          const kept = await pendingStore.load().catch(() => null);
          if (kept?.subscription?.kind === 'unifiedpush' && typeof kept.subscription.endpoint === 'string') {
            // A note from a renewal says so (from: 'renew'); one without the mark came from a turn-on (as before wave 4).
            const { from, ...body } = kept;
            pending = body;
            pendingOpen = from !== 'renew';
          }
        }
        // The approval, handover and needs notifications heard of in an earlier run.
        if (seenStore) {
          const record = await Promise.resolve(seenStore.load()).catch(() => null);
          if (record && typeof record === 'object' && record.tags && typeof record.tags === 'object') {
            for (const [tag, entry] of Object.entries(record.tags).slice(-SEEN_MAX)) {
              if (TAG.test(tag) && entry && SEEN_KINDS.includes(entry.kind)) seen.set(tag, { kind: entry.kind, computer: String(entry.computer ?? ''), approval: String(entry.approval ?? '') });
            }
          }
        }
        // Which computers hold this phone's endpoint, from the last run.
        if (postedStore) {
          const record = await Promise.resolve(postedStore.load()).catch(() => null);
          if (record && typeof record === 'object' && record.computers && typeof record.computers === 'object') {
            postedKnown = true;
            for (const [id, entry] of Object.entries(record.computers)) {
              if (entry && typeof entry === 'object') postedFor[id] = { hash: typeof entry.hash === 'string' ? entry.hash : null, at: Number(entry.at) || 0 };
            }
          }
        }
      } catch (err) {
        log(`push: start ${err?.code ?? 'failed'}`);
        return false;
      }
      return true;
    },

    // What the settings line shows: whether UnifiedPush is on this phone, which push app, and whether the computer has the subscription.
    async state() {
      if (!up) return { supported: false, distributor: null, registered: false, failure };
      try {
        const s = await up.getState();
        return { supported: s?.supported !== false, distributor: s?.distributor ?? null, registered: isPosted(), endpoint: Boolean(lastEndpoint) || Object.keys(s?.endpoints ?? {}).length > 0, failure };
      } catch {
        return { supported: false, distributor: null, registered: false, failure };
      }
    },

    // state() plus what the status row needs (wave 4): permission (Android's own switch for Plenum: true, false, or null when the app cannot
    // say) and saved (the push app registration is kept).
    async status() {
      const base = await api.state();
      if (!up) return { ...base, permission: null, saved: false };
      let permission = null;
      try {
        if (typeof up.getNotificationPermission === 'function') permission = (await up.getNotificationPermission())?.granted === true;
      } catch {
        permission = null;
      }
      const { saved } = await savedState();
      // installed: a push app is on the phone (chosen or not), so the row says Off (one tap turns them on) rather than Needs the ntfy app.
      const installed = base.distributor ? true : await api.hasDistributor();
      return { ...base, permission, saved, installed };
    },

    // The system chooser for the push app (when more than one is installed, or none is chosen).
    async chooseDistributor() {
      if (!up) return { ok: false, reason: 'unavailable' };
      try {
        const out = await up.pickDistributor();
        return { ok: out?.ok !== false, reason: null };
      } catch {
        return { ok: false, reason: 'failed' };
      }
    },

    // Turn on: the permissions (after a tap), a push app, then register. Resolves once the computer has the subscription.
    async enable() {
      if (!up) return { ok: false, reason: 'unavailable' };
      await api.start();
      let wait = null;
      try {
        const granted = await up.requestNotificationPermission();
        if (granted?.granted === false) return { ok: false, reason: 'denied' };
        await local?.requestPermissions?.();
        const s = await up.getState();
        if (s?.supported === false) return { ok: false, reason: 'unavailable' };
        if (!s?.distributor) {
          const list = await up.getDistributors();
          const names = list?.distributors ?? [];
          if (list?.saved) {
            // Already chosen: register below.
          } else if (names.length === 1) {
            await up.chooseDistributor({ packageName: names[0] });
          } else if (names.length === 0) {
            return { ok: false, reason: 'no-distributor' };
          } else {
            const picked = await up.pickDistributor();
            if (picked?.ok === false) return { ok: false, reason: 'no-distributor' };
          }
        }
        wait = waitEndpoint();
        await register();
        return await wait.promise;
      } catch (err) {
        wait?.cancel();
        return { ok: false, reason: err?.code === 'VAPID_REQUIRED' ? 'vapid' : 'failed' };
      }
    },

    // B-129: an endpoint the computer did not get (no channel when the push app gave it, or the computer refused) is sent again. app.js calls this at
    // every HELLO. The computer replaces the phone's subscription with each body, so a second send is harmless. Nothing is sent after a turn off.
    // Wave 4 (m2): an endpoint that came by itself (a renewal) goes only to a computer that already holds this phone's endpoint.
    async resend() {
      if (!pending) return { ok: isPosted(), reason: null };
      if (!pendingOpen && !(await mayRenewHere())) return { ok: isPosted(), reason: null };
      const body = pending;
      const out = await post(body);
      if (out.ok) await accepted(body);
      return { ok: out.ok, reason: out.ok ? null : 'failed' };
    },

    // Wave 4 (m2), at every start and HELLO: when a push app and the 'default' registration are kept, register again, so the push app hands
    // the endpoint and its key set to this listener once more and it goes to the computer (onEndpoint). Resolves true when it asked.
    async renew() {
      if (!up || renewing) return false;
      renewing = true;
      try {
        const kept = await savedState();
        if (!kept.distributor || !kept.saved) return false;
        await register();
        return true;
      } catch (err) {
        log(`push: renew ${err?.code ?? 'failed'}`);
        return false;
      } finally {
        renewing = false;
      }
    },

    // Wave 4 (m2): the computer says it does not hold this phone's endpoint (or holds another). The push app is asked again (never the copy
    // this run kept: a computer that dropped an address the push service called gone would only drop it again), and the endpoint it hands
    // goes to this computer. Resolves { ok, reason, hash }: hash is the first 16 hex of the endpoint that went (app.js tells a repair that
    // sent the same address again apart from one that sent a new one).
    async repair() {
      if (!up) return { ok: false, reason: 'unavailable' };
      const key = here();
      if (postedFor[key]) {
        const { [key]: _gone, ...rest } = postedFor;
        postedFor = rest;
        await savePosted();
      }
      const kept = await savedState();
      if (!kept.distributor) return { ok: false, reason: 'no-distributor' };
      const wait = waitEndpoint();
      try {
        await register();
      } catch {
        wait.cancel();
        return { ok: false, reason: 'failed' };
      }
      const out = await wait.promise;
      return out.ok ? { ...out, hash: postedFor[key]?.hash ?? (await endpointHash(lastEndpoint)) } : out;
    },

    // Wave 4 (m2): whether this phone takes notifications to be on for the computer the channel goes to: that computer accepted its endpoint.
    // An app from before the record (none was ever written) counts the kept push app registration instead.
    async believedOn() {
      if (!up) return false;
      if (isPosted()) return true;
      if (postedKnown) return false;
      const kept = await savedState();
      return Boolean(kept.distributor) && kept.saved;
    },

    // The computer says it holds this phone's endpoint (hash matches): the record notes it, so the next check knows.
    async adopt(hash) {
      if (typeof hash !== 'string' || !hash || isPosted()) return false;
      const mine = await api.endpointHash();
      if (!mine || mine !== hash) return false;
      postedFor = { ...postedFor, [here()]: { hash, at: now() } };
      await savePosted();
      return true;
    },

    // The first 16 hex of sha256 of this phone's endpoint (the one of this run, else the one the plugin kept), or null.
    async endpointHash() {
      if (lastEndpoint) return endpointHash(lastEndpoint);
      if (!up) return null;
      return endpointHash((await savedState()).endpoint);
    },

    // Whether a push app is installed (or chosen) now, and whether Android allows Plenum's notifications now: the re-checks when Plenum comes
    // back to the front after "Get ntfy" or "Open notification settings".
    async hasDistributor() {
      if (!up) return false;
      try {
        const s = await up.getState();
        if (s?.distributor) return true;
        const list = await up.getDistributors();
        return Boolean(list?.saved) || (Array.isArray(list?.distributors) && list.distributors.length > 0);
      } catch {
        return false;
      }
    },
    async permitted() {
      if (!up || typeof up.getNotificationPermission !== 'function') return false;
      try {
        return (await up.getNotificationPermission())?.granted === true;
      } catch {
        return false;
      }
    },

    clear,
    clearApprovals,

    // Turn off: the computer forgets the subscription and the push app registration ends.
    async disable() {
      if (!up) return { ok: false, reason: 'unavailable' };
      const out = await post({ subscription: null });
      try {
        await up.unregister({ instance: 'default' });
      } catch {
        // The registration is already gone.
      }
      postedFor = {};
      lastEndpoint = null;
      lastBody = null;
      pending = null;
      pendingOpen = true;
      await savePosted();
      try { await pendingStore?.clear(); } catch { /* nothing kept */ }
      return { ok: out.ok, reason: out.ok ? null : 'failed' };
    },

    // Test hooks: the handlers the listeners call.
    handlers: { onEndpoint, onMessage, onAction },
  };
  return api;
}
