// Wave 7 (phone follow-ups, 17 Nov 2026): two phone bugs the "phone own UI" fix noticed and left.
//   1. Android, on a page that runs a copy of the computer's screens: a newer copy was switched to as soon as it verified, even in the middle of a
//      turn (the WebView reloads at once and the reply that was streaming is cut). The page now stages the newer copy and moves to it only at a
//      later HELLO, only to a complete record whose files all verified, and only when the HELLO counts no run going and no Stop is going out (the
//      same rule as the built-in screens). Staging never removes the folder the WebView serves, and the old folder goes once the page has moved.
//   2. "N runs going" never showed: the computer's HELLO counts runs in pending.running (lib/remote/index.mjs pendingNow), and the phone's screens
//      read pending.runs. They now read running (runs is still read, for the demo and older fixtures): the line in the failed and connected
//      screens, the Stop button's active mark (screens/main.js) and its description on the UI page (boot.js).
// Node only, on fakes (an in-memory computer, fake Capacitor plugins, fake pages). Nothing is written to disk and nothing runs on a phone.
// Run sealed from the mobile folder: bash /path/to/seal.sh w7-phfu node --test test/w7-phone-followups.test.mjs
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createUiHost, UI_ROOT } from '../shell/ui-host.js';
import { androidStorage } from '../shell/ui-loader.js';
import { installShim } from '../shell/boot.js';
import { MANIFEST_PATH, fileNameFor, manifest, resetManifestCache } from '../../lib/remote/ui-manifest.mjs';
import * as C from '../shell/screens/copy.js';
import { setDocument } from '../shell/screens/dom.js';
import { ctxFor } from '../shell/screens/route.js';
import { buildVm, mountScreens } from '../shell/screens/main.js';
import { renderScreen } from '../shell/screens/views.js';
import { renderPart2 } from '../shell/screens/views2.js';

const enc = new TextEncoder();

const INDEX = '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>Plenum</title>\n</head>\n<body>\n  <main id="app"></main>\n  <script src="/app.js" defer></script>\n</body>\n</html>\n';
const UI_FILES = Object.freeze({ 'index.html': INDEX, 'app.js': 'window.appLoaded = 1;\n', 'ext-alpha.js': 'window.alpha = 1;\n' });
// The HELLO as lib/remote/index.mjs helloFor sends it: pending is { approvals, running }.
const HELLO = Object.freeze({ protocol: { major: 1, minor: 1 }, desktopVersion: '0.6.0', pending: { approvals: 0, running: 0 } });
const DATA_ROOT = '/data/user/0/com.literallyisyou.plenum/files';
const WWW = Object.freeze({ 'boot.js': '/* boot www */', 'shell.js': '/* shell www */', 'channel.worker.js': '/* worker www */', 'styles.css': '/* styles www */' });

async function settle(rounds = 25) {
  for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve));
}

function reply(status, bytes) {
  const body = new ReadableStream({ start(c) { if (bytes?.byteLength) c.enqueue(new Uint8Array(bytes)); c.close(); } });
  return { status, headers: {}, body, id: 1, cancel() {} };
}

// The computer's UI in memory (as in w7-phone-own-ui.test.mjs): the real manifest() over a fake overlay and fs, and a channel that answers it.
function computerUi({ files = UI_FILES, desktopVersion = '0.6.0' } = {}) {
  const state = { files: new Map(Object.entries(files).map(([n, t]) => [n, Buffer.from(t, 'utf8')])), manifest: null, requests: [], fail: null };
  state.build = async () => {
    resetManifestCache();
    const overlay = { listFiles: (dir, pick) => [...state.files.keys()].filter(name => pick(name)), filePath: rel => rel };
    const fs = {
      readFileSync: rel => {
        const bytes = state.files.get(String(rel).replace(/^public\//, ''));
        if (!bytes) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return Buffer.from(bytes);
      },
    };
    state.manifest = await manifest({ desktopVersion, generation: null, overlay, fs, crypto });
    return state.manifest;
  };
  state.change = async (name, text) => {
    state.files.set(name, Buffer.from(text, 'utf8'));
    return state.build();
  };
  state.channel = {
    async request({ path: p = '/' } = {}) {
      state.requests.push(p);
      if (state.fail?.(p)) return reply(404, enc.encode('{"error":"Not found."}'));
      if (p === MANIFEST_PATH) return reply(200, enc.encode(JSON.stringify(state.manifest)));
      const bytes = state.files.get(fileNameFor(p));
      return bytes ? reply(200, new Uint8Array(bytes)) : reply(404, enc.encode('{"error":"Not found."}'));
    },
  };
  return state;
}

// The Android app: Filesystem and WebView plugins. served is the WebView's base: 'public' (the shell page) or an app-data folder (a copy). The
// page's own origin answers the app's www files on the shell page only (a copy's page has no /boot.js or version.json at its root).
function fakeAndroid() {
  const disk = new Map();
  const calls = [];
  const state = { served: 'public' };
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
    persistServerBasePath: async () => { calls.push(['persist', state.served]); },
    getServerBasePath: async () => ({ path: state.served }),
  };
  const versionFile = JSON.stringify({ name: 'plenum-shell', version: '0.6.0', protocol: '1.0', shellSha256: 'c'.repeat(64) });
  const env = {
    location: { href: 'https://localhost/', pathname: '/', search: '', replace() {}, assign() {} },
    sessionStorage: { setItem() {}, getItem: () => null, removeItem() {} },
    setTimeout,
    clearTimeout,
    fetch: async url => {
      const name = new URL(url).pathname.slice(1);
      const text = state.served === 'public' ? (name === 'version.json' ? versionFile : (WWW[name] ?? null)) : null;
      return typeof text === 'string' ? new Response(text) : new Response('', { status: 404 });
    },
  };
  const read = rel => (disk.has(rel) ? Buffer.from(disk.get(rel), 'base64').toString('utf8') : null);
  const folders = () => [...new Set([...disk.keys()].filter(k => k.startsWith(`${UI_ROOT}/plenum-ui-`)).map(k => k.split('/')[1]))].sort();
  return { disk, calls, state, env, native: { Filesystem, WebView }, read, folders };
}

const hostOn = (phone, desk) => createUiHost({ env: phone.env, kind: 'android', native: phone.native, channelOf: () => desk?.channel ?? null });
const activeRecord = phone => JSON.parse(phone.read(`${UI_ROOT}/active.json`));
const folderOf = record => `${DATA_ROOT}/${UI_ROOT}/${record.cacheName}`;

// ----- 1. Android: a newer copy waits for a quiet, later HELLO -----

describe('w7-phfu 1: on the Android page that runs the computer\'s copy, a newer copy is staged and the page moves only at a later quiet HELLO', () => {
  // The phone runs copy A of the computer's screens (the shell page pulled it and the WebView moved there). Then the computer's UI changes (B).
  async function onCopy() {
    const desk = computerUi();
    await desk.build();
    const phone = fakeAndroid();
    const shown = await hostOn(phone, desk).show({ hello: { ...HELLO, uiManifestHash: desk.manifest.hash }, computerId: 'c-one' });
    assert.equal(shown.status, 'updated');
    const a = activeRecord(phone);
    assert.equal(phone.state.served, folderOf(a));
    phone.calls.length = 0;
    await desk.change('app.js', 'window.appLoaded = 2;\n');
    const hello = { ...HELLO, uiManifestHash: desk.manifest.hash };
    return { desk, phone, a, page: hostOn(phone, desk), hello };
  }

  it('the HELLO that brings a newer copy stages it and does not move, even when nothing runs (17 Nov: it moved at once, mid-turn too)', async () => {
    const { phone, a, page, hello } = await onCopy();
    const out = await page.refresh({ hello, computerId: 'c-one', mayMove: true, reason: 'hello' });
    assert.equal(out.ok, true);
    assert.deepEqual(phone.calls, [], 'the WebView is not moved in the call that pulled the copy');
    assert.equal(phone.state.served, folderOf(a));
    const b = activeRecord(phone);
    assert.equal(b.complete, true);
    assert.equal(b.hash, hello.uiManifestHash);
    assert.notEqual(b.cacheName, a.cacheName);
    assert.equal(out.staged, true);
    assert.equal(out.switched ?? false, false);
  });

  it('staging keeps the folder the page runs from whole (no file of the running screens is removed), and the new folder has the shell files', async () => {
    const { phone, a, page, hello } = await onCopy();
    const before = [...phone.disk.keys()].filter(k => k.startsWith(`${UI_ROOT}/${a.cacheName}/`)).sort();
    assert.ok(before.length >= 3 + 4, 'the copy A folder: three UI files and four shell files');
    await page.refresh({ hello, computerId: 'c-one', mayMove: false, reason: 'hello' });
    const kept = [...phone.disk.keys()].filter(k => k.startsWith(`${UI_ROOT}/${a.cacheName}/`)).sort();
    assert.deepEqual(kept, before, 'the folder the WebView serves stays as it was');
    const b = activeRecord(phone);
    for (const name of Object.keys(WWW)) assert.equal(phone.read(`${UI_ROOT}/${b.cacheName}/shell/${name}`), WWW[name], `shell/${name} carried over from the running copy`);
  });

  it('a later HELLO with a run going does not move; the next quiet one moves to the staged copy, whose index is the phone\'s', async () => {
    const { phone, a, page, hello } = await onCopy();
    await page.refresh({ hello, computerId: 'c-one', mayMove: false, reason: 'hello' });
    const busy = await page.refresh({ hello, computerId: 'c-one', mayMove: false, reason: 'hello' });
    assert.equal(busy.switched ?? false, false, 'a run is going (or a Stop is on its way): no move');
    assert.deepEqual(phone.calls, []);
    assert.equal(phone.state.served, folderOf(a));
    const quiet = await page.refresh({ hello, computerId: 'c-one', mayMove: true, reason: 'hello' });
    assert.equal(quiet.ok, true);
    assert.equal(quiet.switched, true);
    const b = activeRecord(phone);
    assert.deepEqual(phone.calls, [['set', folderOf(b)], ['persist', folderOf(b)]], 'set, then persist, at the new folder');
    assert.match(phone.read(`${UI_ROOT}/${b.cacheName}/index.html`), /data-surface="phone"/);
  });

  it('a return to the app never moves and asks for nothing', async () => {
    const { desk, phone, page, hello } = await onCopy();
    await page.refresh({ hello, computerId: 'c-one', mayMove: false, reason: 'hello' });
    desk.requests.length = 0;
    const out = await page.refresh({ hello, computerId: 'c-one', mayMove: true, reason: 'resume' });
    assert.equal(out.ok, true);
    assert.deepEqual(desk.requests, []);
    assert.deepEqual(phone.calls, []);
  });

  it('after the move, the next HELLO removes the folder the page ran from before; the running one stays', async () => {
    const { desk, phone, a, page, hello } = await onCopy();
    await page.refresh({ hello, computerId: 'c-one', mayMove: true, reason: 'hello' });
    await page.refresh({ hello, computerId: 'c-one', mayMove: true, reason: 'hello' });
    const b = activeRecord(phone);
    assert.equal(phone.state.served, folderOf(b));
    assert.deepEqual(phone.folders().sort(), [a.cacheName, b.cacheName].sort(), 'just after the move the old folder may still be in use');
    phone.calls.length = 0;
    // The page reloaded at B: a new page, a new HELLO.
    const again = await hostOn(phone, desk).refresh({ hello, computerId: 'c-one', mayMove: true, reason: 'hello' });
    assert.equal(again.ok, true);
    assert.equal(again.switched ?? false, false);
    assert.deepEqual(phone.calls, []);
    assert.deepEqual(phone.folders(), [b.cacheName]);
  });

  it('a newer copy that fails part way leaves the running copy served and whole, and nothing to move to', async () => {
    const { desk, phone, a, page, hello } = await onCopy();
    desk.fail = p => p === '/app.js';
    const out = await page.refresh({ hello, computerId: 'c-one', mayMove: true, reason: 'hello' });
    assert.equal(out.ok, false);
    assert.equal(activeRecord(phone).cacheName, a.cacheName, 'the record still names the running copy');
    assert.deepEqual(phone.folders(), [a.cacheName]);
    desk.fail = null;
    const next = await page.refresh({ hello, computerId: 'c-one', mayMove: true, reason: 'hello' });
    assert.equal(next.switched ?? false, false, 'the copy pulled now is only just complete');
    assert.equal(phone.state.served, folderOf(a));
  });

  it('the shell page, when the person opens it, still moves to a staged copy at once (nothing runs there)', async () => {
    const { desk, phone, page, hello } = await onCopy();
    await page.refresh({ hello, computerId: 'c-one', mayMove: false, reason: 'hello' });
    phone.state.served = 'public';
    phone.calls.length = 0;
    const out = await hostOn(phone, desk).show({ hello, computerId: 'c-one' });
    assert.equal(out.ok, true);
    assert.equal(out.status, 'current');
    const b = activeRecord(phone);
    assert.deepEqual(phone.calls, [['set', folderOf(b)], ['persist', folderOf(b)]]);
  });
});

describe('w7-phfu 1b: androidStorage never removes the folder the WebView serves', () => {
  function storageOver(served) {
    const map = new Map();
    const files = {
      async write(rel, bytes) { map.set(rel, bytes); },
      async read(rel) { return map.get(rel) ?? null; },
      async removeDir(rel) { for (const k of [...map.keys()]) if (k.startsWith(`${rel}/`)) map.delete(k); },
      async listDirs(root) { return [...new Set([...map.keys()].filter(k => k.startsWith(`${root}/`) && k.split('/').length > 2).map(k => k.split('/')[1]))]; },
    };
    const webView = typeof served === 'function' ? { getServerBasePath: served } : { getServerBasePath: async () => ({ path: served }) };
    const storage = androidStorage({ files, webView, root: 'plenum-ui' });
    for (const name of ['plenum-ui-a', 'plenum-ui-b', 'plenum-ui-c']) map.set(`plenum-ui/${name}/index.html`, enc.encode('x'));
    const left = () => [...new Set([...map.keys()].map(k => k.split('/')[1]))].sort();
    return { storage, left };
  }

  it('dropSlotsExcept keeps the named folder and the served one', async () => {
    const { storage, left } = storageOver('plenum-ui/plenum-ui-a');
    await storage.dropSlotsExcept('plenum-ui-b');
    assert.deepEqual(left(), ['plenum-ui-a', 'plenum-ui-b']);
  });

  it('a WebView that serves something else (the shell page, the built-in screens) protects nothing; one that cannot say removes nothing', async () => {
    const shell = storageOver('public/ui');
    await shell.storage.dropSlotsExcept('plenum-ui-b');
    assert.deepEqual(shell.left(), ['plenum-ui-b']);
    const unknown = storageOver(async () => { throw new Error('no bridge'); });
    await unknown.storage.dropSlotsExcept('plenum-ui-b');
    assert.deepEqual(unknown.left(), ['plenum-ui-a', 'plenum-ui-b', 'plenum-ui-c']);
  });
});

// ----- 1c (review, w7r-phfu): the computer goes back to the copy the page runs -----
//
// The phone runs copy A; a HELLO stages B; then the computer goes back to A (Settings › Updates › roll back: the generation before is kept, so
// the same version, generation and files give the same manifest hash). The next pull's folder name (cacheNameFor) is A's, the folder the
// WebView serves. Before the review the staged pull wrote into that folder: the raw index (without the phone's shell tags) replaced the
// phone's, and ensureActive later saw the folder served and left it, so the next reload of the page had no shell. A pull that failed part
// way removed the folder outright (dropSlot), the page's own files.

describe('w7r-phfu 1c: a pull never writes into or removes the folder the WebView serves', () => {
  async function rolledBack() {
    const desk = computerUi();
    await desk.build();
    const phone = fakeAndroid();
    await hostOn(phone, desk).show({ hello: { ...HELLO, uiManifestHash: desk.manifest.hash }, computerId: 'c-one' });
    const a = activeRecord(phone);
    const folderA = () => [...phone.disk.entries()].filter(([k]) => k.startsWith(`${UI_ROOT}/${a.cacheName}/`)).sort(([x], [y]) => (x < y ? -1 : 1));
    const before = folderA();
    const page = hostOn(phone, desk);
    await desk.change('app.js', 'window.appLoaded = 2;\n');
    await page.refresh({ hello: { ...HELLO, uiManifestHash: desk.manifest.hash }, computerId: 'c-one', mayMove: false, reason: 'hello' });
    assert.notEqual(activeRecord(phone).cacheName, a.cacheName, 'B is staged');
    await desk.change('app.js', UI_FILES['app.js']);
    const hello = { ...HELLO, uiManifestHash: desk.manifest.hash };
    assert.equal(hello.uiManifestHash, a.hash, 'the computer serves A again');
    phone.calls.length = 0;
    return { desk, phone, a, page, hello, before, folderA };
  }

  it('the staged pull leaves the served folder exactly as it was (its index stays the phone\'s); a later quiet HELLO moves to a whole copy', async () => {
    const { phone, a, page, hello, before, folderA } = await rolledBack();
    const out = await page.refresh({ hello, computerId: 'c-one', mayMove: true, reason: 'hello' });
    assert.equal(out.ok, true);
    assert.deepEqual(phone.calls, [], 'no move in the call that pulled');
    assert.equal(phone.state.served, folderOf(a));
    assert.deepEqual(folderA(), before, 'nothing in the folder the page runs from was rewritten');
    assert.match(phone.read(`${UI_ROOT}/${a.cacheName}/index.html`), /data-surface="phone"/);
    const quiet = await page.refresh({ hello, computerId: 'c-one', mayMove: true, reason: 'hello' });
    assert.equal(quiet.ok, true);
    const now = activeRecord(phone);
    assert.equal(now.hash, a.hash);
    assert.equal(now.complete, true);
    const served = phone.state.served.slice(`${DATA_ROOT}/`.length);
    assert.equal(served, `${UI_ROOT}/${now.cacheName}`, 'the WebView serves the record\'s folder');
    assert.match(phone.read(`${served}/index.html`), /data-surface="phone"/, 'whatever folder runs, its index has the shell');
    for (const name of Object.keys(WWW)) assert.equal(phone.read(`${served}/shell/${name}`), WWW[name], `shell/${name}`);
  });

  it('a pull that fails part way never removes the folder the page runs from', async () => {
    const { desk, phone, a, page, hello, before, folderA } = await rolledBack();
    // The staged copy B has lost its index (so the pull has to ask the computer for it), and the computer does not send it.
    phone.disk.delete(`${UI_ROOT}/${activeRecord(phone).cacheName}/index.html`);
    desk.fail = p => p === '/';
    const out = await page.refresh({ hello, computerId: 'c-one', mayMove: true, reason: 'hello' });
    assert.equal(out.ok, false);
    assert.equal(phone.state.served, folderOf(a));
    assert.deepEqual(folderA(), before, 'the running copy is whole');
  });

  it('dropSlot keeps the folder the WebView serves', async () => {
    const map = new Map([['plenum-ui/plenum-ui-a/index.html', enc.encode('x')], ['plenum-ui/plenum-ui-b/index.html', enc.encode('y')]]);
    const files = {
      async write(rel, bytes) { map.set(rel, bytes); },
      async read(rel) { return map.get(rel) ?? null; },
      async removeDir(rel) { for (const k of [...map.keys()]) if (k.startsWith(`${rel}/`)) map.delete(k); },
    };
    const storage = androidStorage({ files, webView: { getServerBasePath: async () => ({ path: 'plenum-ui/plenum-ui-a' }) }, root: 'plenum-ui' });
    await storage.dropSlot('plenum-ui-a');
    await storage.dropSlot('plenum-ui-b');
    assert.deepEqual([...map.keys()], ['plenum-ui/plenum-ui-a/index.html']);
  });
});

// ----- 2. "N runs going": the phone reads the field the computer sends -----

class FakeNode {}
class FakeText extends FakeNode {
  constructor(text) { super(); this.data = String(text); }
}
class FakeEl extends FakeNode {
  constructor(tag) { super(); this.tagName = String(tag).toUpperCase(); this.attrs = new Map(); this.children = []; this.listeners = new Map(); this.parent = null; this.className = ''; this.textContent = ''; this.hidden = false; }
  get firstChild() { return this.children[0] ?? null; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  append(...nodes) {
    for (const node of nodes) {
      if (!(node instanceof FakeNode)) continue;
      if (node.parent) node.parent.children = node.parent.children.filter(c => c !== node);
      node.parent = this;
      this.children.push(node);
    }
  }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { for (const c of this.children) c.parent = null; this.children = []; this.append(...nodes); }
  removeChild(node) { this.children = this.children.filter(c => c !== node); node.parent = null; return node; }
  remove() { this.parent?.removeChild(this); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  focus() {}
  matches(sel) {
    if (sel.startsWith('.')) return this.className.split(/\s+/).includes(sel.slice(1));
    const attr = /^\[([\w-]+)\]$/.exec(sel);
    if (attr) return this.attrs.has(attr[1]);
    return this.tagName === sel.toUpperCase();
  }
  querySelector(sel) {
    for (const c of this.children) {
      if (!(c instanceof FakeEl)) continue;
      if (c.matches(sel)) return c;
      const hit = c.querySelector(sel);
      if (hit) return hit;
    }
    return null;
  }
}
const elementsOf = node => [node, ...node.children.filter(c => c instanceof FakeEl).flatMap(elementsOf)];
const textOf = node => (node instanceof FakeText ? node.data : [node.textContent, ...(node.children ?? []).map(textOf)].join(' '));

describe('w7-phfu 2: the phone shows the runs the computer counts (HELLO pending.running)', () => {
  let savedNode;
  before(() => {
    savedNode = globalThis.Node;
    globalThis.Node = FakeNode;
  });
  after(() => {
    if (savedNode === undefined) delete globalThis.Node;
    else globalThis.Node = savedNode;
  });

  it('pendingLine reads running, as the computer sends it; runs (the demo, older fixtures) still counts', () => {
    assert.equal(C.pendingLine('Home PC', { approvals: 0, running: 2 }), 'On Home PC now: 2 runs going.');
    assert.equal(C.pendingLine('Home PC', { approvals: 1, running: 1 }), 'On Home PC now: 1 approval waiting, 1 run going.');
    assert.equal(C.pendingLine('Home PC', { approvals: 2, runs: 1 }), 'On Home PC now: 2 approvals waiting, 1 run going.');
    assert.equal(C.pendingLine('Home PC', { approvals: 0, running: 0 }), null);
    assert.equal(C.pendingLine('Home PC', null), null);
    assert.equal(C.runsGoing({ running: 3 }), 3);
    assert.equal(C.runsGoing({ running: 'x' }), 0);
    assert.equal(C.runsGoing({ running: -1 }), 0);
  });

  const io = { act: new Proxy({}, { get: () => () => {} }), local: {}, go() {}, back() {}, later() {}, repaint() {} };
  const env = { location: { protocol: 'https:', hostname: 'localhost', pathname: '/', search: '' }, navigator: { userAgent: 'Android' }, Capacitor: { getPlatform: () => 'android', isNativePlatform: () => true } };
  const snapshot = (pending, ui = {}) => ({
    computers: [{ id: 'c-one', name: 'Home PC' }],
    activeId: 'c-one',
    connection: { status: 'connected', carrier: 'lan', since: 1 },
    hello: { desktopName: 'Home PC', desktopVersion: '0.6.0', tier: 'full', pending },
    pairing: null,
    locked: false,
    lock: { mode: 'off', failures: 0, waitSec: 0 },
    device: { appVersion: '0.6.0', protocol: '1.0' },
    ui: { state: 'idle', cause: null, progress: null, hasCopy: false, kind: 'android', ...ui },
  });

  it('the failed and the connected screens say how many runs are going, from the HELLO the computer sends', () => {
    setDocument({ createElement: tag => new FakeEl(tag), createTextNode: text => new FakeText(text) });
    const failed = snapshot({ approvals: 0, running: 2 }, { state: 'failed', cause: 'not-sent' });
    const node = renderScreen('ui-failed', { ...ctxFor(failed, {}, env), id: 'ui-failed' }, io);
    assert.match(textOf(node), /On Home PC now: 2 runs going\./);
    const connected = snapshot({ approvals: 1, running: 1 });
    const ctx = ctxFor(connected, {}, env);
    ctx.vm = buildVm(connected, {}, env, null);
    assert.match(textOf(renderPart2('connected', { ...ctx, id: 'connected' }, io)), /On Home PC now: 1 approval waiting, 1 run going\./);
  });

  it('the shell page\'s Stop button is marked active while the computer counts a run', async () => {
    const page = () => {
      const body = new FakeEl('body');
      const documentElement = new FakeEl('html');
      const byId = id => elementsOf(body).find(e => e.getAttribute('id') === id) ?? elementsOf(documentElement).find(e => e.getAttribute('id') === id) ?? null;
      return { body, documentElement, visibilityState: 'visible', createElement: tag => new FakeEl(tag), createTextNode: text => new FakeText(text), getElementById: byId };
    };
    const mount = async pending => {
      const doc = page();
      const snap = { ...snapshot(pending), stop: { state: 'idle', text: '', seq: 0 } };
      const core = { snap, state() { return this.snap; }, subscribe() { return () => {}; } };
      mountScreens({
        document: doc,
        location: { protocol: 'http:', hostname: '127.0.0.1', pathname: '/', search: '' },
        navigator: { userAgent: 'Test' },
        Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {} },
        __plenumTakeShellCore: () => Promise.resolve(core),
        setTimeout: () => 0,
        clearTimeout: () => {},
        setInterval: () => 0,
        clearInterval: () => {},
        addEventListener() {},
      });
      await settle();
      return doc.getElementById('plenum-stop');
    };
    const busy = await mount({ approvals: 0, running: 1 });
    assert.ok(busy, 'the Stop button is on the page');
    assert.equal(busy.getAttribute('data-active'), '', 'a run is going: the Stop button is active');
    const idle = await mount({ approvals: 0, running: 0 });
    assert.equal(idle.getAttribute('data-active'), null);
  });

  it('the UI page\'s Stop button describes the runs the computer counts (boot.js)', () => {
    const byId = new Map();
    class El {
      constructor(tag) { this.tagName = String(tag).toUpperCase(); this.attrs = new Map(); this.children = []; this.listeners = new Map(); this.textContent = ''; this.hidden = false; this.id = ''; this.className = ''; }
      setAttribute(k, v) { this.attrs.set(k, String(v)); }
      getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
      removeAttribute(k) { this.attrs.delete(k); }
      append(...nodes) { for (const n of nodes) { this.children.push(n); if (n.id) byId.set(n.id, n); for (const c of n.children ?? []) if (c.id) byId.set(c.id, c); } }
      remove() {}
      addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
    }
    const doc = {
      readyState: 'complete', documentElement: new El('html'), head: new El('head'), body: new El('body'),
      createElement: tag => new El(tag), getElementById: id => byId.get(id) ?? null, visibilityState: 'visible', addEventListener() {},
    };
    doc.documentElement.setAttribute('lang', 'en');
    const win = { location: new URL(`http://127.0.0.1:7590/p/${'a'.repeat(32)}/`), Response, ReadableStream, fetch: async () => { throw new Error('no'); }, setTimeout, clearTimeout, open() { return null; }, navigator: {} };
    const subs = new Set();
    const core = {
      channel: { request: () => Promise.reject(new Error('offline')), cancel() {}, onState() { return () => {}; }, onHello() { return () => {}; } },
      snapshot: { connection: { status: 'connected', carrier: 'lan', desktopName: 'Home PC', lastSeen: null }, locked: false, lock: { mode: 'off' }, computers: [{ id: 'a', name: 'Home PC' }], activeId: 'a', stop: { state: 'idle', text: '', seq: 0 }, notice: null, prefs: { theme: 'follow' }, hello: null },
      state: () => core.snapshot,
      request: () => Promise.reject(Object.assign(new Error('offline'), { code: 'offline' })),
      log() {},
      async openShell() { return true; },
      subscribe(fn) { subs.add(fn); fn(core.snapshot); return () => subs.delete(fn); },
      push(patch) { Object.assign(core.snapshot, patch); for (const fn of [...subs]) fn(core.snapshot); },
      async stop() { return { state: 'done', text: 'Stopped' }; },
      async lock() { return { ok: false, reason: 'no-lock' }; },
      async unlock() { return { ok: true }; },
    };
    installShim({ win, doc, origFetch: async () => new Response('original'), core, app: { version: '1.0.0', build: '7' } });
    const stop = doc.getElementById('plenum-stop');
    assert.ok(stop, 'the Stop button is on the UI page');
    core.push({ hello: { pending: { approvals: 0, running: 2, driving: null }, deviceId: 'd', tier: 'full' } });
    assert.equal(stop.getAttribute('aria-description'), '2 runs are going');
    core.push({ hello: { pending: { approvals: 0, running: 1 }, deviceId: 'd', tier: 'full' } });
    assert.equal(stop.getAttribute('aria-description'), '1 run is going');
    core.push({ hello: { pending: { approvals: 0, running: 0 }, deviceId: 'd', tier: 'full' } });
    assert.equal(stop.getAttribute('aria-description'), null);
  });
});
