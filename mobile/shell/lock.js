// App lock (mob-10, wave 104; MOBILE.json mobile.app_lock; MOBILE-UI 6.9 and 6.13).
//   native: biometric (@aparajita/capacitor-biometric-auth, device passcode fallback). Default on. The Noise private keys are read
//           from secure storage only after the biometric check passes.
//   PWA:    a passkey (WebAuthn, platform authenticator, user verification) or a six-digit PIN. The PIN wraps every private key
//           with AES-GCM under a key from PBKDF2-SHA256 (600 000 iterations), mixed with a non-extractable device key (HMAC, v2
//           records; v1 records from before are migrated at the next right PIN). Both are off by default on the PWA.
// Re-lock after five minutes in the background, or on demand. A stolen unlocked phone has full power; the desktop's Remove is the
// real revoke. That warning is a notice in the screens, not a restriction here.
// Wave 4 (m3): on the Android app a biometric unlock is remembered in the app's memory (createUnlockMemory), so the next page of the same
// app (the shell page and the UI page are separate documents) starts unlocked when it loads within the lock time. A lock by the person, Lock
// now and a real background timeout forget it. The PIN mode does not use it: its keys need the PIN.
//
// The PIN check: a verifier (a known string under the PIN key, AES-GCM) decides the PIN; a wrong PIN counts up. From the fifth
// wrong try the wait is 30 s and doubles on each further wrong try, up to 15 minutes (pinWaitSeconds). The count and the wait end
// are kept in the store, so a restart does not reset them.

import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { gcm } from '@noble/ciphers/aes.js';

export const PIN_ITERATIONS = 600000;
export const PIN_LENGTH = 6;
export const PIN_KEY_BYTES = 32;
// The bounds a stored PIN record must meet before it is derived (a damaged or forged record is refused, not run for hours).
export const PIN_MIN_ITERATIONS = 100000;
export const PIN_MAX_ITERATIONS = 10000000;
const DEVICE_META = 'pin-device';
export const BACKGROUND_LOCK_MS = 5 * 60 * 1000;
export const PIN_WAIT_FROM = 5;
export const PIN_WAIT_CAP_S = 900;
const VERIFIER_TEXT = new TextEncoder().encode('plenum-pin-check/1');
const VERIFIER_AAD = new TextEncoder().encode('plenum-lock-verifier');

// Seconds the PIN pad waits after this many wrong tries: 0 below five, then 30, 60, 120 ... up to 900.
export function pinWaitSeconds(failures) {
  if (!Number.isSafeInteger(failures) || failures < PIN_WAIT_FROM) return 0;
  return Math.min(PIN_WAIT_CAP_S, 30 * 2 ** (failures - PIN_WAIT_FROM));
}

const b64u = {
  enc(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(text) {
    const s = String(text).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

export function isValidPin(pin) {
  return typeof pin === 'string' && new RegExp(`^[0-9]{${PIN_LENGTH}}$`).test(pin);
}

// A PIN wrap of a key: { v: 1, iv, ct } (b64url). The computer id is the associated data, so a wrap cannot move between records.
export function wrapKey(keyBytes, pinKey, computerId) {
  const iv = randomBytes(12);
  const ct = gcm(pinKey, iv, new TextEncoder().encode(`plenum-key/${computerId}`)).encrypt(keyBytes);
  return { v: 1, iv: b64u.enc(iv), ct: b64u.enc(ct) };
}

export function unwrapKey(wrap, pinKey, computerId) {
  if (!wrap || wrap.v !== 1) throw new Error('bad wrap');
  const plain = gcm(pinKey, b64u.dec(wrap.iv), new TextEncoder().encode(`plenum-key/${computerId}`)).decrypt(b64u.dec(wrap.ct));
  if (plain.byteLength !== PIN_KEY_BYTES) throw new Error('bad key');
  return plain;
}

export function derivePinKey(pin, salt, iterations = PIN_ITERATIONS) {
  return pbkdf2(sha256, new TextEncoder().encode(pin), salt, { c: iterations, dkLen: PIN_KEY_BYTES });
}

// The WebAuthn gate. `credentials` is navigator.credentials, `PublicKeyCredential` the constructor (both missing on a page that is not
// a secure context, which is then "not available"). Only a local check: the credential proves a user-verified platform authenticator
// answered on this device; nothing is sent to a server.
export function createPasskeyGate({ credentials = globalThis.navigator?.credentials, PublicKeyCredentialCtor = globalThis.PublicKeyCredential, rpId = globalThis.location?.hostname ?? 'localhost', random = randomBytes } = {}) {
  return {
    async available() {
      if (!credentials || !PublicKeyCredentialCtor) return false;
      try {
        return (await PublicKeyCredentialCtor.isUserVerifyingPlatformAuthenticatorAvailable?.()) === true;
      } catch {
        return false;
      }
    },
    async register() {
      const cred = await credentials.create({
        publicKey: {
          challenge: random(32),
          rp: { name: 'Plenum', id: rpId },
          user: { id: random(16), name: 'plenum-phone', displayName: 'Plenum on this phone' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
          timeout: 60000,
        },
      });
      if (!cred || !cred.rawId) throw new Error('no passkey');
      return b64u.enc(new Uint8Array(cred.rawId));
    },
    async verify(credentialId) {
      const assertion = await credentials.get({
        publicKey: {
          challenge: random(32),
          allowCredentials: [{ type: 'public-key', id: b64u.dec(credentialId) }],
          userVerification: 'required',
          timeout: 60000,
        },
      });
      return assertion !== null && assertion !== undefined;
    },
  };
}

// The native biometric gate: `plugin` is Capacitor.Plugins.BiometricAuth (checkBiometry, authenticate).
export function createBiometricGate({ plugin = null } = {}) {
  return {
    async available() {
      if (!plugin) return false;
      try {
        const answer = await plugin.checkBiometry();
        return answer?.isAvailable === true;
      } catch {
        return false;
      }
    },
    async verify(reason = 'Unlock Plenum') {
      if (!plugin) return false;
      try {
        await plugin.authenticate({ reason, allowDeviceCredential: true, cancelTitle: 'Cancel', iosFallbackTitle: 'Use passcode' });
        return true;
      } catch {
        return false;
      }
    },
  };
}

// Wave 4 (m3): how long launch waits for the app's answer on a recent unlock before it asks for the fingerprint as before.
export const UNLOCK_FRESH_WAIT_MS = 1500;

// Wave 4 (m3): the app's memory of a recent biometric unlock. On Android the shell page and the UI page are separate documents, and each
// one starts locked; without this the fingerprint was asked again on every page switch. `plugin` is the PlenumPrivacy plugin of the app:
// markUnlocked() keeps the time in the app's memory (a static field, never on disk), unlockFresh({ maxAgeMs }) -> { fresh } is true only when
// that time is younger than maxAgeMs and the app was neither in the background longer than that nor had its screen turned off since, and
// clearUnlocked() forgets it. An older app has none of the three (Capacitor's plugin object then rejects the call): every answer is then
// "not fresh", so launch asks as before. Nothing here is written to localStorage, sessionStorage, the store or any other storage.
export function createUnlockMemory({ plugin = null, waitMs = UNLOCK_FRESH_WAIT_MS, setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout } = {}) {
  const call = (name, arg) => {
    try {
      const fn = plugin?.[name];
      if (typeof fn !== 'function') return null;
      return Promise.resolve(fn.call(plugin, arg)).catch(() => null);
    } catch {
      return null;
    }
  };
  return {
    // true only on the app's own { fresh: true } within waitMs; anything else (no method, a refusal, no answer in time) is false.
    async fresh(maxAgeMs) {
      if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return false;
      const asked = call('unlockFresh', { maxAgeMs: Math.round(maxAgeMs) });
      if (!asked) return false;
      let timer = null;
      const gaveUp = new Promise(resolve => { timer = setTimer?.(() => resolve(null), waitMs); timer?.unref?.(); });
      try {
        const answer = await Promise.race([asked, gaveUp]);
        return answer?.fresh === true;
      } finally {
        if (timer !== null) clearTimer?.(timer);
      }
    },
    mark() { call('markUnlocked', {}); },
    clear() { call('clearUnlocked', {}); },
  };
}

// The lock. `store` is createStore(); `now` is wall time in ms (tests inject a clock). `subtle` is the WebCrypto SubtleCrypto (the device
// key). `mono` is a monotonic clock in ms: a PIN wait also ends only on it, so moving the wall clock forward does not end the wait.
// `memory` (wave 4, m3) is createUnlockMemory(...) on the Android app, else null: only the biometric mode reads it (a PIN must unwrap the keys).
export function createLock({ store, now = () => Date.now(), biometric = null, passkey = null, iterations = PIN_ITERATIONS, subtle = globalThis.crypto?.subtle ?? null, mono = () => globalThis.performance?.now?.() ?? Date.now(), memory = null } = {}) {
  if (!store) throw new TypeError('createLock needs the store');
  let backgroundAt = null;
  let locked = false;
  let settings = null;
  // The derived PIN key, kept only while the phone is unlocked in PIN mode, so a record stored later (a new pairing) is wrapped too.
  let pinKeyHeld = null;
  let monoUntil = 0;
  // Every public call that reads or writes lock state runs after the one before it, so two calls cannot read the same failure count.
  let queue = Promise.resolve();
  const serial = fn => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

  const readSettings = async () => {
    if (!settings) settings = (await store.meta.get('lock')) ?? { mode: 'off', failures: 0, lockedUntil: 0 };
    return settings;
  };
  const writeSettings = async next => {
    settings = next;
    await store.meta.put('lock', next);
  };

  // Every stored record, as its plain key: a record with a PIN wrap needs the PIN key (unwrap), a plain record is returned as is.
  const plainKeys = async pinKey => {
    const out = new Map();
    for (const rec of await store.list()) {
      if (typeof rec.myPriv === 'string') out.set(rec.id, b64u.dec(rec.myPriv));
      else if (rec.myPriv && pinKey) out.set(rec.id, unwrapKey(rec.myPriv, pinKey, rec.id));
    }
    return out;
  };

  // The seconds left on a PIN wait: the wall-clock end kept in the store, or the end this page set on its monotonic clock, whichever is later.
  const lockout = s => {
    const wall = s.lockedUntil > now() ? Math.ceil((s.lockedUntil - now()) / 1000) : 0;
    const steady = monoUntil > mono() ? Math.ceil((monoUntil - mono()) / 1000) : 0;
    return Math.max(wall, steady);
  };

  const api = {
    // What the lock screen and Settings show. No key material.
    async status() {
      const s = await readSettings();
      return {
        mode: s.mode,
        locked,
        failures: s.failures ?? 0,
        waitSec: lockout(s),
        biometricAvailable: biometric ? await biometric.available() : false,
        passkeyAvailable: passkey ? await passkey.available() : false,
      };
    },

    // Called once at launch: a lock that is on starts locked. Wave 4 (m3): in biometric mode, a page of the same app that was unlocked a
    // moment ago (freshMs, the app answers through `memory`) starts unlocked, so a page switch does not ask for the fingerprint again.
    async lockOnLaunch({ freshMs = 0 } = {}) {
      const s = await readSettings();
      locked = s.mode !== 'off';
      if (locked && s.mode === 'biometric' && memory && freshMs > 0 && (await memory.fresh(freshMs))) {
        locked = false;
        memory.mark();
      }
      return locked;
    },

    isLocked: () => locked,
    lock() {
      locked = true;
      pinKeyHeld = null;
      memory?.clear();
      return true;
    },

    // Wave 4 (m3): the page is being left (a page switch) while unlocked in biometric mode: the app keeps the time, so the next page starts
    // unlocked if it loads within the time.
    keepUnlocked() {
      if (locked || !memory || settings?.mode !== 'biometric') return false;
      memory.mark();
      return true;
    },

    onBackground() {
      backgroundAt = now();
    },

    async onForeground() {
      const s = await readSettings();
      if (s.mode !== 'off' && backgroundAt !== null && now() - backgroundAt >= BACKGROUND_LOCK_MS) {
        locked = true;
        pinKeyHeld = null;
        memory?.clear();
      }
      backgroundAt = null;
      return locked;
    },

    // The record as it must rest in the store: in PIN mode its private key is wrapped under the PIN key held while unlocked. It refuses
    // (throws 'locked') when the PIN key is not held, so a key is never written plain under a PIN.
    async protect(record) {
      const s = await readSettings();
      if (s.mode !== 'pin') return record;
      if (!pinKeyHeld) throw new Error('locked');
      if (typeof record.myPriv !== 'string') return record;
      return { ...record, myPriv: wrapKey(b64u.dec(record.myPriv), pinKeyHeld, record.id) };
    },

    // The public calls that read or write lock state run one at a time (serial above). The bodies are the *Inner functions below.
    enableBiometric: (...a) => serial(() => enableBiometricInner(...a)),
    unlockBiometric: (...a) => serial(() => unlockBiometricInner(...a)),
    setPin: (...a) => serial(() => setPinInner(...a)),
    unlockPin: (...a) => serial(() => unlockPinInner(...a)),
    enablePasskey: (...a) => serial(() => enablePasskeyInner(...a)),
    unlockPasskey: (...a) => serial(() => unlockPasskeyInner(...a)),
    disable: (...a) => serial(() => disableInner(...a)),
  };

  // The device key: a non-extractable HMAC key in this browser's storage (web only). With it the PIN key is HMAC(device key, PBKDF2(pin)),
  // so a copy of the stored records cannot be searched for the PIN anywhere else. `create` makes the key when there is none yet.
  async function deviceKey(create) {
    if (!subtle || store.kind !== 'web') return null;
    const have = await store.meta.get(DEVICE_META);
    if (have && typeof have === 'object' && have.type === 'secret') return have;
    if (!create) return null;
    const made = await subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    await store.meta.put(DEVICE_META, made);
    return made;
  }

  // The v2 PIN key: HMAC-SHA256(device key, PBKDF2-SHA256(pin)).
  async function pinKeyV2(pin, salt, its, key) {
    const stretched = derivePinKey(pin, salt, its);
    const mixed = new Uint8Array(await subtle.sign('HMAC', key, stretched));
    stretched.fill(0);
    return mixed;
  }

  // Native: biometric on. Returns { ok, keys: Map(id -> key bytes) } or { ok: false, reason }.
  async function enableBiometricInner() {
    settings = null;
    if (!biometric || !(await biometric.available())) return { ok: false, reason: 'unavailable' };
    if (!(await biometric.verify('Turn on app lock for Plenum'))) return { ok: false, reason: 'cancelled' };
    await writeSettings({ mode: 'biometric', failures: 0, lockedUntil: 0 });
    memory?.mark();
    return { ok: true };
  }

  async function unlockBiometricInner() {
    settings = null;
    const s = await readSettings();
    if (s.mode !== 'biometric') return { ok: false, reason: 'mode' };
    if (!(await biometric.verify())) return { ok: false, reason: 'cancelled' };
    locked = false;
    memory?.mark();
    return { ok: true, keys: await plainKeys(null) };
  }

  // PWA: a PIN wraps every key. The keys the caller already holds (the device is unlocked) are wrapped too. Answers the keys (S9): the
  // caller keeps them, so the phone can connect at once without a relock.
  async function setPinInner(pin) {
    settings = null;
    if (!isValidPin(pin)) return { ok: false, reason: 'format' };
    const current = await readSettings();
    if (current.mode !== 'off') return { ok: false, reason: 'mode' };
    const salt = randomBytes(16);
    const dk = await deviceKey(true);
    const pinKey = dk ? await pinKeyV2(pin, salt, iterations, dk) : derivePinKey(pin, salt, iterations);
    const nonce = randomBytes(12);
    const ct = gcm(pinKey, nonce, VERIFIER_AAD).encrypt(VERIFIER_TEXT);
    const keys = await plainKeys(null);
    for (const rec of await store.list()) {
      const key = keys.get(rec.id);
      if (!key) continue;
      const next = { ...rec, myPriv: wrapKey(key, pinKey, rec.id) };
      await store.put(next);
    }
    await store.meta.put('pin', { v: dk ? 2 : 1, salt: b64u.enc(salt), iterations, nonce: b64u.enc(nonce), ct: b64u.enc(ct) });
    await writeSettings({ mode: 'pin', failures: 0, lockedUntil: 0 });
    pinKeyHeld = pinKey;
    return { ok: true, keys };
  }

  async function unlockPinInner(pin) {
    settings = null;
    const s = await readSettings();
    if (s.mode !== 'pin') return { ok: false, reason: 'mode' };
    if (!isValidPin(pin)) return { ok: false, reason: 'format' };
    if (lockout(s) > 0) return { ok: false, reason: 'wait', waitSec: lockout(s), failures: s.failures };
    const pinRecord = await store.meta.get('pin');
    if (!pinRecord) return { ok: false, reason: 'mode' };
    if (!Number.isSafeInteger(pinRecord.iterations) || pinRecord.iterations < Math.min(PIN_MIN_ITERATIONS, iterations) || pinRecord.iterations > PIN_MAX_ITERATIONS) {
      return { ok: false, reason: 'damaged' };
    }
    const salt = b64u.dec(pinRecord.salt);
    let pinKey;
    if (pinRecord.v === 2) {
      const dk = await deviceKey(false);
      if (!dk) return { ok: false, reason: 'damaged' };
      pinKey = await pinKeyV2(pin, salt, pinRecord.iterations, dk);
    } else {
      pinKey = derivePinKey(pin, salt, pinRecord.iterations);
    }
    let right = false;
    try {
      const plain = gcm(pinKey, b64u.dec(pinRecord.nonce), VERIFIER_AAD).decrypt(b64u.dec(pinRecord.ct));
      right = plain.length === VERIFIER_TEXT.length && plain.every((b, i) => b === VERIFIER_TEXT[i]);
    } catch {
      right = false;
    }
    if (!right) {
      const failures = (s.failures ?? 0) + 1;
      const wait = pinWaitSeconds(failures);
      monoUntil = wait > 0 ? mono() + wait * 1000 : 0;
      await writeSettings({ ...s, failures, lockedUntil: wait > 0 ? now() + wait * 1000 : 0 });
      return { ok: false, reason: 'wrong', failures, waitSec: wait };
    }
    // A right PIN on a v1 record (from before the device key) moves it to v2: every key is wrapped under the device-mixed key, then the
    // verifier is written under it. Only in this browser, where the device key can exist.
    let held = pinKey;
    if (pinRecord.v !== 2 && subtle && store.kind === 'web') {
      const made = await deviceKey(true);
      const v2 = await pinKeyV2(pin, salt, pinRecord.iterations, made);
      const keysV1 = await plainKeys(pinKey);
      for (const rec of await store.list()) {
        const key = keysV1.get(rec.id);
        if (!key) continue;
        await store.put({ ...rec, myPriv: wrapKey(key, v2, rec.id) });
      }
      const nonce = randomBytes(12);
      const ct = gcm(v2, nonce, VERIFIER_AAD).encrypt(VERIFIER_TEXT);
      await store.meta.put('pin', { v: 2, salt: pinRecord.salt, iterations: pinRecord.iterations, nonce: b64u.enc(nonce), ct: b64u.enc(ct) });
      held = v2;
    }
    await writeSettings({ ...s, failures: 0, lockedUntil: 0 });
    locked = false;
    pinKeyHeld = held;
    return { ok: true, keys: await plainKeys(held) };
  }

  // PWA: a passkey check. The keys are plain in this mode (no PIN wrap), so the record is read after the check.
  async function enablePasskeyInner() {
    settings = null;
    if (!passkey || !(await passkey.available())) return { ok: false, reason: 'unavailable' };
    const credentialId = await passkey.register();
    await store.meta.put('passkey', { id: credentialId });
    await writeSettings({ mode: 'passkey', failures: 0, lockedUntil: 0 });
    return { ok: true };
  }

  async function unlockPasskeyInner() {
    settings = null;
    const s = await readSettings();
    if (s.mode !== 'passkey') return { ok: false, reason: 'mode' };
    const record = await store.meta.get('passkey');
    if (!record || !(await passkey.verify(record.id))) return { ok: false, reason: 'cancelled' };
    locked = false;
    return { ok: true, keys: await plainKeys(null) };
  }

  // Turns the lock off. Biometric and passkey ask the person first (a failed check changes nothing). From a PIN, the keys are unwrapped
  // with the PIN first and stored plain again, and the device key is removed.
  async function disableInner({ pin = null } = {}) {
    settings = null;
    const s = await readSettings();
    if (s.mode === 'biometric') {
      if (!(await biometric?.verify('Turn off app lock for Plenum'))) return { ok: false, reason: 'cancelled' };
    } else if (s.mode === 'passkey') {
      const rec = await store.meta.get('passkey');
      if (!rec || !(await passkey?.verify(rec.id))) return { ok: false, reason: 'cancelled' };
    }
    if (s.mode === 'pin') {
      const unlocked = await unlockPinInner(pin);
      if (!unlocked.ok) return unlocked;
      for (const rec of await store.list()) {
        const key = unlocked.keys.get(rec.id);
        if (key) await store.put({ ...rec, myPriv: b64u.enc(key) });
      }
      await store.meta.remove('pin');
      await store.meta.remove(DEVICE_META);
    } else if (s.mode === 'passkey') {
      await store.meta.remove('passkey');
    }
    await writeSettings({ mode: 'off', failures: 0, lockedUntil: 0 });
    locked = false;
    pinKeyHeld = null;
    memory?.clear();
    return { ok: true };
  }

  return api;
}
