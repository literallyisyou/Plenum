import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationReminder, parts } from '../lib/prompt-parts/10-core.mjs';
import { createComputerRun } from '../lib/computer/run.mjs';
import { normalizeRunSettings } from '../lib/computer/policy.mjs';
import { callTool, listTools } from '../lib/routes/mcp.mjs';

test('normal conversation guidance follows the team setting and direct turns retain their identity', async () => {
  assert.match(conversationReminder(false), /Plenum’s lead.*terminal tools.*start_computer_use/);
  assert.doesNotMatch(conversationReminder(false), /use one available read-only delegate/);
  assert.match(conversationReminder(true), /use one available read-only delegate.*configured team pick/);
  assert.match(await parts[0].text({ root: 'project', conversation: true }), /Plenum’s conversation lead/);
  assert.match(await parts[0].text({ root: 'project' }), /the coding agent inside Plenum/);
});

test('subscription bridge can request a screen only for an opted-in Plenum conversation with the native start callback', async () => {
  const name = 'start_computer_use';
  const input = { task: 'Inspect the demo', scope: 'display' };
  let calls = 0;
  const scopeRequest = async actual => {
    calls++;
    assert.deepEqual(actual, { ...input, app: undefined });
    return { ok: true, output: 'Start card completed.' };
  };
  const startComputer = scopeRequest;
  for (const ctx of [{ startComputer }, { conversation: true }, { conversation: true, startComputer, scope: { root: 'elsewhere' } }, { conversation: true, startComputer, computer: {} }]) {
    const entry = { ctx, calls: 0 };
    assert.equal((await listTools(entry)).some(tool => tool.name === name), false);
    assert.equal((await callTool(entry, { name, input })).ok, false);
  }
  assert.equal(calls, 0);
  const entry = { ctx: { conversation: true, startComputer }, calls: 0 };
  assert.equal((await listTools(entry)).some(tool => tool.name === name), true);
  assert.equal((await callTool(entry, { name, input })).ok, true);
  assert.equal(calls, 1);
});

test('a computer run proposed in chat still asks for approval in Approve all', async () => {
  const displays = [{ id: 'test-display', bounds: { x: 0, y: 0, width: 640, height: 480 } }];
  const windows = [{ id: 'demo-window', exe: 'C:/Example/Demo.exe', own: false, elevated: false }];
  const settings = normalizeRunSettings({ scope: 'display', target: 'test-display', allow: ['demo-window'] }, { displays, windows });
  let asked = 0;
  const input = async () => assert.fail('Approval was denied');
  const run = createComputerRun({
    project: { id: 'test-plenum-proposed-run' },
    settings,
    task: 'Inspect the demo',
    bridge: { available: true, probe: async () => ({ supported: true, displays }), input },
    mode: 'all',
    covers: { computer: true },
    consent: 'conversation-card',
    approve: async card => {
      assert.match(card.summary, /Start computer use/);
      asked++;
      return false;
    },
  });
  const result = await run.start();
  assert.equal(asked, 1);
  assert.equal(result.declined, true);
  assert.equal(run.drive, null);
});
