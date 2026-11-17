// The native plugins of the Android and iPhone apps, registered for the shell (H6, L18, M7, M11, M15; MOBILE.json mobile.plugins).
//
// Capacitor puts nothing on window.Capacitor.Plugins by itself: a plugin appears there only once JavaScript has called registerPlugin for it,
// which is what each plugin package's own index.js does when it is imported. Until this file existed the shell read Capacitor.Plugins.X for
// plugins that nothing had registered, so on a phone the keys fell back to IndexedDB (not the Keychain or Keystore), the biometric lock was
// unavailable, and share, save, haptics, Back and the camera did nothing.
//
// app.js loads this module with a dynamic import, and only when Capacitor.isNativePlatform() and the page has Capacitor's registerPlugin
// (the harness stub for the Electron suites has neither, so it keeps working from Capacitor.Plugins). The web shell never runs this code.
//
// What is imported and what is registered by name:
//   imported (their JS wrappers hold real logic)   @aparajita/capacitor-secure-storage (keys, prefixes), @aparajita/capacitor-biometric-auth
//                                                  (registers 'BiometricAuthNative', so Capacitor.Plugins.BiometricAuth never exists), and the
//                                                  three app-local plugins under mobile/plugins (pure logic in their core.js).
//   registered by name (the package's index.js is   App, Haptics, Browser, Share, Filesystem, TextZoom, Network, LocalNotifications, the barcode
//   only registerPlugin(name) plus a web fallback)  scanner ('CapacitorBarcodeScanner', whose web fallback would add a camera library to the
//                                                  shell), and the app's own PlenumPrivacy (android/.../PlenumPrivacyPlugin.java).
//   from @capacitor/core itself                    SystemBars (wave 4, m3: the status bar follows Plenum's theme, not only the phone's). Core
//                                                  registers it when it is imported, so it is taken from there: a second registerPlugin of
//                                                  the same name only warns and hands back the same object. Its native side is part of the
//                                                  Capacitor Android library (com.getcapacitor.plugin.SystemBars), registered by the Bridge.
// Those packages stay in mobile/package.json: `cap sync` reads them to wire the native side.
//
// The result of buildNative() is what app.js hands to the store, the lock, the push code and the screens, and what boot.js reads through
// window.plenumNative. Nothing here stores or logs a key: the secure-storage adapter passes values straight through.

import { Capacitor, SystemBars, WebView, registerPlugin } from '@capacitor/core';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { BiometricAuth } from '@aparajita/capacitor-biometric-auth';
import { Dictation } from '../plugins/dictation/src/index.js';
import { IsolatedPreview } from '../plugins/isolated-preview/src/index.js';
import { UnifiedPush, stopCardFromRecord } from '../plugins/unifiedpush/src/index.js';

// The plugins this file registers by name, in one list: the build test looks for each of them in the shell bundle.
export const REGISTERED_NAMES = Object.freeze([
  'App', 'Haptics', 'Browser', 'Share', 'Filesystem', 'TextZoom', 'Network', 'LocalNotifications', 'CapacitorBarcodeScanner', 'PlenumPrivacy',
]);

// Wave 4 (m3): the plugins the shell reads that @capacitor/core registers itself (they are handed over as parts, not registered again).
// SystemBars' style names the bar's background (@capacitor/core SystemBarsStyle; SystemBars.java setAppearanceLightStatusBars(!"DARK")):
// 'DARK' draws light icons, for Plenum's dark page; 'LIGHT' draws dark icons.
export const CORE_NAMES = Object.freeze(['SystemBars']);

// The barcode scanner's option defaults (@capacitor/barcode-scanner 3.x index.js) and enum values (definitions.js), kept here so the shell
// does not bundle the package's web scanner.
const QR_CODE_HINT = 0;
const CAMERA_BACK = 1;
const ORIENTATION_ADAPTIVE = 3;

// The shape store.js reads (getItem({ key }) -> { value }, setItem({ key, value }), removeItem({ key }), keys() -> { keys }), over the
// package's own API (getItem(key) -> string | null, setItem(key, value), removeItem(key), keys() -> string[]).
export function secureStorageAdapter(plugin) {
  return {
    async getItem({ key }) {
      return { value: await plugin.getItem(String(key)) };
    },
    async setItem({ key, value }) {
      await plugin.setItem(String(key), String(value));
    },
    async removeItem({ key }) {
      await plugin.removeItem(String(key));
    },
    async keys() {
      return { keys: await plugin.keys() };
    },
  };
}

// ----- Stop from a notification with no unlock (wave 6, k3) -----
// The notification's Stop button is sent natively (the UnifiedPush plugin's StopReceiver) when the plugin holds that computer's Stop card. The
// cards come from here: the secure-storage adapter is wrapped, and each time the store writes its computers ('computers' under the plugin's
// prefix: pairing, a new Stop key, new ways, Forget) the cards of every record that holds a Stop key go to UnifiedPush.setStopCards, which
// replaces them all, so a forgotten computer's card goes too. A card is only what a Stop-only message needs (core.js stopCardFromRecord):
// never myPriv, the psk or the push key. The handshake counter goes along (noteStopCounter), and a read of the counter answers the higher
// of the store's and the plugin's (a Stop sent from a notification raised it), so the next handshake is above every Stop ever sent.
// Nothing here can fail a store read or write: a plugin that is missing, old or slow (STOP_MIRROR_WAIT_MS) changes nothing, and Stop then
// opens Plenum as before. Nothing is logged.
export const STOP_MIRROR_WAIT_MS = 1500;
const STORE_PREFIX = 'plenum.';
const COMPUTERS_KEY = `${STORE_PREFIX}computers`;
const COUNTER_KEY = /^plenum\.ctr:([0-9a-f]{64})$/;

function within(ms, promise) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// adapter: the secureStorageAdapter shape. up: the UnifiedPush plugin. Answers the same shape, plus syncStopCards() (a first hand-over at start,
// for a phone paired before this existed). waitMs: how long one plugin call may take before it is given up.
export function withStopMirror(adapter, up, { waitMs = STOP_MIRROR_WAIT_MS } = {}) {
  if (!adapter || !up) return adapter;
  const call = (name, arg) => within(waitMs, Promise.resolve().then(() => up[name](arg)));
  let generation = 0;
  const cardsOf = text => {
    let list;
    try { list = JSON.parse(String(text)); } catch { return null; }
    if (!Array.isArray(list)) return null;
    return list.map(r => { try { return stopCardFromRecord(r); } catch { return null; } }).filter(Boolean);
  };
  const hand = async cards => {
    if (!cards) return;
    await call('setStopCards', { cards }).catch(() => {});
  };
  return {
    async getItem({ key }) {
      const answer = await adapter.getItem({ key });
      const m = COUNTER_KEY.exec(String(key));
      if (!m) return answer;
      try {
        const native = Number((await call('stopCounters'))?.counters?.[m[1]]);
        let mine = null;
        try { mine = answer?.value === null || answer?.value === undefined ? null : JSON.parse(String(answer.value)); } catch { mine = null; }
        if (Number.isSafeInteger(native) && native > 0 && !(Number.isSafeInteger(mine) && mine >= native)) return { value: JSON.stringify(native) };
      } catch {
        // The store's own counter stands.
      }
      return answer;
    },
    async setItem({ key, value }) {
      await adapter.setItem({ key, value });
      if (key === COMPUTERS_KEY) {
        generation += 1;
        await hand(cardsOf(value));
        return;
      }
      const m = COUNTER_KEY.exec(String(key));
      if (m) {
        let counter = null;
        try { counter = JSON.parse(String(value)); } catch { counter = null; }
        if (Number.isSafeInteger(counter) && counter >= 0) await call('noteStopCounter', { computer: m[1], counter }).catch(() => {});
      }
    },
    async removeItem({ key }) {
      await adapter.removeItem({ key });
      if (key === COMPUTERS_KEY) {
        generation += 1;
        await hand([]);
      }
    },
    keys: () => adapter.keys(),
    // The cards of the computers the store holds now. A write of the computers that comes while this reads wins: this one then sends nothing.
    async syncStopCards() {
      const at = generation;
      let answer;
      try { answer = await adapter.getItem({ key: COMPUTERS_KEY }); } catch { return false; }
      if (at !== generation) return false;
      const text = answer?.value;
      const cards = text === null || text === undefined ? [] : cardsOf(text);
      if (!cards) return false;
      await hand(cards);
      return true;
    },
  };
}

// The scan result as the shell wants it: { ok, text } or { ok: false, reason: 'denied' | 'cancelled' | 'failed' }.
export function scanOutcome(error, result) {
  if (!error) {
    const text = typeof result?.ScanResult === 'string' ? result.ScanResult : '';
    return text ? { ok: true, text } : { ok: false, reason: 'cancelled' };
  }
  const said = `${error?.code ?? ''} ${error?.message ?? error ?? ''}`;
  if (/permission|denied|not authori[sz]ed|restricted/i.test(said)) return { ok: false, reason: 'denied' };
  if (/cancel|dismiss|closed/i.test(said)) return { ok: false, reason: 'cancelled' };
  return { ok: false, reason: 'failed' };
}

// parts: { registerPlugin, WebView, SystemBars, SecureStorage, BiometricAuth, Dictation, IsolatedPreview, UnifiedPush }. The Node suites pass fakes.
// platform: Capacitor.getPlatform(), 'android' | 'ios' | 'web'. Only iOS has the Keychain setting.
export function buildNative(parts, { platform = '' } = {}) {
  const register = parts.registerPlugin;
  const scanner = register('CapacitorBarcodeScanner');
  const plugins = {
    App: register('App'),
    Haptics: register('Haptics'),
    Browser: register('Browser'),
    Share: register('Share'),
    Filesystem: register('Filesystem'),
    TextZoom: register('TextZoom'),
    Network: register('Network'),
    LocalNotifications: register('LocalNotifications'),
    PlenumPrivacy: register('PlenumPrivacy'),
  };
  // Wave 6 (k3): on Android the store's writes of its computers also hand the Stop cards to the UnifiedPush plugin (withStopMirror).
  const storage = secureStorageAdapter(parts.SecureStorage);
  return {
    ...plugins,
    secureStorage: platform === 'android' && parts.UnifiedPush ? withStopMirror(storage, parts.UnifiedPush) : storage,
    // Settings the shell wants for the keys: never synchronised to iCloud, and on this device only. On iOS the Keychain setting must hold:
    // when it cannot be set, this throws, and app.js treats a throwing loadPlugins as no secure storage, so no key is stored.
    async configureStorage() {
      await Promise.resolve(parts.SecureStorage.setSynchronize?.(false)).catch(() => {});   // off is the plugin's default too
      if (platform !== 'ios') return;
      if (typeof parts.SecureStorage.setDefaultKeychainAccess !== 'function') throw new Error('keychain access cannot be set');
      await parts.SecureStorage.setDefaultKeychainAccess(1); // whenUnlockedThisDeviceOnly; a refusal throws, so no key is stored
    },
    BiometricAuth: parts.BiometricAuth,
    SystemBars: parts.SystemBars ?? null,
    WebView: parts.WebView,
    UnifiedPush: parts.UnifiedPush,
    Dictation: parts.Dictation,
    IsolatedPreview: parts.IsolatedPreview,
    BarcodeScanner: {
      // Scans one QR code. The result is { ok, text } or { ok: false, reason }.
      async scan(options = {}) {
        try {
          const result = await scanner.scanBarcode({
            hint: QR_CODE_HINT,
            scanInstructions: ' ',
            scanButton: false,
            scanText: ' ',
            cameraDirection: CAMERA_BACK,
            scanOrientation: ORIENTATION_ADAPTIVE,
            ...options,
          });
          return scanOutcome(null, result);
        } catch (error) {
          return scanOutcome(error, null);
        }
      },
    },
    names: [...REGISTERED_NAMES],
  };
}

// The real plugins. Called once by app.js on a phone.
export async function loadNativePlugins() {
  const native = buildNative({ registerPlugin, WebView, SystemBars, SecureStorage, BiometricAuth, Dictation, IsolatedPreview, UnifiedPush }, { platform: Capacitor.getPlatform() });
  await native.configureStorage();
  // Wave 6 (k3): a phone paired before the native Stop existed hands its Stop cards over now, not only at the store's next write.
  Promise.resolve(native.secureStorage.syncStopCards?.()).catch(() => {});
  return native;
}
