// Wave 4 package m3: phone feel. Node only, on fakes; nothing here runs on a phone.
//   1. the biometric lock is not asked again on a page switch: the app (PlenumPrivacy) remembers a recent unlock in its memory, and the next page
//      of the app starts unlocked; a stale unlock, an app without the three methods, the PIN mode, Lock now and a real background timeout all
//      still ask; nothing about the unlock is written to localStorage, sessionStorage or the store
//   2. the status bar follows Plenum's theme (SystemBars.setStyle 'DARK' for a dark page, 'LIGHT' for a light one) on the shell page (app.js)
//      and on the UI page (boot.js), and the UI page gets setStyle only
//   3. the shell page's early colour: index.html stays inside the strict CSP and carries the colour metas and the stylesheets before the body;
//      a theme chosen in Plenum is shown on the root before anything is awaited (earlyTheme)
// Run sealed from the mobile folder: bash C:/Users/willi/PlenumWork/mcshots/ultra/seal.sh w4-m3 node --test test/w4-m3-phone-feel.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBiometricGate, createLock, createUnlockMemory, UNLOCK_FRESH_WAIT_MS } from '../shell/lock.js';
import { createStore, STOP_CARDS_KEY } from '../shell/store.js';
import { createShell, earlyTheme, makeFacade, PAGE_SWITCH_FRESH_MS, showEarlyTheme, startShell, THEME_KEY } from '../shell/app.js';
import { installShim } from '../shell/boot.js';
import { buildNative, CORE_NAMES, REGISTERED_NAMES } from '../shell/native.js';
import { cspViolations } from '../../scripts/build-mobile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.join(HERE, '..');
const PROJECT = path.join(MOBILE, '..');
const ITS = 2000;
const FIVE_MIN = 5 * 60 * 1000;

async function settle(rounds = 30) {
  for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve));
}

// ----- fakes -----

// The app's PlenumPrivacy plugin as the shell sees it, with the k1 contract: the stamp lives here (the app's memory), never in the page.
function fakePrivacy(clock, { methods = true, reject = false, silent = false } = {}) {
  const calls = [];
  const state = { stamp: 0, away: 0 };
  const answer = value => (silent ? new Promise(() => {}) : reject ? Promise.reject(Object.assign(new Error('"PlenumPrivacy.unlockFresh()" is not implemented on android'), { code: 'UNIMPLEMENTED' })) : Promise.resolve(value));
  const plugin = {
    calls,
    state,
    async setHideInSwitcher(arg) { calls.push(['hide', arg]); return arg; },
  };
  if (methods) {
    plugin.markUnlocked = () => { calls.push(['mark']); if (!reject && !silent) { state.stamp = clock.now(); state.away = 0; } return answer({}); };
    plugin.unlockFresh = arg => {
      calls.push(['fresh', arg]);
      const max = arg?.maxAgeMs;
      return answer({ fresh: state.stamp > 0 && clock.now() - state.stamp < max && state.away <= max });
    };
    plugin.clearUnlocked = () => { calls.push(['clear']); if (!reject && !silent) state.stamp = 0; return answer({}); };
  }
  return plugin;
}

function fakeBiometric() {
  const bio = { prompts: 0, refuse: false };
  bio.plugin = {
    async checkBiometry() { return { isAvailable: true }; },
    async authenticate() { bio.prompts += 1; if (bio.refuse) throw new Error('cancelled'); },
  };
  return bio;
}

// The secure-storage shape store.js reads (getItem({ key }) -> { value }, ...), recording every write.
function fakeSecureStorage() {
  const items = new Map();
  const writes = [];
  return {
    items,
    writes,
    async getItem({ key }) { return { value: items.has(key) ? items.get(key) : null }; },
    async setItem({ key, value }) { writes.push(['set', key, value]); items.set(key, value); },
    async removeItem({ key }) { writes.push(['remove', key]); items.delete(key); },
    async keys() { return { keys: [...items.keys()] }; },
  };
}

// localStorage / sessionStorage stand-ins that record every call.
function recordingStorage() {
  const map = new Map();
  const calls = [];
  return {
    map,
    calls,
    getItem(k) { calls.push(['get', k]); return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { calls.push(['set', k, String(v)]); map.set(k, String(v)); },
    removeItem(k) { calls.push(['remove', k]); map.delete(k); },
  };
}

function fakeRootStyle() {
  const props = new Map();
  return {
    props,
    setProperty(k, v) { props.set(k, String(v)); },
    removeProperty(k) { props.delete(k); },
    getPropertyValue(k) { return props.get(k) ?? ''; },
  };
}

function fakeScheme(dark = false) {
  const listeners = [];
  const mq = {
    dark,
    get matches() { return mq.dark; },
    addEventListener(type, fn) { if (type === 'change') listeners.push(fn); },
    flip(value) { mq.dark = value; for (const fn of listeners) fn({ matches: value }); },
  };
  return mq;
}

function fakeBars() {
  const calls = [];
  return { calls, async setStyle(arg) { calls.push(arg?.style); }, async hide() { calls.push('hide'); }, async show() { calls.push('show'); } };
}

// One page of the Android app (the shell page or the UI page). The phone's secure storage, the biometric plugin and PlenumPrivacy are the
// phone's (shared by the pages); localStorage and sessionStorage are this page's stand-ins.
function androidPage(phone, { kind = 'shell', scheme = fakeScheme(false), bars = null, local = recordingStorage(), session = recordingStorage() } = {}) {
  const listeners = new Map();
  const attrs = new Map(kind === 'shell' ? [['data-shell-page', '']] : [['data-surface', 'phone']]);
  const root = {
    hasAttribute: k => attrs.has(k),
    getAttribute: k => (attrs.has(k) ? attrs.get(k) : null),
    setAttribute: (k, v) => attrs.set(k, String(v)),
    removeAttribute: k => attrs.delete(k),
    style: fakeRootStyle(),
  };
  const env = {
    location: { href: 'https://localhost/index.html', pathname: '/index.html', search: '', hash: '', hostname: 'localhost', protocol: 'https:', origin: 'https://localhost', assign() {}, replace() {}, reload() {} },
    isSecureContext: true,
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
    androidBridge: {},
    document: { documentElement: root, visibilityState: 'visible' },
    localStorage: local,
    sessionStorage: session,
    matchMedia: () => scheme,
    navigator: {},
    setTimeout,
    clearTimeout,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    fire(type) { for (const fn of listeners.get(type) ?? []) fn({ type }); },
  };
  const plugins = {
    secureStorage: phone.secure,
    BiometricAuth: phone.bio.plugin,
    PlenumPrivacy: phone.privacy,
    ...(bars ? { SystemBars: bars } : {}),
  };
  return { env, root, local, session, scheme, bars, start: () => startShell(env, { loadPlugins: async () => plugins, attach: null, giveCore: () => {} }) };
}

function phone({ privacyOptions } = {}) {
  const clock = { t: 1_000_000, now() { return clock.t; } };
  return { clock, secure: fakeSecureStorage(), bio: fakeBiometric(), privacy: fakePrivacy(clock, privacyOptions) };
}

// Turns the biometric lock on through the shell (the person confirms with the fingerprint once), as Phone settings does.
async function lockOn(p) {
  const page = androidPage(p);
  const shell = await page.start();
  await settle();
  const on = await shell.enableLock('biometric');
  assert.equal(on.ok, true, 'the lock is on');
  await settle();
  return { page, shell };
}

// The writes a page made to a Web Storage stand-in, apart from the Stop cards (store.js keeps them there since before wave 4; with no computer
// paired the sync only removes the key).
function writesOf(storage) {
  return storage.calls.filter(c => c[0] !== 'get' && c[1] !== STOP_CARDS_KEY);
}

// No unlock word, stamp or time in any value the page wrote: the unlock is the app's.
function assertNoStamp(...storages) {
  for (const s of storages) {
    for (const call of s.calls ?? s.writes ?? []) {
      assert.doesNotMatch(JSON.stringify(call), /unlock|fresh|stamp|elapsed/i, `no unlock state in ${JSON.stringify(call)}`);
    }
  }
}

// ----- 1. the lock on a page switch -----

describe('the biometric lock is asked once, not on every page switch (wave 4, m3)', () => {
  it('a page of the app that was unlocked a moment ago starts unlocked: the second boot does not ask; the stamp never reaches the page storage', async () => {
    const p = phone();
    await lockOn(p);
    // A new process: the app's memory is empty (the stamp of the turn-on is gone).
    p.privacy.state.stamp = 0;
    const first = androidPage(p);
    const shellA = await first.start();
    await settle();
    assert.equal(shellA.state().locked, true, 'a cold start asks');
    const promptsBefore = p.bio.prompts;
    assert.equal((await shellA.unlock('biometric')).ok, true);
    assert.equal(p.bio.prompts, promptsBefore + 1);
    assert.ok(p.privacy.calls.some(c => c[0] === 'mark'), 'the unlock is kept in the app\'s memory');
    // The person opens the UI: the shell page is left (pagehide), the UI page loads in the same app a moment later.
    first.env.fire('pagehide');
    p.clock.t += 800;
    const writesBefore = p.secure.writes.length;
    const ui = androidPage(p, { kind: 'ui' });
    const shellB = await ui.start();
    await settle();
    assert.equal(shellB.state().locked, false, 'the UI page starts unlocked');
    assert.equal(p.bio.prompts, promptsBefore + 1, 'no second fingerprint');
    const asked = p.privacy.calls.filter(c => c[0] === 'fresh');
    assert.deepEqual(asked.at(-1)[1], { maxAgeMs: FIVE_MIN }, 'the person\'s lock time (5 minutes by default) is the most the unlock may be old');
    // And back to Phone settings: the shell page again, again unlocked.
    ui.env.fire('pagehide');
    p.clock.t += 500;
    const back = androidPage(p);
    const shellC = await back.start();
    await settle();
    assert.equal(shellC.state().locked, false);
    assert.equal(p.bio.prompts, promptsBefore + 1);
    // Nothing about the unlock is in the page storage or the store.
    for (const page of [first, ui, back]) {
      assert.deepEqual(writesOf(page.local), [], 'localStorage untouched (the theme follows the phone, so no theme copy either)');
      assert.ok(page.session.calls.filter(c => c[0] === 'set').length === 0, 'sessionStorage: nothing written');
      assertNoStamp(page.local, page.session);
    }
    assert.deepEqual(p.secure.writes.slice(writesBefore).filter(w => /lock/.test(String(w[1]))), [], 'the lock record is not rewritten by a page switch');
    assertNoStamp(p.secure);
  });

  it('"Immediately" keeps one minute for page switches only', async () => {
    const p = phone();
    const { shell } = await lockOn(p);
    await shell.setPrefs({ lockAfter: 'immediately' });
    p.privacy.calls.length = 0;
    const next = androidPage(p);
    const s2 = await next.start();
    await settle();
    assert.equal(s2.state().locked, false);
    assert.deepEqual(p.privacy.calls.find(c => c[0] === 'fresh')[1], { maxAgeMs: PAGE_SWITCH_FRESH_MS });
    assert.equal(PAGE_SWITCH_FRESH_MS, 60 * 1000);
  });

  it('a stale unlock still asks', async () => {
    const p = phone();
    await lockOn(p);
    p.clock.t += FIVE_MIN + 1;
    const page = androidPage(p);
    const shell = await page.start();
    await settle();
    assert.equal(shell.state().locked, true);
  });

  it('an app without the three methods (an older APK) asks on every page, exactly as before; so does one whose methods are refused', async () => {
    for (const privacyOptions of [{ methods: false }, { reject: true }]) {
      const p = phone({ privacyOptions });
      await lockOn(p);
      for (let i = 0; i < 2; i++) {
        const page = androidPage(p, { kind: i % 2 ? 'ui' : 'shell' });
        const shell = await page.start();
        await settle();
        assert.equal(shell.state().locked, true, `${JSON.stringify(privacyOptions)} page ${i}`);
        assert.equal((await shell.unlock('biometric')).ok, true);
        page.env.fire('pagehide');
      }
    }
  });

  it('an app that does not answer in time asks (launch waits a moment, never forever)', async () => {
    const clock = { now: () => 1 };
    const memory = createUnlockMemory({ plugin: fakePrivacy(clock, { silent: true }), waitMs: 20 });
    const started = Date.now();
    assert.equal(await memory.fresh(60000), false);
    assert.ok(Date.now() - started < 2000);
    assert.ok(UNLOCK_FRESH_WAIT_MS > 0 && UNLOCK_FRESH_WAIT_MS <= 3000);
    for (const plugin of [null, {}, { unlockFresh: () => { throw new Error('sync'); } }, { unlockFresh: async () => ({ fresh: 'yes' }) }, { unlockFresh: async () => null }]) {
      assert.equal(await createUnlockMemory({ plugin, waitMs: 20 }).fresh(60000), false, JSON.stringify(plugin));
    }
    assert.equal(await createUnlockMemory({ plugin: { unlockFresh: async () => ({ fresh: true }) } }).fresh(0), false, 'no time, no skip');
  });

  it('Lock now forgets the unlock: the next page asks', async () => {
    const p = phone();
    const { shell } = await lockOn(p);
    assert.equal((await shell.lockNow()).ok, true);
    await settle();
    assert.ok(p.privacy.calls.some(c => c[0] === 'clear'));
    const page = androidPage(p, { kind: 'ui' });
    const next = await page.start();
    await settle();
    assert.equal(next.state().locked, true);
  });

  it('a real background timeout locks and forgets the unlock (the person\'s lock time), and leaving a locked page keeps nothing', async () => {
    const p = phone();
    const store = createStore({ kv: memoryKv() });
    const memory = createUnlockMemory({ plugin: p.privacy });
    const wall = { t: 5_000_000, now() { return wall.t; }, setTimeout, clearTimeout };
    const mk = () => createLock({ store, iterations: ITS, now: () => wall.t, biometric: createBiometricGate({ plugin: p.bio.plugin }), memory });
    const lock = mk();
    const shell = createShell({ store, lock, device: { name: 'p', platform: 'android', app: 'android', appVersion: '1', uiHash: '' }, stopClock: wall, createWorker: () => { throw new Error('none'); } });
    await shell.boot();
    assert.equal((await shell.enableLock('biometric')).ok, true);
    await settle();
    await shell.visibility(false);
    wall.t += FIVE_MIN;
    await shell.visibility(true);
    await settle();
    assert.equal(shell.state().locked, true, 'five minutes away locks');
    assert.equal(p.privacy.state.stamp, 0, 'and the app forgot the unlock');
    assert.equal(shell.leavingPage(), false, 'a locked page leaves nothing behind');
    assert.equal(p.privacy.state.stamp, 0);
    // lock.js's own background rule forgets it too.
    const again = mk();
    await again.lockOnLaunch();
    assert.equal((await again.unlockBiometric()).ok, true);
    await settle();
    assert.ok(p.privacy.state.stamp > 0);
    again.onBackground();
    wall.t += FIVE_MIN;
    assert.equal(await again.onForeground(), true);
    await settle();
    assert.equal(p.privacy.state.stamp, 0);
  });

  it('the PIN mode keeps asking: its keys need the PIN, so a fresh unlock is never read', async () => {
    const store = createStore({ kv: memoryKv() });
    const fresh = { calls: 0, async unlockFresh() { fresh.calls += 1; return { fresh: true }; }, async markUnlocked() {}, async clearUnlocked() {} };
    const memory = createUnlockMemory({ plugin: fresh });
    const lock = createLock({ store, iterations: ITS, memory });
    await lock.lockOnLaunch();
    assert.equal((await lock.setPin('123456')).ok, true);
    const next = createLock({ store, iterations: ITS, memory });
    assert.equal(await next.lockOnLaunch({ freshMs: FIVE_MIN }), true, 'locked');
    assert.equal(fresh.calls, 0, 'the app was not even asked');
    assert.equal(next.keepUnlocked(), false);
    // The passkey mode (the web app) does not read it either, and a lock that is off stays off.
    const off = createLock({ store: createStore({ kv: memoryKv() }), memory });
    assert.equal(await off.lockOnLaunch({ freshMs: FIVE_MIN }), false);
    assert.equal(fresh.calls, 0);
  });
});

// A key-value back end over a Map (kind 'web', as shell-lock.test.mjs uses).
function memoryKv() {
  const map = new Map();
  return {
    kind: 'web',
    map,
    get: async key => map.get(key),
    put: async (key, value) => { map.set(key, value); },
    delete: async key => { map.delete(key); },
    keys: async () => [...map.keys()],
  };
}

// ----- 2. the status bar -----

describe('the status bar follows Plenum\'s theme, not only the phone\'s (wave 4, m3)', () => {
  it('SystemBars is handed over from @capacitor/core (not registered twice); the registered names are unchanged', () => {
    const registered = [];
    const parts = {
      registerPlugin: name => { registered.push(name); return { name }; },
      SystemBars: { id: 'bars' },
      SecureStorage: { setSynchronize() {} },
      BiometricAuth: {}, WebView: {}, Dictation: {}, IsolatedPreview: {}, UnifiedPush: {},
    };
    const native = buildNative(parts, { platform: 'android' });
    assert.equal(native.SystemBars, parts.SystemBars);
    assert.equal(registered.includes('SystemBars'), false);
    assert.deepEqual([...registered].sort(), [...REGISTERED_NAMES].sort());
    assert.deepEqual(CORE_NAMES, ['SystemBars']);
    const src = fs.readFileSync(path.join(MOBILE, 'shell', 'native.js'), 'utf8');
    assert.match(src, /import \{[^}]*\bSystemBars\b[^}]*\} from '@capacitor\/core'/);
  });

  // The constant: SystemBars.java draws light icons for every style but DARK. The file comes with the installed Capacitor Android package; a
  // copy of mobile/ without it (the battery's src-bat copy has no Android sources) skips this check and says why. Where it exists it is strict.
  const SYSTEM_BARS_JAVA = path.join(MOBILE, 'node_modules', '@capacitor', 'android', 'capacitor', 'src', 'main', 'java', 'com', 'getcapacitor', 'plugin', 'SystemBars.java');
  const noJava = fs.existsSync(SYSTEM_BARS_JAVA) ? false : `SystemBars.java is not in this copy of mobile/ (${SYSTEM_BARS_JAVA}): the Capacitor Android sources are not installed here, so the DARK-style check is skipped`;
  it('SystemBars.java (Capacitor Android) draws light status-bar icons for every style but DARK', { skip: noJava }, () => {
    const java = fs.readFileSync(SYSTEM_BARS_JAVA, 'utf8');
    assert.match(java, /setAppearanceLightStatusBars\(!style\.equals\(STYLE_DARK\)\)/);
    assert.match(java, /STYLE_DARK = "DARK"/);
  });

  it('the shell page: Dark in Plenum on a light phone sets DARK (light icons); Light sets LIGHT; Follow phone follows the phone\'s change', async () => {
    const p = phone();
    const bars = fakeBars();
    const scheme = fakeScheme(false);
    const first = androidPage(p, { bars, scheme });
    const shell = await first.start();
    await settle();
    assert.deepEqual(bars.calls, ['LIGHT'], 'Follow phone on a light phone');
    await shell.setPrefs({ theme: 'dark' });
    await settle();
    assert.deepEqual(bars.calls, ['LIGHT', 'DARK']);
    await shell.setPrefs({ theme: 'dark', textSize: 120 });
    await settle();
    assert.deepEqual(bars.calls, ['LIGHT', 'DARK'], 'once per change');
    scheme.flip(true);
    scheme.flip(false);
    assert.deepEqual(bars.calls, ['LIGHT', 'DARK'], 'a chosen theme wins over the phone');
    await shell.setPrefs({ theme: 'follow' });
    await settle();
    assert.deepEqual(bars.calls, ['LIGHT', 'DARK', 'LIGHT']);
    scheme.flip(true);
    assert.deepEqual(bars.calls, ['LIGHT', 'DARK', 'LIGHT', 'DARK']);
    await shell.setPrefs({ theme: 'light' });
    await settle();
    assert.deepEqual(bars.calls, ['LIGHT', 'DARK', 'LIGHT', 'DARK', 'LIGHT']);
    assert.equal(bars.calls.includes('hide'), false);
    // A start with Dark saved sets DARK at once, before the lock or a computer.
    const bars2 = fakeBars();
    await shell.setPrefs({ theme: 'dark' });
    const again = androidPage(p, { bars: bars2, scheme: fakeScheme(false) });
    await again.start();
    await settle();
    assert.deepEqual(bars2.calls, ['DARK']);
  });

  it('the shell page of an app without SystemBars, the web app and the UI page\'s app.js leave the bars alone', async () => {
    const p = phone();
    const none = androidPage(p);
    const shell = await none.start();
    await settle();
    assert.equal((await shell.setPrefs({ theme: 'dark' })).ok, true, 'no plugin, no error');
    const bars = fakeBars();
    const ui = androidPage(p, { kind: 'ui', bars });
    await ui.start();
    await settle();
    assert.deepEqual(bars.calls, [], 'on the UI page boot.js sets the bars, not app.js');
    const rejecting = { async setStyle() { throw new Error('no'); } };
    const s = createShell({ store: createStore({ kv: memoryKv() }), systemBars: rejecting, colorScheme: fakeScheme(true), createWorker: () => { throw new Error('none'); } });
    await s.boot();
    await settle();
    assert.equal(s.state().prefs.theme, 'follow');
  });

  it('the UI page (boot.js): setStyle on the first state and on every change of the theme it draws, on a native app only', async () => {
    const run = (nativeApp) => {
      const bars = fakeBars();
      const scheme = fakeScheme(false);
      const subs = new Set();
      const snapshot = { connection: { status: 'connected' }, locked: false, lock: { mode: 'biometric' }, computers: [], stop: { state: 'idle', text: '', seq: 0 }, notice: null, prefs: { theme: 'dark' }, hello: null };
      const core = {
        state: () => snapshot,
        subscribe(fn) { subs.add(fn); fn(snapshot); return () => subs.delete(fn); },
        push(patch) { Object.assign(snapshot, patch); for (const fn of [...subs]) fn(snapshot); },
        plugin: name => (name === 'SystemBars' ? bars : null),
        request: async () => { throw new Error('offline'); },
        stop: async () => ({}), lock: async () => ({}), unlock: async () => ({}), connect: async () => false, openShell: async () => true, takeRoute: () => null, log() {},
      };
      const win = {
        location: new URL('https://localhost/'),
        Response, ReadableStream, setTimeout, clearTimeout, navigator: {},
        matchMedia: () => scheme,
        fetch: async () => { throw new Error('no'); },
        ...(nativeApp ? { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {} } } : {}),
      };
      installShim({ win, doc: null, origFetch: null, core, log: () => {} });
      return { bars, scheme, core };
    };
    const { bars, scheme, core } = run(true);
    assert.deepEqual(bars.calls, ['DARK'], 'Dark in Plenum on a light phone: DARK from the first state');
    scheme.flip(true);
    assert.deepEqual(bars.calls, ['DARK'], 'nothing changed on the page');
    core.push({ prefs: { theme: 'light' } });
    assert.deepEqual(bars.calls, ['DARK', 'LIGHT']);
    core.push({ prefs: { theme: 'follow' } });
    assert.deepEqual(bars.calls, ['DARK', 'LIGHT', 'DARK'], 'Follow phone on a dark phone');
    scheme.flip(false);
    assert.deepEqual(bars.calls, ['DARK', 'LIGHT', 'DARK', 'LIGHT']);
    core.push({ notice: null });
    assert.equal(bars.calls.length, 4, 'once per change');
    const web = run(false);
    assert.deepEqual(web.bars.calls, [], 'the web app has no bars to set');
  });

  it('the facade hands the UI page SystemBars.setStyle only, with DARK or LIGHT, and nothing that hides a bar', async () => {
    const bars = fakeBars();
    const shell = { channel: null, state: () => ({}), subscribe: () => () => {}, stop() {}, lockNow() {}, unlock() {}, connect() {}, openShell: async h => h, takeRoute: () => null, pageLog: () => true };
    const facade = makeFacade(shell, { SystemBars: bars });
    const got = facade.plugin('SystemBars');
    assert.deepEqual(Object.keys(got), ['setStyle']);
    assert.equal(Object.isFrozen(got), true);
    await got.setStyle({ style: 'DARK' });
    await got.setStyle({ style: 'DEFAULT' });
    await got.setStyle({ style: 'DARK', bar: 'NavigationBar' });
    assert.deepEqual(bars.calls, ['DARK', 'LIGHT', 'DARK']);
    assert.equal(got.hide, undefined);
    assert.equal(makeFacade(shell, null).plugin('SystemBars'), null);
    assert.equal(makeFacade(shell, {}).plugin('SystemBars'), null);
  });
});

// ----- 3. the early colour -----

describe('the shell page does not flash white or the other theme (wave 4, m3)', () => {
  const html = fs.readFileSync(path.join(MOBILE, 'shell', 'index.html'), 'utf8');

  it('index.html: strict CSP kept (no inline CSS or code), the colour metas, and both stylesheets in the head before any script', () => {
    assert.deepEqual(cspViolations(html), []);
    assert.match(html, /<meta name="color-scheme" content="light dark">/);
    assert.match(html, /<meta name="theme-color" content="#f6f6fb" media="\(prefers-color-scheme: light\)">/);
    assert.match(html, /<meta name="theme-color" content="#0a0a11" media="\(prefers-color-scheme: dark\)">/);
    const head = html.slice(0, html.indexOf('</head>'));
    assert.ok(head.includes('<link rel="stylesheet" href="shell-tokens.css">') && head.includes('<link rel="stylesheet" href="styles.css">'));
    assert.ok(html.indexOf('styles.css') < html.indexOf('<script'), 'the stylesheets block the first paint; the scripts come after');
    assert.match(html, /The page colour before the first paint \(wave 4, m3\)/);
    // The colours the page paints with are the theme-color ones.
    const styles = fs.readFileSync(path.join(MOBILE, 'shell', 'styles.css'), 'utf8');
    assert.match(styles, /html\[data-shell-page\] \{\s*background: var\(--bg\);/);
    assert.match(styles, /html\[data-shell-page\] body \{[^}]*background: var\(--bg\);/);
    const tokens = fs.readFileSync(path.join(PROJECT, 'public', 'style.css'), 'utf8');
    assert.match(tokens, /--bg: light-dark\(#f6f6fb, #0a0a11\);/);
  });

  it('earlyTheme shows the kept theme on the root before anything is awaited; Follow phone (nothing kept) leaves it to the stylesheet', () => {
    for (const [kept, want] of [['dark', 'dark'], ['light', 'light'], [null, null], ['purple', null]]) {
      const local = recordingStorage();
      if (kept) local.map.set(THEME_KEY, kept);
      const style = fakeRootStyle();
      const env = { localStorage: local, document: { documentElement: { style } } };
      assert.equal(earlyTheme(env), want, String(kept));
      assert.equal(style.getPropertyValue('color-scheme'), want ?? '');
    }
    assert.equal(earlyTheme({ get localStorage() { throw new Error('blocked'); }, document: { documentElement: { style: fakeRootStyle() } } }), null, 'blocked storage');
    assert.equal(showEarlyTheme(null, 'dark'), false);
    const app = fs.readFileSync(path.join(MOBILE, 'shell', 'app.js'), 'utf8');
    const call = app.indexOf('earlyTheme(globalThis);');
    assert.ok(call > 0 && call < app.indexOf('export function createShell'), 'it runs when the module is evaluated');
  });

  it('the shell page keeps the chosen theme for its next start and shows it at once; Follow phone removes the copy; the UI page keeps none', async () => {
    const p = phone();
    const page = androidPage(p);
    const shell = await page.start();
    await settle();
    assert.deepEqual(writesOf(page.local), [], 'Follow phone with nothing kept: nothing written');
    await shell.setPrefs({ theme: 'dark' });
    assert.equal(page.local.map.get(THEME_KEY), 'dark');
    assert.equal(page.root.style.getPropertyValue('color-scheme'), 'dark');
    const writes = page.local.calls.filter(c => c[0] === 'set').length;
    await shell.setPrefs({ theme: 'dark', haptics: false });
    assert.equal(page.local.calls.filter(c => c[0] === 'set').length, writes, 'an unchanged theme writes nothing');
    await shell.setPrefs({ theme: 'light' });
    assert.equal(page.local.map.get(THEME_KEY), 'light');
    assert.equal(page.root.style.getPropertyValue('color-scheme'), 'light');
    await shell.setPrefs({ theme: 'follow' });
    assert.equal(page.local.map.has(THEME_KEY), false);
    assert.equal(page.root.style.getPropertyValue('color-scheme'), '', 'back to the stylesheet');
    assert.deepEqual([...new Set(writesOf(page.local).map(c => c[1]))], [THEME_KEY], 'only the theme');
    const ui = androidPage(p, { kind: 'ui' });
    const uiShell = await ui.start();
    await settle();
    await uiShell.setPrefs({ theme: 'dark' });
    assert.deepEqual(writesOf(ui.local), []);
  });
});
