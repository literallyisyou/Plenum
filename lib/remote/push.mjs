// Web Push sender for the phone bridge (Plenum mobile track A, mob-08).
// RFC 8291 (aes128gcm content coding with ECDH P-256 and HKDF-SHA256),
// RFC 8292 (VAPID, ES256 JWT) and RFC 8030 (HTTP POST to a push service).
// node:crypto and node:net only. Nothing here logs or returns keys, tokens or
// endpoints, and every error is a fixed sentence.

import crypto from 'node:crypto';
import net from 'node:net';

// The notification hub (lib/notify.mjs, wave 4 n1) decides quiet hours and business mutes. It is loaded without a static import, as
// lib/events.mjs does, so a hub that fails to load never stops a push: the push then goes out as it did before.
let notifyHub = null;
try {
  notifyHub = await import('../notify.mjs');
} catch {
  notifyHub = null;
}

export const RECORD_SIZE = 4096;
export const PAD_SHORT = 2048; // plaintext bucket for ordinary payloads (padded length incl. delimiter)
export const PAD_LONG = RECORD_SIZE - 16; // 4080: the AES-GCM tag takes 16 octets of the record
export const MAX_PAYLOAD_BYTES = 4000;
export const PUSH_TTL_S = 3600;
export const VAPID_TTL_S = 12 * 3600;
export const VAPID_REFRESH_MS = 3600 * 1000;
// The subject ('sub') of every VAPID token when the settings name no contact: the project's public address. Apple's push service refuses a
// token without a mailto: or https: subject (403 BadJwtToken), so an iPhone's home-screen app got no notification at all. It is a web
// address on purpose: no person's email address is sent to a push service.
export const VAPID_CONTACT = 'https://github.com/literallyisyou/Plenum';
export const PRESENCE_IDLE_S = 120;
export const FOREGROUND_WINDOW_MS = 30 * 1000;
export const SEND_TIMEOUT_MS = 15 * 1000;
export const PUSH_KINDS = Object.freeze(['webpush', 'unifiedpush', 'apns-forwarder']);
// needs (14 Nov 2026): a business left new items on the owner's list. The text is "<Business>: 2 things need you": the business's
// name and a count, never a title or a model's text, whatever the first-line switch says. It follows the approvals switch. Since wave 4
// (n2) its title is the business's name, its tag carries the business id (two businesses never replace each other) and it taps
// '/#today=<business id>'. A notice of level needs-you (lib/notify.mjs) is a 'needs' too, with the notice's own title and text, and a
// notice of level problem is a 'failed'; both carry the notice key in their tag, and both follow the approvals switch (wave 5: a 'failed'
// with a notice is not a run that ended, so "Finished runs" does not turn it off). fyi notices are never pushed.
// needs with quick (wave 8; lib/phone-answer.mjs quickFor): the newest item that waits for the business is a simple yes/no. Only when the
// first-line switch is ON, and only for a phone at Full, the text is that question in quotes and the payload carries a No and (for a
// phone with Approve from notifications) a Yes, each a route '/#no=<n>.<token>' or '/#yes=<n>.<token>'. With the switch off it stays a
// name and a count, as above.
// limit with limitKind 'plan' and a text (DECISIONS item 153): a plan will run short or is used up (lib/plan-watch.mjs). The text is the
// computer's own finished sentence (a subscription, a time, the businesses it touches), never a model's words, so it is sent whatever
// the first-line switch says. It is a 'limit' and not a kind of its own so that a phone app that knows only the kinds above shows it.
// clear (wave 4, n2): data only, no title or body. payload.tag is the tag of the notification the phone takes down (an approval that was
// answered, a notice whose condition ended). It goes out with low urgency, under no switch and no presence rule, and only to a phone app
// that keeps notifications itself (a 'unifiedpush' subscription): a browser must show something for every push, so a PWA is not sent one.
export const EVENT_KINDS = Object.freeze(['approval', 'handover', 'finished', 'failed', 'limit', 'needs', 'test', 'clear']);
// A push that met a network error, a 429 or a 5xx is tried again twice: after about 5 s, then 30 s (a Retry-After is honoured up to 60 s).
export const RETRY_DELAYS_MS = Object.freeze([5000, 30000]);
export const RETRY_AFTER_MAX_MS = 60 * 1000;
// An approval push waits this long first: a card answered at the computer in the meantime is never sent to the phone.
export const APPROVAL_GRACE_MS = 20 * 1000;
export const GROUP_MAX = 64;

const FIRST_LINE_MAX = 120;
const PART_MAX = 60;
const NOTICE_KEY_MAX = 120;
// The phone app cleans a body to 240 characters (mobile/plugins/unifiedpush/src/core.js parsePushPayload), so nothing longer is sent.
const PLAN_TEXT_MAX = 240;
const APNS_REFUSAL = 'Phone push through the forwarder is not available in this version.';
const SWITCH_DEFAULTS = Object.freeze({ approvals: true, finished: true, limits: true, onlyWhenAway: true, firstLine: false });

function refusal(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function b64uDecode(text, label) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new Error(`${label} is not base64url.`);
  }
  return Buffer.from(text, 'base64url');
}

function ephemeralEcdh() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh;
}

// ---------------------------------------------------------------- VAPID (RFC 8292)

export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]);
  return { publicKey: point.toString('base64url'), privateKey: priv.d };
}

function vapidSigningKey(keys) {
  const point = b64uDecode(keys.publicKey, 'VAPID public key');
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: keys.privateKey,
    x: point.subarray(1, 33).toString('base64url'),
    y: point.subarray(33, 65).toString('base64url'),
  };
  return crypto.createPrivateKey({ key: jwk, format: 'jwk' });
}

export function validVapidKeys(keys) {
  try {
    if (!keys || typeof keys !== 'object') return false;
    const pub = b64uDecode(keys.publicKey, 'VAPID public key');
    const priv = b64uDecode(keys.privateKey, 'VAPID private key');
    if (pub.length !== 65 || pub[0] !== 4 || priv.length !== 32) return false;
    vapidSigningKey(keys);
    return true;
  } catch {
    return false;
  }
}

// The Authorization value for one push origin. Expires after VAPID_TTL_S (12 h).
export function vapidAuthorization({ endpoint, keys, nowMs, contact }) {
  const origin = new URL(endpoint).origin;
  const claims = { aud: origin, exp: Math.floor(nowMs / 1000) + VAPID_TTL_S };
  if (contact) claims.sub = contact;
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = `${header}.${body}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: vapidSigningKey(keys),
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${signingInput}.${signature.toString('base64url')}, k=${keys.publicKey}`;
}

// ---------------------------------------------------------------- aes128gcm (RFC 8291 / RFC 8188)

// Core encryption for one record. padTo is the padded plaintext length including
// the 0x02 delimiter (0 means no padding). Used by the production path with a
// fixed bucket and by the RFC 8291 appendix A test with no padding.
export function aes128gcmEncrypt({ plaintext, uaPublic, authSecret, salt, asEcdh, padTo = 0, recordSize = RECORD_SIZE }) {
  const asPublic = asEcdh.getPublicKey(null, 'uncompressed');
  const shared = asEcdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const padLength = padTo > 0 ? padTo - plaintext.length - 1 : 0;
  if (padLength < 0) {
    throw new Error('Push payload does not fit its padding bucket.');
  }
  const padded = Buffer.concat([plaintext, Buffer.from([0x02]), Buffer.alloc(padLength)]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
  if (sealed.length > recordSize) {
    throw new Error('Push payload does not fit one push record.');
  }
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(recordSize, 0);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, sealed]);
}

// Production path: pads to PAD_SHORT (2 KB) for ordinary payloads and to PAD_LONG
// for the larger bucket, so the ciphertext length does not reveal the text length
// within a bucket. The ephemeral key and salt are random unless injected for tests.
export function encryptPushPayload(plaintext, subscription, { salt, asEcdh } = {}) {
  if (plaintext.length + 1 > PAD_LONG) {
    throw new Error('Push payload is larger than one record.');
  }
  const padTo = plaintext.length + 1 <= PAD_SHORT ? PAD_SHORT : PAD_LONG;
  return aes128gcmEncrypt({
    plaintext,
    uaPublic: b64uDecode(subscription.keys.p256dh, 'Push key'),
    authSecret: b64uDecode(subscription.keys.auth, 'Push auth secret'),
    salt: salt ?? crypto.randomBytes(16),
    asEcdh: asEcdh ?? ephemeralEcdh(),
    padTo,
    recordSize: RECORD_SIZE,
  });
}

// ---------------------------------------------------------------- subscriptions

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  const family = net.isIP(host);
  if (family === 6) return true;
  if (family === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127);
  }
  return false;
}

// A 65-byte uncompressed point is a P-256 key only when it lies on the curve. Node refuses an off-curve point when the JWK is
// imported, so the import is the check.
function onP256Curve(point) {
  try {
    crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33, 65).toString('base64url') },
      format: 'jwk',
    });
    return true;
  } catch {
    return false;
  }
}

// Validates a PushSubscription-shaped object: { kind?, endpoint, keys: { p256dh, auth } }.
// allowLocalEndpoints is for the sealed tests only; the desktop never sets it.
export function normalizeSubscription(raw, { allowLocalEndpoints = false } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('Push subscription is missing.');
  const kind = raw.kind ?? 'webpush';
  if (!PUSH_KINDS.includes(kind)) throw new Error('Push kind is not known.');
  if (kind === 'apns-forwarder') throw refusal(APNS_REFUSAL, 'kind-unavailable');
  if (typeof raw.endpoint !== 'string' || raw.endpoint.length > 2048) {
    throw new Error('Push endpoint is missing or too long.');
  }
  let url;
  try {
    url = new URL(raw.endpoint);
  } catch {
    throw new Error('Push endpoint is not a URL.');
  }
  const localHttp = allowLocalEndpoints && url.protocol === 'http:';
  if (url.protocol !== 'https:' && !localHttp) throw new Error('Push endpoint must use https.');
  if (url.username || url.password) throw new Error('Push endpoint must not carry credentials.');
  if (!allowLocalEndpoints && isPrivateHost(url.hostname)) throw new Error('Push endpoint must be a public address.');
  const keys = raw.keys && typeof raw.keys === 'object' ? raw.keys : {};
  const p256dh = b64uDecode(keys.p256dh, 'Push key');
  if (p256dh.length !== 65 || p256dh[0] !== 4 || !onP256Curve(p256dh)) throw new Error('Push key is not a P-256 public key.');
  const auth = b64uDecode(keys.auth, 'Push auth secret');
  if (auth.length !== 16) throw new Error('Push auth secret has the wrong size.');
  return {
    kind,
    endpoint: url.href,
    keys: { p256dh: p256dh.toString('base64url'), auth: auth.toString('base64url') },
  };
}

// ---------------------------------------------------------------- text and payload (MOBILE-UI section 10)

const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g');

function cleanText(text) {
  return String(text ?? '').replace(CONTROL_CHARS, ' ').trim();
}

function truncate(text, max) {
  const chars = Array.from(cleanText(text));
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

// The first non-empty line of a card or run text, cleaned and capped at 120 characters.
export function firstLineOf(text) {
  if (typeof text !== 'string') return '';
  const line = text.split(/\r\n|\r|\n/).map(cleanText).find((s) => s.length > 0) ?? '';
  return truncate(line, FIRST_LINE_MAX);
}

// What a program is called on a phone, by the provider part of a model ref ('codex:default' -> 'Codex').
const PROGRAMS = Object.freeze({
  anthropic: 'Claude Code', claude: 'Claude Code', 'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', 'gemini-cli': 'Gemini CLI',
  muse: 'Muse Code', 'muse-code': 'Muse Code', antigravity: 'Antigravity', agy: 'Antigravity', cursor: 'Cursor', 'cursor-agent': 'Cursor',
  grok: 'Grok Build', openai: 'OpenAI', googleai: 'Google AI', xai: 'xAI', deepseek: 'DeepSeek', mistral: 'Mistral', openrouter: 'OpenRouter',
});

export function programOf(ref) {
  const provider = String(ref ?? '').split(':')[0].trim().toLowerCase();
  return Object.hasOwn(PROGRAMS, provider) ? PROGRAMS[provider] : '';
}

// Why a run failed, in Plenum's own words, from the error's kind (server.mjs errorExtras: lib/cli-errors.mjs and lib/api-errors.mjs kinds).
// It holds no model text, so it is sent whatever the first-line switch says. '' for an error without a kind.
export function reasonFor(errorKind, program) {
  const kind = String(errorKind ?? '').trim();
  if (!kind) return '';
  if (['not-signed-in', 'sign-in-refused', 'auth'].includes(kind)) return `${truncate(program || 'The program', PART_MAX)} is signed out.`;
  if (['quota', 'rate-limit', 'no-credit', 'limit', 'plan'].includes(kind)) return 'The plan is used up for now.';
  if (['overloaded', 'server'].includes(kind)) return 'The service was busy.';
  if (kind === 'network') return 'The computer had no internet.';
  if (kind === 'crashed') return 'The program stopped.';
  return 'The run failed.';
}

// Where a notice's route opens the phone (lib/notify.mjs ROUTES).
function noticeTap(route, business, project) {
  if (route === 'accounts') return '/#accounts';
  if (route === 'today') return business ? `/#today=${business}` : '/#today';
  if (route === 'plan-use') return '/#settings=limit';
  if (route === 'services') return '/#services';
  if (route === 'chat') return project ? `/#chat=${project}` : '/#chat';
  // Wave 6: a Night shift job's notice opens the Night shift pane (the phone shell's place 'night-shift').
  if (route === 'night-shift') return '/#night-shift';
  return '';
}

// The simple yes/no item of a 'needs' event, checked: { id: '<n>.<32 hex>', title (one line, 120 characters), more } or null.
function quickOf(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !/^[1-9]\d{0,14}\.[0-9a-f]{32}$/.test(raw.id)) return null;
  const title = truncate(String(raw.title ?? '').replace(/"/g, "'"), FIRST_LINE_MAX);
  if (!title) return null;
  return { id: raw.id, title, more: Math.min(999, Math.max(0, Math.floor(Number(raw.more) || 0))) };
}

// Ids that go into a route: the same safe characters every other route carries.
const safeId = (value, max = 64) => {
  const text = String(value ?? '');
  return /^[A-Za-z0-9_.-]{1,200}$/.test(text) ? text.slice(0, max) : '';
};

// The tag of one notification. The formula of the kinds that existed before wave 4 is unchanged, so an older notification is still
// replaced by its newer one. needs from a business adds the business id and a notice uses its key, so two businesses (or two notices)
// never replace each other.
export function pushTag({ computerId = '', projectId = '', kind = '', alertId = '', businessId = '', noticeKey = '' } = {}) {
  const base = noticeKey
    ? `${computerId}|notice|${noticeKey}`
    : `${computerId}|${projectId}|${kind}${alertId ? `|${alertId}` : ''}${businessId ? `|biz:${businessId}` : ''}`;
  return `plenum-${crypto.createHash('sha256').update(base).digest('hex').slice(0, 32)}`;
}

// The tag a clear takes down. target: { kind: 'approval' | 'handover' | 'needs' | ..., projectId?, businessId?, noticeKey?, alertId? }.
export function targetTag(target, computerId) {
  const t = target && typeof target === 'object' ? target : {};
  return pushTag({
    computerId,
    projectId: String(t.projectId ?? ''),
    kind: String(t.kind ?? ''),
    alertId: t.kind === 'limit' ? cleanText(t.alertId).slice(0, 80) : '',
    businessId: t.kind === 'needs' ? cleanText(t.businessId).slice(0, GROUP_MAX) : '',
    noticeKey: cleanText(t.noticeKey).slice(0, NOTICE_KEY_MAX),
  });
}

// Builds the generic text, actions and the payload for one device.
// event: { kind, computerName?, projectName?, projectId?, approvalId?, count?, firstLine?, limitKind?, text?, alertId?, defaultDeny?,
//          businessId?, businessName?, runKind?, errorKind?, program?, routineName?, verdict?,
//          notice?: { key, title, text, route, business, project }, silent?, target? (kind 'clear'), replaces? (a target, see targetTag) }
// prefs: state.phones.push (switches); device: { tier, approveFromNotifications }; computer: { id, name }.
//
// The title leads with the business or the project: '<Project> · <computer>' when the computer has a name of its own that is not the
// project's, else '<Project>'; the computer's name alone when there is neither. 'needs' is titled with the business; a council
// 'Council is done: <Project>'; a notice with its own title.
export function buildPushText(event, { prefs, device, computer }) {
  const kind = event?.kind;
  if (!EVENT_KINDS.includes(kind)) throw new Error('Push event kind is not known.');
  const sw = { ...SWITCH_DEFAULTS, ...(prefs ?? {}) };
  const computerId = String(computer?.id ?? '');
  const projectId = String(event.projectId ?? '');
  const ids = { computer: computerId, project: projectId, approval: String(event.approvalId ?? '') };

  if (kind === 'clear') {
    const tag = targetTag(event.target, computerId);
    const payload = { v: 1, kind, tag, ids: { ...ids, approval: '' } };
    return { payload, urgency: 'low', tag, title: '', body: '' };
  }

  const computerName = truncate(computer?.name || 'Plenum', PART_MAX);
  const notice = event.notice && typeof event.notice === 'object' ? event.notice : null;
  const businessId = cleanText(event.businessId ?? notice?.business ?? '').slice(0, GROUP_MAX);
  const businessName = truncate(event.businessName ?? '', PART_MAX);
  const projectName = truncate(event.projectName ?? '', PART_MAX);
  const place = kind === 'needs' ? businessName : (businessName || projectName);
  const generic = ['plenum', 'this computer', ''].includes(computerName.toLowerCase());
  const adds = !generic && computerName.toLowerCase() !== place.toLowerCase();
  let title = place ? (adds ? `${place} · ${computerName}` : place) : computerName;
  const count = kind === 'approval' ? Math.max(1, Math.floor(Number(event.count) || 1)) : 1;
  const approvalId = ids.approval;
  // A single card has an id; a count of 1 without one (cards the Bridge learnt of only by their number) opens the Waiting list.
  const single = kind === 'approval' && count === 1 && approvalId !== '';
  const line = sw.firstLine ? firstLineOf(event.firstLine) : '';
  const council = event.runKind === 'council';
  const routine = truncate(event.routineName ?? '', PART_MAX);
  const reason = reasonFor(event.errorKind, event.program);

  let body;
  let quick = null;
  switch (kind) {
    case 'approval':
      if (count > 1) body = line || `${count} approvals are waiting.`;
      else if (!single) body = 'An approval is waiting.';
      else body = line ? `Waiting: ${line}` : 'An approval is waiting.';
      break;
    case 'handover':
      body = line ? `The model asks: "${line}"` : 'The model needs you to do a step.';
      break;
    case 'finished':
      if (council) body = 'The verdict is ready.';
      else if (routine) body = `${routine} is done.`;
      else body = line ? `Finished: ${line}` : 'The run finished.';
      break;
    case 'failed':
      if (council) body = reason && reason !== 'The run failed.' ? `The council stopped: ${reason}` : 'The council stopped before it reached a verdict.';
      else if (routine) body = reason && reason !== 'The run failed.' ? `${routine} did not finish. ${reason}` : `${routine} did not finish.`;
      else if (reason) body = reason;
      else body = line ? `Failed: ${line}` : 'The run failed.';
      break;
    case 'limit':
      body = (event.limitKind === 'plan' ? truncate(event.text, PLAN_TEXT_MAX) : '')
        || (event.limitKind === 'plan' ? 'A plan limit was reached.' : 'A spend limit was reached.');
      break;
    case 'needs': {
      const things = Math.min(999, Math.max(1, Math.floor(Number(event.count) || 1)));
      body = `${truncate(event.businessName || 'A business', PART_MAX)}: ${things === 1 ? '1 thing needs you' : `${things} things need you`}`;
      title = businessName || 'A business';
      // A simple yes/no item (lib/phone-answer.mjs quickFor; wave 8): its question is shown, in quotes because a model worded it, and it
      // gets a No and a Yes. Only where the owner switched on the first line in notifications, and only on a phone at Full (a phone below
      // Full cannot answer). Everywhere else the text stays a name and a count.
      quick = sw.firstLine === true && device?.tier === 'full' ? quickOf(event.quick) : null;
      if (quick) body = `"${quick.title}"${quick.more ? ` ${quick.more === 1 ? '1 more thing waits' : `${quick.more} more things wait`}.` : ''}`;
      break;
    }
    default:
      body = 'Test notification: Plenum can reach this phone.';
  }
  if (council && (kind === 'finished' || kind === 'failed')) title = place ? `Council is done: ${place}` : 'Council is done';
  // A notice carries Plenum's own words (lib/notify.mjs cleans them): its title and text are the notification.
  if (notice && (kind === 'needs' || kind === 'failed')) {
    title = truncate(notice.title, PART_MAX) || title;
    body = truncate(notice.text, PLAN_TEXT_MAX) || body;
  }

  const approveAllowed = single
    && device?.approveFromNotifications === true
    && sw.firstLine === true
    && line !== ''
    && event.defaultDeny !== true
    && device?.tier !== 'read';
  const actions = [];
  if (single) actions.push({ action: 'deny', title: 'Deny', route: `/#deny=${approvalId}` });
  if (kind === 'approval' || kind === 'handover') actions.push({ action: 'stop', title: 'Stop all', route: '/#stop' });
  if (approveAllowed) actions.push({ action: 'approve', title: 'Approve', route: `/#approve=${approvalId}` });
  // The words on the two buttons are the program's own. The No is the server's refusal; the Yes is offered only to a phone that has
  // Approve from a notification, as Approve is. Neither is ever a default: a notification nobody taps answers nothing.
  if (quick) {
    actions.push({ action: 'no', title: 'No', route: `/#no=${quick.id}` });
    if (device?.approveFromNotifications === true) actions.push({ action: 'yes', title: 'Yes', route: `/#yes=${quick.id}` });
  }

  const tapBusiness = safeId(businessId);
  let tap;
  if (kind === 'approval') tap = single ? `/#waiting=${approvalId}` : '/#waiting';
  else if (kind === 'handover') tap = `/#handover=${approvalId}`;
  else if (notice) tap = noticeTap(notice.route, tapBusiness, safeId(notice.project ?? projectId, 200)) || (tapBusiness ? `/#today=${tapBusiness}` : kind === 'needs' ? '/#today' : '/#home');
  else if (kind === 'finished' || kind === 'failed') tap = projectId ? `/#chat=${projectId}` : '/#chat';
  else if (kind === 'limit') tap = '/#settings=limit';
  else if (kind === 'needs') tap = tapBusiness ? `/#today=${tapBusiness}` : '/#home';
  else tap = '/#home';

  // A plan alert has its own tag (its id), so the alert of one plan does not replace the alert of another on the phone.
  const alertId = kind === 'limit' && event.limitKind === 'plan' ? cleanText(event.alertId).slice(0, 80) : '';
  const noticeKey = notice ? cleanText(notice.key).slice(0, NOTICE_KEY_MAX) : '';
  // replaces: the target of an earlier notification this one stands for (a routine's notice for the run that failed): it takes its tag,
  // so it replaces that notification on the phone instead of showing beside it.
  const replaces = event.replaces && typeof event.replaces === 'object' ? event.replaces : null;
  const tag = replaces
    ? targetTag(replaces, computerId)
    : pushTag({ computerId, projectId, kind, alertId, businessId: kind === 'needs' && !noticeKey ? businessId : '', noticeKey });
  const urgency = kind === 'approval' || kind === 'handover' ? 'high' : 'normal';

  const payload = {
    v: 1,
    kind,
    title,
    body,
    tag,
    tap,
    actions,
    ids,
  };
  if (line && (kind === 'approval' || kind === 'handover')) payload.firstLine = line;
  // group: the business (or the project) the notification belongs to, so the phone can bundle them. silent: show it without sound.
  const group = (businessId || projectId).slice(0, GROUP_MAX);
  if (group) payload.group = group;
  if (event.silent === true) payload.silent = true;
  return { payload, urgency, tag, title, body };
}

// ---------------------------------------------------------------- quiet hours (lib/notify.mjs)

// The stamp lib/notify.mjs gives a notice, for a push that is not a notice: { quiet, silent }. quiet when a business is muted now, or
// quiet hours are on now and the level is not 'needs-you'; silent for a 'needs-you' push in quiet hours. A hub that cannot be read
// stamps nothing (the push goes out as before).
export function quietStamp({ level, business = '', nowMs }) {
  try {
    if (!notifyHub || typeof notifyHub.settings !== 'function' || typeof notifyHub.inQuietHours !== 'function') return { quiet: false, silent: false };
    const s = notifyHub.settings();
    const t = Number.isFinite(nowMs) ? nowMs : Date.now();
    const muted = Boolean(business) && Number(s?.mutes?.[business]) > t;
    const quietHours = notifyHub.inQuietHours(s?.quiet, t);
    return { quiet: muted || (quietHours && level !== 'needs-you'), silent: !muted && quietHours && level === 'needs-you' };
  } catch {
    return { quiet: false, silent: false };
  }
}

// The level a push that is not a notice has for quiet hours (lib/notify.mjs LEVELS). A test and a clear have none: they are never held.
export const QUIET_LEVELS = Object.freeze({ approval: 'needs-you', handover: 'needs-you', needs: 'needs-you', failed: 'problem', limit: 'problem', finished: 'fyi' });

// A push held back as quiet is written to the hub (lib/notify.mjs admit, not published): it is then in Recent and in the morning
// summary, under a key that names a thing that happened ('run:' or 'limit:'), so it is never on the bell. Never throws.
export function holdInHub(notice, nowMs) {
  try {
    if (!notifyHub || typeof notifyHub.admit !== 'function') return null;
    return notifyHub.admit(notice, { now: nowMs });
  } catch {
    return null;
  }
}

let heldRuns = 0;
// The hub record of one held push, in the words the push would have had (never the first line of a card or a model's words). A routine's
// run that failed is not written: the routine's own notice (lib/routines.mjs, key 'routine:<id>') tells it, and a passing failure that
// the routine tries again is not news.
export function heldNotice(event, level, { nowMs, computer } = {}) {
  const kind = event?.kind;
  if (kind !== 'finished' && kind !== 'failed' && kind !== 'limit') return null;
  if (kind === 'failed' && cleanText(event.routineName)) return null;
  let built;
  try {
    built = buildPushText(event, { prefs: { firstLine: false }, device: null, computer });
  } catch {
    return null;
  }
  const projectId = safeId(String(event.projectId ?? ''), 200);
  const at = Number.isFinite(nowMs) ? nowMs : Date.now();
  // A run has a key of its own (each one that ended counts); a limit's key is its alert (the same alert told twice counts once).
  heldRuns += 1;
  const key = kind === 'limit'
    ? `limit:${cleanText(event.alertId).slice(0, 80) || `${event.limitKind === 'plan' ? 'plan' : 'spend'}:${projectId}`}`
    : `run:${projectId || 'none'}:${at.toString(36)}-${heldRuns}`;
  return {
    key: key.slice(0, NOTICE_KEY_MAX),
    level,
    title: built.title,
    text: built.body,
    route: kind === 'limit' ? 'plan-use' : 'chat',
    business: cleanText(event.businessId ?? '').slice(0, GROUP_MAX),
    project: projectId,
  };
}

function holdForSummary(event, level, { nowMs, computer, hold }) {
  if (typeof hold !== 'function') return;
  try {
    const notice = heldNotice(event, level, { nowMs, computer });
    if (notice) hold(notice, nowMs);
  } catch {
    // The summary is a courtesy: a push held back is never a reason to fail.
  }
}

// Seconds or an HTTP date -> milliseconds to wait, capped at RETRY_AFTER_MAX_MS; null when the header is missing or unreadable.
export function retryAfterMs(value, nowMs = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  let ms = null;
  if (/^\d{1,9}$/.test(text)) ms = Number(text) * 1000;
  else {
    const at = Date.parse(text);
    if (Number.isFinite(at)) ms = at - nowMs;
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(0, ms));
}

const defaultSleep = ms => new Promise(resolve => {
  const t = setTimeout(resolve, ms);
  t?.unref?.();
});

// ---------------------------------------------------------------- the pusher

// options: devices { list() -> [{ id, name?, tier, approveFromNotifications, pushSubscription }] }, removeSubscription(id, endpoint),
// presence() -> { focused, idleS, locked? }, foreground(id) -> ms of the phone's last request, settings() -> { push, computer }, log(line),
// vapid | vapidStore, now(), fetch, allowLocalEndpoints, sleep(ms) -> promise (the retry and grace timer; injectable for tests),
// quiet({ level, business, nowMs }) -> { quiet, silent } (default quietStamp), hold(notice, nowMs) for a push held back as quiet (default
// holdInHub), onGiveUp({ deviceId, name, kind, reason }) once per device whose push failed after every try.
export function createPusher(options = {}) {
  const {
    devices,
    removeSubscription,
    presence,
    foreground,
    settings,
    log = () => {},
    vapid: vapidInput = null,
    vapidStore = null,
    now = () => Date.now(),
    fetch: fetchImpl = globalThis.fetch,
    allowLocalEndpoints = false,
    sleep = defaultSleep,
    quiet = quietStamp,
    hold = holdInHub,
    onGiveUp = null,
  } = options;
  if (!devices || typeof devices.list !== 'function') throw new Error('Push needs a device list.');
  if (typeof fetchImpl !== 'function') throw new Error('Push needs a fetch function.');

  let keys = vapidInput;
  if (!keys && vapidStore) {
    const stored = vapidStore.load();
    if (stored) {
      if (!validVapidKeys(stored)) throw new Error('Stored VAPID keys are damaged.');
      keys = stored;
    }
  }
  if (!keys) {
    keys = generateVapidKeys();
    if (vapidStore) vapidStore.save(keys);
  }
  if (!validVapidKeys(keys)) throw new Error('VAPID keys are not valid.');

  const authCache = new Map(); // origin -> { value, madeMs }

  function authFor(endpoint, nowMs) {
    const origin = new URL(endpoint).origin;
    const hit = authCache.get(origin);
    if (hit && nowMs - hit.madeMs < VAPID_REFRESH_MS) return hit.value;
    const contact = readSettings().contact;
    // A token always names a contact (wave 7): the one in the settings when it is a mailto: or https: address, else VAPID_CONTACT.
    const safeContact = typeof contact === 'string' && /^(mailto:|https:\/\/)\S+$/.test(contact) ? contact : VAPID_CONTACT;
    const value = vapidAuthorization({ endpoint, keys, nowMs, contact: safeContact });
    authCache.set(origin, { value, madeMs: nowMs });
    return value;
  }

  function readSettings() {
    try {
      return settings?.() ?? {};
    } catch {
      return {};
    }
  }

  function readPrefs() {
    const s = readSettings();
    return { ...SWITCH_DEFAULTS, ...(s.push ?? {}) };
  }

  function readComputer() {
    const c = readSettings().computer ?? {};
    return { id: String(c.id ?? ''), name: String(c.name ?? '') };
  }

  // The owner is at the computer while the system has been idle under PRESENCE_IDLE_S, whether or not the Plenum window has focus: the
  // desktop's own notification reaches him there. A locked screen, a long idle or no reading at all count as away.
  async function atComputer() {
    if (typeof presence !== 'function') return false;
    try {
      const answer = await presence();
      if (!answer || typeof answer !== 'object' || answer.ok === false) return false;
      if (answer.locked === true || answer.idleState === 'locked') return false;
      const idle = Number(answer.idleS);
      return Number.isFinite(idle) && idle >= 0 && idle < PRESENCE_IDLE_S;
    } catch {
      return false;
    }
  }

  function phoneInForeground(deviceId, nowMs) {
    if (typeof foreground !== 'function') return false;
    try {
      const at = Number(foreground(deviceId)) || 0;
      const age = nowMs - at;
      return at > 0 && age >= 0 && age < FOREGROUND_WINDOW_MS;
    } catch {
      return false;
    }
  }

  // A 'failed' that carries a notice (still signed out, the hub is down, a routine did not run, a problem summary) is not a run that
  // ended: it is something Plenum needs the owner to know, so it follows the approvals switch with the needs-you notices, not "Finished
  // runs" (wave 5). Turning the run pushes off no longer turns the problem alerts off with them.
  function switchOn(kind, prefs, event = {}) {
    if (kind === 'approval' || kind === 'handover' || kind === 'needs') return prefs.approvals !== false;
    if (kind === 'failed' && event.notice) return prefs.approvals !== false;
    if (kind === 'finished' || kind === 'failed') return prefs.finished !== false;
    if (kind === 'limit') return prefs.limits !== false;
    return true;
  }

  function outcome(deviceId, result, extra = {}) {
    return { deviceId, outcome: result, ...extra };
  }

  async function wanted(stillWanted) {
    if (typeof stillWanted !== 'function') return true;
    try {
      return (await stillWanted()) !== false;
    } catch {
      return true;
    }
  }

  // One POST to the push service. -> { result: 'sent' | 'removed' | 'retry' | 'failed', status?, reason?, waitMs? }
  async function postOnce(sub, body, urgency, short) {
    const headers = {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(PUSH_TTL_S),
      Urgency: urgency,
    };
    // Every push is signed (wave 7). The phone app registers with its push app (UnifiedPush) under this computer's VAPID key, and a push
    // app that asked for the key (Sunup, an FCM one) refuses an unsigned push; one that does not check it (ntfy) ignores the header.
    headers.Authorization = authFor(sub.endpoint, now());
    let response;
    try {
      response = await fetchImpl(sub.endpoint, {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch {
      log(`push: network error for device ${short}`);
      return { result: 'retry', reason: 'network', waitMs: null };
    }
    const status = Number(response?.status) || 0;
    let waitMs = null;
    try {
      waitMs = retryAfterMs(response.headers?.get?.('retry-after') ?? null, now());
    } catch {
      waitMs = null;
    }
    try {
      await response.arrayBuffer();
    } catch {
      // The status is what matters; the body is discarded.
    }
    if (status === 404 || status === 410) return { result: 'removed', status };
    if (status >= 200 && status < 300) return { result: 'sent', status };
    if (status === 429 || status >= 500) {
      log(`push: busy for device ${short} (HTTP ${status})`);
      return { result: 'retry', status, waitMs };
    }
    log(`push: failed for device ${short} (HTTP ${status})`);
    return { result: 'failed', status };
  }

  async function deliver(device, event, ctx) {
    const deviceId = String(device?.id ?? '');
    const short = deviceId.slice(0, 8);
    if (!deviceId) return outcome('', 'skipped', { reason: 'no-device-id' });
    if (!device.pushSubscription) return outcome(deviceId, 'skipped', { reason: 'no-subscription' });

    let sub;
    try {
      sub = normalizeSubscription(device.pushSubscription, { allowLocalEndpoints });
    } catch (error) {
      const reason = error.code === 'kind-unavailable' ? 'refused' : 'invalid-subscription';
      log(`push: ${reason} for device ${short}`);
      return outcome(deviceId, reason === 'refused' ? 'refused' : 'skipped', { reason });
    }

    // A browser must show a notification for every push, so a clear goes only to the phone app, which takes the notification down itself.
    if (event.kind === 'clear' && sub.kind !== 'unifiedpush') return outcome(deviceId, 'skipped', { reason: 'clear-not-supported' });
    if (!ctx.switchOn) return outcome(deviceId, 'skipped', { reason: 'switch-off' });
    if (ctx.presenceRules) {
      if (ctx.atComputer) return outcome(deviceId, 'skipped', { reason: 'at-computer' });
      if (phoneInForeground(deviceId, ctx.nowMs)) return outcome(deviceId, 'skipped', { reason: 'phone-foreground' });
    }
    if (ctx.quiet) return outcome(deviceId, 'skipped', { reason: 'quiet' });

    let plaintext;
    let urgency;
    try {
      const built = buildPushText(event, { prefs: ctx.prefs, device, computer: ctx.computer });
      plaintext = Buffer.from(JSON.stringify(built.payload), 'utf8');
      urgency = built.urgency;
      if (plaintext.length > MAX_PAYLOAD_BYTES) throw new Error('Push payload is too large.');
    } catch (error) {
      log(`push: text not built for device ${short}`);
      return outcome(deviceId, 'failed', { reason: 'bad-event' });
    }

    // A device whose key cannot be used fails alone: the other devices are sent all the same.
    let body;
    try {
      body = encryptPushPayload(plaintext, sub);
    } catch {
      log(`push: could not encrypt for device ${short}`);
      return outcome(deviceId, 'failed', { reason: 'bad-subscription' });
    }

    // A network error, a 429 or a 5xx is tried again after about 5 s and 30 s (or the Retry-After, up to 60 s). Before each try again the
    // event is asked whether it is still wanted (an approval that was answered in the meantime is dropped).
    let tries = 0;
    for (;;) {
      tries += 1;
      const answer = await postOnce(sub, body, urgency, short);
      if (answer.result === 'removed') {
        if (typeof removeSubscription === 'function') removeSubscription(deviceId, sub.endpoint);
        log(`push: subscription removed for device ${short} (HTTP ${answer.status})`);
        return outcome(deviceId, 'removed', { status: answer.status, tries });
      }
      if (answer.result === 'sent') {
        log(`push: sent ${event.kind} to device ${short} (HTTP ${answer.status})`);
        return outcome(deviceId, 'sent', { status: answer.status, tries });
      }
      const extra = answer.status ? { status: answer.status } : { reason: answer.reason ?? 'network' };
      // A test notification is a person waiting at the button: one try, and the page says at once that it did not get through.
      const once = event.kind === 'test';
      if (answer.result === 'failed' || once || tries > RETRY_DELAYS_MS.length) {
        if (answer.result === 'retry' && !once) log(`push: gave up for device ${short} after ${tries} tries`);
        if (typeof onGiveUp === 'function' && event.kind !== 'clear' && !once) {
          try {
            onGiveUp({ deviceId, name: String(device.name ?? ''), kind: event.kind, ...extra });
          } catch {
            // The activity log is a courtesy.
          }
        }
        return outcome(deviceId, 'failed', { ...extra, tries });
      }
      await sleep(answer.waitMs ?? RETRY_DELAYS_MS[tries - 1]);
      if (!(await wanted(ctx.stillWanted))) {
        log(`push: ${event.kind} no longer needed for device ${short}`);
        return outcome(deviceId, 'skipped', { reason: 'answered', tries });
      }
    }
  }

  // event: see buildPushText. opts.stillWanted() -> false when the event no longer needs a push (the card was answered). An approval with a
  // stillWanted waits APPROVAL_GRACE_MS first and is dropped when it was answered meanwhile; presence is read after that wait.
  async function sendEvent(event, opts = {}) {
    if (!event || !EVENT_KINDS.includes(event.kind)) throw new Error('Push event kind is not known.');
    const stillWanted = typeof opts?.stillWanted === 'function' ? opts.stillWanted : null;
    if (event.kind === 'approval' && stillWanted) {
      await sleep(APPROVAL_GRACE_MS);
      if (!(await wanted(stillWanted))) {
        return devices.list().map(d => outcome(String(d?.id ?? ''), 'skipped', { reason: 'answered' }));
      }
    }
    const prefs = readPrefs();
    const computer = readComputer();
    const nowMs = now();
    // A test notification is sent on request at the computer, and a clear only takes one down, so presence holds neither.
    const presenceRules = prefs.onlyWhenAway === true && event.kind !== 'test' && event.kind !== 'clear';
    // Quiet hours and mutes (lib/notify.mjs). A notice was stamped by the hub already (the caller drops a quiet one). Every other push is
    // stamped here by its level (QUIET_LEVELS): a finished run is an update and a failed run or a limit a problem, so they are held back in
    // quiet hours; an approval, a hand-over and 'needs' from a business need the owner, so they are sent without sound in quiet hours
    // (wave 5: approvals, hand-overs and limits were not stamped and rang at night). What is held back is written to the hub (hold), so
    // the morning summary counts it and Recent lists it.
    let held = false;
    let silent = event.silent === true;
    const level = event.notice ? '' : QUIET_LEVELS[event.kind] ?? '';
    if (level) {
      const stamp = quiet({ level, business: String(event.businessId ?? ''), nowMs }) ?? {};
      held = stamp.quiet === true;
      silent = silent || stamp.silent === true;
    }
    if (held && level !== 'needs-you') holdForSummary(event, level, { nowMs, computer, hold });
    const sent = silent && event.silent !== true ? { ...event, silent: true } : event;
    const ctx = {
      prefs,
      computer,
      nowMs,
      presenceRules,
      stillWanted,
      quiet: held,
      atComputer: presenceRules ? await atComputer() : false,
      switchOn: event.kind === 'clear' ? true : switchOn(event.kind, prefs, event),
    };
    // Every device at once: one slow or busy push service does not hold the others back.
    const list = devices.list();
    const settled = await Promise.allSettled(list.map(device => deliver(device, sent, ctx)));
    return settled.map((s, i) => (s.status === 'fulfilled' ? s.value : outcome(String(list[i]?.id ?? ''), 'failed', { reason: 'error' })));
  }

  return {
    sendEvent,
    vapidPublicKey: () => keys.publicKey,
  };
}
