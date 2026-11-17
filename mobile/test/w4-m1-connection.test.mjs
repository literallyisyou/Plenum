// Wave 4 package m1: phone connection and updates (mobile/shell). Node only, on fakes: the channel worker core over the in-memory fake computer
// (fixtures/shell-core/fake-desktop.mjs) and a fake clock, the UI loader over fake files and a fake WebView, the UI host over fake Capacitor
// plugins, the shell (app.js) over a fake worker, and boot.js over a fake page. Nothing here runs on a phone.
//   1. a rebuilt app's shell files are copied into the UI folder the WebView serves (version.json shellSha256), and only then
//   2. a network change reconnects (Network plugin networkStatusChange, the 'online' event)
//   3. back after a long time away, a new session is dialled beside the probe; one session is left
//   4. offline retries slow down: 10 s, then 30 s, then 60 s; a network change or a return still tries at once
//   5. "Update Plenum on your computer" is retried and connects once the computer is updated, with the "was updated" line
//   6. Android "Use the copy in this app" activates the record the phone has
//   7. window.plenumShell.onConnection reports { state: 'connected' } on every (re)connect (boot.js already did; checked here)
// Run sealed from the mobile folder: bash C:/Users/willi/PlenumWork/mcshots/ultra/seal.sh w4-m1 node --test test/w4-m1-connection.test.mjs
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createFakeClock } from './helpers/fake-clock.mjs';
import { createFakeIndexedDB } from './fixtures/shell-core/fake-idb.mjs';
import { createFakeNet, createFakeDesktop } from './fixtures/shell-core/fake-desktop.mjs';
import {
  createChannelCore, DELAYS_MS, OFFLINE_SLOW_AFTER_ROUNDS, OFFLINE_SLOW_MS, OFFLINE_SLOWEST_AFTER_ROUNDS, OFFLINE_SLOWEST_MS, PROBE_MS,
  RESUME_RACE_AFTER_MS, RETRY_CAP_MS, UPDATE_DESKTOP_RETRY_MS,
} from '../shell/channel.worker.js';
import { bytesToB64u, openChannel } from '../shell/channel.js';
import { createIdbKv, createStore } from '../shell/store.js';
import { createShell, NETWORK_QUIET_MS, updatedLine, UPDATED_LINE_PATTERN, wireNetwork } from '../shell/app.js';
import { createUiHost, UI_ROOT } from '../shell/ui-host.js';
import { androidStorage, bundledShellSha, createUiLoader, SHELL_FILES } from '../shell/ui-loader.js';
import { installShim } from '../shell/boot.js';
import { deviceId, generateKeyPair } from '../../lib/remote/noise.mjs';
import * as overlay from '../../lib/overlay.mjs';
import { MANIFEST_PATH, fileNameFor, manifest, resetManifestCache } from '../../lib/remote/ui-manifest.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

// ----- shared helpers -----

async function settle(rounds = 25) {
  for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve));
}

async function walk(clock, ms, step = 1000) {
  for (let t = 0; t < ms; t += step) {
    clock.advance(step);
    await settle();
  }
}

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function coreComputer(desktop, phone, extra = {}) {
  return {
    id: deviceId(desktop.keys.publicKey),
    name: 'Test PC',
    desktopPub: desktop.keys.publicKey,
    myPriv: phone.privateKey,
    carriers: [{ kind: 'lan', urls: [desktop.url] }],
    lastCarrier: null,
    counter: 0,
    ...extra,
  };
}

// A worker core driven directly, with an in-memory counter store. dials: every socket the phone opened, with the time.
function coreRig({ net, clock, computer }) {
  const messages = [];
  const counters = new Map([[computer.id, 0]]);
  const rig = { messages, dials: [], sockets: [] };
  const Counting = class extends net.WebSocket {
    constructor(url) {
      super(url);
      rig.dials.push({ at: clock.now(), url });
      rig.sockets.push(this);
    }
  };
  rig.core = createChannelCore({
    post: msg => {
      messages.push(structuredClone(msg));
      if (msg.op !== 'counter') return;
      queueMicrotask(() => {
        const counter = Math.max(counters.get(msg.id) ?? 0, msg.minimum - 1) + 1;
        counters.set(msg.id, counter);
        rig.core.handle({ op: 'counterSaved', rid: msg.rid, ok: true, counter });
      });
    },
    WebSocketImpl: Counting,
    clock,
  });
  rig.last = op => messages.filter(m => m.op === op).at(-1);
  rig.init = () => rig.core.handle({ op: 'init', computer, device: { name: 'Test phone', platform: 'android', app: 'android', appVersion: '1', uiHash: '' }, caps: ['ui-from-desktop'] });
  return rig;
}

// The page side of a worker: every page -> worker message is kept in sent (the shell's reconnect reasons are read there).
function fakeWorkerFactory({ net, clock, store, sent = [] }) {
  return () => {
    let core = null;
    const worker = {
      onmessage: null,
      onerror: null,
      postMessage(msg) {
        const copy = structuredClone(msg);
        sent.push(copy);
        queueMicrotask(() => core.handle(copy));
      },
      terminate() {},
    };
    core = createChannelCore({
      post: msg => {
        if (msg.op === 'counter') {
          queueMicrotask(async () => {
            const counter = await store.raiseCounter(msg.id, msg.minimum);
            core.handle({ op: 'counterSaved', rid: msg.rid, ok: true, counter });
          });
          return;
        }
        queueMicrotask(() => worker.onmessage?.({ data: structuredClone(msg) }));
      },
      WebSocketImpl: net.WebSocket,
      clock,
    });
    return worker;
  };
}

async function shellRig({ desktopOptions = {}, shellOptions = {} } = {}) {
  const net = createFakeNet();
  const clock = createFakeClock(0);
  const wall = createFakeClock(1_000_000);
  const desktop = createFakeDesktop({ net, ...desktopOptions });
  const phone = generateKeyPair();
  desktop.counters.set(deviceId(phone.publicKey), 0);
  const store = createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) });
  await store.put({
    id: deviceId(desktop.keys.publicKey),
    name: 'Test PC',
    desktopPub: bytesToB64u(desktop.keys.publicKey),
    myPriv: bytesToB64u(phone.privateKey),
    carriers: [{ kind: 'lan', urls: [desktop.url] }],
    lastCarrier: null,
    counter: 0,
  });
  const sent = [];
  const shell = createShell({
    store,
    createWorker: fakeWorkerFactory({ net, clock, store, sent }),
    device: { name: 'Test phone', platform: 'web', app: 'pwa', appVersion: '1', uiHash: '' },
    caps: ['ui-from-desktop'],
    stopClock: wall,
    ...shellOptions,
  });
  await shell.start();
  return { shell, desktop, clock, wall, store, net, sent };
}

// ----- 1. the stale shell after a reinstall -----

const INDEX = '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>Plenum</title>\n</head>\n<body>\n  <main id="app"></main>\n  <script src="/app.js" defer></script>\n</body>\n</html>\n';
const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w4m1-root-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'public'));
  fs.writeFileSync(path.join(root, 'public', 'index.html'), INDEX);
  fs.writeFileSync(path.join(root, 'public', 'app.js'), 'window.appLoaded = 1;\n');
  return root;
}

function reply(status, bytes) {
  const body = new ReadableStream({ start(c) { if (bytes?.byteLength) c.enqueue(new Uint8Array(bytes)); c.close(); } });
  return { status, headers: {}, body, id: 1, cancel() {} };
}

function fakeDesktopUi(root, meta = { desktopVersion: '1.4.2', generation: 1 }) {
  const state = { meta, manifest: null };
  state.build = async () => {
    resetManifestCache();
    state.manifest = await manifest({ root, desktopVersion: state.meta.desktopVersion, generation: state.meta.generation, overlay, fs, crypto });
  };
  state.channel = {
    async request({ path: p = '/' } = {}) {
      if (p === MANIFEST_PATH) return reply(200, enc.encode(JSON.stringify(state.manifest)));
      const entry = state.manifest.files.find(f => f.path === p);
      if (!entry) return reply(404, enc.encode('{}'));
      return reply(200, fs.readFileSync(path.join(root, 'public', fileNameFor(p))));
    },
  };
  return state;
}

function fakeFiles() {
  const map = new Map();
  return {
    map,
    async write(rel, bytes) { map.set(rel, new Uint8Array(bytes)); },
    async read(rel) { return map.get(rel) ?? null; },
    async removeDir(rel) { for (const k of [...map.keys()]) if (k.startsWith(`${rel}/`)) map.delete(k); },
    async listDirs(root) {
      const set = new Set();
      for (const k of map.keys()) if (k.startsWith(`${root}/`) && k.slice(root.length + 1).includes('/')) set.add(k.slice(root.length + 1).split('/')[0]);
      return [...set];
    },
  };
}

// A bundle (the app's www): the four shell files and version.json, as scripts/build-mobile.mjs writes them. readBundled(rel) reads it.
function bundleOf(tag, sha) {
  return {
    'shell/boot.js': `/* boot ${tag} */`,
    'shell/shell.js': `/* shell ${tag} */`,
    'shell/channel.worker.js': `/* worker ${tag} */`,
    'shell/styles.css': `/* styles ${tag} */`,
    'version.json': JSON.stringify({ name: 'plenum-shell', version: '1.0.0', protocol: '1.0', shellSha256: sha }),
  };
}

describe('w4-m1 1: a rebuilt app copies its shell files into the UI folder the WebView already serves', () => {
  async function androidRig() {
    const root = makeRoot();
    const desk = fakeDesktopUi(root);
    await desk.build();
    const files = fakeFiles();
    const calls = [];
    let served = null;
    const webView = {
      getServerBasePath: async () => ({ path: served }),
      persistServerBasePath: async ({ path: p }) => calls.push(['persist', p]),
      setServerBasePath: async ({ path: p }) => { calls.push(['set', p]); served = p; },
    };
    const holder = { bundle: bundleOf('old', 'a'.repeat(64)) };
    const readBundled = async rel => (typeof holder.bundle?.[rel] === 'string' ? enc.encode(holder.bundle[rel]) : null);
    const loader = createUiLoader({ channel: desk.channel, storage: androidStorage({ files, webView }), platform: 'android', readBundled });
    const first = await loader.check({ loadedHash: null, computerId: 'c-one' });
    assert.equal(first.status, 'updated');
    const base = served;
    assert.ok(base, 'the WebView serves the UI folder');
    const shellOf = () => Object.fromEntries(SHELL_FILES.map(rel => [rel, files.map.get(`${base}/${rel}`) ? dec.decode(files.map.get(`${base}/${rel}`)) : null]));
    return { root, desk, files, calls, holder, loader, base, shellOf, setServed: p => { served = p; } };
  }

  it('keeps the bundled shellSha256 in the active record', async () => {
    const { loader } = await androidRig();
    assert.equal((await loader.current()).shellSha256, 'a'.repeat(64));
  });

  it('the same UI hash with another bundled shellSha256 copies the four shell files again (persist, then set), and keeps the new sha', async () => {
    const { loader, calls, holder, shellOf } = await androidRig();
    const record = await loader.current();
    assert.deepEqual(Object.values(shellOf()), ['/* boot old */', '/* shell old */', '/* worker old */', '/* styles old */']);
    calls.length = 0;
    holder.bundle = bundleOf('new', 'b'.repeat(64));
    const again = await loader.check({ helloHash: record.hash, loadedHash: record.hash, computerId: 'c-one' });
    assert.equal(again.status, 'current', 'nothing was fetched from the computer');
    assert.deepEqual(calls.map(c => c[0]), ['persist', 'set'], 'activated again, once, although the WebView already served the folder');
    assert.deepEqual(Object.values(shellOf()), ['/* boot new */', '/* shell new */', '/* worker new */', '/* styles new */'], 'the four shell files are the new app\'s');
    const after = await loader.current();
    assert.equal(after.shellSha256, 'b'.repeat(64));
    assert.equal(after.computerId, 'c-one', 'the rest of the record is kept');
    assert.equal(after.hash, record.hash);
  });

  it('the same sha copies nothing and leaves the WebView alone', async () => {
    const { loader, calls, shellOf } = await androidRig();
    const record = await loader.current();
    const before = shellOf();
    calls.length = 0;
    await loader.check({ helloHash: record.hash, loadedHash: record.hash, computerId: 'c-one' });
    await loader.check({ helloHash: record.hash, loadedHash: record.hash, computerId: 'c-one' });
    assert.deepEqual(calls, [], 'no persist, no set');
    assert.deepEqual(shellOf(), before);
  });

  it('a bundle that cannot be read (the Android UI page serves the UI folder, not www) decides nothing', async () => {
    const { loader, calls, holder } = await androidRig();
    const record = await loader.current();
    calls.length = 0;
    holder.bundle = null;
    await loader.check({ helloHash: record.hash, loadedHash: record.hash, computerId: 'c-one' });
    assert.deepEqual(calls, []);
    assert.equal(await bundledShellSha(async () => enc.encode('not json')), null);
    assert.equal(await bundledShellSha(async () => enc.encode(JSON.stringify({ shellSha256: 'short' }))), null);
    assert.equal(await bundledShellSha(null), null);
  });

  it('a UI update pulled where the bundle cannot be read carries the shell files over from the folder in use, and its sha', async () => {
    const { root, desk, loader, files, holder } = await androidRig();
    const record = await loader.current();
    fs.writeFileSync(path.join(root, 'public', 'app.js'), 'window.appLoaded = 2;\n');
    desk.meta = { desktopVersion: '1.4.3', generation: 2 };
    await desk.build();
    holder.bundle = null;
    const out = await loader.check({ helloHash: desk.manifest.hash, loadedHash: record.hash, computerId: 'c-one' });
    assert.equal(out.status, 'updated');
    const next = await loader.current();
    assert.notEqual(next.cacheName, record.cacheName);
    const dir = `${UI_ROOT}/${next.cacheName}`;
    for (const rel of SHELL_FILES) assert.ok(files.map.get(`${dir}/${rel}`), `${rel} is in the new folder`);
    assert.equal(dec.decode(files.map.get(`${dir}/shell/boot.js`)), '/* boot old */');
    assert.equal(next.shellSha256, record.shellSha256, 'the sha of the files carried over');
  });
});

// ----- 6. Android "Use the copy in this app" -----

function fakeAndroidPlugins() {
  const DATA_ROOT = '/data/user/0/com.literallyisyou.plenum/files';
  const disk = new Map();   // rel path -> base64
  const sequence = [];
  let servedAbs = '/android_asset/public';
  const Filesystem = {
    getUri: async () => ({ uri: `file://${DATA_ROOT}` }),
    writeFile: async ({ path: p, data }) => { disk.set(p, data); return {}; },
    readFile: async ({ path: p }) => { if (!disk.has(p)) throw new Error('none'); return { data: disk.get(p) }; },
    rmdir: async ({ path: p }) => { for (const k of [...disk.keys()]) if (k.startsWith(`${p}/`)) disk.delete(k); },
    readdir: async () => ({ files: [] }),
  };
  const WebView = {
    setServerBasePath: async ({ path: p }) => { sequence.push(['set', p]); servedAbs = p; },
    persistServerBasePath: async () => { sequence.push(['persist']); },
    getServerBasePath: async () => ({ path: servedAbs }),
  };
  const b64 = text => Buffer.from(text, 'utf8').toString('base64');
  const read = rel => (disk.has(rel) ? Buffer.from(disk.get(rel), 'base64').toString('utf8') : null);
  return { DATA_ROOT, disk, sequence, native: { Filesystem, WebView }, b64, read };
}

function androidEnv(bundle) {
  return {
    location: { href: 'https://localhost/', pathname: '/', search: '', replace() {}, assign() {} },
    sessionStorage: { setItem() {}, getItem: () => null, removeItem() {} },
    setTimeout,
    clearTimeout,
    fetch: async url => {
      const name = new URL(url).pathname.slice(1);
      const key = name === 'version.json' ? name : `shell/${name}`;
      return typeof bundle[key] === 'string' ? new Response(bundle[key]) : new Response('', { status: 404 });
    },
  };
}

describe('w4-m1 6: Android "Use the copy in this app"', () => {
  it('with a complete record: hasCopy is true, useCopy activates it with this app\'s shell files and the WebView moves there', async () => {
    const fx = fakeAndroidPlugins();
    const record = { hash: 'h'.repeat(64), generation: 1, desktopVersion: '1.4.2', cacheName: 'plenum-ui-1.4.2-1-abc', complete: true, files: [], computerId: 'c-one', shellSha256: 'a'.repeat(64) };
    fx.disk.set(`${UI_ROOT}/active.json`, fx.b64(JSON.stringify(record)));
    fx.disk.set(`${UI_ROOT}/${record.cacheName}/index.html`, fx.b64(INDEX));
    const bundle = bundleOf('now', 'c'.repeat(64));
    const host = createUiHost({ env: androidEnv(bundle), kind: 'android', native: fx.native, channelOf: () => null });
    assert.equal(await host.hasCopy(), true);
    const out = await host.useCopy();
    assert.deepEqual(out, { ok: true, status: 'copy', navigated: true });
    assert.deepEqual(fx.sequence, [['set', `${fx.DATA_ROOT}/${UI_ROOT}/${record.cacheName}`], ['persist']], 'the base path is set to the copy, then persisted');
    assert.equal(fx.read(`${UI_ROOT}/${record.cacheName}/shell/boot.js`), '/* boot now */');
    assert.equal(fx.read(`${UI_ROOT}/${record.cacheName}/shell/channel.worker.js`), '/* worker now */');
    assert.match(fx.read(`${UI_ROOT}/${record.cacheName}/index.html`), /data-surface="phone"/);
    assert.equal(JSON.parse(fx.read(`${UI_ROOT}/active.json`)).shellSha256, 'c'.repeat(64));
  });

  it('with no record, or one that is not complete, there is no copy and useCopy says so without touching the WebView', async () => {
    const fx = fakeAndroidPlugins();
    const host = createUiHost({ env: androidEnv(bundleOf('x', 'd'.repeat(64))), kind: 'android', native: fx.native, channelOf: () => null });
    assert.equal(await host.hasCopy(), false);
    const none = await host.useCopy();
    assert.equal(none.ok, false);
    assert.equal(none.code, 'storage');
    fx.disk.set(`${UI_ROOT}/active.json`, fx.b64(JSON.stringify({ hash: 'h', cacheName: 'plenum-ui-x', complete: false })));
    assert.equal(await host.hasCopy(), false);
    assert.deepEqual(fx.sequence, []);
  });
});

// ----- 2. reconnect on a network change -----

describe('w4-m1 2: a network change reconnects', () => {
  // A fake Network plugin seeded with a status, a fake page and a fake timer for the quiet window.
  function networkRig(seed = { connected: true, connectionType: 'wifi' }) {
    let listener = null;
    let removed = 0;
    const network = {
      getStatus: async () => seed,
      addListener: async (name, fn) => { assert.equal(name, 'networkStatusChange'); listener = fn; return { remove() { removed += 1; } }; },
    };
    const envListeners = new Map();
    const env = {
      addEventListener: (type, fn) => envListeners.set(type, fn),
      removeEventListener: type => envListeners.delete(type),
    };
    let t = 0;
    const timers = [];
    const rig = {
      asked: 0,
      network, env, envListeners,
      fire: status => listener(status),
      online: () => envListeners.get('online')(),
      removed: () => removed,
      timers: () => timers.filter(x => !x.cleared && !x.ran).length,
      advance(ms) {
        t += ms;
        for (const x of timers) if (!x.cleared && !x.ran && x.at <= t) { x.ran = true; x.fn(); }
      },
    };
    rig.off = wireNetwork({
      network, env, shell: { networkChanged: () => { rig.asked += 1; } },
      now: () => t,
      setTimer: (fn, ms) => { const x = { fn, at: t + ms, cleared: false, ran: false }; timers.push(x); return x; },
      clearTimer: x => { x.cleared = true; },
    });
    return rig;
  }

  it('a real change asks the shell (back from no signal, Wi-Fi to mobile data); losing the network does not; the online event does too', async () => {
    const r = networkRig({ connected: true, connectionType: 'wifi' });
    await settle();
    r.fire({ connected: true, connectionType: 'cellular' });
    assert.equal(r.asked, 1, 'Wi-Fi to mobile data while connected');
    r.fire({ connected: false, connectionType: 'none' });
    assert.equal(r.asked, 1, 'losing the network does nothing');
    r.advance(NETWORK_QUIET_MS);
    r.fire({ connected: true, connectionType: 'cellular' });
    assert.equal(r.asked, 2, 'back from no signal');
    r.advance(NETWORK_QUIET_MS);
    r.online();
    assert.equal(r.asked, 3, 'the page\'s online event');
    r.off();
    assert.equal(r.removed(), 1);
    assert.equal(r.envListeners.has('online'), false);
    assert.doesNotThrow(() => wireNetwork({ network: null, env: null, shell: null }), 'no plugin and no page: nothing to wire');
  });

  it('the same status again (the Android plugin on every resume and every capabilities change) asks nothing, after a short resume too', async () => {
    const r = networkRig({ connected: true, connectionType: 'wifi' });
    await settle();
    // Android: handleOnResume -> startMonitoring -> registerDefaultNetworkCallback -> onCapabilitiesChanged at once, on the same network.
    for (let i = 0; i < 5; i++) r.fire({ connected: true, connectionType: 'wifi' });
    assert.equal(r.asked, 0);
    r.advance(5_000);
    r.fire({ connected: true, connectionType: 'wifi' });
    assert.equal(r.asked, 0, 'a resume after five seconds on the same Wi-Fi');
    assert.equal(r.timers(), 0, 'nothing waiting either');
  });

  it('with no seed the first status is only recorded; a seed that arrives after an event does not overwrite it', async () => {
    let listener = null;
    let resolveSeed = null;
    let asked = 0;
    wireNetwork({
      network: {
        getStatus: () => new Promise(resolve => { resolveSeed = resolve; }),
        addListener: async (_name, fn) => { listener = fn; return { remove() {} }; },
      },
      shell: { networkChanged: () => { asked += 1; } },
    });
    await settle();
    listener({ connected: true, connectionType: 'cellular' });
    assert.equal(asked, 0, 'nothing to compare with yet');
    resolveSeed({ connected: false, connectionType: 'none' });
    await settle();
    listener({ connected: true, connectionType: 'cellular' });
    assert.equal(asked, 0, 'the late seed did not replace what the event said');
  });

  it('a burst of real changes is folded: one call at once, at most one more after the quiet time', async () => {
    const r = networkRig({ connected: false, connectionType: 'none' });
    await settle();
    r.fire({ connected: true, connectionType: 'wifi' });
    assert.equal(r.asked, 1);
    r.online();
    r.fire({ connected: true, connectionType: 'cellular' });
    r.fire({ connected: false, connectionType: 'none' });
    r.fire({ connected: true, connectionType: 'wifi' });
    assert.equal(r.asked, 1, 'held during the quiet time');
    r.advance(NETWORK_QUIET_MS - 1);
    assert.equal(r.asked, 1);
    r.advance(1);
    assert.equal(r.asked, 2, 'one more for everything that came in the quiet time');
    r.advance(10_000);
    assert.equal(r.asked, 2);
    // Removed with a call still waiting: it never comes.
    r.fire({ connected: true, connectionType: 'cellular' });
    r.fire({ connected: true, connectionType: 'wifi' });
    assert.equal(r.asked, 3);
    r.off();
    r.advance(NETWORK_QUIET_MS);
    assert.equal(r.asked, 3);
  });

  it('the shell sends reconnect with reason network to the worker; a return from the background sends resume with the time away', async () => {
    const k = await shellRig();
    await waitFor(() => k.shell.state().hello, 8000);
    assert.equal(k.shell.networkChanged(), true);
    await settle();
    assert.deepEqual(k.sent.filter(m => m.op === 'reconnect').at(-1), { op: 'reconnect', reason: 'network' });
    await k.shell.visibility(false);
    k.wall.advance(30_000);
    await k.shell.visibility(true);
    await settle();
    assert.deepEqual(k.sent.filter(m => m.op === 'reconnect').at(-1), { op: 'reconnect', reason: 'resume', hiddenMs: 30_000 });
  });

  it('the worker: a network change with a session that is up dials a new one at once and keeps one session', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const rig = coreRig({ net, clock, computer: coreComputer(desktop, phone) });
    rig.init();
    await settle();
    assert.equal(rig.core.phase, 'connected');
    const old = rig.core.session;
    // The socket of the old network: nothing goes through any more, and nothing says so.
    const sock = rig.sockets.at(-1);
    sock.send = () => {};
    sock.deliver = () => {};
    const dialled = rig.dials.length;
    rig.core.handle({ op: 'reconnect', reason: 'network' });
    await settle();
    assert.equal(rig.dials.length, dialled + 1, 'a new dial at once, not after the probe');
    assert.notEqual(rig.core.session, old, 'the new session is the one in use');
    assert.equal(rig.core.phase, 'connected');
    assert.equal(desktop.sessionCount, 1, 'one session at the computer: the old one was closed');
  });
});

// ----- 3. faster resume -----

describe('w4-m1 3: back after a long time away, a new session is dialled beside the probe', () => {
  async function connected() {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const rig = coreRig({ net, clock, computer: coreComputer(desktop, phone) });
    rig.init();
    await settle();
    assert.equal(rig.core.phase, 'connected');
    return { rig, clock, desktop };
  }

  it('after 30 s hidden with a socket that died silently: dialled in parallel, adopted before PROBE_MS, one session left', async () => {
    const { rig, clock, desktop } = await connected();
    assert.ok(30_000 > RESUME_RACE_AFTER_MS);
    const old = rig.core.session;
    const sock = rig.sockets.at(-1);
    sock.send = () => {};
    sock.deliver = () => {};
    const dialled = rig.dials.length;
    const hellos = rig.messages.filter(m => m.op === 'hello').length;
    rig.core.handle({ op: 'reconnect', reason: 'resume', hiddenMs: 30_000 });
    await settle();
    clock.advance(100);
    await settle();
    assert.ok(clock.now() < PROBE_MS, 'well before the probe would have given up');
    assert.equal(rig.dials.length, dialled + 1, 'one new dial, beside the probe');
    assert.notEqual(rig.core.session, old);
    assert.equal(old.retired, true, 'the old session is closed');
    assert.equal(rig.core.phase, 'connected');
    assert.equal(desktop.sessionCount, 1, 'never two sessions');
    assert.equal(rig.messages.filter(m => m.op === 'hello').length, hellos + 1, 'the page hears the new HELLO');
    // Nothing more happens when the old probe would have run out.
    const dials = rig.dials.length;
    await walk(clock, PROBE_MS + 2000, 500);
    assert.equal(rig.dials.length, dials);
    assert.equal(rig.core.phase, 'connected');
    assert.equal(desktop.sessionCount, 1);
  });

  it('after 30 s hidden with a session that is alive: whichever answers first is kept, and one session is left', async () => {
    const { rig, clock, desktop } = await connected();
    const old = rig.core.session;
    const handshakes = desktop.stats.handshakes;
    rig.core.handle({ op: 'reconnect', reason: 'resume', hiddenMs: 30_000 });
    await settle();
    await walk(clock, PROBE_MS + 1000, 500);
    assert.equal(rig.core.phase, 'connected');
    assert.equal(desktop.sessionCount, 1, 'never two sessions: the loser was closed');
    assert.equal(rig.core.session.closed, false);
    // In the in-memory net the PONG comes back before the new socket's handshake: the session that was up is kept, the dial stopped unused.
    assert.equal(rig.core.session, old);
    assert.equal(desktop.stats.handshakes, handshakes, 'the dial was stopped before it sent a handshake');
  });

  it('after a short time away only the probe runs, as before', async () => {
    const { rig, clock } = await connected();
    const session = rig.core.session;
    const dialled = rig.dials.length;
    rig.core.handle({ op: 'reconnect', reason: 'resume', hiddenMs: 5_000 });
    await walk(clock, PROBE_MS + 1000, 500);
    assert.equal(rig.dials.length, dialled, 'no new dial');
    assert.equal(rig.core.session, session);
  });

  it('a reason or a time the worker does not know is ignored: only the probe runs', async () => {
    const { rig, clock } = await connected();
    const dialled = rig.dials.length;
    rig.core.handle({ op: 'reconnect', reason: 'surprise', hiddenMs: 'long' });
    rig.core.handle({ op: 'reconnect', hiddenMs: -40_000 });
    await walk(clock, PROBE_MS + 1000, 500);
    assert.equal(rig.dials.length, dialled);
  });
});

// ----- 4. battery: offline retries slow down -----

describe('w4-m1 4: offline retries slow to 30 s and then 60 s; a network change or a return still tries at once', () => {
  it('waits 10 s for the first offline rounds, then 30 s, then 60 s, and stays offline', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net, url: 'ws://unused.local/b/key' });
    const phone = generateKeyPair();
    const rig = coreRig({ net, clock, computer: coreComputer(desktop, phone, { carriers: [{ kind: 'lan', urls: ['ws://nobody.local/b/key'] }] }) });
    rig.init();
    await settle();
    await walk(clock, 25 * 60_000);
    const gaps = rig.dials.slice(1).map((d, i) => d.at - rig.dials[i].at);
    // Rounds 1 and 2 reconnect (2 s, 4 s), round 3 makes it offline (8 s), then RETRY_CAP_MS until OFFLINE_SLOW_AFTER_ROUNDS offline rounds.
    const quick = [DELAYS_MS[1], DELAYS_MS[2], DELAYS_MS[3], ...Array(OFFLINE_SLOW_AFTER_ROUNDS - 1).fill(RETRY_CAP_MS)];
    const slow = Array(OFFLINE_SLOWEST_AFTER_ROUNDS - OFFLINE_SLOW_AFTER_ROUNDS).fill(OFFLINE_SLOW_MS);
    assert.deepEqual(gaps.slice(0, quick.length + slow.length + 3), [...quick, ...slow, OFFLINE_SLOWEST_MS, OFFLINE_SLOWEST_MS, OFFLINE_SLOWEST_MS]);
    assert.equal(RETRY_CAP_MS, 10_000);
    assert.equal(OFFLINE_SLOW_MS, 30_000);
    assert.equal(OFFLINE_SLOWEST_MS, 60_000);
    assert.ok(gaps.slice(quick.length + slow.length).every(g => g === OFFLINE_SLOWEST_MS), 'once a minute from then on');
    assert.equal(rig.core.phase, 'offline', 'the screen says Can\'t reach, with Try again');

    // A return to the app tries at once, and the slow cadence stays.
    let before = rig.dials.length;
    rig.core.handle({ op: 'reconnect', reason: 'resume', hiddenMs: 120_000 });
    await settle();
    assert.equal(rig.dials.length, before + 1, 'a return tries at once');
    assert.equal(rig.last('state').state.nextRetryAt - clock.now(), OFFLINE_SLOWEST_MS);

    // A network change tries at once and brings back the 10 s cadence for a new network.
    before = rig.dials.length;
    rig.core.handle({ op: 'reconnect', reason: 'network' });
    await settle();
    assert.equal(rig.dials.length, before + 1, 'a network change tries at once');
    assert.equal(rig.last('state').state.nextRetryAt - clock.now(), RETRY_CAP_MS);
    assert.equal(rig.core.phase, 'offline', 'still Can\'t reach, not Reconnecting');
  });
});

// ----- 5. update-desktop recovers -----

describe('w4-m1 5: "Update Plenum on your computer" is retried and connects once the computer is updated', () => {
  it('retries every minute; an older computer keeps the screen; an updated one connects with the "was updated" line', async () => {
    const carried = [];
    const k = await shellRig({ desktopOptions: { protocolMajor: 0 }, shellOptions: { noteCarry: { put: text => carried.push(text) } } });
    await waitFor(() => k.shell.state().connection.status === 'update-desktop', 8000);
    const first = k.desktop.stats.handshakes;
    await walk(k.clock, UPDATE_DESKTOP_RETRY_MS + 1000);
    assert.equal(k.desktop.stats.handshakes, first + 1, 'tried again after a minute');
    assert.equal(k.shell.state().connection.status, 'update-desktop', 'the older computer\'s HELLO keeps the same screen');
    assert.equal(k.shell.state().hello, null);
    // The computer is updated. The next try (or a return to the app) connects.
    k.desktop.protocolMajor = 1;
    await walk(k.clock, UPDATE_DESKTOP_RETRY_MS + 1000);
    await waitFor(() => k.shell.state().connection.status === 'connected', 8000);
    const line = 'Plenum on Test PC was updated. Connected again.';
    assert.equal(k.shell.state().notice?.text, line);
    assert.equal(k.shell.state().notice?.tone, 'ok');
    assert.deepEqual(carried, [line], 'the line waits for the UI page the shell hands over to');
    assert.equal(updatedLine('Test PC'), line);
    assert.match(line, UPDATED_LINE_PATTERN);
    // It is said once: a later reconnect says nothing more.
    const seq = k.shell.state().notice.seq;
    k.shell.networkChanged();
    await walk(k.clock, 5000);
    assert.equal(k.shell.state().notice.seq, seq);
  });

  it('a return to the app tries at once while the computer asks for an update', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net, protocolMajor: 0 });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const rig = coreRig({ net, clock, computer: coreComputer(desktop, phone) });
    rig.init();
    await settle();
    assert.equal(rig.core.phase, 'update-desktop');
    assert.equal(rig.last('state').state.nextRetryAt - clock.now(), UPDATE_DESKTOP_RETRY_MS);
    desktop.protocolMajor = 1;
    rig.core.handle({ op: 'reconnect', reason: 'resume', hiddenMs: 60_000 });
    await settle();
    assert.equal(rig.core.phase, 'connected');
  });

  it('the UI page says the line the shell page left for it, and nothing that is not that line', async () => {
    const base = await shellRig({ shellOptions: { initialNote: 'Plenum on Test PC was updated. Connected again.' } });
    assert.equal(base.shell.state().notice?.text, 'Plenum on Test PC was updated. Connected again.');
    const other = await shellRig({ shellOptions: { initialNote: 'Type your PIN here' } });
    assert.equal(other.shell.state().notice, null);
  });
});

// ----- 7. boot.js: onConnection on every (re)connect -----

function fakeDocument() {
  const byId = new Map();
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.attrs = new Map();
      this.children = [];
      this.listeners = new Map();
      this.textContent = '';
      this.hidden = false;
      this.id = '';
      this.className = '';
    }
    setAttribute(k, v) { this.attrs.set(k, String(v)); }
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
    hasAttribute(k) { return this.attrs.has(k); }
    removeAttribute(k) { this.attrs.delete(k); }
    append(...nodes) {
      for (const n of nodes) {
        this.children.push(n);
        if (n.id) byId.set(n.id, n);
        for (const c of n.children ?? []) if (c.id) byId.set(c.id, c);
      }
    }
    remove() {}
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
  }
  const doc = {
    readyState: 'complete',
    documentElement: new El('html'),
    head: new El('head'),
    body: new El('body'),
    createElement: tag => new El(tag),
    getElementById: id => byId.get(id) ?? null,
    visibilityState: 'visible',
    addEventListener() {},
  };
  return doc;
}

describe('w4-m1 7: window.plenumShell.onConnection reports connected on every reconnect', () => {
  it('connected, then reconnecting, then connected again: the page hears state connected each time', () => {
    const subs = new Set();
    const snapshot = {
      connection: { status: 'connected', desktopName: 'Home PC' }, locked: false, lock: { mode: 'off' }, computers: [{ id: 'a', name: 'Home PC' }],
      activeId: 'a', stop: { state: 'idle', text: '', seq: 0 }, notice: null, prefs: { theme: 'follow' }, hello: null,
    };
    const core = {
      state: () => snapshot,
      subscribe(fn) { subs.add(fn); fn(snapshot); return () => subs.delete(fn); },
      request: () => Promise.reject(Object.assign(new Error('offline'), { code: 'offline' })),
      log() {},
    };
    const push = patch => { Object.assign(snapshot, patch); for (const fn of [...subs]) fn(snapshot); };
    const win = { location: new URL('https://phone.example/'), Response, ReadableStream, fetch: async () => new Response(''), setTimeout, clearTimeout, navigator: {} };
    installShim({ win, doc: fakeDocument(), origFetch: async () => new Response(''), core, app: { version: '1', build: '1' } });
    const seen = [];
    win.plenumShell.onConnection(view => seen.push(view.state));
    push({ connection: { status: 'reconnecting', desktopName: 'Home PC' } });
    push({ connection: { status: 'connected', desktopName: 'Home PC' } });
    push({ connection: { status: 'offline', desktopName: 'Home PC' } });
    push({ connection: { status: 'connected', desktopName: 'Home PC' } });
    const connects = seen.reduce((n, s, i) => n + (s === 'connected' && seen[i - 1] !== 'connected' ? 1 : 0), 0);
    assert.equal(seen[0], 'connected', 'at once, on subscribe');
    assert.ok(connects >= 3, `connected is reported on the first connect and on each reconnect (saw ${seen.join(', ')})`);
  });
});

void openChannel;
