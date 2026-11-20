// Pure logic for the UnifiedPush plugin's JavaScript side (mob-13, wave 105). No imports, so the same file runs in the
// Node tests, in the shell and in the browser. The Kotlin side under android/ mirrors the payload rules; the sealed suite
// mobile/test/plugins.test.mjs checks both against the desktop's own payload builder (lib/remote/push.mjs).
//
// Payloads: the desktop sends the event as an encrypted Web Push message (RFC 8291) through the distributor. The
// distributor delivers the decrypted bytes to the app; the plugin passes them to JavaScript as base64.

export const UNIFIEDPUSH_EVENTS = Object.freeze(['endpoint', 'registrationFailed', 'unregistered', 'tempUnavailable', 'message']);
export const FAILED_REASONS = Object.freeze(['INTERNAL_ERROR', 'NETWORK', 'ACTION_REQUIRED', 'VAPID_REQUIRED']);
export const DEFAULT_INSTANCE = 'default';
export const DEFAULT_MESSAGE_FOR_DISTRIBUTOR = 'Plenum';
export const MAX_MESSAGE_BYTES = 256 * 1024;
// Every kind the computer sends (lib/remote/push.mjs EVENT_KINDS). A kind that is missing here is shown as "Plenum has an update."
// with its own words lost, so the two lists are pinned to each other (mobile/test/plugins.test.mjs).
// 'clear' (wave 4) is not shown: it carries only the tag of a notification to take down (an answered approval, a fixed problem).
export const PUSH_KINDS = Object.freeze(['approval', 'handover', 'finished', 'failed', 'limit', 'needs', 'test', 'clear']);
// yes and no (wave 8): the two answers of a simple yes/no item of a business (lib/phone-answer.mjs); their route is '/#yes=<n>.<token>'.
export const PUSH_ACTIONS = Object.freeze(['deny', 'stop', 'approve', 'yes', 'no']);
// The actions that ask for the device's unlock before they run: a yes of any kind. Stop, Deny and No do not ask by themselves.
export const AUTH_ACTIONS = Object.freeze(['approve', 'yes']);
export const NOTIFICATION_CHANNELS = Object.freeze({
  approvals: 'plenum-approvals',
  finished: 'plenum-finished',
  problems: 'plenum-problems',
  limits: 'plenum-limits',
});
// The four channels as Android's notification settings list them. The Kotlin side creates them when the plugin loads, from
// res/values/strings.xml with the same names and descriptions (pinned by mobile/test/plugins.test.mjs); the shell may create them
// again for its own local notifications with these values, which changes nothing. importance: 4 high, 3 default (Android's numbers).
// Problems is its own channel id: Android cannot raise or split a channel once it exists, so failures could not move otherwise.
export const NOTIFICATION_CHANNEL_LIST = Object.freeze([
  Object.freeze({ id: 'plenum-approvals', name: 'Approvals and your turn', description: 'Something is waiting for your OK, or a model needs you to do a step.', importance: 4 }),
  Object.freeze({ id: 'plenum-finished', name: 'Finished runs', description: 'A run or a council finished.', importance: 3 }),
  Object.freeze({ id: 'plenum-problems', name: 'Problems', description: 'A run failed, or something stopped working and needs a look.', importance: 3 }),
  Object.freeze({ id: 'plenum-limits', name: 'Limits', description: 'A plan or spend limit was reached.', importance: 3 }),
]);
// Taps and notification actions open the app at this prefix plus the desktop's route, for example plenum://app/#deny=<id>.
export const INTENT_PREFIX = 'plenum://app';
// An approval notification removes itself after the push lifetime (lib/remote/push.mjs PUSH_TTL_S), a backstop for a lost 'clear'.
export const APPROVAL_TIMEOUT_MS = 3600 * 1000;
export const GROUP_MAX = 64;

const INSTANCE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const VAPID_RE = /^[A-Za-z0-9_-]{87}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const HTTPS_URL_RE = /^https:\/\/\S{1,2000}$/;
const TAG_RE = /^plenum-[0-9a-f]{32}$/;
// A tag the phone may cancel: a computer's tag, or 'plenum', the tag a payload without a valid one is shown under.
const CANCEL_TAG_RE = /^plenum(?:-[0-9a-f]{32})?$/;
const COMPUTER_RE = /^[0-9a-f]{64}$/;
// The routes the computer names (lib/remote/push.mjs buildPushText) and nothing else. Ids are the safe characters every route carries
// (letters, digits, dots, dashes, underscores; the shell's parseNotificationHash allows the same 80). The phone may add '&nt=<tag>' (the
// notification to take down after acting) and '&computer=<64 hex>' (the computer that sent it), in that order. PlenumNotifier.kt
// ROUTE_PATTERN is the same expression.
const ROUTE_RE = /^\/#(?:home|stop|waiting|chat|today|accounts|services|night-shift|settings=limit|(?:waiting|handover|chat|today|deny|approve|yes|no)=[A-Za-z0-9_.-]{1,80})(?:&nt=plenum-[0-9a-f]{32})?(?:&computer=[0-9a-f]{64})?$/;

export class UnifiedPushError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UnifiedPushError';
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Removes control characters and trims. Text from the desktop is data: it is only ever shown as text.
export function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

export function isRoute(value) {
  return typeof value === 'string' && ROUTE_RE.test(value);
}

export function normaliseInstance(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_INSTANCE;
  if (typeof value !== 'string' || !INSTANCE_RE.test(value)) {
    throw new UnifiedPushError('bad-instance', 'A registration name is 1 to 64 letters, digits, dots, dashes or underscores.');
  }
  return value;
}

export function normaliseMessageForDistributor(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_MESSAGE_FOR_DISTRIBUTOR;
  if (typeof value !== 'string') {
    throw new UnifiedPushError('bad-message-for-distributor', 'The label for the push app must be text.');
  }
  return cleanText(value, 120) || DEFAULT_MESSAGE_FOR_DISTRIBUTOR;
}

// The VAPID public key is the 87-character base64url form of the uncompressed P-256 point (RFC 8292).
export function normaliseVapid(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !VAPID_RE.test(value)) {
    throw new UnifiedPushError('bad-vapid', 'The VAPID key is the 87-character base64url public key.');
  }
  return value;
}

export function normalisePackageName(value) {
  if (typeof value !== 'string' || value.length > 200 || !PACKAGE_RE.test(value)) {
    throw new UnifiedPushError('bad-package', 'Name the push app by its package name, for example io.heckel.ntfy.');
  }
  return value;
}

export function normaliseRegisterOptions(options = {}) {
  if (!isPlainObject(options)) options = {};
  return {
    instance: normaliseInstance(options.instance),
    messageForDistributor: normaliseMessageForDistributor(options.messageForDistributor),
    vapid: normaliseVapid(options.vapid),
  };
}

// Standard or URL-safe base64, with or without padding. Returns the decoded bytes.
export function decodeBase64(text) {
  if (typeof text !== 'string' || text.length > Math.ceil((MAX_MESSAGE_BYTES * 4) / 3) + 8) {
    throw new UnifiedPushError('bad-message', 'The push message is not base64 text.');
  }
  const standard = text.replace(/-/g, '+').replace(/_/g, '/');
  if (!BASE64_RE.test(standard)) {
    throw new UnifiedPushError('bad-message', 'The push message is not base64 text.');
  }
  const unpadded = standard.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) {
    throw new UnifiedPushError('bad-message', 'The push message is not base64 text.');
  }
  const padded = unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new UnifiedPushError('bad-message', 'The push message is not base64 text.');
  }
  if (binary.length > MAX_MESSAGE_BYTES) {
    throw new UnifiedPushError('message-too-large', 'The push message is larger than the 256 KB limit.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function parseJsonObject(text) {
  if (typeof text !== 'string' || text.trimStart()[0] !== '{') return null;
  try {
    const value = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

// Validates one desktop payload (version 1 of lib/remote/push.mjs). Unknown fields are ignored; an unknown kind or
// version returns null, so the shell shows the generic "Plenum has an update" path instead of acting on it.
//
// Wave 4 (old payloads parse as before): optional `group` (text up to 64 characters: notifications of one business or project are
// bundled; longer or empty means none) and `silent` (true: shown without sound). Kind 'clear' carries only `tag`, the notification to
// take down; a clear without a valid computer tag is refused (null), so it can never take down something else.
export function parsePushPayload(value) {
  if (!isPlainObject(value) || value.v !== 1 || !PUSH_KINDS.includes(value.kind)) return null;
  const ids = isPlainObject(value.ids) ? value.ids : {};
  const idsOut = {
    computer: cleanText(ids.computer, 80),
    project: cleanText(ids.project, 80),
    approval: cleanText(ids.approval, 80),
  };
  if (value.kind === 'clear') {
    if (typeof value.tag !== 'string' || !TAG_RE.test(value.tag)) return null;
    return { v: 1, kind: 'clear', title: '', body: '', tag: value.tag, tap: '/#home', actions: [], silent: true, ids: idsOut };
  }
  const title = cleanText(value.title, 120) || 'Plenum';
  const body = cleanText(value.body, 240) || 'Plenum has an update.';
  const tag = typeof value.tag === 'string' && TAG_RE.test(value.tag) ? value.tag : 'plenum';
  const tap = isRoute(value.tap) ? value.tap : '/#home';
  const firstLine = cleanText(value.firstLine, 200);
  const actions = [];
  if (Array.isArray(value.actions)) {
    // The first three valid actions count; invalid entries are skipped rather than hiding the valid ones after them.
    for (const entry of value.actions) {
      if (actions.length >= 3) break;
      if (isPlainObject(entry) && PUSH_ACTIONS.includes(entry.action) && isRoute(entry.route)) {
        actions.push({ action: entry.action, title: cleanText(entry.title, 40) || entry.action, route: entry.route });
      }
    }
  }
  const group = typeof value.group === 'string' && value.group.length <= GROUP_MAX ? cleanText(value.group, GROUP_MAX) : '';
  const out = {
    v: 1,
    kind: value.kind,
    title,
    body,
    tag,
    tap,
    actions,
    firstLine: firstLine || undefined,
    ids: idsOut,
  };
  if (group) out.group = group;
  if (value.silent === true) out.silent = true;
  return out;
}

// The computer that sent a payload, when it named itself with its 64-hex id; '' otherwise (the shell then acts on the open one).
export function computerOf(payload) {
  const id = payload?.ids?.computer;
  return typeof id === 'string' && COMPUTER_RE.test(id) ? id : '';
}

// An approve route carries the first line the notification showed, so the server can match the card (MOBILE-UI 10).
// With `where` ({ tag, computer }, wave 4) an action route also ends in '&nt=<tag>' (the shell takes that notification down after it
// acted) and '&computer=<64 hex>' (with two computers paired, the action reaches the one that sent it). PlenumNotifier.kt routeFor is
// the same rule. Without `where` the route is what it was before wave 4.
export function routeForAction(action, firstLine, where) {
  let route = action.action === 'approve' && firstLine ? `${action.route}&line=${encodeURIComponent(firstLine)}` : action.route;
  if (where && PUSH_ACTIONS.includes(action.action)) {
    if (typeof where.tag === 'string' && TAG_RE.test(where.tag)) route += `&nt=${where.tag}`;
    if (typeof where.computer === 'string' && COMPUTER_RE.test(where.computer)) route += `&computer=${where.computer}`;
  }
  return route;
}

// The tap route of a payload: the computer's tap, plus '&computer=<64 hex>' when the payload named its computer (PlenumNotifier.kt tapFor).
export function tapRouteFor(payload) {
  const computer = computerOf(payload);
  return computer ? `${payload.tap}&computer=${computer}` : payload.tap;
}

// A tag the plugin's cancel({ tag }) takes: a computer's tag or 'plenum'.
export function normaliseNotificationTag(value) {
  if (typeof value !== 'string' || !CANCEL_TAG_RE.test(value)) {
    throw new UnifiedPushError('bad-tag', 'That is not a Plenum notification tag.');
  }
  return value;
}

// The channel of cancelAll({ channel }): one of the four, or undefined for all of Plenum's push notifications.
export function normaliseChannel(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !Object.values(NOTIFICATION_CHANNELS).includes(value)) {
    throw new UnifiedPushError('bad-channel', 'That is not one of Plenum’s notification channels.');
  }
  return value;
}

export function intentUrlForRoute(route) {
  if (!isRoute(route)) throw new UnifiedPushError('bad-route', 'The route is not a Plenum route.');
  return `${INTENT_PREFIX}${route}`;
}

export function channelForKind(kind) {
  // needs: a business left things on the owner's list. The computer sends it under the approvals switch, so it uses that channel.
  if (kind === 'approval' || kind === 'handover' || kind === 'needs') return NOTIFICATION_CHANNELS.approvals;
  // failed (wave 4): its own channel, so problems can be tuned apart from finished runs.
  if (kind === 'failed') return NOTIFICATION_CHANNELS.problems;
  if (kind === 'limit') return NOTIFICATION_CHANNELS.limits;
  return NOTIFICATION_CHANNELS.finished;
}

// One `message` event of the plugin. shown: the plugin's own service already showed this message as a notification (Plenum was
// behind), so the shell must not show a local one for it. clear: the service took down the notification of
// that tag and the shell shows nothing for it (payload.kind is 'clear').
export function parseMessageEvent(event) {
  if (!isPlainObject(event)) throw new UnifiedPushError('bad-event', 'The push event is not an object.');
  const instance = normaliseInstance(event.instance);
  const decrypted = event.decrypted === true;
  const bytes = decodeBase64(event.content);
  const text = decrypted ? decodeUtf8(bytes) : null;
  const payload = text === null ? null : parsePushPayload(parseJsonObject(text));
  return { instance, decrypted, bytes, text, payload, shown: event.shown === true, clear: payload?.kind === 'clear' };
}

// The endpoint is the distributor's https push address. The key set (P-256 public key and auth secret) is passed on
// once so the shell can send it to the computer over its channel; it is never logged or written anywhere by this plugin.
export function parseEndpointEvent(event) {
  if (!isPlainObject(event)) throw new UnifiedPushError('bad-event', 'The endpoint event is not an object.');
  const instance = normaliseInstance(event.instance);
  if (typeof event.url !== 'string' || !HTTPS_URL_RE.test(event.url)) {
    throw new UnifiedPushError('endpoint-not-https', 'The push app gave an address that is not https.');
  }
  const keys = isPlainObject(event.pubKeySet)
    && typeof event.pubKeySet.pubKey === 'string' && BASE64URL_RE.test(event.pubKeySet.pubKey)
    && typeof event.pubKeySet.auth === 'string' && BASE64URL_RE.test(event.pubKeySet.auth)
    ? { pubKey: event.pubKeySet.pubKey, auth: event.pubKeySet.auth }
    : null;
  return { instance, url: event.url, temporary: event.temporary === true, keys };
}

// What the person sees and what the shell does next, for each registration failure.
export function describeRegistrationFailure(reason) {
  const known = FAILED_REASONS.includes(reason) ? reason : 'INTERNAL_ERROR';
  switch (known) {
    case 'NETWORK':
      return { reason: known, retry: 'when-online', message: 'The push app could not be reached. Plenum tries again when the network is back.' };
    case 'ACTION_REQUIRED':
      return { reason: known, retry: 'after-person', message: 'Open your push app, such as ntfy, sign in or allow Plenum, then try again.' };
    case 'VAPID_REQUIRED':
      return { reason: known, retry: 'with-vapid', message: 'This push app asks for a VAPID key. Plenum registers again with its key.' };
    default:
      return { reason: 'INTERNAL_ERROR', retry: 'now', message: 'The push app failed. Try again.' };
  }
}

// ----- Stop from a notification with no unlock (wave 6, k3) -----
// The shell hands each computer's Stop card to the plugin (setStopCards), so the notification's Stop button can send the signed Stop-only
// message natively (StopReceiver.kt, StopSender.java) instead of opening Plenum, which a locked phone would first ask to unlock. A card is
// what a Stop-only message needs and nothing more: the computer's id and name, this phone's id there, the Stop key, the ways and the
// handshake counter. Never the phone's private key, the psk or the push key (mobile/shell/store.js keeps those).
export const STOP_CARD_KINDS = Object.freeze(['lan', 'tailscale', 'relay']);
export const STOP_CARD_MAX_WAYS = 12;
const STOP_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const WAY_URL_RE = /^wss?:\/\/[^\s]{1,500}$/;

// The card of one store record (mobile/shell/store.js), or null when the record holds no Stop key, no id of this phone, or no way.
// carriers is the record's [{ kind, urls }] (or { kind, url }); the native side checks every address again (StopSender.carrierUrlOk).
export function stopCardFromRecord(record) {
  if (!isPlainObject(record) || typeof record.id !== 'string' || !COMPUTER_RE.test(record.id)) return null;
  if (typeof record.stopKey !== 'string' || !STOP_KEY_RE.test(record.stopKey)) return null;
  if (typeof record.myDeviceId !== 'string' || !COMPUTER_RE.test(record.myDeviceId)) return null;
  const ways = [];
  const seen = new Set();
  for (const c of Array.isArray(record.carriers) ? record.carriers : []) {
    if (!isPlainObject(c) || !STOP_CARD_KINDS.includes(c.kind) || seen.has(c.kind)) continue;
    seen.add(c.kind);
    const urls = Array.isArray(c.urls) ? c.urls : typeof c.url === 'string' ? [c.url] : [];
    for (const url of urls.filter(u => typeof u === 'string' && WAY_URL_RE.test(u)).slice(0, 4)) {
      if (ways.length < STOP_CARD_MAX_WAYS) ways.push({ kind: c.kind, url });
    }
  }
  if (!ways.length) return null;
  const card = {
    id: record.id,
    name: String(record.name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60),
    deviceId: record.myDeviceId,
    stopKey: record.stopKey,
    ways,
    counter: Number.isSafeInteger(record.counter) && record.counter >= 0 ? record.counter : 0,
  };
  if (STOP_CARD_KINDS.includes(record.lastCarrier)) card.lastCarrier = record.lastCarrier;
  if (typeof record.lastUrl === 'string' && ways.some(w => w.url === record.lastUrl)) card.lastUrl = record.lastUrl;
  return card;
}
