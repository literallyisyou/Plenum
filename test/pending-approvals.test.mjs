import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pendingApprovalBatch } from '../lib/approval-batch.mjs';
import { inheritApprovalDefaults, approvalSummary, chatModeOf } from '../lib/projects.mjs';
import { runTool } from '../lib/tools.mjs';

const httpError = (status, message) => Object.assign(new Error(message), { status });
const request = approvalIds => ({ project: 'project-a', scope: 'chat-a', approvalIds, allow: true });
const pending = ({ projectId = 'project-a', scope = 'chat-a', batchEligible = true, signal = new AbortController().signal } = {}) =>
  ({ signal, meta: { projectId, scope }, card: { batchEligible } });

test('batch approves the requested snapshot in chat order, leaving later requests alone', () => {
  const first = pending();
  const second = pending();
  const waiting = new Map([['a', first], ['b', second], ['new', pending()]]);
  assert.deepEqual(pendingApprovalBatch(request(['b', 'a']), waiting, httpError), [second, first]);
  assert.equal(waiting.size, 3);
});

test('the entire batch is refused if a request is stale, stopped, special, or belongs to another chat', () => {
  const stopped = new AbortController();
  stopped.abort();
  const waiting = new Map([
    ['valid', pending()],
    ['stopped', pending({ signal: stopped.signal })],
    ['special', pending({ batchEligible: false })],
    ['other-project', pending({ projectId: 'project-b' })],
    ['other-chat', pending({ scope: 'chat-b' })],
  ]);
  for (const id of ['missing', 'stopped', 'special', 'other-project', 'other-chat']) {
    assert.throws(() => pendingApprovalBatch(request(['valid', id]), waiting, httpError), { status: 409 });
  }
  for (const ids of [[], ['valid', 'valid'], [1], 'valid']) {
    assert.throws(() => pendingApprovalBatch(request(ids), waiting, httpError), { status: 400 });
  }
  assert.throws(() => pendingApprovalBatch({ ...request(['valid']), allow: false }, waiting, httpError), { status: 400 });
  assert.throws(() => pendingApprovalBatch({ ...request(['valid']), approvalId: 'valid' }, waiting, httpError), { status: 400 });
});

test('the all-project preset inherits approval defaults and preserves plan, budget, and deny rules', () => {
  const project = {
    settings: {
      approvals: 'ask', approveAllBlocked: true, approveAllCovers: { computer: false }, codersCannotAsk: 'refuse',
      chatMode: 'plan', budget: { warnUsd: 1, capUsd: 4 }, denyPatterns: ['synthetic fixture'],
    },
  };
  const inherited = inheritApprovalDefaults(project, { clearCoverage: true });
  assert.deepEqual(inherited.settings, { chatMode: 'plan', budget: { warnUsd: 1, capUsd: 4 }, denyPatterns: ['synthetic fixture'] });
  assert.equal(project.settings.approvals, 'ask');
  assert.equal(chatModeOf(inherited), 'plan');
  const app = { approvals: 'all', approveAllCovers: { computer: true, browser: true } };
  assert.deepEqual(approvalSummary(app, inherited), {
    approvals: 'all', ownApprovals: null, approveAllBlocked: false, approveAllCovers: app.approveAllCovers, codersCannotAsk: 'run',
  });
  assert.deepEqual(inheritApprovalDefaults(project).settings.approveAllCovers, { computer: false });
  assert.equal(inheritApprovalDefaults(inherited), inherited);
});

test('ordinary project writes and terminal requests can be grouped while outside or blocked cards cannot', async t => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'plenum-approval-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, 'project');
  await fs.mkdir(root);
  const check = async (name, input, eligible, denyPatterns = []) => {
    let seen = false;
    const result = await runTool(name, input, {
      root, mode: 'ask', denyPatterns,
      approve: async card => {
        seen = true;
        assert.equal(card.batchEligible, eligible);
        return false;
      },
    });
    assert.equal(seen, true, result.output);
    assert.equal(result.denied, true, result.output);
  };
  await check('write_file', { path: 'example.txt', content: 'Synthetic' }, true);
  await check('write_file', { path: '../example.txt', content: 'Synthetic' }, false);
  await check('run_command', { command: 'echo example' }, true);
  await check('run_command', { command: 'echo special' }, false, ['echo special']);
});
