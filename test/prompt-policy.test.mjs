import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTONOMY_RECOVERY, PROMPT_POLICY_VERSION } from '../lib/prompt-policy.mjs';
import { buildSystem } from '../lib/prompt.mjs';
import { get, flush } from '../lib/store.mjs';
import { openSession, getSession } from '../lib/sessions.mjs';
import { moderatorMessage } from '../lib/council.mjs';

test('shared operating policy is wired once across acting roles and leaves compact summaries separate', async () => {
  const ctx = { root: '.', rules: null, globalRules: null, extra: { folder: 'text' } };
  for (const role of ['chat', 'planner', 'coder', 'reviewer', 'council', 'moderator', 'relay', 'compare', 'pipeline']) {
    const system = await buildSystem(role, ctx);
    assert.equal(system.split(AUTONOMY_RECOVERY).length - 1, 1, role);
  }
  assert.ok(!(await buildSystem('compact', ctx)).includes(AUTONOMY_RECOVERY));
});

test('an older native session gets the revised policy once without losing approvals or chat state', async t => {
  const st = get();
  const before = { sessionMode: st.sessionMode, sessions: st.sessions };
  const chats = st.chats;
  const approvals = st.approvals;
  const ref = 'codex:gpt-6.2-astra';
  const project = 'prompt-policy-regression';
  st.sessionMode = 'native';
  st.sessions = { [project]: { [ref]: { provider: 'codex', sessionId: 'old-session', lastUsedAt: 1 } } };
  let active;
  t.after(async () => {
    active?.release();
    st.sessionMode = before.sessionMode;
    st.sessions = before.sessions;
    await flush();
  });
  active = openSession(project, ref, { lastReplyModel: ref });
  assert.equal(active.resume, false);
  assert.equal(active.policyChanged, true);
  assert.equal(active.moved, false);
  assert.equal(getSession(project, ref).promptPolicyVersion, PROMPT_POLICY_VERSION);
  assert.equal(st.chats, chats);
  assert.equal(st.approvals, approvals);
  active.setId('updated-session');
  active.touch();
  active.release();
  active = openSession(project, ref, { lastReplyModel: ref });
  assert.equal(active.resume, true);
  assert.equal(active.policyChanged, false);
  assert.equal(active.sessionId, 'updated-session');
});

test('a work council with no changes reports an empty change list without claiming an edit', () => {
  const states = [{ id: 'a', label: 'Reviewer', role: 'engineer', rounds: { 1: { text: 'Read only.', ok: true }, 2: { text: 'No change needed.', ok: true, changed: [] } } }];
  const { prompt } = moderatorMessage({ question: 'Review this.', history: '', cwd: '.', states, rounds: 2,
    files: { names: [], blocks: [], documents: [] }, ref: 'codex:gpt-6.2-astra', system: '', pictures: { images: [], note: '' }, folder: 'work' });
  assert.match(prompt, /The seats changed no files/);
  assert.doesNotMatch(prompt, /seats changed the folder/);
});
