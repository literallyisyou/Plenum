import { randomBytes, timingSafeEqual } from 'node:crypto';

export const CHROME_ORIGIN = 'chrome-extension://oemhjeifgagepiidpdnngfeidkbibmgf';
const extensionPaths = new Set(['/api/chrome-share/pair', '/api/chrome-share/share', '/api/chrome-share/disconnect']);
export const chromeExtensionRequest = (method, pathname) => extensionPaths.has(pathname)
  && (method === 'POST' || method === 'OPTIONS');

const root = '/api/chrome-share/';
const changed = events => events.publish({ type: 'chrome-share' });
const pairTtl = 6 * 60_000;
const shareTtl = 15 * 60_000;
const reviewTtl = 30_000;
const selectionLimit = 4000;
let pairing;
let capability;
let pending;
let review;

export function onChromeLoopback(req) {
  return ['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
    && !req.headers['x-plenum-device'] && !req.headers.forwarded && !req.headers['x-forwarded-for'];
}

function matches(actual, expected) {
  return typeof actual === 'string' && typeof expected === 'string' && actual.length === expected.length
    && /^[a-f0-9]+$/.test(actual) && timingSafeEqual(Buffer.from(actual, 'ascii'), Buffer.from(expected, 'ascii'));
}

function pageShare(body, httpError) {
  let url;
  try {
    if (typeof body.url !== 'string' || body.url.length > 2048) throw new Error();
    url = new URL(body.url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  } catch {
    throw httpError(400, 'Share a web tab with a valid HTTP or HTTPS address.');
  }
  url.username = url.password = url.search = url.hash = '';
  const clean = (value, limit) => typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, limit)
    : '';
  return { id: randomBytes(16).toString('hex'), url: url.href, title: clean(body.title, 180) || url.hostname,
    selection: clean(body.selection, selectionLimit), expiresAt: Date.now() + shareTtl };
}

function currentShare() {
  if (pending?.expiresAt <= Date.now()) pending = undefined;
  if (!pending || review?.expiresAt <= Date.now() || review?.id !== pending.id) review = undefined;
  return pending ?? null;
}

function local(handler) {
  return context => {
    if (!onChromeLoopback(context.req)) throw context.httpError(403, 'Open Chrome sharing on this computer.');
    return handler(context);
  };
}

const owner = [
  { method: 'GET', path: root + 'status', handler: local(({ res, json }) => json(res, 200, {
    paired: Boolean(capability), share: currentShare(),
  })) },
  { method: 'POST', path: root + 'code', handler: local(({ res, json }) => {
    pairing = { code: randomBytes(16).toString('hex'), expiresAt: Date.now() + pairTtl };
    return json(res, 200, pairing);
  }) },
  { method: 'POST', path: root + 'cancel', handler: local(async ({ req, res, json, readBody }) => {
    const body = await readBody(req, 8192);
    // An older drawer must not cancel a replacement code that another window just requested.
    if (body.code === undefined || matches(body.code, pairing?.code)) pairing = undefined;
    return json(res, 200, { ok: true });
  }) },
  { method: 'POST', path: root + 'revoke', handler: local(({ res, json, events }) => {
    pairing = capability = pending = review = undefined;
    changed(events);
    return json(res, 200, { ok: true });
  }) },
  { method: 'POST', path: root + 'take', handler: local(async ({ req, res, json, readBody, httpError, events }) => {
    const body = await readBody(req, 8192);
    const share = currentShare();
    if (!share || body.id !== share.id) throw httpError(409, 'That tab share is no longer waiting.');
    if (review && body.review !== review.token) throw httpError(409, 'That tab is being reviewed in another window. Try again in a moment.');
    if (body.review && !review) throw httpError(409, 'The tab review expired. Review the waiting tab again.');
    pending = review = undefined;
    changed(events);
    return json(res, 200, { share });
  }) },
  // Reserve the waiting share until the renderer has actually inserted it into the chosen chat.
  // Reloading, switching chats, or dropping the reply to this request must leave the original review available.
  { method: 'POST', path: root + 'review', handler: local(async ({ req, res, json, readBody, httpError }) => {
    const body = await readBody(req, 8192);
    const share = currentShare();
    if (!share || body.id !== share.id) throw httpError(409, 'That tab share is no longer waiting.');
    if (review) throw httpError(409, 'That tab is already being reviewed. Try again in a moment.');
    review = { id: share.id, token: randomBytes(16).toString('hex'), expiresAt: Math.min(share.expiresAt, Date.now() + reviewTtl) };
    return json(res, 200, { share, review: review.token, expiresAt: review.expiresAt });
  }) },
  { method: 'POST', path: root + 'release', handler: local(async ({ req, res, json, readBody }) => {
    const body = await readBody(req, 8192);
    currentShare();
    if (review && body.id === review.id && body.review === review.token) review = undefined;
    return json(res, 200, { ok: true });
  }) },
];

async function fromExtension({ req, res, url, json, readBody, httpError, events }) {
  if (!onChromeLoopback(req) || req.headers.origin !== CHROME_ORIGIN) throw httpError(403, 'Chrome sharing requires the Plenum extension on this computer.');
  if (url.pathname === root + 'pair') {
    const body = await readBody(req, 8192);
    if (!pairing || pairing.expiresAt <= Date.now() || !matches(body.code, pairing.code)) {
      throw httpError(403, 'That pairing code is invalid or expired. Get a new code in Plenum.');
    }
    pairing = pending = review = undefined;
    capability = randomBytes(32).toString('hex');
    changed(events);
    return json(res, 200, { capability });
  }
  if (!matches(req.headers['x-plenum-chrome'], capability)) throw httpError(401, 'Connect Chrome again in Plenum.');
  if (url.pathname === root + 'disconnect') {
    pairing = capability = pending = review = undefined;
  } else {
    const body = await readBody(req, 32768);
    if (!matches(req.headers['x-plenum-chrome'], capability)) throw httpError(401, 'Connect Chrome again in Plenum.');
    if (currentShare()) throw httpError(409, 'Review or dismiss the previous tab share in Plenum first.');
    pending = pageShare(body, httpError);
  }
  changed(events);
  return json(res, 200, { ok: true });
}

export const routes = [...owner, ...Array.from(extensionPaths, path => ({ method: 'POST', path, handler: fromExtension }))];
