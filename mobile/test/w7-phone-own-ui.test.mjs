// Wave 7 (phone own UI): the Android app uses the screens built into it when the computer cannot send its own (17 Nov 2026: a fresh install
// stopped on "Plenum's screens did not load"). Node only, on fakes: the UI loader over an in-memory computer and fake files, the UI host over fake
// Capacitor plugins (Filesystem, WebView) and a fake fetch of the app's own files, the shell (app.js) over a fake worker and a fake UI host, and
// the screens over a small fake document. Nothing is written to disk and nothing runs on a phone.
//   1. the index Plenum on the computer themes (server.mjs withTheme: data-theme, data-legal) is checked without exactly those attributes
//   2. a staged pull (activate: false) writes and checks every file and the record, and leaves the WebView alone
//   3. the compatibility rule: the release the built-in screens were made for (version.json) against the HELLO's desktopVersion and protocol
//   4. Android: a pull that fails opens the built-in screens when they fit, and says plainly why not when they do not
//   5. Android, on the built-in screens: the pull is tried again in the background, and the page moves only to a complete, checked copy, only
//      at a HELLO that says nothing is running, never in the call that pulled it
//   6. the shell: the UI page passes mayMove and the resume reason; the shell page keeps the source and the versions for the screens
//   7. the screens: the plain version sentence, and the line in Phone settings
// Run sealed from the mobile folder: bash /path/to/seal.sh w7-phone-own-ui node --test test/w7-phone-own-ui.test.mjs
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createFakeClock } from './helpers/fake-clock.mjs';
import { createFakeIndexedDB } from './fixtures/shell-core/fake-idb.mjs';
import { createFakeNet, createFakeDesktop } from './fixtures/shell-core/fake-desktop.mjs';
import { createChannelCore } from '../shell/channel.worker.js';
import { bytesToB64u } from '../shell/channel.js';
import { createIdbKv, createStore } from '../shell/store.js';
import { createShell, uiMayMove } from '../shell/app.js';
import {
  BUNDLED_UI_ASSET, bundledFit, bundledUiReader, causeOf, createUiHost, readBundledVersion, releaseOf, UI_ROOT,
} from '../shell/ui-host.js';
import {
  androidStorage, createUiLoader, sha256Hex, SHELL_FILES, UiError, unthemedIndex, verifiedCopy, webStorage,
} from '../shell/ui-loader.js';
import { deviceId, generateKeyPair } from '../../lib/remote/noise.mjs';
import { MANIFEST_PATH, fileNameFor, manifest, resetManifestCache } from '../../lib/remote/ui-manifest.mjs';
import * as C from '../shell/screens/copy.js';
import * as C2 from '../shell/screens/copy2.js';
import { setDocument } from '../shell/screens/dom.js';
import { ctxFor } from '../shell/screens/route.js';
import { buildVm } from '../shell/screens/main.js';
import { renderScreen } from '../shell/screens/views.js';
import { renderPart2 } from '../shell/screens/views2.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

const INDEX = '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>Plenum</title>\n</head>\n<body>\n  <main id="app"></main>\n  <script src="/app.js" defer></script>\n</body>\n</html>\n';
const UI_FILES = Object.freeze({ 'index.html': INDEX, 'app.js': 'window.appLoaded = 1;\n', 'ext-alpha.js': 'window.alpha = 1;\n' });
const HELLO = Object.freeze({ protocol: { major: 1, minor: 1 }, desktopVersion: '0.6.0', pending: { approvals: 0, running: 0 } });

async function settle(rounds = 25) {
  for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve));
}

async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

// What server.mjs withTheme does to the index it serves: the attributes go into the first <html lang="en">.
function themed(text, attrs) {
  return text.replace('<html lang="en">', `<html lang="en" ${attrs}>`);
}

function reply(status, bytes) {
  const body = new ReadableStream({ start(c) { if (bytes?.byteLength) c.enqueue(new Uint8Array(bytes)); c.close(); } });
  return { status, headers: {}, body, id: 1, cancel() {} };
}

// The computer's UI, in memory: manifest() runs on a fake overlay and a fake fs (no folder on disk), and the channel answers the manifest and
// each file. serve(path, bytes) may change what a file is answered with (the theme); fail(path) answers 404 for that path.
function computerUi({ files = UI_FILES, desktopVersion = '0.6.0', generation = null } = {}) {
  const state = {
    files: new Map(Object.entries(files).map(([name, text]) => [name, Buffer.from(text, 'utf8')])),
    desktopVersion,
    generation,
    manifest: null,
    requests: [],
    serve: null,
    fail: null,
  };
  state.build = async () => {
    resetManifestCache();
    const overlay = {
      listFiles: (dir, pick) => [...state.files.keys()].filter(name => pick(name)),
      filePath: rel => rel,
    };
    const fs = {
      readFileSync: rel => {
        const bytes = state.files.get(String(rel).replace(/^public\//, ''));
        if (!bytes) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return Buffer.from(bytes);
      },
    };
    state.manifest = await manifest({ desktopVersion: state.desktopVersion, generation: state.generation, overlay, fs, crypto });
    return state.manifest;
  };
  state.channel = {
    async request({ path: p = '/' } = {}) {
      state.requests.push(p);
      if (state.fail?.(p)) return reply(404, enc.encode('{"error":"Not found."}'));
      if (p === MANIFEST_PATH) return reply(200, enc.encode(JSON.stringify(state.manifest)));
      const bytes = state.files.get(fileNameFor(p));
      if (!bytes) return reply(404, enc.encode('{"error":"Not found."}'));
      return reply(200, state.serve ? state.serve(p, new Uint8Array(bytes)) : new Uint8Array(bytes));
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
    async remove(rel) { map.delete(rel); },
    async removeDir(rel) { for (const k of [...map.keys()]) if (k.startsWith(`${rel}/`)) map.delete(k); },
    async listDirs(root) {
      const set = new Set();
      for (const k of map.keys()) if (k.startsWith(`${root}/`) && k.slice(root.length + 1).includes('/')) set.add(k.slice(root.length + 1).split('/')[0]);
      return [...set];
    },
  };
}

function fakeCaches() {
  const store = new Map();
  return {
    store,
    async open(name) {
      if (!store.has(name)) store.set(name, new Map());
      const slot = store.get(name);
      return {
        async match(p) {
          const hit = slot.get(p);
          return hit ? new Response(hit.bytes, { headers: hit.headers }) : undefined;
        },
        async put(p, res) {
          slot.set(p, { bytes: new Uint8Array(await res.arrayBuffer()), headers: Object.fromEntries(res.headers) });
        },
      };
    },
    async delete(name) { return store.delete(name); },
    async keys() { return [...store.keys()]; },
  };
}

// ----- 1. the themed index -----

describe('w7 1: the index Plenum on the computer themes is checked without exactly the attributes it adds', () => {
  it('unthemedIndex removes data-theme and data-legal from the first <html lang="en"> and nothing else', () => {
    for (const attrs of ['data-theme="dark"', 'data-theme="light"', 'data-legal="pending"', 'data-theme="dark" data-legal="pending"']) {
      assert.equal(dec.decode(unthemedIndex(enc.encode(themed(INDEX, attrs)))), INDEX, attrs);
    }
    assert.equal(unthemedIndex(enc.encode(INDEX)), null, 'a plain index has nothing to remove');
    assert.equal(unthemedIndex(enc.encode(themed(INDEX, 'data-theme="blue"'))), null, 'only the two themes withTheme writes');
    assert.equal(unthemedIndex(enc.encode(themed(INDEX, 'data-legal="pending" data-theme="dark"'))), null, 'only in the order withTheme writes them');
  });

  it('verifiedCopy keeps the manifest\'s own bytes for a themed index, and refuses every other change', async () => {
    const desk = computerUi();
    const m = await desk.build();
    const entry = m.files.find(f => f.path === '/');
    const kept = verifiedCopy(enc.encode(themed(INDEX, 'data-theme="dark" data-legal="pending"')), entry);
    assert.equal(sha256Hex(kept), entry.sha256, 'what is kept is the file the manifest names');
    assert.throws(() => verifiedCopy(enc.encode(themed(INDEX, 'data-theme="dark"').replace('Plenum', 'Plenun')), entry), err => err instanceof UiError && err.code === 'size');
    assert.throws(() => verifiedCopy(enc.encode(INDEX.replace('Plenum', 'Plenun')), entry), err => err.code === 'verify');
    const app = m.files.find(f => f.path === '/app.js');
    assert.throws(() => verifiedCopy(enc.encode(themed('<html lang="en">x', 'data-theme="dark"')), app), err => err.code === 'size', 'only the index is ever un-themed');
  });

  it('a pull from a computer that serves a themed index succeeds, on web and Android, and keeps the plain index', async () => {
    const desk = computerUi();
    await desk.build();
    desk.serve = (p, bytes) => (p === '/' ? enc.encode(themed(dec.decode(bytes), 'data-theme="dark"')) : bytes);
    const caches = fakeCaches();
    const web = createUiLoader({ channel: desk.channel, storage: webStorage(caches), platform: 'web' });
    const out = await web.check({ helloHash: desk.manifest.hash, computerId: 'c-one' });
    assert.equal(out.status, 'updated');
    const slot = caches.store.get(out.record.cacheName);
    assert.equal(dec.decode(slot.get('/').bytes), INDEX);

    const files = fakeFiles();
    const calls = [];
    const webView = {
      getServerBasePath: async () => ({ path: null }),
      persistServerBasePath: async ({ path: p }) => calls.push(['persist', p]),
      setServerBasePath: async ({ path: p }) => calls.push(['set', p]),
    };
    const android = createUiLoader({ channel: desk.channel, storage: androidStorage({ files, webView }), platform: 'android' });
    const pulled = await android.check({ helloHash: desk.manifest.hash, computerId: 'c-one' });
    const html = dec.decode(files.map.get(`plenum-ui/${pulled.record.cacheName}/index.html`));
    assert.match(html, /<html lang="en" data-surface="phone">/, 'the rewritten index, without the computer\'s theme');
    assert.deepEqual(calls.map(c => c[0]), ['persist', 'set']);
  });
});

// ----- 2. the staged pull -----

describe('w7 2: a staged pull (activate: false) checks and keeps every file and the record, and moves nothing', () => {
  it('writes the files and a complete record, never persists or sets the base path, and a second check fetches nothing', async () => {
    const desk = computerUi();
    await desk.build();
    const files = fakeFiles();
    const calls = [];
    const webView = {
      getServerBasePath: async () => ({ path: 'public/ui' }),
      persistServerBasePath: async () => calls.push('persist'),
      setServerBasePath: async () => calls.push('set'),
    };
    const loader = createUiLoader({ channel: desk.channel, storage: androidStorage({ files, webView }), platform: 'android' });
    const first = await loader.check({ helloHash: desk.manifest.hash, computerId: 'c-one', activate: false });
    assert.equal(first.status, 'updated');
    assert.equal(first.staged, true);
    assert.equal(first.record.complete, true);
    assert.ok(files.map.get(`plenum-ui/${first.record.cacheName}/app.js`), 'the files are kept');
    assert.deepEqual(calls, [], 'the WebView is not touched');
    desk.requests.length = 0;
    const again = await loader.check({ helloHash: desk.manifest.hash, computerId: 'c-one', activate: false });
    assert.equal(again.status, 'current');
    assert.equal(again.staged, true);
    assert.deepEqual(desk.requests, [], 'nothing is fetched');
    assert.deepEqual(calls, [], 'and the WebView is still not touched (no ensureActive)');
  });

  it('a staged pull that fails part way writes no record and leaves no folder behind', async () => {
    const desk = computerUi();
    await desk.build();
    desk.fail = p => p === '/ext-alpha.js';
    const files = fakeFiles();
    const loader = createUiLoader({ channel: desk.channel, storage: androidStorage({ files, webView: null }), platform: 'android' });
    await assert.rejects(loader.check({ helloHash: desk.manifest.hash, computerId: 'c-one', activate: false }), err => err.code === 'fetch');
    assert.equal(await loader.current(), null);
    assert.deepEqual([...files.map.keys()], [], 'the half-filled folder is dropped');
  });
});

// ----- 3. the compatibility rule -----

describe('w7 3: the built-in screens fit a computer that runs the release they were made for, on the same link protocol', () => {
  const bundled = { version: '0.6.0', protocol: '1.0' };

  it('the same release fits; a build suffix does not count, a pre-release does', () => {
    assert.equal(bundledFit(bundled, HELLO).fits, true);
    assert.equal(bundledFit(bundled, { ...HELLO, desktopVersion: 'v0.6.0+abc' }).fits, true);
    const pre = bundledFit(bundled, { ...HELLO, desktopVersion: '0.6.0-beta.1' });
    assert.equal(pre.fits, false);
    assert.equal(pre.update, 'desktop', 'a pre-release comes before its release');
  });

  it('another release does not fit, and says which side to update', () => {
    assert.deepEqual(bundledFit(bundled, { ...HELLO, desktopVersion: '0.5.0' }), { fits: false, why: 'version', app: '0.6.0', desktop: '0.5.0', update: 'desktop' });
    assert.deepEqual(bundledFit(bundled, { ...HELLO, desktopVersion: '0.6.1' }), { fits: false, why: 'version', app: '0.6.0', desktop: '0.6.1', update: 'app' });
    assert.deepEqual(bundledFit(bundled, { ...HELLO, desktopVersion: '0.10.0' }), { fits: false, why: 'version', app: '0.6.0', desktop: '0.10.0', update: 'app' });
  });

  it('nothing is assumed: an unreadable bundle, a HELLO without a version, or another protocol major do not fit', () => {
    assert.equal(bundledFit(null, HELLO).why, 'unknown');
    assert.equal(bundledFit({ version: 'dev', protocol: '1.0' }, HELLO).why, 'unknown');
    assert.equal(bundledFit(bundled, { ...HELLO, desktopVersion: '' }).why, 'unknown');
    assert.equal(bundledFit(bundled, { ...HELLO, protocol: { major: 2, minor: 0 } }).why, 'protocol');
    assert.equal(bundledFit({ version: '0.6.0' }, HELLO).why, 'unknown', 'a version file without a protocol');
  });

  it('releaseOf reads x.y.z with an optional v, pre-release and build; readBundledVersion reads version.json', async () => {
    assert.equal(releaseOf('0.6.0').text, '0.6.0');
    assert.equal(releaseOf(' v1.2.3-rc.1+x ').text, '1.2.3-rc.1');
    assert.equal(releaseOf('1.2'), null);
    assert.equal(releaseOf(null), null);
    const read = async rel => (rel === 'version.json' ? enc.encode(JSON.stringify({ name: 'plenum-shell', version: '0.6.0', protocol: '1.0', shellSha256: 'a'.repeat(64) })) : null);
    assert.deepEqual(await readBundledVersion(read), { version: '0.6.0', protocol: '1.0' });
    assert.equal(await readBundledVersion(async () => enc.encode('not json')), null);
    assert.equal(await readBundledVersion(async () => null), null);
    assert.equal(await readBundledVersion(null), null);
  });

  it('causeOf names a version mismatch, and a link that dropped mid-pull is "stopped"', () => {
    assert.equal(causeOf({ code: 'version' }), 'version');
    assert.equal(causeOf({ code: 'lost' }), 'stopped');
    assert.equal(causeOf({ code: 'size' }), 'checksum');
  });
});

// ----- 4 and 5. Android -----

const DATA_ROOT = '/data/user/0/com.literallyisyou.plenum/files';
const WWW = Object.freeze({
  'boot.js': '/* boot www */',
  'shell.js': '/* shell www */',
  'channel.worker.js': '/* worker www */',
  'styles.css': '/* styles www */',
});
const SNAPSHOT_SHELL = Object.freeze({
  'shell/boot.js': '/* boot www */',
  'shell/shell.js': '/* shell www */',
  'shell/channel.worker.js': '/* worker www */',
  'shell/styles.css': '/* styles www */',
});

// The app on a phone: the Filesystem and WebView plugins and the app's own files as the WebView serves them. served is the WebView's base: the
// asset folder 'public' (the shell page), 'public/ui' (the built-in screens) or a folder of the app-data folder (a copy from the computer).
function fakeAndroid({ version = '0.6.0', protocol = '1.0' } = {}) {
  const disk = new Map();
  const calls = [];
  const state = { served: 'public', persisted: null };
  const Filesystem = {
    getUri: async () => ({ uri: `file://${DATA_ROOT}` }),
    writeFile: async ({ path: p, data }) => { disk.set(p, data); return {}; },
    readFile: async ({ path: p }) => { if (!disk.has(p)) throw new Error('File does not exist.'); return { data: disk.get(p) }; },
    deleteFile: async ({ path: p }) => { if (!disk.has(p)) throw new Error('File does not exist.'); disk.delete(p); },
    rmdir: async ({ path: p }) => { for (const k of [...disk.keys()]) if (k.startsWith(`${p}/`)) disk.delete(k); },
    readdir: async ({ path: p }) => {
      const names = new Set();
      for (const k of disk.keys()) if (k.startsWith(`${p}/`) && k.slice(p.length + 1).includes('/')) names.add(k.slice(p.length + 1).split('/')[0]);
      return { files: [...names].map(name => ({ name, type: 'directory' })) };
    },
  };
  const WebView = {
    setServerBasePath: async ({ path: p }) => { calls.push(['set', p]); state.served = p; },
    setServerAssetPath: async ({ path: p }) => { calls.push(['asset', p]); state.served = p; },
    persistServerBasePath: async () => { calls.push(['persist', state.served]); state.persisted = state.served; },
    getServerBasePath: async () => ({ path: state.served }),
  };
  const versionFile = JSON.stringify({ name: 'plenum-shell', version, protocol, shellSha256: 'c'.repeat(64) });
  const env = {
    location: { href: 'https://localhost/', pathname: '/', search: '', replace() {}, assign() {} },
    sessionStorage: { setItem() {}, getItem: () => null, removeItem() {} },
    setTimeout,
    clearTimeout,
    // The page's own origin: the www root on the shell page, the ui/ snapshot on the built-in screens. Nothing else is answered here.
    fetch: async url => {
      const name = new URL(url).pathname.slice(1);
      let text = null;
      if (state.served === 'public') text = name === 'version.json' ? versionFile : (WWW[name] ?? null);
      else if (state.served === BUNDLED_UI_ASSET) text = SNAPSHOT_SHELL[name] ?? null;
      return typeof text === 'string' ? new Response(text) : new Response('', { status: 404 });
    },
  };
  const read = rel => (disk.has(rel) ? Buffer.from(disk.get(rel), 'base64').toString('utf8') : null);
  const note = () => { const text = read(`${UI_ROOT}/bundled.json`); return text ? JSON.parse(text) : null; };
  return { disk, calls, state, env, native: { Filesystem, WebView }, read, note };
}

function hostOn(phone, desk) {
  return createUiHost({ env: phone.env, kind: 'android', native: phone.native, channelOf: () => desk?.channel ?? null });
}

describe('w7 4: Android, a pull that fails opens the built-in screens when they fit the computer', () => {
  it('a computer that cannot send its files: the WebView moves to public/ui (and the stale folder path is overwritten), with a note for Phone settings', async () => {
    const desk = computerUi();
    await desk.build();
    desk.fail = p => p !== MANIFEST_PATH;
    const phone = fakeAndroid();
    const host = hostOn(phone, desk);
    const out = await host.show({ hello: { ...HELLO, uiManifestHash: desk.manifest.hash }, computerId: 'c-one' });
    assert.equal(out.ok, true);
    assert.equal(out.status, 'bundled');
    assert.equal(out.navigated, true);
    assert.equal(out.cause, 'not-sent');
    assert.deepEqual(phone.calls, [['asset', 'public/ui'], ['persist', 'public/ui']], 'the asset path, then persist: no folder path is left for the next start');
    const note = phone.note();
    assert.equal(note.computerId, 'c-one');
    assert.equal(note.cause, 'not-sent');
    assert.equal(note.desktopVersion, '0.6.0');
    assert.deepEqual(await host.uiSource(), { kind: 'bundled', computerId: 'c-one', cause: 'not-sent' });
    assert.equal(await host.hasCopy(), false, 'nothing was kept from the computer');
  });

  it('a damaged manifest (the checksum cause) opens the built-in screens too', async () => {
    const desk = computerUi();
    await desk.build();
    desk.manifest = { ...desk.manifest, hash: 'f'.repeat(64) };
    const phone = fakeAndroid();
    const out = await hostOn(phone, desk).show({ hello: { ...HELLO, uiManifestHash: 'f'.repeat(64) }, computerId: 'c-one' });
    assert.equal(out.status, 'bundled');
    assert.equal(out.cause, 'checksum');
  });

  it('a computer on an older release keeps the failed screen, with the versions and "update the computer"; the WebView is not touched', async () => {
    const desk = computerUi({ desktopVersion: '0.5.0' });
    await desk.build();
    desk.fail = () => true;
    const phone = fakeAndroid({ version: '0.6.0' });
    const out = await hostOn(phone, desk).show({ hello: { ...HELLO, desktopVersion: '0.5.0', uiManifestHash: desk.manifest.hash }, computerId: 'c-one' });
    assert.equal(out.ok, false);
    assert.equal(out.cause, 'version');
    assert.deepEqual(out.versions, { app: '0.6.0', desktop: '0.5.0', update: 'desktop' });
    assert.deepEqual(phone.calls, []);
    assert.equal(phone.note(), null);
  });

  it('a computer on a newer release says "update this app"; a bundle that cannot be read keeps the pull\'s own cause', async () => {
    const desk = computerUi({ desktopVersion: '0.7.0' });
    await desk.build();
    desk.fail = () => true;
    const newer = await hostOn(fakeAndroid({ version: '0.6.0' }), desk).show({ hello: { ...HELLO, desktopVersion: '0.7.0', uiManifestHash: desk.manifest.hash }, computerId: 'c-one' });
    assert.equal(newer.cause, 'version');
    assert.equal(newer.versions.update, 'app');
    const phone = fakeAndroid({ version: 'not a version' });
    const unknown = await hostOn(phone, desk).show({ hello: { ...HELLO, desktopVersion: '0.7.0', uiManifestHash: desk.manifest.hash }, computerId: 'c-one' });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.cause, 'not-sent');
    assert.equal(unknown.versions ?? null, null);
    assert.deepEqual(phone.calls, []);
  });

  it('a copy that verifies still wins: the WebView moves to the folder, never to public/ui, and an old note is cleared', async () => {
    const desk = computerUi();
    await desk.build();
    const phone = fakeAndroid();
    phone.disk.set(`${UI_ROOT}/bundled.json`, Buffer.from(JSON.stringify({ computerId: 'c-one', at: 1, cause: 'not-sent' })).toString('base64'));
    const host = hostOn(phone, desk);
    const out = await host.show({ hello: { ...HELLO, uiManifestHash: desk.manifest.hash }, computerId: 'c-one' });
    assert.equal(out.ok, true);
    assert.equal(out.status, 'updated');
    const record = await androidStorage({ files: { read: async rel => (phone.disk.has(rel) ? Buffer.from(phone.disk.get(rel), 'base64') : null) } }).readActive();
    assert.deepEqual(phone.calls, [['set', `${DATA_ROOT}/${UI_ROOT}/${record.cacheName}`], ['persist', `${DATA_ROOT}/${UI_ROOT}/${record.cacheName}`]]);
    assert.equal(phone.note(), null, 'the note is gone: the computer\'s own screens run');
    assert.deepEqual(await host.uiSource(), { kind: 'computer', computerId: 'c-one', files: 3 });
  });

  it('the themed index of an older Plenum on the computer no longer fails the pull (the cause of the 17 Nov failure when a theme is set)', async () => {
    const desk = computerUi();
    await desk.build();
    desk.serve = (p, bytes) => (p === '/' ? enc.encode(themed(dec.decode(bytes), 'data-theme="dark"')) : bytes);
    const phone = fakeAndroid();
    const out = await hostOn(phone, desk).show({ hello: { ...HELLO, uiManifestHash: desk.manifest.hash }, computerId: 'c-one' });
    assert.equal(out.status, 'updated');
    assert.equal(phone.calls[0][0], 'set', 'the computer\'s own screens, not the built-in ones');
  });
});

describe('w7 5: Android, on the built-in screens the pull is tried again in the background; the page moves only to a complete, checked copy', () => {
  // The phone after a fallback: the WebView serves public/ui and the note names c-one. The computer is fixed afterwards.
  async function onBuiltIn() {
    const desk = computerUi();
    await desk.build();
    desk.fail = p => p !== MANIFEST_PATH;
    const phone = fakeAndroid();
    await hostOn(phone, desk).show({ hello: { ...HELLO, uiManifestHash: desk.manifest.hash }, computerId: 'c-one' });
    assert.equal(phone.state.served, BUNDLED_UI_ASSET);
    desk.fail = null;
    phone.calls.length = 0;
    const page = hostOn(phone, desk);
    const hello = { ...HELLO, uiManifestHash: desk.manifest.hash };
    return { desk, phone, page, hello };
  }

  it('the built-in page knows which computer it was opened for (no loop through the shell page); without a note it serves any', async () => {
    const { phone, page } = await onBuiltIn();
    assert.equal(await page.uiComputerId(), 'c-one');
    phone.disk.delete(`${UI_ROOT}/bundled.json`);
    assert.equal(await page.uiComputerId(), 'any');
  });

  it('a HELLO stages the copy (with the shell files of the built-in page) and does not move, even when nothing is running', async () => {
    const { phone, page, hello } = await onBuiltIn();
    const out = await page.refresh({ hello, computerId: 'c-one', mayMove: true, reason: 'hello' });
    assert.equal(out.ok, true);
    assert.equal(out.staged, true);
    assert.equal(out.switched ?? false, false, 'not in the call that pulled it');
    assert.deepEqual(phone.calls, []);
    const record = JSON.parse(phone.read(`${UI_ROOT}/active.json`));
    assert.equal(record.complete, true);
    for (const rel of SHELL_FILES) assert.equal(phone.read(`${UI_ROOT}/${record.cacheName}/${rel}`), SNAPSHOT_SHELL[rel], `${rel} came from the built-in page's /shell/`);
    assert.ok(phone.note(), 'the built-in screens still run, and the note still says so');
  });

  it('the next HELLO moves to the staged copy only when nothing runs; the folder is whole and the note is cleared', async () => {
    const { phone, page, hello } = await onBuiltIn();
    await page.refresh({ hello, computerId: 'c-one', mayMove: true, reason: 'hello' });
    const busy = await page.refresh({ hello, computerId: 'c-one', mayMove: false, reason: 'hello' });
    assert.equal(busy.switched ?? false, false, 'a run is going: no move');
    assert.deepEqual(phone.calls, []);
    const quiet = await page.refresh({ hello, computerId: 'c-one', mayMove: true, reason: 'hello' });
    assert.equal(quiet.switched, true);
    const record = JSON.parse(phone.read(`${UI_ROOT}/active.json`));
    const folder = `${DATA_ROOT}/${UI_ROOT}/${record.cacheName}`;
    assert.deepEqual(phone.calls, [['set', folder], ['persist', folder]]);
    assert.match(phone.read(`${UI_ROOT}/${record.cacheName}/index.html`), /data-surface="phone"/);
    assert.equal(phone.read(`${UI_ROOT}/${record.cacheName}/shell/boot.js`), SNAPSHOT_SHELL['shell/boot.js']);
    assert.equal(phone.note(), null);
  });

  it('a resume tries the pull again but never moves; a copy for another hash than the HELLO\'s is pulled again first', async () => {
    const { desk, phone, page, hello } = await onBuiltIn();
    const resumed = await page.refresh({ hello, computerId: 'c-one', mayMove: true, reason: 'resume' });
    assert.equal(resumed.staged, true);
    const again = await page.refresh({ hello, computerId: 'c-one', mayMove: false, reason: 'resume' });
    assert.equal(again.switched ?? false, false);
    assert.deepEqual(phone.calls, []);
    desk.files.set('app.js', Buffer.from('window.appLoaded = 2;\n'));
    await desk.build();
    const changed = await page.refresh({ hello: { ...hello, uiManifestHash: desk.manifest.hash }, computerId: 'c-one', mayMove: true, reason: 'hello' });
    assert.equal(changed.switched ?? false, false, 'the new copy was only just pulled');
    assert.equal(JSON.parse(phone.read(`${UI_ROOT}/active.json`)).hash, desk.manifest.hash);
  });

  it('a pull that still fails leaves the built-in screens and no half-written folder; a later HELLO cannot move to it', async () => {
    const { desk, phone, page, hello } = await onBuiltIn();
    desk.fail = p => p === '/ext-alpha.js';
    const out = await page.refresh({ hello, computerId: 'c-one', mayMove: true, reason: 'hello' });
    assert.equal(out.ok, false);
    assert.equal(phone.read(`${UI_ROOT}/active.json`), null);
    assert.deepEqual([...phone.disk.keys()].filter(k => k.startsWith(`${UI_ROOT}/plenum-ui-`)), []);
    const later = await page.refresh({ hello, computerId: 'c-one', mayMove: true, reason: 'hello' });
    assert.equal(later.switched ?? false, false);
    assert.deepEqual(phone.calls, []);
    assert.equal(phone.state.served, BUNDLED_UI_ASSET);
  });

  it('on a page that runs the computer\'s copy, a resume asks for nothing', async () => {
    const desk = computerUi();
    await desk.build();
    const phone = fakeAndroid();
    await hostOn(phone, desk).show({ hello: { ...HELLO, uiManifestHash: desk.manifest.hash }, computerId: 'c-one' });
    desk.requests.length = 0;
    phone.calls.length = 0;
    const out = await hostOn(phone, desk).refresh({ hello: { ...HELLO, uiManifestHash: desk.manifest.hash }, computerId: 'c-one', mayMove: true, reason: 'resume' });
    assert.equal(out.ok, true);
    assert.deepEqual(desk.requests, []);
    assert.deepEqual(phone.calls, []);
  });

  it('bundledUiReader reads the shell files where the built-in page has them (/shell/<name>)', async () => {
    const seen = [];
    const read = bundledUiReader(async url => { seen.push(url); return new Response('x'); }, 'https://localhost/');
    assert.equal(dec.decode(await read('shell/boot.js')), 'x');
    assert.deepEqual(seen, ['https://localhost/shell/boot.js']);
  });
});

// ----- 6. the shell -----

function fakeWorkerFactory({ net, clock, store }) {
  return () => {
    let core = null;
    const worker = {
      onmessage: null,
      onerror: null,
      postMessage(msg) {
        const copy = structuredClone(msg);
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

async function shellRig(shellOptions = {}) {
  const net = createFakeNet();
  const clock = createFakeClock(0);
  const wall = createFakeClock(1_000_000);
  const desktop = createFakeDesktop({ net, uiManifestHash: 'h'.repeat(64) });
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
  const shell = createShell({
    store,
    createWorker: fakeWorkerFactory({ net, clock, store }),
    device: { name: 'Test phone', platform: 'android', app: 'android', appVersion: '1', uiHash: '' },
    caps: ['ui-from-desktop'],
    stopClock: wall,
    ...shellOptions,
  });
  await shell.start();
  return { shell, desktop, id: deviceId(desktop.keys.publicKey) };
}

describe('w7 6: the shell passes when the UI page may move, and keeps which screens run', () => {
  it('uiMayMove: a HELLO that counts no run and no Stop in flight; anything else is not quiet', () => {
    assert.equal(uiMayMove({ pending: { approvals: 2, running: 0 } }, 'idle'), true);
    assert.equal(uiMayMove({ pending: { approvals: 0, running: 1 } }, 'idle'), false);
    assert.equal(uiMayMove({ pending: { runs: 0 } }, 'done'), true);
    assert.equal(uiMayMove({ pending: { running: 0 } }, 'sending'), false);
    assert.equal(uiMayMove({ pending: { running: 0 } }, 'queued'), false);
    assert.equal(uiMayMove({}, 'idle'), false, 'a HELLO without a count says nothing');
    assert.equal(uiMayMove(null), false);
  });

  it('on the UI page a HELLO refreshes with reason hello and mayMove; a return to the app refreshes with reason resume and never moves', async () => {
    const calls = [];
    const uiHost = {
      kind: 'android',
      refresh: async args => { calls.push({ reason: args.reason, mayMove: args.mayMove, computerId: args.computerId }); return { ok: true, changed: false, reload: false }; },
      show: async () => ({ ok: true }),
      loadedHash: async () => null,
      hasCopy: async () => false,
      useCopy: async () => ({ ok: true }),
      openShell: async () => true,
      uiComputerId: async () => 'any',
    };
    const rig = await shellRig({ pageKind: 'ui', uiHost });
    await waitFor(() => calls.length >= 1);
    assert.deepEqual(calls[0], { reason: 'hello', mayMove: true, computerId: rig.id });
    await rig.shell.visibility(false);
    await rig.shell.visibility(true);
    await waitFor(() => calls.length >= 2);
    assert.equal(calls[1].reason, 'resume');
    assert.equal(calls[1].mayMove, false);
  });

  it('on the shell page a pull that does not fit keeps the cause and the versions for the failed screen, and the source for Phone settings', async () => {
    const uiHost = {
      kind: 'android',
      show: async () => ({ ok: false, cause: 'version', code: 'fetch', versions: { app: '0.6.0', desktop: '0.5.0', update: 'desktop' } }),
      refresh: async () => ({ ok: true, changed: false, reload: false }),
      loadedHash: async () => null,
      hasCopy: async () => false,
      useCopy: async () => ({ ok: true }),
      openShell: async () => true,
      uiSource: async () => ({ kind: 'bundled', computerId: 'c-x', cause: 'not-sent' }),
    };
    const rig = await shellRig({ uiHost });
    await waitFor(() => rig.shell.state().ui.state === 'failed');
    const ui = rig.shell.state().ui;
    assert.equal(ui.cause, 'version');
    assert.deepEqual(ui.versions, { app: '0.6.0', desktop: '0.5.0', update: 'desktop' });
    await waitFor(() => rig.shell.state().ui.source !== null && rig.shell.state().ui.source !== undefined);
    assert.deepEqual(rig.shell.state().ui.source, { kind: 'bundled', computerId: 'c-x', cause: 'not-sent' });
  });
});

// ----- 7. the screens -----

class FakeNode {}
class FakeText extends FakeNode {
  constructor(text) { super(); this.data = String(text); }
}
class FakeEl extends FakeNode {
  constructor(tag) { super(); this.tagName = String(tag).toUpperCase(); this.attrs = new Map(); this.children = []; this.textContent = ''; this.className = ''; this.hidden = false; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.get(k) ?? null; }
  append(...nodes) { this.children.push(...nodes); }
  addEventListener() {}
}
const textOf = node => (node instanceof FakeText ? node.data : [node.textContent, ...(node.children ?? []).map(textOf)].join(' '));

describe('w7 7: the screens say plainly which screens run, and why the built-in ones could not stand in', () => {
  let savedNode;
  before(() => {
    savedNode = globalThis.Node;
    globalThis.Node = FakeNode;
    setDocument({ createElement: tag => new FakeEl(tag), createTextNode: text => new FakeText(text) });
  });
  after(() => {
    if (savedNode === undefined) delete globalThis.Node;
    else globalThis.Node = savedNode;
  });

  const io = { act: new Proxy({}, { get: () => () => {} }), local: {}, go() {}, back() {}, later() {}, repaint() {} };
  const env = { location: { protocol: 'https:', hostname: 'localhost', pathname: '/', search: '' }, navigator: { userAgent: 'Android' }, Capacitor: { getPlatform: () => 'android', isNativePlatform: () => true } };
  const snapshot = (ui, extra = {}) => ({
    computers: [{ id: 'c-one', name: 'Home PC' }],
    activeId: 'c-one',
    connection: { status: 'connected', carrier: 'lan', since: 1 },
    hello: { desktopName: 'Home PC', desktopVersion: '0.5.0', pending: null },
    pairing: null,
    locked: false,
    lock: { mode: 'off', failures: 0, waitSec: 0 },
    device: { appVersion: '0.6.0', protocol: '1.0' },
    ui: { state: 'idle', cause: null, progress: null, hasCopy: false, kind: 'android', ...ui },
    ...extra,
  });

  it('the version sentence names both versions and which side to update', () => {
    const older = C.uiFailedBody('Home PC', 'version', { app: '0.6.0', desktop: '0.5.0', update: 'desktop' });
    assert.equal(older, "Home PC could not send Plenum's screens. The screens built into this app are for Plenum 0.6.0, and Home PC runs Plenum 0.5.0. On the computer, open Settings › Updates and install the update.");
    const newer = C.uiFailedBody('Home PC', 'version', { app: '0.6.0', desktop: '0.7.0', update: 'app' });
    assert.equal(newer, "Home PC could not send Plenum's screens. The screens built into this app are for Plenum 0.6.0, and Home PC runs Plenum 0.7.0. Update this app, then open it again.");
    assert.equal(C.uiFailedBody('Home PC', 'not-sent'), "Home PC did not send Plenum's screens. Try again.", 'the other causes are as before');
    for (const text of [older, newer]) assert.doesNotMatch(text, /!/);
  });

  it('the failed screen shows the version sentence from the shell state', () => {
    const s = snapshot({ state: 'failed', cause: 'version', versions: { app: '0.6.0', desktop: '0.5.0', update: 'desktop' } });
    const ctx = ctxFor(s, {}, env);
    const node = renderScreen('ui-failed', { ...ctx, id: 'ui-failed' }, io);
    assert.match(textOf(node), /The screens built into this app are for Plenum 0\.6\.0, and Home PC runs Plenum 0\.5\.0\./);
    assert.doesNotMatch(textOf(node), /Use the copy in this app/);
  });

  it('Phone settings says the built-in screens run for this computer, and only then; About says where the screens came from', () => {
    const line = C2.fillName(C2.SCREENS_BUNDLED, 'Home PC');
    assert.equal(line, 'Using the screens built into this app; Plenum on Home PC could not send its own.');
    const render = (source, id = 'settings') => {
      const s = snapshot({ source });
      const ctx = ctxFor(s, {}, env);
      ctx.vm = buildVm(s, {}, env, null);
      return textOf(renderPart2(id, { ...ctx, id }, io));
    };
    assert.ok(render({ kind: 'bundled', computerId: 'c-one', cause: 'not-sent' }).includes(line));
    assert.ok(!render({ kind: 'bundled', computerId: 'c-two', cause: 'not-sent' }).includes(line), 'another computer\'s fallback is not this one\'s');
    assert.ok(!render({ kind: 'computer', computerId: 'c-one', files: 141 }).includes(line));
    assert.ok(!render(null).includes(line));
    assert.ok(render({ kind: 'computer', computerId: 'c-one', files: 141 }, 'about').includes('Screens: loaded from Home PC, 141 files, all checked'));
    assert.ok(render({ kind: 'bundled', computerId: 'c-one' }, 'about').includes(C2.ABOUT_SCREENS_BUILT));
  });
});
