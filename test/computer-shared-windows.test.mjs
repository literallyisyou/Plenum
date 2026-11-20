import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRunSettings } from '../lib/computer/policy.mjs';
import { createComputerRun } from '../lib/computer/run.mjs';
import { computerToolsFor, canonicalFor } from '../lib/computer/generic.mjs';
import geometry from '../desktop/computer/geometry.cjs';

const app = (id, pid, title = id) => ({
  id, pid, title, exe: 'C:/Example/Editor.exe', own: false, elevated: false,
  bounds: { x: 0, y: 0, width: 640, height: 480 }, displayId: 'screen',
});
const first = app('1', 301, 'First workbook');
const second = app('2', 301, 'Second workbook');
const other = app('3', 301, 'Unshared workbook');
const normalize = (input = {}, windows = [first, second, other]) =>
  normalizeRunSettings({ target: '1', additionalWindows: ['2'], ...input }, { windows });

test('shared windows are distinct Windows identities and cannot add other apps', () => {
  const settings = normalize({ unknownApps: 'allow' });
  assert.deepEqual(settings.sharedWindows.map(w => [w.id, w.pid]), [['1', 301], ['2', 301]]);
  assert.equal(settings.unknownApps, 'refuse');
  assert.throws(() => normalize({ additionalWindows: ['1'] }), /once/);
  assert.throws(() => normalize({ additionalWindows: ['3', '2', '2'] }), /once/);
  assert.throws(() => normalize({}, [first]), /no longer available/);
  assert.throws(() => normalize({}, [first, { ...second, elevated: true }]), /cannot be shared/);
  assert.throws(() => normalize({}, [first, { ...second, own: true }]), /Plenum/);
  assert.throws(() => normalize({ scope: 'display' }), /window run/);
  assert.equal(normalize({ additionalWindows: [] }).sharedWindows, undefined);
});

test('shared-window capture masks a sibling of the exact same app', () => {
  const bounds = { x: 4, y: 8, width: 20, height: 30 };
  const overlay = { ...other, bounds };
  assert.deepEqual(geometry.maskRects(first.bounds, [overlay, first], { ...first, strict: true }), [bounds]);
  assert.deepEqual(geometry.maskRects(first.bounds, [overlay, first], first), []);
  assert.deepEqual(geometry.maskRects(first.bounds, [overlay, { ...first, pid: 999 }], { ...first, strict: true }), [first.bounds]);
});

test('shared tool schemas carry a frame and a slot rather than exposing window handles', () => {
  const tools = computerToolsFor({ settings: normalize() });
  assert.deepEqual(tools.find(t => t.name === 'computer_switch_window').input_schema.required, ['slot']);
  assert.ok(tools.find(t => t.name === 'computer_click').input_schema.required.includes('frame'));
  assert.equal(computerToolsFor({ settings: {} }).some(t => t.name === 'computer_switch_window'), false);
  assert.deepEqual(canonicalFor('computer_switch_window', { slot: 2 }).canonical, { kind: 'switch_window', slot: 2 });
  assert.equal(canonicalFor('computer_click', { coordinate: [25, 30], frame: 5 }).canonical.frameId, 5);
});

test('a switch invalidates old frames, refuses a sibling, and handles a closed or reused window', async () => {
  let windows = [first, second, other];
  let front = first;
  let focused = [];
  const input = [];
  const bridge = {
    available: true,
    probe: async () => ({ supported: true, windowGroups: true }),
    windows: async () => windows,
    foreground: async () => front,
    focus: async (id, expected) => {
      focused.push(id);
      assert.equal(expected?.id, id);
      front = windows.find(w => w.id === id);
      return { ok: Boolean(front) };
    },
    capture: async ({ target, expectedWindow }) => {
      assert.equal(target, expectedWindow.id);
      return { ok: true, png: Buffer.from('fixture'), width: 640, height: 480, physical: first.bounds };
    },
    input: async action => { input.push(action); return { ok: true }; },
    overlay: async () => ({ ok: true }),
    cursor: async () => ({ x: 0, y: 0 }),
    userInput: async () => ({ mouse: false, keys: false }),
    release: async () => {},
  };
  const log = { id: 'test-shared-window', frame: async () => null, action() {}, event() {}, finish: async () => {} };
  const run = createComputerRun({ project: { id: 'test-shared-window' }, settings: normalize(), bridge,
    approve: async () => true, consent: 'drawer', logs: { prune: async () => {}, openRunLog: async () => log } });
  assert.equal((await run.start()).ok, true);
  try {
    const shot1 = await run.step({ kind: 'screenshot' });
    assert.equal(shot1.frame.n, 1);
    const switched = await run.step({ kind: 'switch_window', slot: 2 });
    assert.equal(switched.ok, true);
    assert.equal(run.frame, null);

    const click = frameId => run.step({ kind: 'click', x: 5, y: 5, frameId });
    assert.equal((await click(shot1.frame.n)).ok, false);
    const shot2 = await run.step({ kind: 'screenshot' });
    assert.equal(shot2.frame.n, 2);
    assert.equal((await click(shot1.frame.n)).ok, false);
    assert.equal((await click(shot2.frame.n)).ok, true);
    assert.equal(input[0].expectedWindow.id, '2');

    front = other;
    assert.equal((await click(shot2.frame.n)).ok, false);
    assert.equal(input.length, 1);
    assert.equal((await run.step({ kind: 'switch_window', slot: 3 })).ok, false);
    windows = [{ ...first, pid: 999 }, second, other];
    assert.equal((await run.step({ kind: 'switch_window', slot: 1 })).ok, false);
    assert.deepEqual(focused, ['1', '2']);

    let release;
    let arrived;
    const beforeFocus = new Promise(resolve => { arrived = resolve; });
    bridge.windows = () => {
      arrived();
      return new Promise(resolve => { release = () => resolve(windows); });
    };
    const pending = run.step({ kind: 'switch_window', slot: 2 });
    await beforeFocus;
    run.drive.stop('stop');
    release();
    assert.equal((await pending).ok, false);
    assert.deepEqual(focused, ['1', '2']);
  } finally {
    await run.finish('stop');
  }
});
