// The shell screens' actions that call the shell core (mob-10 fix, wave 106). main.js calls these and the screens move on only when
// the result says ok: true, so a button never advances past a step the phone did not complete. Plain functions with no DOM: the core
// is passed in, so the Node suite drives every one with a fake core. Nothing here stores or reads a key, a token or a Noise value.

// Calls one core method. A method the core does not have answers unavailable, and a thrown error answers failed.
// A result of true, or an object whose ok is true, is a success; anything else is a failure with its reason.
export async function call(core, name, ...args) {
  const fn = core?.[name];
  if (typeof fn !== 'function') return { ok: false, reason: 'unavailable' };
  try {
    const out = await fn.apply(core, args);
    if (out === true) return { ok: true, reason: null };
    if (out && typeof out === 'object') {
      const ok = out.ok === true;
      return { ...out, ok, reason: ok ? (out.reason ?? null) : (out.reason ?? 'failed') };
    }
    return { ok: false, reason: 'failed' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

export function enableLockFlow(core, mode) {
  return call(core, 'enableLock', mode);
}

export function enableNotificationsFlow(core) {
  return call(core, 'enableNotifications');
}

export function unlockFlow(core, method, arg = null) {
  return call(core, 'unlock', method, arg);
}

// Unlocks with the method the lock uses, then stops everything. Stop is sent only after the unlock succeeded.
export async function unlockAndStopFlow(core, method) {
  const result = await unlockFlow(core, method);
  if (!result.ok) return result;
  try {
    await core.stop?.();
  } catch {
    return { ...result, stopped: false };
  }
  return { ...result, stopped: true };
}

// Forgets the computer this phone is paired with. The core answers with a state snapshot, not an ok flag.
export async function forgetFlow(core, id) {
  if (typeof core?.forget !== 'function' || !id) return { ok: false, reason: 'unavailable' };
  try {
    await core.forget(id);
    return { ok: true, reason: null };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

// Opens a https link outside the app. Null means the link is not published in this build, so nothing is opened and nothing is made up.
// The legal texts are the ones in the public repository (legal/PRIVACY.md and legal/THIRD-PARTY-SERVICES.md; the Legal screen's rows are keyed
// license, privacy and third). The Apple privacy rule (5.1.2(i)) needs the Privacy Notice link to open from the consent screen. The store
// buttons: the web page and the Android app come from the repository's releases; the iPhone app has no store page yet, so it stays null and
// the screen says so until the app is published.
const REPO = 'https://github.com/literallyisyou/Plenum';
export const LEGAL_LINKS = Object.freeze({
  privacy: `${REPO}/blob/main/legal/PRIVACY.md`,
  'third-party': `${REPO}/blob/main/legal/THIRD-PARTY-SERVICES.md`,
  license: `${REPO}/blob/main/legal/EULA.md`,
  third: `${REPO}/blob/main/THIRD-PARTY-NOTICES.txt`,
});
export const STORE_LINKS = Object.freeze({ ios: null, android: `${REPO}/releases`, web: `${REPO}/releases` });
// The free push app Plenum's Android notifications come through (wave 4, m2): its Play store page (the Get ntfy button) and its F-Droid page
// (shown as text under it).
export const NTFY_LINKS = Object.freeze({
  play: 'https://play.google.com/store/apps/details?id=io.heckel.ntfy',
  fdroid: 'https://f-droid.org/packages/io.heckel.ntfy/',
});

export function openLinkFlow(env, href) {
  if (!href) return { ok: false, reason: 'not-configured' };
  let url;
  try {
    url = new URL(String(href));
  } catch {
    return { ok: false, reason: 'bad-link' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'bad-link' };
  const browser = env?.Capacitor?.Plugins?.Browser;
  if (browser?.open) {
    Promise.resolve(browser.open({ url: url.href })).catch(() => {});
    return { ok: true, reason: null };
  }
  if (typeof env?.open === 'function') {
    env.open(url.href, '_blank', 'noopener');
    return { ok: true, reason: null };
  }
  return { ok: false, reason: 'unavailable' };
}

// The phone's own Settings page is not reachable from the web shell, so the screen shows the manual path (MOBILE-UI 6.4 and 6.6).
export function openSettingsFlow() {
  return { ok: false, reason: 'manual' };
}

// The name the person typed, cleaned for the pairing: trimmed, control and bidirectional characters out, 60 characters at most.
export function cleanPhoneName(text, fallback) {
  const cleaned = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '')
    .trim()
    .slice(0, 60)
    .trim();
  return cleaned || fallback;
}

// ---- Wave 5 (brb): the code page at /pair/ ----

// The code as the computer checks it: spaces and dashes out. Twelve letters and digits, or null (nothing is sent then).
export function claimCodeOf(text) {
  const code = String(text ?? '').replace(/[\s-]+/g, '');
  return /^[0-9A-Za-z]{12}$/.test(code) ? code : null;
}

// The link the computer answers with, when it is a pairing link of this page's own origin (/p/<32 hex>/#pair=...), else null.
export function claimLinkOk(link, origin) {
  const text = String(link ?? '');
  if (text.length > 8192) return null;
  try {
    const url = new URL(text);
    if (url.origin !== String(origin ?? '')) return null;
    if (!/^\/p\/[0-9a-f]{32}\/$/.test(url.pathname) || !/^#pair=[A-Za-z0-9_-]+$/.test(url.hash)) return null;
    return url.href;
  } catch {
    return null;
  }
}

// POST /pair/claim { code } (same origin, JSON). Resolves { ok: true, link } or { ok: false, error }: wrong, none, locked, too-many (the
// computer's answers), or network (no answer, or one this page cannot use). The link is handed back once and kept nowhere (no web storage).
export async function claimFlow(env, text) {
  const code = claimCodeOf(text);
  if (!code) return { ok: false, error: 'wrong' };
  const fetchFn = typeof env?.fetch === 'function' ? env.fetch.bind(env) : null;
  if (!fetchFn) return { ok: false, error: 'network' };
  let res;
  try {
    res = await fetchFn('/pair/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
    });
  } catch {
    return { ok: false, error: 'network' };
  }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (res.status === 200) {
    const link = claimLinkOk(body?.link, env?.location?.origin);
    return link ? { ok: true, link } : { ok: false, error: 'network' };
  }
  const error = String(body?.error ?? '');
  if (['wrong', 'none', 'locked', 'too-many'].includes(error)) return { ok: false, error };
  if (error === 'bad-request' || error === 'too-large') return { ok: false, error: 'wrong' };
  return { ok: false, error: 'network' };
}
