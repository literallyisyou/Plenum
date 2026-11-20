import assert from 'node:assert/strict';
import test from 'node:test';
import { createUnattendedDesktop } from '../lib/computer/unattended.mjs';
import { createBridge } from '../lib/computer/bridge.mjs';
import backendModule from '../desktop/computer/index.cjs';
import winModule from '../desktop/computer/win.cjs';
import { BROWSER_TOOLS, setBridge } from '../lib/browser-tools.mjs';

function fixture() {
  let now = 0;
  let end = 20_000;
  let idleSec = 601;
  let state = 'idle';
  let keys = false;
  const sent = [];
  const ac = new AbortController();
  const desktop = createUnattendedDesktop({
    bridge: {
      userInput: async () => ({ mouse: false, keys }),
      input: async action => { sent.push(action); idleSec = 0; return { ok: true }; },
      capture: async () => { sent.push('capture'); return { ok: true }; },
      overlay: async action => { sent.push(action); return { ok: true }; },
    },
    windowEnd: () => end,
    presence: async () => ({ ok: true, state, idleSec }),
    now: () => now,
    signal: ac.signal,
  });
  return {
    desktop, sent, ac,
    update(next) {
      if (next.now !== undefined) now = next.now;
      if (Object.hasOwn(next, 'end')) end = next.end;
      if (Object.hasOwn(next, 'idleSec')) idleSec = next.idleSec;
      if (next.state !== undefined) state = next.state;
      if (next.keys !== undefined) keys = next.keys;
    },
  };
}

test('scheduled Windows desktop waits for a readable, unlocked idle PC in Night shift hours', async () => {
  const { desktop, update, sent } = fixture();
  for (const conditions of [{ end: null }, { end: 20_000, idleSec: null }, { idleSec: 601, state: 'unknown' }, { state: 'locked' }, { state: 'active', idleSec: 599 }]) {
    update(conditions);
    assert.match(await desktop.begin(), /waits for Night shift hours/);
    assert.match(await desktop.browserCheck(), /waits for Night shift hours/);
    assert.equal((await desktop.bridge.capture()).ok, false);
  }
  assert.deepEqual(sent, []);
});

test('an unreadable physical-input probe survives IPC and holds both start and continuing input', async () => {
  const coldBackend = backendModule.createComputerBackend({ platform: 'win32', fake: false, electron: null });
  const missing = await createBridge({ backend: coldBackend }).userInput();
  assert.deepEqual(missing, { available: false, mouse: false, keys: false });

  let reply = { ok: false };
  const bridge = createBridge({ request: async method => {
    assert.equal(method, 'computer-user-input');
    return reply;
  } });
  const sent = [];
  const stopped = [];
  const desktop = createUnattendedDesktop({
    bridge: { ...bridge, input: async action => { sent.push(action); return { ok: true }; } },
    windowEnd: () => 20000, now: () => 0,
    presence: async () => ({ ok: true, state: 'idle', idleSec: 603 }),
  });
  desktop.onBlocked(reason => stopped.push(reason));
  for (const unreadable of [missing, { ok: false }, { keys: false }, {}]) {
    reply = unreadable;
    assert.match(await desktop.begin(), /waits for Night shift/);
  }
  reply = { mouse: false, keys: false };
  assert.equal(await desktop.begin(), null);
  assert.equal((await desktop.bridge.input('permitted')).ok, true);
  reply = missing;
  assert.equal((await desktop.bridge.input('unreadable')).ok, false);
  assert.deepEqual(sent, ['permitted']);
  assert.equal(stopped.length, 1);
});

test('a failed Windows cursor read is distinguishable from an actual pointer at the origin', async () => {
  let cursorOk = 0;
  const native = winModule.createWinNative({ koffi: {
    struct: name => name, union: name => name, proto: name => name,
    sizeof: name => ({ INPUT: 40, MOUSEINPUT: 32, KEYBDINPUT: 24 })[name],
    load: () => ({ func: signature => signature.includes('GetCursorPos(') ? () => cursorOk : () => 0 }),
  } });
  await assert.rejects(native.userInput(), /could not read the cursor/);
  cursorOk = 1;
  assert.deepEqual(await native.cursor(), { x: 0, y: 0 });
  assert.deepEqual(await native.userInput(), { mouse: false, keys: false });
});

test('native synthetic input does not stop its next action; physical input and the window boundary do', async () => {
  const { desktop, update, sent } = fixture();
  assert.equal(await desktop.begin(), null);
  assert.equal((await desktop.bridge.input('first')).ok, true);
  update({ now: 1500, idleSec: 1, state: 'idle' });
  assert.equal((await desktop.bridge.capture()).ok, true);
  update({ keys: true });
  assert.match((await desktop.bridge.input('second')).message, /yielded to activity/);
  update({ keys: false, now: 20_000 });
  assert.equal((await desktop.bridge.capture()).ok, false);
  assert.equal((await desktop.bridge.overlay({ show: false })).ok, true);
  assert.deepEqual(sent, ['first', 'capture', { show: false }]);
});

test('a later Windows input-clock reset or cancellation blocks the next desktop operation', async () => {
  const { desktop, update, sent, ac } = fixture();
  assert.equal(await desktop.begin(), null);
  assert.equal((await desktop.bridge.input('first')).ok, true);
  update({ now: 6000, idleSec: 6 });
  assert.equal((await desktop.bridge.capture()).ok, true);
  update({ now: 8000, idleSec: 1 });
  assert.match((await desktop.bridge.capture()).message, /yielded to activity/);
  ac.abort();
  assert.match(await desktop.browserCheck(), /waits for Night shift hours/);
  assert.deepEqual(sent, ['first', 'capture']);
});

test('a shared pane action rechecks idle at the desktop request', async () => {
  let requests = 0;
  let checks = 0;
  setBridge({ available: () => true, ask: async () => { requests += 1; return { ok: true }; } });
  try {
    const result = await BROWSER_TOOLS.browser_tabs.run({ action: 'new' }, {
      browser: true,
      browserPresence: async () => ++checks === 1 ? null : 'The owner is using the PC.',
    });
    assert.equal(result.ok, false);
    assert.match(result.output, /owner is using/);
    assert.equal(requests, 0);
    const manual = await BROWSER_TOOLS.browser_tabs.run({ action: 'new' }, { browser: true });
    assert.equal(manual.ok, true);
    assert.equal(requests, 1);
  } finally {
    setBridge();
  }
});
