import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { CHROME_ORIGIN, routes } from '../lib/routes/chrome-share.mjs';

function call(name, body = {}, headers = {}) {
  const url = new URL('/api/chrome-share/' + name, 'http://127.0.0.1:4317');
  const method = name === 'status' ? 'GET' : 'POST';
  const route = routes.find(row => row.path === url.pathname && row.method === method);
  return route.handler({
    req: { headers, socket: { remoteAddress: '127.0.0.1' } }, url, readBody: async () => body,
    json: (_response, _status, value) => value, events: { publish() {} },
    httpError: (status, message) => Object.assign(new Error(message), { status }),
  });
}

async function pairedShare() {
  await call('revoke');
  const { code } = await call('code');
  const header = { origin: CHROME_ORIGIN };
  const { capability } = await call('pair', { code }, header);
  header['x-plenum-chrome'] = capability;
  await call('share', { url: 'https://example.org/demo', title: 'Sample' }, header);
  return (await call('status')).share;
}

test('a renderer reload preserves a waiting share and an abandoned reservation expires', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { id } = await pairedShare();
  const first = await call('review', { id });
  assert.equal((await call('status')).share.id, id);
  await assert.rejects(call('review', { id }), { status: 409 });
  await assert.rejects(call('take', { id }), { status: 409 });
  t.mock.timers.setTime(first.expiresAt);
  const second = await call('review', { id });
  assert.notEqual(second.review, first.review);
  await call('release', { id, review: first.review });
  await assert.rejects(call('take', { id, review: first.review }), { status: 409 });
  await call('release', { id, review: second.review });
  const last = await call('review', { id });
  assert.equal((await call('take', { id, review: last.review })).share.id, id);
  assert.equal((await call('status')).share, null);
});

test('review cannot retain a share beyond its expiry or disconnect', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let share = await pairedShare();
  t.mock.timers.setTime(share.expiresAt - 1);
  let claim = await call('review', { id: share.id });
  assert.equal(claim.expiresAt, share.expiresAt);
  t.mock.timers.setTime(share.expiresAt);
  await assert.rejects(call('take', { id: share.id, review: claim.review }), { status: 409 });
  share = await pairedShare();
  claim = await call('review', { id: share.id });
  await call('revoke');
  await assert.rejects(call('take', { id: share.id, review: claim.review }), { status: 409 });
  assert.equal((await call('status')).share, null);
});

test('canceling an old pairing prompt leaves the current prompt usable', async () => {
  const first = await call('code');
  const second = await call('code');
  await call('cancel', { code: first.code });
  const paired = await call('pair', { code: second.code }, { origin: CHROME_ORIGIN });
  assert.equal(paired.capability.length, 64);
  await call('revoke');
});

// Drive the production drawer handlers with a minimal in-memory document. No desktop or network is needed.
async function drawerFixture(intercept) {
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.value = ''; this.isConnected = true; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    addEventListener(type, fn) { this[type] = fn; }
    closest() { return null; }
    focus() {}
    dispatchEvent() {}
  }
  const body = new Element();
  const input = new Element();
  const slots = {};
  const events = {};
  const ui = {
    threads: { scope: () => ui.active }, active: 'A',
    ui: { chip: options => ({ click: options.onClick }) },
    slots: { add: (slot, _name, node) => { slots[slot] = node; } },
    events: { on: (name, fn) => { events[name] = fn; } },
    openDrawer: (_name, render) => { body.replaceChildren(); return render(body); },
    closeDrawer() {}, toast() {},
    api: (url, payload) => intercept(url.split('/').pop(), payload),
  };
  const source = await readFile(new URL('../public/ext-chrome-share.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    window: { MuseUI: ui, plenumShell: { desktop: true } },
    document: { createElement: () => new Element(), getElementById: () => input },
    Event, setTimeout: () => 1, clearTimeout() {},
  });
  function find(node, label) {
    if (node.textContent === label) return node;
    for (const child of node.children) {
      const found = find(child, label);
      if (found) return found;
    }
  }
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await tick();
  slots.titlebar.click();
  await tick();
  return { ui, input, slots, events, tick, button: label => find(body, label) };
}

test('switching chat during Add keeps the server share available after renderer reload', async () => {
  const { id } = await pairedShare();
  let deliver;
  const drawer = await drawerFixture(async (name, data) => {
    const result = await call(name, data);
    if (name === 'review') await new Promise(resolve => { deliver = resolve; });
    return result;
  });
  const clicked = drawer.button('Add to chat draft').click();
  await drawer.tick();
  drawer.ui.active = 'B';
  deliver();
  await clicked;
  assert.equal(drawer.input.value, '');
  assert.equal((await call('status')).share.id, id);
  const reloaded = await drawerFixture(call);
  reloaded.input.value = 'Existing text';
  await reloaded.button('Add to chat draft').click();
  assert.match(reloaded.input.value, /^Existing text[\s\S]*https:\/\/example.org\/demo/);
  assert.equal((await call('status')).share, null);
});

test('a delayed status response cannot restore a revoked preview', async () => {
  const share = await pairedShare();
  let holdNext = false;
  let deliver;
  const drawer = await drawerFixture(async (name, data) => {
    const result = await call(name, data);
    if (name === 'status' && holdNext) {
      holdNext = false;
      await new Promise(resolve => { deliver = resolve; });
    }
    return result;
  });
  assert.equal(drawer.button(share.title).textContent, 'Sample');
  holdNext = true;
  const delayed = drawer.events['chrome-share']();
  await drawer.tick();
  await call('revoke');
  await drawer.events['chrome-share']();
  deliver();
  await delayed;
  assert.equal(drawer.button('Add to chat draft'), undefined);
  assert.equal(drawer.slots.bannerSlot.hidden, true);
});
