// What kind of page this is, shared by boot.js (the UI page's shim) and app.js (the shell). One module, so both say the same thing in the
// handshake and on the screens (M8: app.js used to look for a /p/<key>/ path while boot.js looked at the origin, so one phone reported two
// different capability lists). No side effects at import: boot.js installs itself when it loads, so app.js must not import boot.js.

// The LAN page is the one the computer serves over plain http on the phone's own network (proxy.serveUi). It is not a secure context, so
// it has no service worker and no Web Push, and its artifact is a picture (a plain navigation to the listener would answer 404). Found by
// the origin, not by the path: the UI document of the LAN page is served at /, and the shell's own page at /p/<key>/ is the same origin.
// localhost and loopback count as a development page, not a LAN.
export function isLanPage(win) {
  const loc = win?.location ?? {};
  if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(String(loc.hostname ?? ''))) return false;
  return win?.isSecureContext === false || String(loc.protocol ?? '') === 'http:';
}

export function isNative(win) {
  return win?.Capacitor?.isNativePlatform?.() === true;
}

export function platformFor(win) {
  const cap = win?.Capacitor;
  if (cap?.isNativePlatform?.() !== true) return 'web';
  return String(cap.getPlatform?.() ?? 'ios') === 'android' ? 'android' : 'ios';
}

// The phone's own caps, as the shell reports them in its handshake (MOBILE.json handshake caps).
export function capsFor(win) {
  if (isNative(win)) return ['ui-bundled', 'artifacts-picture', 'push-none', 'share', 'save', 'camera', 'lan-control'];
  return isLanPage(win) ? ['ui-from-desktop', 'artifacts-picture', 'push-none', 'share', 'save'] : ['ui-from-desktop', 'artifacts-iframe', 'push-webpush', 'share', 'save'];
}

// { app, name } for the handshake: 'android' | 'ios' on a native app, 'lan-web' on the LAN page, 'pwa' everywhere else.
export function appKindFor(win) {
  if (isNative(win)) return { app: platformFor(win), name: 'This phone' };
  if (isLanPage(win)) return { app: 'lan-web', name: 'This browser' };
  return { app: 'pwa', name: 'This phone (web app)' };
}

// The page the person is looking at: the shell's own screens (index.html of the shell, marked data-shell-page) or the desktop's UI (marked
// data-surface="phone" by rewriteIndex, and "phone" or "wide" by boot.js, surfaceFor). Without a document (a Node suite) it is the shell.
export function pageKindFor(win) {
  const root = win?.document?.documentElement;
  if (!root || typeof root.hasAttribute !== 'function') return 'shell';
  if (root.hasAttribute('data-shell-page')) return 'shell';
  const surface = typeof root.getAttribute === 'function' ? root.getAttribute('data-surface') : null;
  if (surface === 'phone' || surface === 'wide') return 'ui';
  return 'shell';
}

// Wave 5 (brb): the layout of the remote UI page. 'wide' is the desktop's own layout (sidebar and chat side by side) under the shell's Stop,
// strip and lock; 'phone' is the phone frame (ext-phone.js). A wide window with a mouse or a trackpad gets 'wide'; a touch-only device (an iPad
// without a trackpad) and anything under 1000 px gets 'phone'. The person can pin either in the shell's settings (LAYOUT_KEY in
// localStorage). The native apps are always 'phone'. The layout is chosen once per page load: a window that is resized past the line is
// offered a reload (boot.js), never switched live.
export const WIDE_QUERY = '(min-width: 1000px) and (hover: hover) and (pointer: fine)';
export const LAYOUT_KEY = 'plenum-layout';
export const LAYOUTS = Object.freeze(['phone', 'wide']);

// The layout the person chose on this device ('phone' or 'wide'), or null for Automatic. Storage that cannot be read is Automatic.
export function savedLayout(win) {
  try {
    const value = win?.localStorage?.getItem(LAYOUT_KEY) ?? null;
    return LAYOUTS.includes(value) ? value : null;
  } catch {
    return null;
  }
}

// What the window itself calls for: 'wide' when the query matches, else 'phone'.
export function windowLayout(win) {
  try {
    return win?.matchMedia?.(WIDE_QUERY)?.matches === true ? 'wide' : 'phone';
  } catch {
    return 'phone';
  }
}

export function surfaceFor(win) {
  if (isNative(win)) return 'phone';
  return savedLayout(win) ?? windowLayout(win);
}

// "<Browser> on <System>", the default name of a browser on its Welcome and review screens. navigator.userAgentData first (its brands
// and platform), then the user-agent string. Edge's string carries "Edg/" and Opera's "OPR/", both beside "Chrome/"; Chrome's carries
// "Safari/" too, so the order of the checks matters. A browser or a system that cannot be told is left out ("Browser on Windows",
// "Firefox"); with neither it is "This browser".
const BRAND_NAMES = Object.freeze([[/edge/i, 'Edge'], [/opera/i, 'Opera'], [/firefox/i, 'Firefox'], [/safari/i, 'Safari'], [/google chrome|^chrome$/i, 'Chrome']]);
function browserOf(win) {
  const brands = win?.navigator?.userAgentData?.brands;
  if (Array.isArray(brands)) {
    const names = brands.map(b => String(b?.brand ?? ''));
    for (const [pattern, name] of BRAND_NAMES) if (names.some(n => pattern.test(n))) return name;
  }
  const ua = String(win?.navigator?.userAgent ?? '');
  if (/\bEdg(e|A|iOS)?\//.test(ua)) return 'Edge';
  if (/\bOPR\/|\bOpera\b/.test(ua)) return 'Opera';
  if (/\bFirefox\/|\bFxiOS\//.test(ua)) return 'Firefox';
  if (/\bChrome\/|\bCriOS\//.test(ua)) return 'Chrome';
  if (/\bSafari\//.test(ua) && /\bVersion\//.test(ua)) return 'Safari';
  if (Array.isArray(brands) && brands.some(b => /chromium/i.test(String(b?.brand ?? '')))) return 'Chrome';
  return '';
}

function systemOf(win) {
  const platform = String(win?.navigator?.userAgentData?.platform ?? '');
  if (/^windows$/i.test(platform)) return 'Windows';
  if (/^macos$/i.test(platform)) return 'macOS';
  if (/^chrome ?os$/i.test(platform)) return 'ChromeOS';
  if (/^android$/i.test(platform)) return 'Android';
  if (/^linux$/i.test(platform)) return 'Linux';
  const ua = String(win?.navigator?.userAgent ?? '');
  if (/\bCrOS\b/.test(ua)) return 'ChromeOS';
  if (/\bWindows\b/.test(ua)) return 'Windows';
  if (/\biPhone\b/.test(ua)) return 'iPhone';
  if (/\biPad\b/.test(ua)) return 'iPad';
  if (/\bAndroid\b/.test(ua)) return 'Android';
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) return 'macOS';
  if (/\bLinux\b|\bX11\b/.test(ua)) return 'Linux';
  return '';
}

export function browserName(win) {
  const browser = browserOf(win);
  const system = systemOf(win);
  if (browser && system) return `${browser} on ${system}`;
  if (browser) return browser;
  if (system) return `Browser on ${system}`;
  return 'This browser';
}
