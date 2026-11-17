// Wave 4 package m2: phone notifications that set themselves up and repair themselves, and stay calm while Plenum is open. Node only, on
// fakes: the shell (app.js) over a fake worker and the in-memory fake computer (fixtures/shell-core/fake-desktop.mjs), a fake UnifiedPush
// plugin and fake local notifications, the screens (screens/main.js) on a fake page with a fake core, and the service worker's push handler.
// Nothing here runs on a phone or reaches a push service.
//   1. each reason a turn-on stopped shows its sentence and its button, in the onboarding and in Phone settings; success sends the test
//   2. the Android status row comes from the push app, the computer and Android's own switch, with the last notification's time
//   3. the endpoint is registered again at start and at every HELLO; a computer that lost it gets it again quietly, and Settings says so once
//   4. a notification is taken down after its Deny, Approve or Stop, and at a HELLO with nothing waiting; a 'clear' shows nothing
//   5. in front, a finished run is the toast, not a system notification; an approval is one unless its card is on screen
//   6. #today, #today=<id>, #accounts and #services parse and reach the UI page; anything else is refused
// Run sealed from the mobile folder: bash C:/Users/willi/PlenumWork/mcshots/ultra/seal.sh w4-m2 node --test test/w4-m2-notifications.test.mjs
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFakeClock } from './helpers/fake-clock.mjs';
import { createFakeIndexedDB } from './fixtures/shell-core/fake-idb.mjs';
import { createFakeNet, createFakeDesktop } from './fixtures/shell-core/fake-desktop.mjs';
import { createChannelCore } from '../shell/channel.worker.js';
import { bytesToB64u } from '../shell/channel.js';
import { createIdbKv, createStore } from '../shell/store.js';
import { createShell } from '../shell/app.js';
import { ANDROID_CHANNELS, createAndroidPush, endpointHash, isRouteLink, noticeFor, parseNotificationHash } from '../shell/push.js';
import { showPush } from '../shell/sw.js';
import { deviceId, generateKeyPair } from '../../lib/remote/noise.mjs';
import { buildPushText } from '../../lib/remote/push.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCREENS = path.join(HERE, '..', 'shell', 'screens');
const screen = name => import(pathToFileURL(path.join(SCREENS, name)).href);
const settings = await screen('settings.js');
const copy2 = await screen('copy2.js');
const main = await screen('main.js');
const flows = await screen('flows.js');

const TAG = `plenum-${'a'.repeat(32)}`;
const TAG2 = `plenum-${'b'.repeat(32)}`;
const URL1 = 'https://ntfy.example.net/up/abc123';
const hex16 = url => crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);

async function settle(rounds = 25) {
  for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve));
}

async function waitFor(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const keyPair = () => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { pubKey: ecdh.getPublicKey(null, 'uncompressed').toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
};

// The UnifiedPush plugin as the shell sees it. register() hands the endpoint (with its key set) to the listener a moment later, as the push
// app does. st is the plugin's own state, which a test changes (a push app installed, the permission given).
function fakeUnifiedPush({ distributor = 'io.heckel.ntfy', registrations = ['default'], distributors = ['io.heckel.ntfy'], permission = true, url = URL1, cancel = true } = {}) {
  const handlers = new Map();
  const log = [];
  const keys = keyPair();
  const st = { distributor, registrations: [...registrations], distributors: [...distributors], permission, url };
  const up = {
    st,
    log,
    handlers,
    async getState() {
      return {
        supported: true,
        distributor: st.distributor,
        endpoints: st.registrations.includes('default') ? { default: { url: st.url, temporary: false } } : {},
        failures: {},
        registrations: [...st.registrations],
        visible: true,
      };
    },
    async getDistributors() { return { distributors: [...st.distributors], saved: st.distributor }; },
    async chooseDistributor({ packageName }) { log.push(['choose', packageName]); st.distributor = packageName; return { saved: packageName }; },
    async pickDistributor() { return { ok: true }; },
    async register(options) {
      log.push(['register', options]);
      if (!st.registrations.includes('default')) st.registrations.push('default');
      setTimeout(() => handlers.get('endpoint')?.({ instance: 'default', url: st.url, temporary: false, pubKeySet: keys }), 1);
    },
    async unregister() { st.registrations = []; },
    async requestNotificationPermission() { return { granted: st.permission }; },
    async getNotificationPermission() { return { granted: st.permission }; },
    async addListener(event, fn) { handlers.set(event, fn); return { remove: async () => handlers.delete(event) }; },
  };
  if (cancel) {
    up.cancel = async arg => { log.push(['cancel', arg]); return { cancelled: 1 }; };
    up.cancelAll = async arg => { log.push(['cancelAll', arg]); return { cancelled: 0 }; };
  }
  return up;
}

function fakeLocal() {
  const local = { channels: [], scheduled: [], cancelled: [], listeners: new Map() };
  return {
    local,
    plugin: {
      async createChannel(c) { local.channels.push(c); },
      async registerActionTypes() {},
      async schedule(arg) { local.scheduled.push(...arg.notifications); },
      async requestPermissions() { return { display: 'granted' }; },
      async addListener(event, fn) { local.listeners.set(event, fn); return { remove: async () => {} }; },
      async cancel(arg) { local.cancelled.push(...arg.notifications); },
    },
  };
}

const message = payload => ({ instance: 'default', content: Buffer.from(JSON.stringify(payload)).toString('base64'), decrypted: true });
const computer = { id: 'c1', name: 'Home PC' };
const approvalPayload = (id = 'ap-1') => buildPushText({ kind: 'approval', projectName: 'my-app', projectId: 'p1', approvalId: id, count: 1 }, { prefs: {}, device: { tier: 'full' }, computer }).payload;
const finishedPayload = () => buildPushText({ kind: 'finished', projectName: 'my-app', projectId: 'p1' }, { prefs: {}, device: {}, computer }).payload;

// ----- the shell over a fake worker (the w4-m1 rig), as an Android phone -----

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

async function androidShell({ desktopOptions = {}, up = fakeUnifiedPush(), privacy = null, showing = new Set(), meta = {}, start = true } = {}) {
  const net = createFakeNet();
  const clock = createFakeClock(0);
  const wall = createFakeClock(1_000_000);
  const desktop = createFakeDesktop({ net, ...desktopOptions });
  const phone = generateKeyPair();
  desktop.counters.set(deviceId(phone.publicKey), 0);
  const store = createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) });
  const id = deviceId(desktop.keys.publicKey);
  await store.put({
    id,
    name: 'Test PC',
    desktopPub: bytesToB64u(desktop.keys.publicKey),
    myPriv: bytesToB64u(phone.privateKey),
    carriers: [{ kind: 'lan', urls: [desktop.url] }],
    lastCarrier: null,
    counter: 0,
  });
  for (const [key, value] of Object.entries(typeof meta === 'function' ? meta(id) : meta)) await store.meta.put(key, value);
  const local = fakeLocal();
  const doc = {
    visibilityState: 'visible',
    querySelector: sel => {
      const m = /^\[data-approval-id="([^"]+)"\]$/.exec(sel);
      return m && showing.has(m[1]) ? { getClientRects: () => [{}] } : null;
    },
  };
  const native = { UnifiedPush: up, LocalNotifications: local.plugin, ...(privacy ? { PlenumPrivacy: privacy } : {}) };
  const shell = createShell({
    store,
    createWorker: fakeWorkerFactory({ net, clock, store }),
    device: { name: 'Test phone', platform: 'android', app: 'android', appVersion: '1', uiHash: '' },
    caps: ['ui-from-desktop'],
    stopClock: wall,
    native,
    pushEnv: { document: doc },
  });
  if (start) {
    await shell.start();
    await waitFor(() => shell.state().hello);
  }
  return { shell, desktop, store, up, local: local.local, id, doc, showing, wall };
}

const registers = up => up.log.filter(l => l[0] === 'register').length;
const subscriptionsSent = desktop => desktop.stats.pushes.filter(p => p.subscription && p.subscription.kind === 'unifiedpush');

// ----- 6. routes -----

describe('notification routes: #today, #accounts, #services, &nt and &computer', () => {
  it('the new places parse and are UI routes; &nt and &computer may follow any link, in either order', () => {
    assert.deepEqual(parseNotificationHash('#today'), { kind: 'today' });
    assert.deepEqual(parseNotificationHash('#today=biz-1'), { kind: 'today', id: 'biz-1' });
    assert.deepEqual(parseNotificationHash('#accounts'), { kind: 'accounts' });
    assert.deepEqual(parseNotificationHash('#services'), { kind: 'services' });
    for (const link of ['#today', '#today=biz-1', '#accounts', '#services']) assert.equal(isRouteLink(parseNotificationHash(link)), true, link);
    const pc = 'c'.repeat(64);
    assert.deepEqual(parseNotificationHash(`#deny=ap-1&nt=${TAG}`), { kind: 'deny', id: 'ap-1', nt: TAG });
    assert.deepEqual(parseNotificationHash(`#deny=ap-1&nt=${TAG}&computer=${pc}`), { kind: 'deny', id: 'ap-1', nt: TAG, computer: pc });
    assert.deepEqual(parseNotificationHash(`#stop&computer=${pc}&nt=${TAG}`), { kind: 'stop', nt: TAG, computer: pc });
    assert.deepEqual(parseNotificationHash(`#approve=ap-1&line=Run%3A%20x&nt=${TAG}&computer=${pc}`), { kind: 'approve', id: 'ap-1', line: 'Run: x', nt: TAG, computer: pc });
    assert.deepEqual(parseNotificationHash(`#today=b1&computer=${pc}`), { kind: 'today', id: 'b1', computer: pc });
    // The links before wave 4 read as they did.
    assert.deepEqual(parseNotificationHash('#approve=ap-1&line=Run%3A%20x'), { kind: 'approve', id: 'ap-1', line: 'Run: x' });
    assert.deepEqual(parseNotificationHash('#settings=limit'), { kind: 'settings', section: 'limit' });
  });

  it('unknown places and malformed suffixes are refused', () => {
    for (const bad of [
      '#todayx', '#accounts=1', '#services=x', '#today=a b', '#today=../x', `#today=${'a'.repeat(81)}`, '#account', '#service',
      `#deny=ap-1&nt=bad`, `#deny=ap-1&nt=${TAG}&nt=${TAG2}`, '#home&line=x', '#today&line=x', '#stop&what=1', '#stop&computer=a b',
      `#nothing&nt=${TAG}`, '#', '',
    ]) assert.equal(parseNotificationHash(bad), null, bad);
  });

  it('the shell hands #today=<id>, #accounts and #services to the UI page as its route', async () => {
    const k = await androidShell();
    // Wave 6: #night-shift (a Night shift job's notice) is handed over the same way.
    for (const [link, want] of [['#today=biz-1', { kind: 'today', id: 'biz-1' }], ['#today', { kind: 'today' }], ['#accounts', { kind: 'accounts' }], ['#services', { kind: 'services' }], ['#night-shift', { kind: 'night-shift' }]]) {
      const out = await k.shell.handleHash(link);
      assert.equal(out.ok, true, link);
      const { seq, taken, ...intent } = k.shell.state().intent;
      assert.deepEqual(intent, want, link);
      assert.equal(taken, false);
      assert.ok(seq > 0);
    }
    assert.equal((await k.shell.handleHash('#services=x')).reason, 'no link');
    assert.equal((await k.shell.handleHash('#night-shift=x')).reason, 'no link');
  });
});

// ----- 1. turning notifications on: a sentence and a button for each reason -----

describe('turning notifications on says what happened and what to do (onboarding and Phone settings)', () => {
  it('each reason has its sentence and, where one helps, its button', () => {
    const at = { platform: 'android', computer: 'Home PC' };
    assert.deepEqual(copy2.notifyFixFor('no-distributor', at), {
      text: 'Plenum sends notifications through a small free app called ntfy. Install it, then come back and tap Turn on again.',
      button: { label: 'Get ntfy', action: 'get-ntfy' },
      help: copy2.NOTIFY_FDROID,
    });
    assert.ok(copy2.NOTIFY_FDROID.includes('f-droid.org/packages/io.heckel.ntfy'));
    assert.deepEqual(copy2.notifyFixFor('denied', at), { text: "Notifications are blocked for Plenum in Android's settings.", button: { label: 'Open notification settings', action: 'open-settings' }, help: null });
    assert.equal(copy2.notifyFixFor('timeout', at).text, 'ntfy did not answer. Open ntfy once, then try again.');
    assert.equal(copy2.notifyFixFor('timeout', at).button, null);
    for (const reason of ['vapid', 'failed', 'endpoint', 'offline']) {
      assert.equal(copy2.notifyFixFor(reason, at).text, 'Plenum could not turn notifications on. Check that the phone is connected to Home PC, then try again.', reason);
    }
    assert.equal(copy2.notifyFixFor('other-computer', at), null, 'the lock step words it (copy.js lockFailText)');
    assert.equal(copy2.notifyFixFor('denied', { platform: 'web' }).button, null, 'the web has no settings page to open');
    assert.equal(flows.NTFY_LINKS.play, 'https://play.google.com/store/apps/details?id=io.heckel.ntfy');
  });

  it('the push.js reasons come out as they are: no push app, a denied permission, a push app that does not answer', async () => {
    const none = createAndroidPush({ native: { UnifiedPush: fakeUnifiedPush({ distributor: null, registrations: [], distributors: [] }), LocalNotifications: fakeLocal().plugin }, requestOf: () => null });
    assert.deepEqual(await none.enable(), { ok: false, reason: 'no-distributor' });
    const denied = createAndroidPush({ native: { UnifiedPush: fakeUnifiedPush({ permission: false }), LocalNotifications: fakeLocal().plugin }, requestOf: () => null });
    assert.deepEqual(await denied.enable(), { ok: false, reason: 'denied' });
    const silentUp = fakeUnifiedPush();
    silentUp.register = async () => {};
    let fire = null;
    const quiet = createAndroidPush({ native: { UnifiedPush: silentUp, LocalNotifications: fakeLocal().plugin }, requestOf: () => null, setTimer: fn => { fire = fn; return 1; }, clearTimer: () => {} });
    const waiting = quiet.enable();
    await waitFor(() => fire);
    fire();
    assert.deepEqual(await waiting, { ok: false, reason: 'timeout' });
  });

  it('a turn-on that worked sends the test notification and says it is on its way; a missing push app is checked again on the way back to the front', async () => {
    const up = fakeUnifiedPush({ distributor: null, registrations: [], distributors: [] });
    const k = await androidShell({ up, desktopOptions: { testPushStatus: 200 } });
    assert.deepEqual(await k.shell.enableNotifications(), { ok: false, reason: 'no-distributor' });
    assert.equal(k.shell.state().notifySetup.reason, 'no-distributor');
    assert.equal(k.shell.state().androidPush.lastReason, 'no-distributor');
    // Back in front without a push app: nothing happens.
    await k.shell.visibility(false);
    await k.shell.visibility(true);
    await settle();
    assert.equal(registers(up), 0);
    // The person installed ntfy and comes back: Plenum turns notifications on by itself.
    up.st.distributors = ['io.heckel.ntfy'];
    await k.shell.visibility(false);
    await k.shell.visibility(true);
    await waitFor(() => k.shell.state().notifySetup?.auto === true);
    const setup = k.shell.state().notifySetup;
    assert.deepEqual([setup.ok, setup.reason, setup.testSent], [true, null, true]);
    assert.equal(k.desktop.stats.testPushes, 1, 'the test notification was asked for');
    assert.equal(k.shell.state().notice.text, 'A test notification is on its way.');
    assert.equal(subscriptionsSent(k.desktop).at(-1).subscription.endpoint, URL1);
    // A turn-on from the screen does the same and still answers { ok, reason } only.
    assert.deepEqual(await k.shell.enableNotifications(), { ok: true, reason: null });
    assert.equal(k.desktop.stats.testPushes, 2);
  });

  it('Open notification settings goes through PlenumPrivacy when the app has it; an older app answers unavailable', async () => {
    const opened = [];
    const k = await androidShell({ privacy: { openNotificationSettings: async () => { opened.push(1); return { opened: true }; } } });
    assert.deepEqual(await k.shell.openNotificationSettings(), { ok: true, reason: null });
    assert.equal(opened.length, 1);
    const old = await androidShell();
    assert.deepEqual(await old.shell.openNotificationSettings(), { ok: false, reason: 'unavailable' });
    const throwing = await androidShell({ privacy: { openNotificationSettings: async () => { throw Object.assign(new Error('x'), { code: 'UNIMPLEMENTED' }); } } });
    assert.deepEqual(await throwing.shell.openNotificationSettings(), { ok: false, reason: 'unavailable' });
  });
});

// ----- the screens on a fake page (the shell-screens.test.mjs fake DOM) -----

describe('the screens: reasons, buttons, the Android row and the one-time line (fake page, fake core)', () => {
  class FakeNode {}
  class FakeText extends FakeNode {
    constructor(data) { super(); this.data = String(data); }
  }
  class FakeEl extends FakeNode {
    constructor(tag) {
      super();
      this.tagName = String(tag).toUpperCase();
      this.attrs = new Map();
      this.children = [];
      this.listeners = new Map();
      this.parent = null;
      this.className = '';
      this.textContent = '';
    }
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
    replaceChildren(...nodes) {
      for (const c of this.children) c.parent = null;
      this.children = [];
      this.append(...nodes);
    }
    removeChild(node) { this.children = this.children.filter(c => c !== node); node.parent = null; return node; }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
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
  const textOf = node => (node instanceof FakeText ? node.data : [node.textContent, ...node.children.map(textOf)].join(''));
  const byId = (node, id) => elementsOf(node).find(e => e.getAttribute('id') === id) ?? null;

  let savedNode;
  before(() => { savedNode = globalThis.Node; globalThis.Node = FakeNode; });
  after(() => { if (savedNode === undefined) delete globalThis.Node; else globalThis.Node = savedNode; });

  function fakePage() {
    const body = new FakeEl('body');
    const documentElement = new FakeEl('html');
    return {
      body,
      documentElement,
      visibilityState: 'visible',
      createElement: tag => new FakeEl(tag),
      createTextNode: text => new FakeText(text),
      getElementById: id => byId(body, id) ?? byId(documentElement, id),
    };
  }

  function fakePageEnv(core, { doc = fakePage(), opened = [] } = {}) {
    return {
      document: doc,
      location: { protocol: 'http:', hostname: '127.0.0.1', pathname: '/', search: '' },
      navigator: { userAgent: 'Test' },
      Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { Browser: { open: async arg => { opened.push(arg.url); } } } },
      __plenumTakeShellCore: () => Promise.resolve(core),
      setTimeout: () => 0,
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
      addEventListener() {},
    };
  }

  function fakeShell(snap, methods = {}) {
    return { snap, state() { return this.snap; }, subscribe() { return () => {}; }, ...methods };
  }
  const CONNECTED = Object.freeze({
    computers: [{ id: 'a', name: 'Home PC' }],
    activeId: 'a',
    connection: { status: 'connected' },
    hello: { desktopName: 'Home PC', tier: 'full' },
    pairing: null,
    locked: false,
    androidPush: { supported: true, distributor: null, registered: false, permission: true },
  });

  const viewOf = doc => doc.getElementById('sh-view');
  const buttonsOf = doc => elementsOf(viewOf(doc)).filter(e => e.tagName === 'BUTTON');
  const click = async node => {
    for (const fn of node.listeners.get('click') ?? []) await fn({});
    await settle();
  };
  const buttonNamed = (doc, label) => buttonsOf(doc).find(b => textOf(b) === label) ?? null;
  const rowNamed = (doc, label) => buttonsOf(doc).find(b => textOf(b).startsWith(label)) ?? null;

  const REASONS = [
    ['no-distributor', 'Plenum sends notifications through a small free app called ntfy. Install it, then come back and tap Turn on again.', 'Get ntfy'],
    ['denied', "Notifications are blocked for Plenum in Android's settings.", 'Open notification settings'],
    ['timeout', 'ntfy did not answer. Open ntfy once, then try again.', null],
    ['vapid', 'Plenum could not turn notifications on. Check that the phone is connected to Home PC, then try again.', null],
    ['failed', 'Plenum could not turn notifications on. Check that the phone is connected to Home PC, then try again.', null],
  ];

  for (const [reason, sentence, label] of REASONS) {
    it(`"${reason}" shows its sentence${label ? ` and ${label}` : ''} in Phone settings and in the onboarding`, async () => {
      for (const where of ['settings', 'onboarding']) {
        const doc = fakePage();
        const calls = [];
        const core = fakeShell({ ...CONNECTED }, {
          enableNotifications: async () => { calls.push('enable'); return { ok: false, reason }; },
          releaseUi: () => {},
        });
        const mounted = main.mountScreens(fakePageEnv(core, { doc }));
        await settle();
        if (where === 'settings') {
          mounted.io.go('settings-notify');
          assert.equal(doc.body.getAttribute('data-screen'), 'settings-notify');
          await click(rowNamed(doc, 'On this phone'));
        } else {
          mounted.nav.onboarding = ['paired-notify'];
          mounted.paint();
          assert.equal(doc.body.getAttribute('data-screen'), 'paired-notify');
          await click(buttonNamed(doc, 'Turn on'));
          assert.equal(doc.body.getAttribute('data-screen'), 'paired-notify', 'the step stays until it worked');
        }
        assert.deepEqual(calls, ['enable'], where);
        const fix = elementsOf(viewOf(doc)).find(e => e.className === 'sh-fix');
        assert.ok(fix, `${where}: the reason block is there`);
        assert.equal(fix.getAttribute('data-reason'), reason);
        assert.ok(textOf(fix).includes(sentence), `${where}: ${sentence}`);
        assert.equal(textOf(viewOf(doc)).includes('Plenum did not turn this on. Try again.'), false, 'not the old catch-all');
        assert.equal(textOf(viewOf(doc)).includes('UnifiedPush'), false);
        if (label) assert.ok(elementsOf(fix).some(e => e.tagName === 'BUTTON' && textOf(e) === label), `${where}: ${label}`);
        else assert.equal(elementsOf(fix).some(e => e.tagName === 'BUTTON'), false);
        if (reason === 'no-distributor') assert.ok(textOf(fix).includes('F-Droid'), 'the F-Droid line');
      }
    });
  }

  it('Get ntfy opens its store page in the browser and asks the core to look again; Open notification settings says where it is when the app cannot open it', async () => {
    const doc = fakePage();
    const opened = [];
    const asked = [];
    const core = fakeShell({ ...CONNECTED }, {
      enableNotifications: async () => ({ ok: false, reason: 'no-distributor' }),
      awaitPushApp: () => { asked.push('await'); return { ok: true, reason: null }; },
      openNotificationSettings: async () => ({ ok: false, reason: 'unavailable' }),
    });
    const mounted = main.mountScreens(fakePageEnv(core, { doc, opened }));
    await settle();
    mounted.io.go('settings-notify');
    await click(rowNamed(doc, 'On this phone'));
    await click(buttonNamed(doc, 'Get ntfy'));
    assert.deepEqual(opened, ['https://play.google.com/store/apps/details?id=io.heckel.ntfy']);
    assert.deepEqual(asked, ['await']);
    core.enableNotifications = async () => ({ ok: false, reason: 'denied' });
    await click(rowNamed(doc, 'On this phone'));
    assert.ok(textOf(viewOf(doc)).includes(copy2.NOTIFY_COMES_BACK));
    await click(buttonNamed(doc, 'Open notification settings'));
    assert.ok(textOf(viewOf(doc)).includes('Open Settings on the phone, then Apps, then Plenum, then Notifications, and turn them on.'));
  });

  it('a turn-on that worked says the test notification is on its way, and the onboarding moves on', async () => {
    const doc = fakePage();
    const core = fakeShell({ ...CONNECTED }, {
      enableNotifications: async () => { core.snap = { ...core.snap, notifySetup: { seq: 1, ok: true, reason: null, auto: false, testSent: true } }; return { ok: true, reason: null }; },
      releaseUi: () => {},
    });
    const mounted = main.mountScreens(fakePageEnv(core, { doc }));
    await settle();
    mounted.io.go('settings-notify');
    await click(rowNamed(doc, 'On this phone'));
    assert.ok(textOf(viewOf(doc)).includes('A test notification is on its way.'));
    assert.equal(elementsOf(viewOf(doc)).some(e => e.className === 'sh-fix'), false);
  });

  it('a turn-on the core ran by itself (back from Get ntfy) moves the onboarding on', async () => {
    const doc = fakePage();
    let released = 0;
    const core = fakeShell({ ...CONNECTED, notifySetup: { seq: 1, ok: false, reason: 'no-distributor', auto: false, testSent: false } }, { releaseUi: () => { released += 1; } });
    const mounted = main.mountScreens(fakePageEnv(core, { doc }));
    await settle();
    mounted.nav.onboarding = ['paired-notify'];
    mounted.paint();
    assert.equal(doc.body.getAttribute('data-screen'), 'paired-notify');
    core.snap = { ...core.snap, notifySetup: { seq: 2, ok: true, reason: null, auto: true, testSent: true } };
    mounted.paint();
    assert.notEqual(doc.body.getAttribute('data-screen'), 'paired-notify');
    assert.equal(released, 1, 'the UI may load now');
  });

  it('the Android row is what the phone knows, with the last notification time; the web keeps the permission words', async () => {
    const T = settings.ANDROID_NOTIFY_LABEL;
    assert.equal(settings.androidNotifyLabel({ supported: true, distributor: 'io.heckel.ntfy', registered: true, permission: true }), T.on);
    assert.equal(T.on, 'On, through ntfy');
    assert.equal(settings.androidNotifyLabel({ supported: true, distributor: 'org.example.push', registered: true, permission: true }), 'On, through your push app');
    assert.equal(settings.androidNotifyLabel({ supported: true, distributor: null, registered: false, permission: true }), 'Needs the ntfy app');
    assert.equal(settings.androidNotifyLabel({ supported: true, distributor: null, registered: true, permission: true }), 'Needs the ntfy app', 'ntfy was removed');
    // A push app installed but none chosen yet (Turn on has not worked yet): one tap turns them on, so the row says Off, not Needs the app.
    assert.equal(settings.androidNotifyLabel({ supported: true, distributor: null, registered: false, permission: true, installed: true }), 'Off');
    assert.equal(settings.androidNotifyLabel({ supported: true, distributor: null, registered: false, permission: true, installed: false }), 'Needs the ntfy app');
    assert.equal(settings.unifiedPushLine(null, { installed: true }).includes('Install'), false);
    assert.equal(/UnifiedPush/i.test(settings.unifiedPushLine(null, { installed: true })), false);
    assert.ok(settings.unifiedPushLine(null).includes('Install'));
    assert.equal(settings.androidNotifyLabel({ supported: true, distributor: 'io.heckel.ntfy', registered: true, permission: false }), 'Blocked in Android settings');
    assert.equal(settings.androidNotifyLabel({ supported: true, distributor: 'io.heckel.ntfy', registered: false, permission: false, lastReason: 'denied' }), 'Blocked in Android settings');
    assert.equal(settings.androidNotifyLabel({ supported: true, distributor: 'io.heckel.ntfy', registered: false, permission: null }), 'Off');
    assert.equal(settings.androidNotifyLabel(null), 'Off');
    assert.equal(settings.androidNotifyLabel({ supported: false }), 'Off');
    const at = new Date(2026, 10, 16, 14, 2).getTime();
    assert.equal(main.lastNotificationLine(at, new Date(2026, 10, 16, 18, 0).getTime()), 'Last notification 14:02');
    assert.equal(main.lastNotificationLine(at, new Date(2026, 10, 17, 9, 0).getTime()), 'Last notification 16 Nov, 14:02');
    assert.equal(main.lastNotificationLine(null), null);
    // The view model: Android reads the push status, not the web Notification API (absent in the Android WebView: it would say Not asked).
    const env = fakePageEnv(null);
    const vm = main.buildVm({ ...CONNECTED, androidPush: { supported: true, distributor: 'io.heckel.ntfy', registered: true, permission: true, lastAt: Date.now() } }, {}, env, { notificationPermission: () => 'default' });
    assert.equal(vm.notify.label, 'On, through ntfy');
    assert.match(vm.notify.last, /^Last notification \d\d:\d\d$/);
    const web = main.buildVm({ ...CONNECTED }, {}, { ...env, Capacitor: null }, { notificationPermission: () => 'default' });
    assert.equal(web.notify.label, 'Not asked');
    // On the screen: the row value and the line under it.
    const doc = fakePage();
    const core = fakeShell({ ...CONNECTED, androidPush: { supported: true, distributor: 'io.heckel.ntfy', registered: true, permission: true, lastAt: Date.now() } });
    const mounted = main.mountScreens(fakePageEnv(core, { doc }));
    await settle();
    mounted.io.go('settings-notify');
    assert.ok(textOf(rowNamed(doc, 'On this phone')).includes('On, through ntfy'));
    assert.match(textOf(viewOf(doc)), /Last notification \d\d:\d\d/);
    assert.equal(textOf(viewOf(doc)).includes('UnifiedPush'), false);
  });

  it('status() says whether a push app is installed, chosen or not', async () => {
    const none = createAndroidPush({ native: { UnifiedPush: fakeUnifiedPush({ distributor: null, registrations: [], distributors: [] }), LocalNotifications: fakeLocal().plugin }, requestOf: () => null });
    assert.equal((await none.status()).installed, false);
    const unchosen = createAndroidPush({ native: { UnifiedPush: fakeUnifiedPush({ distributor: null, registrations: [], distributors: ['io.heckel.ntfy'] }), LocalNotifications: fakeLocal().plugin }, requestOf: () => null });
    const st = await unchosen.status();
    assert.equal(st.installed, true);
    assert.equal(settings.androidNotifyLabel(st), 'Off', 'ntfy is there: one tap turns them on');
    const chosen = createAndroidPush({ native: { UnifiedPush: fakeUnifiedPush(), LocalNotifications: fakeLocal().plugin }, requestOf: () => null });
    assert.equal((await chosen.status()).installed, true);
  });

  it('"turned them back on" shows in Phone settings once: taken from the core there, kept while on the settings screens, gone after', async () => {
    const doc = fakePage();
    let acks = 0;
    const core = fakeShell({ ...CONNECTED, pushRepaired: true }, {
      ackPushRepaired() { acks += 1; this.snap = { ...this.snap, pushRepaired: false }; return { ok: true, reason: null }; },
    });
    const mounted = main.mountScreens(fakePageEnv(core, { doc }));
    await settle();
    assert.equal(acks, 0, 'not taken while Phone settings is not open');
    mounted.io.go('settings');
    await settle();
    const line = 'Notifications had stopped reaching this phone. Plenum turned them back on.';
    assert.ok(textOf(viewOf(doc)).includes(line));
    assert.equal(acks, 1);
    mounted.paint();
    mounted.io.go('settings-notify');
    assert.ok(textOf(viewOf(doc)).includes(line), 'still there on the Notifications screen');
    mounted.io.back();
    mounted.io.back();
    mounted.paint();
    mounted.io.go('settings');
    assert.equal(textOf(viewOf(doc)).includes(line), false, 'once');
    assert.equal(acks, 1);
  });
});

// ----- 3. self-repair -----

describe('notifications repair themselves: renewed at start and at every HELLO, sent again when the computer lost them', () => {
  it('a kept registration is registered again at start and at the HELLO, and the endpoint reaches the computer', async () => {
    const k = await androidShell();
    await waitFor(() => registers(k.up) >= 2 && subscriptionsSent(k.desktop).length >= 1);
    assert.deepEqual(k.up.log.find(l => l[0] === 'register')[1], { instance: 'default', messageForDistributor: 'Plenum' });
    assert.equal(subscriptionsSent(k.desktop).at(-1).subscription.endpoint, URL1);
    await waitFor(() => k.shell.state().androidPush?.registered === true);
    assert.equal(k.shell.state().pushRepaired, false, 'a renewal says nothing');
    // No registration kept (notifications never turned on, or turned off): nothing is registered.
    const off = await androidShell({ up: fakeUnifiedPush({ registrations: [] }) });
    await settle(50);
    assert.equal(registers(off.up), 0);
    assert.equal(subscriptionsSent(off.desktop).length, 0);
  });

  it('subscribed: false from the computer while this phone has them on: sent again quietly, and Phone settings says so once', async () => {
    const k = await androidShell({
      desktopOptions: { pushAnswer: { subscribed: false } },
      meta: id => ({ 'up-posted': { v: 1, computers: { [id]: { hash: hex16(URL1), at: 1 } } } }),
    });
    await waitFor(() => k.shell.state().pushRepaired === true);
    assert.ok(subscriptionsSent(k.desktop).length >= 1);
    assert.ok(registers(k.up) >= 2, 'the push app was asked again (start, and the repair)');
    assert.notEqual(k.shell.state().notice?.text, copy2.NOTIFY_REPAIRED, 'no toast: the line waits for Phone settings');
    assert.equal(await k.store.meta.get('push-repaired'), true, 'kept until Phone settings shows it');
    k.shell.ackPushRepaired();
    assert.equal(k.shell.state().pushRepaired, false);
    await settle();
    assert.equal(await k.store.meta.get('push-repaired'), undefined);
  });

  it('a computer that holds another endpoint is sent this one; a computer that holds this one is left alone', async () => {
    const other = await androidShell({
      desktopOptions: { pushAnswer: { subscribed: true, endpoint: '0123456789abcdef' } },
      meta: id => ({ 'up-posted': { v: 1, computers: { [id]: { hash: hex16(URL1), at: 1 } } } }),
    });
    await waitFor(() => other.shell.state().pushRepaired === true);
    const same = await androidShell({
      desktopOptions: { pushAnswer: { subscribed: true, endpoint: hex16(URL1) } },
      meta: id => ({ 'up-posted': { v: 1, computers: { [id]: { hash: hex16(URL1), at: 1 } } } }),
    });
    await waitFor(() => registers(same.up) >= 2);
    await settle(50);
    assert.equal(same.shell.state().pushRepaired, false);
    // A computer this phone never turned notifications on for is not subscribed behind the person's back.
    const never = await androidShell({
      desktopOptions: { pushAnswer: { subscribed: false } },
      meta: { 'up-posted': { v: 1, computers: { ['f'.repeat(64)]: { hash: hex16(URL1), at: 1 } } } },
    });
    await settle(80);
    await waitFor(() => registers(never.up) >= 1);
    await settle(80);
    assert.equal(never.shell.state().pushRepaired, false);
    assert.equal(subscriptionsSent(never.desktop).length, 0, 'the renewal at start sent this computer nothing');
    assert.equal(never.shell.state().androidPush.registered, false, 'the row does not say On for it');
  });

  it('a renewal kept from an earlier run goes only to a computer that holds this phone\'s endpoint; a turn-on kept goes to the open one', async () => {
    const posted = [];
    const request = async (req, body) => { posted.push(JSON.parse(body)); return { status: 200, body: { cancel: async () => {} } }; };
    const kept = { body: null };
    const pendingStore = { load: async () => kept.body, save: async b => { kept.body = structuredClone(b); }, clear: async () => { kept.body = null; } };
    const record = { v: 1, computers: { 'pc-1': { hash: hex16(URL1), at: 1 } } };
    const postedStore = { load: async () => structuredClone(record), save: async () => {} };
    let at = '';
    let req = null;
    const up = fakeUnifiedPush();
    const push = createAndroidPush({ native: { UnifiedPush: up, LocalNotifications: fakeLocal().plugin }, requestOf: () => req, pendingStore, postedStore, computerOf: () => at });
    await push.start();
    // At start there is no channel: the renewal's endpoint is kept, marked as one that came by itself.
    assert.equal(await push.renew(), true);
    await waitFor(() => kept.body);
    assert.equal(kept.body.from, 'renew');
    // The channel reaches pc-2, which never had notifications from this phone: nothing goes.
    at = 'pc-2';
    req = request;
    assert.equal((await push.resend()).ok, false);
    assert.equal(posted.length, 0);
    // The channel reaches pc-1, which holds this phone's endpoint: it goes, without the mark.
    at = 'pc-1';
    assert.equal((await push.resend()).ok, true);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].from, undefined);
    assert.equal(posted[0].subscription.endpoint, URL1);
    // A turn-on that could not reach its computer is kept unmarked and goes to the open computer, as before wave 4.
    kept.body = { subscription: { kind: 'unifiedpush', endpoint: URL1, keys: { p256dh: 'x', auth: 'y' } } };
    const later = createAndroidPush({ native: { UnifiedPush: fakeUnifiedPush(), LocalNotifications: fakeLocal().plugin }, requestOf: () => request, pendingStore, postedStore, computerOf: () => 'pc-3' });
    await later.start();
    assert.equal((await later.resend()).ok, true);
    assert.equal(posted.length, 2);
  });

  it('a computer that drops the same address again within a day is sent it again, but is not reported as fixed again', async () => {
    const k = await androidShell({
      desktopOptions: { pushAnswer: { subscribed: false } },
      meta: id => ({
        'up-posted': { v: 1, computers: { [id]: { hash: hex16(URL1), at: 1 } } },
        'push-repairs': { [id]: { hash: hex16(URL1), at: 1_000_000 - 60_000 } },
      }),
    });
    await waitFor(() => registers(k.up) >= 2 && subscriptionsSent(k.desktop).length >= 1);
    await settle(80);
    assert.equal(k.shell.state().pushRepaired, false, 'the same address went again: not claimed as fixed');
    assert.equal(await k.store.meta.get('push-repaired'), undefined);
    // A day later the same drop is a new event (a computer reinstalled, say): the line shows.
    const later = await androidShell({
      desktopOptions: { pushAnswer: { subscribed: false } },
      meta: id => ({
        'up-posted': { v: 1, computers: { [id]: { hash: hex16(URL1), at: 1 } } },
        'push-repairs': { [id]: { hash: hex16(URL1), at: 1_000_000 - 25 * 60 * 60 * 1000 } },
      }),
    });
    await waitFor(() => later.shell.state().pushRepaired === true);
  });

  it('web: a computer that lost this browser\'s subscription gets a fresh one (the old address may be gone), and another computer\'s is left alone', async () => {
    const vapid = Buffer.from(new Uint8Array(65).fill(4)).toString('base64url');
    let n = 0;
    let unsubscribed = 0;
    const make = endpoint => ({ endpoint, options: { applicationServerKey: new Uint8Array(65).fill(4).buffer }, toJSON() { return { endpoint, keys: { p256dh: 'p', auth: 'a' } }; }, unsubscribe: async () => { unsubscribed += 1; held = null; return true; } });
    let held = make('https://push.example/send/old');
    const registration = { pushManager: { getSubscription: async () => held, subscribe: async () => { n += 1; held = make(`https://push.example/send/new-${n}`); return held; } } };
    const pushEnv = { isSecureContext: true, navigator: { serviceWorker: {} }, PushManager: function () {}, Notification: function () {} };
    const webShell = async (endpoint, answer) => {
      const net = createFakeNet();
      const clock = createFakeClock(0);
      const desktop = createFakeDesktop({ net, vapidPublicKey: vapid, pushAnswer: answer });
      const phone = generateKeyPair();
      desktop.counters.set(deviceId(phone.publicKey), 0);
      const store = createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) });
      const id = deviceId(desktop.keys.publicKey);
      await store.put({ id, name: 'Test PC', desktopPub: bytesToB64u(desktop.keys.publicKey), myPriv: bytesToB64u(phone.privateKey), carriers: [{ kind: 'lan', urls: [desktop.url] }], lastCarrier: null, counter: 0, ...(endpoint ? { pushEndpoint: endpoint } : {}) });
      const shell = createShell({
        store,
        createWorker: fakeWorkerFactory({ net, clock, store }),
        device: { name: 'Test phone', platform: 'web', app: 'web', appVersion: '1', uiHash: '' },
        caps: ['ui-from-desktop'],
        stopClock: createFakeClock(1_000_000),
        notifications: { permission: 'granted', requestPermission: async () => 'granted' },
        pushEnv,
        serviceWorker: { getRegistration: async () => registration },
      });
      await shell.start();
      await waitFor(() => shell.state().hello);
      return { shell, desktop, store, id };
    };
    const k = await webShell('https://push.example/send/old', { subscribed: false });
    await waitFor(() => k.shell.state().pushRepaired === true);
    assert.equal(unsubscribed, 1, 'the old subscription went');
    const sent = k.desktop.stats.pushes.filter(p => p.subscription);
    assert.equal(sent.at(-1).subscription.endpoint, 'https://push.example/send/new-1', 'a new address, not the one the computer dropped');
    assert.equal((await k.store.get(k.id)).pushEndpoint, 'https://push.example/send/new-1');
    assert.equal((await k.store.get(k.id)).pushLost, undefined);
    // The browser's subscription is another computer's (not the one this record kept): nothing is touched.
    held = make('https://push.example/send/someone-else');
    const other = await webShell('https://push.example/send/mine', { subscribed: false });
    await settle(80);
    assert.equal(other.shell.state().pushRepaired, false);
    assert.equal(unsubscribed, 1);
    assert.equal(other.desktop.stats.pushes.filter(p => p.subscription).length, 0);
  });

  it('which computers hold the endpoint survives a restart, so the status row still says on', async () => {
    const kept = {};
    const postedStore = { load: async () => kept.record, save: async r => { kept.record = structuredClone(r); } };
    const up = fakeUnifiedPush({ distributor: null, registrations: [] });
    const posted = [];
    const request = async (req, body) => { posted.push(JSON.parse(body)); return { status: 200, body: { cancel: async () => {} } }; };
    const first = createAndroidPush({ native: { UnifiedPush: up, LocalNotifications: fakeLocal().plugin }, requestOf: () => request, postedStore, computerOf: () => 'pc-1' });
    assert.deepEqual(await first.enable(), { ok: true, reason: null });
    assert.deepEqual(Object.keys(kept.record.computers), ['pc-1']);
    assert.equal(kept.record.computers['pc-1'].hash, hex16(URL1));
    assert.equal(JSON.stringify(kept.record).includes(posted[0].subscription.keys.auth), false, 'no key in the record');
    const again = createAndroidPush({ native: { UnifiedPush: up, LocalNotifications: fakeLocal().plugin }, requestOf: () => null, postedStore, computerOf: () => 'pc-1' });
    await again.start();
    assert.equal((await again.state()).registered, true);
    assert.equal(await again.believedOn(), true);
    const elsewhere = createAndroidPush({ native: { UnifiedPush: up, LocalNotifications: fakeLocal().plugin }, requestOf: () => null, postedStore, computerOf: () => 'pc-2' });
    await elsewhere.start();
    assert.equal((await elsewhere.state()).registered, false, 'another computer does not hold it');
    assert.equal(await endpointHash(URL1), hex16(URL1), 'the same 16 hex the computer says');
    // Turning notifications off forgets them everywhere.
    await again.disable();
    assert.deepEqual(kept.record.computers, {});
  });
});

// ----- 4. clearing -----

describe('notifications are taken down once they are answered, and a clear shows nothing', () => {
  it('a HELLO with nothing waiting takes down only that computer\'s approval notifications: not a handover, a needs list or another computer\'s', async () => {
    const mineA = `plenum-${'1'.repeat(32)}`;
    const mineB = `plenum-${'2'.repeat(32)}`;
    const handover = `plenum-${'3'.repeat(32)}`;
    const needs = `plenum-${'4'.repeat(32)}`;
    const theirs = `plenum-${'5'.repeat(32)}`;
    const k = await androidShell({
      meta: id => ({
        'up-seen': { v: 1, tags: {
          [mineA]: { kind: 'approval', computer: id, approval: 'ap-1' },
          [mineB]: { kind: 'approval', computer: id, approval: 'ap-2' },
          [handover]: { kind: 'handover', computer: id, approval: '' },
          [needs]: { kind: 'needs', computer: id, approval: '' },
          [theirs]: { kind: 'approval', computer: 'f'.repeat(64), approval: 'ap-9' },
        } },
      }),
    });
    await waitFor(() => k.up.log.filter(l => l[0] === 'cancel').length >= 2);
    await settle(40);
    assert.deepEqual(k.up.log.filter(l => l[0] === 'cancel').map(l => l[1].tag).sort(), [mineA, mineB].sort());
    assert.equal(k.up.log.some(l => l[0] === 'cancelAll'), false, 'never every notification of the channel');
    // What is left is noted still (the other computer's card, the handover, the needs list); what went is forgotten.
    assert.deepEqual(Object.keys((await k.store.meta.get('up-seen')).tags).sort(), [handover, needs, theirs].sort());
  });

  it('every approval, handover and needs message is noted (shown here or not), and a clear forgets it', async () => {
    const k = await androidShell();
    const fire = (payload, extra = {}) => k.up.handlers.get('message')({ ...message(payload), ...extra });
    const approval = { ...approvalPayload('ap-7'), tag: TAG, ids: { computer: k.id, project: 'p1', approval: 'ap-7' } };
    await fire(approval, { shown: true });
    const seen = (await k.store.meta.get('up-seen')).tags;
    assert.deepEqual(seen[TAG], { kind: 'approval', computer: k.id, approval: 'ap-7' });
    await fire(finishedPayload());
    assert.equal(Object.keys((await k.store.meta.get('up-seen')).tags).length, 1, 'a finished run is not noted');
    // A Deny from a notification without a tag of its own: the 'plenum' one goes, and the noted one of that card on that computer.
    k.up.log.length = 0;
    await k.shell.handleHash('#deny=ap-7');
    assert.deepEqual(k.up.log.filter(l => l[0] === 'cancel').map(l => l[1].tag).sort(), ['plenum', TAG].sort());
    assert.deepEqual((await k.store.meta.get('up-seen')).tags, {});
  });

  it('after a Deny, an Approve and a Stop from a notification, whatever the outcome', async () => {
    const k = await androidShell();
    await settle(40);
    k.up.log.length = 0;
    await k.shell.handleHash(`#deny=ap-1&nt=${TAG}`);
    assert.deepEqual(k.up.log.filter(l => l[0] === 'cancel' || l[0] === 'cancelAll'), [['cancel', { tag: TAG }]]);
    k.up.log.length = 0;
    await k.shell.handleHash(`#approve=ap-2&line=${encodeURIComponent('Run: x')}&nt=${TAG2}`);
    assert.deepEqual(k.up.log.filter(l => l[0] === 'cancel' || l[0] === 'cancelAll'), [['cancel', { tag: TAG2 }]]);
    k.up.log.length = 0;
    const stopped = await k.shell.handleHash('#stop');
    assert.equal(stopped.state, 'done');
    assert.deepEqual(k.up.log.filter(l => l[0] === 'cancel' || l[0] === 'cancelAll'), [['cancel', { tag: 'plenum' }]], 'no tag: the notification without one, not every approval notification');
    // An approve without its line opens the card (nothing is approved), and the notification still goes.
    k.up.log.length = 0;
    await k.shell.handleHash(`#approve=ap-3&nt=${TAG}`);
    assert.deepEqual(k.up.log.filter(l => l[0] === 'cancel'), [['cancel', { tag: TAG }]]);
    // A place (a tap) takes nothing down.
    k.up.log.length = 0;
    await k.shell.handleHash('#waiting=ap-1');
    assert.deepEqual(k.up.log.filter(l => l[0] === 'cancel' || l[0] === 'cancelAll'), []);
  });

  it('a HELLO with approvals waiting leaves their notifications; an app without cancel does nothing and does not fail', async () => {
    const k = await androidShell({
      desktopOptions: { pendingApprovals: 2 },
      meta: id => ({ 'up-seen': { v: 1, tags: { [TAG]: { kind: 'approval', computer: id, approval: 'ap-1' } } } }),
    });
    await settle(80);
    assert.equal(k.up.log.some(l => l[0] === 'cancelAll' || l[0] === 'cancel'), false);
    const old = await androidShell({ up: fakeUnifiedPush({ cancel: false }) });
    const out = await old.shell.handleHash(`#deny=ap-1&nt=${TAG}`);
    assert.equal(out.kind, 'deny');
  });

  it('a clear message shows nothing and takes down the notification with its tag (also one this code showed)', async () => {
    const up = fakeUnifiedPush();
    const l = fakeLocal();
    const notices = [];
    const push = createAndroidPush({ native: { UnifiedPush: up, LocalNotifications: l.plugin }, requestOf: () => null, onNotice: n => notices.push(n) });
    await push.start();
    const approval = { ...approvalPayload(), tag: TAG };
    await up.handlers.get('message')(message(approval));
    assert.equal(l.local.scheduled.length, 1);
    await up.handlers.get('message')(message({ v: 1, kind: 'clear', tag: TAG, ids: { computer: 'c1', project: '', approval: '' } }));
    assert.equal(l.local.scheduled.length, 1, 'nothing more shown');
    assert.deepEqual(notices, [], 'and no toast');
    assert.deepEqual(up.log.filter(e => e[0] === 'cancel'), [['cancel', { tag: TAG }]]);
    assert.deepEqual(l.local.cancelled.map(n => n.id), [l.local.scheduled[0].id], 'the local one goes too');
    // A clear with no valid tag takes nothing down.
    await up.handlers.get('message')(message({ v: 1, kind: 'clear', tag: 'plenum', ids: {} }));
    await up.handlers.get('message')(message({ v: 1, kind: 'clear', ids: {} }));
    assert.equal(up.log.filter(e => e[0] === 'cancel').length, 1);
  });

  it('an action of a notification shown here carries its tag (&nt=) to the link', async () => {
    const up = fakeUnifiedPush();
    const l = fakeLocal();
    const links = [];
    const push = createAndroidPush({ native: { UnifiedPush: up, LocalNotifications: l.plugin }, requestOf: () => null, onLink: (link, computer) => links.push([link, computer]) });
    await push.start();
    const extra = { tap: '/#waiting=ap1', routes: { deny: '/#deny=ap1', stop: '/#stop' }, line: '', computer: '', tag: TAG };
    for (const actionId of ['tap', 'deny', 'stop']) l.local.listeners.get('localNotificationActionPerformed')({ actionId, notification: { extra } });
    assert.deepEqual(links.map(x => x[0]), ['#waiting=ap1', `#deny=ap1&nt=${TAG}`, `#stop&nt=${TAG}`]);
    assert.deepEqual(parseNotificationHash(links[1][0]), { kind: 'deny', id: 'ap1', nt: TAG });
  });

  it('the service worker: a clear closes the notifications of its tag and shows nothing; silent shows without sound', async () => {
    const shown = [];
    const closed = [];
    const asked = [];
    const registration = {
      showNotification: async (title, options) => { shown.push([title, options]); },
      getNotifications: async filter => { asked.push(filter); return [{ close: () => closed.push(filter.tag) }]; },
    };
    await showPush({ data: { json: () => ({ v: 1, kind: 'clear', tag: TAG, ids: {} }) } }, { registration, maxActions: 2 });
    assert.deepEqual(shown, []);
    assert.deepEqual(asked, [{ tag: TAG }]);
    assert.deepEqual(closed, [TAG]);
    await showPush({ data: { json: () => ({ v: 1, kind: 'clear', tag: 'not a tag' }) } }, { registration, maxActions: 2 });
    assert.equal(asked.length, 1, 'a bad tag closes nothing');
    assert.deepEqual(shown, []);
    await showPush({ data: { json: () => ({ ...finishedPayload(), silent: true }) } }, { registration, maxActions: 2 });
    assert.equal(shown[0][1].silent, true);
    await showPush({ data: { json: () => finishedPayload() } }, { registration, maxActions: 2 });
    assert.equal(shown[1][1].silent, undefined, 'a plain push is unchanged');
  });
});

// ----- 5. calm while Plenum is in front -----

describe('calm while Plenum is in front: the toast instead of a system notification', () => {
  it('a finished run, a failure and a limit are the toast; an approval is a system notification unless its card is on screen', async () => {
    const k = await androidShell();
    const fire = payload => k.up.handlers.get('message')(message(payload));
    await fire(finishedPayload());
    assert.equal(k.local.scheduled.length, 0, 'no system notification for a finished run');
    const finished = finishedPayload();
    assert.equal(k.shell.state().notice.text, `${finished.title}: ${finished.body}`);
    assert.equal(k.shell.state().notice.tone, 'ok');
    const failed = buildPushText({ kind: 'failed', projectName: 'my-app', projectId: 'p1' }, { prefs: {}, device: {}, computer }).payload;
    await fire(failed);
    assert.equal(k.shell.state().notice.tone, 'warn');
    await fire(buildPushText({ kind: 'limit', limitKind: 'spend' }, { prefs: {}, device: {}, computer }).payload);
    assert.equal(k.local.scheduled.length, 0);
    assert.ok(k.shell.state().androidPush.lastAt > 0, 'the last notification time is kept');
    assert.ok(await k.store.meta.get('push-last-at') > 0);
    // An approval: a system notification on the approvals channel.
    await fire(approvalPayload('ap-1'));
    assert.equal(k.local.scheduled.length, 1);
    assert.equal(k.local.scheduled[0].channelId, 'plenum-approvals');
    // Its card on screen: nothing more.
    k.showing.add('ap-2');
    await fire(approvalPayload('ap-2'));
    assert.equal(k.local.scheduled.length, 1, 'the card is on screen');
    // A silent approval is the toast.
    await fire({ ...approvalPayload('ap-3'), silent: true });
    assert.equal(k.local.scheduled.length, 1);
    assert.equal(k.shell.state().notice.text.includes('An approval is waiting.'), true);
    // Behind (or already shown by the plugin's own service): nothing here.
    k.doc.visibilityState = 'hidden';
    await fire(approvalPayload('ap-4'));
    k.doc.visibilityState = 'visible';
    await k.up.handlers.get('message')({ ...message(approvalPayload('ap-5')), shown: true });
    assert.equal(k.local.scheduled.length, 1);
  });

  it('a test is a system notification even while Plenum is in front (the proof that Android shows them), unless it is silent', async () => {
    const k = await androidShell();
    const fire = payload => k.up.handlers.get('message')(message(payload));
    const test = buildPushText({ kind: 'test' }, { prefs: {}, device: {}, computer }).payload;
    const before = k.shell.state().notice?.text ?? null;
    await fire(test);
    assert.equal(k.local.scheduled.length, 1, 'shown in the shade, with its sound');
    assert.equal(k.local.scheduled[0].channelId, 'plenum-finished');
    assert.equal(k.local.scheduled[0].title, test.title);
    assert.equal(k.shell.state().notice?.text ?? null, before, 'not a toast as well');
    await fire({ ...test, silent: true });
    assert.equal(k.local.scheduled.length, 1, 'a silent one is the toast');
  });

  it('the channels are the plugin\'s four, Problems included, with the same names', () => {
    assert.deepEqual(ANDROID_CHANNELS.map(c => [c.id, c.name, c.importance]), [
      ['plenum-approvals', 'Approvals and your turn', 4],
      ['plenum-finished', 'Finished runs', 3],
      ['plenum-problems', 'Problems', 3],
      ['plenum-limits', 'Limits', 3],
    ]);
    assert.deepEqual(noticeFor({ kind: 'finished', title: 'Plenum', body: 'The run finished.' }), { text: 'The run finished.', tone: 'ok', kind: 'finished' });
  });
});
