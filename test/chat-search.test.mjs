import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { setToken } from '../lib/auth.mjs';
import { searchChats } from '../lib/chat-search.mjs';
import { routes as local } from '../lib/routes/history.mjs';
import { routes as global } from '../lib/routes/history-all.mjs';
import { classify } from '../lib/remote/tiers.mjs';

const widget = { id: 'a', name: 'Widget shop' };
const studio = { id: 'b', name: 'Studio' };
const message = (content, ts, options = {}) => ({ role: 'user', content, ts, ...options });

function fixture() {
  return {
    projects: [widget, studio],
    threads: {
      a: { active: 'a-tops', writer: 'a', list: [{ id: 'a-tops', name: 'Shipping [EU]', createdAt: 8 }, { id: 'a-told', name: 'Past orders', createdAt: 7, closedAt: 14 }] },
      b: { list: [{ id: 'b-ttrack', name: 'Tracking', createdAt: 9 }, { id: 'a-told', name: 'Bad scope' }] },
    },
    chats: {
      a: [message('Widget shipping is approved', 10)],
      'a-tops': [message('Shipping invoice #410.', 12), message('Shipping draft-only', 22, { role: 'assistant', draft: true })],
      'a-told': [message('Earlier shipping estimate', 9, { role: 'assistant', tools: [{ summary: 'internal-secret' }] })],
      b: [message('Shipping terms for the studio', 18), message('Shipping hidden record', 24, { role: 'tool' })],
      'b-ttrack': [message('A literal [EU] label.', 19)],
      'removed-t1': [message('Shipping removed scope', 28)],
    },
  };
}

test('project chat search finds titles, Main and other threads, including closed chats', () => {
  const state = fixture();
  const { results, more } = searchChats(state, [widget], 'SHIPPING');
  assert.equal(more, false);
  assert.deepEqual(results.map(h => [h.kind, h.thread.id, h.project.id, h.thread.closed]), [
    ['title', 'a-tops', 'a', false],
    ['message', 'a-tops', 'a', false],
    ['message', 'a', 'a', false],
    ['message', 'a-told', 'a', true],
  ]);
  assert.equal(searchChats(state, [widget], 'widget shop').results[0].thread.id, 'a');
  assert.equal(searchChats(state, [widget], '[eu]').results[0].kind, 'title');
  assert.deepEqual(searchChats(state, [widget], 'internal-secret').results, []);
});

test('global chat search bounds output and ranks newest hits across projects', () => {
  const state = fixture();
  state.chats.b.push(...Array.from({ length: 64 }, (_, i) => message(`${'long start '.repeat(300)}needle${' long end'.repeat(300)}`, 100 + i)));
  state.chats.a.push(message('Needle appears in another project', 10_000));
  const found = searchChats(state, state.projects, 'needle');
  assert.equal(found.results.length, 50);
  assert.equal(found.more, true);
  assert.equal(found.results[0].project.id, 'a');
  assert.equal(found.results[1].ts, 163);
  assert.ok(found.results[1].snippet.length <= 162);
  assert.match(found.results[1].snippet, /needle/);
  assert.equal(searchChats(state, state.projects, 'Shipping').results.filter(r => r.kind === 'message').length, 4);
});

test('search previews omit stray assistant protocol and preserve literal code and user text', () => {
  const state = fixture();
  state.chats.a.push(
    message('The reply is ready.\n<function_calls>\n<invoke name="private_probe">\nneedle-hidden\n</invoke>\n</function_calls>', 20, { role: 'assistant' }),
    message('```xml\n<function_calls>needle-visible</function_calls>\n```', 21, { role: 'assistant' }),
    message('<function_calls>needle-user</function_calls>', 22),
  );
  assert.deepEqual(searchChats(state, [widget], 'needle-hidden').results, []);
  const visible = searchChats(state, [widget], 'needle').results;
  assert.deepEqual(visible.map(r => r.role), ['user', 'assistant']);
  assert.ok(visible.every(r => r.snippet.includes('<function_calls>')));
  assert.doesNotMatch(searchChats(state, [widget], 'reply is ready').results[0].snippet, /private_probe/);
});

test('search endpoints enforce session authentication, scope and bounded literal queries', async () => {
  const state = fixture();
  const token = randomBytes(32).toString('hex');
  assert.equal(setToken(token, 'generated'), true);
  const [projectRoute] = local;
  const [globalRoute] = global;
  const response = (route, query, auth = token) => route.handler({
    req: { headers: { 'x-plenum-token': auth } },
    url: new URL(`${route.path}${query}`, 'http://example.test'),
    store: { get: () => state },
    projectById: id => state.projects.find(p => p.id === id) ?? assert.fail('unexpected project id'),
    json: (_res, status, body) => ({ status, ...body }),
    httpError: (status, text) => Object.assign(new Error(text), { status }),
  });
  for (const route of [projectRoute, globalRoute]) {
    assert.equal(classify(route.method, route.path, route.gated), 'read');
    await assert.rejects(response(route, '?project=a&q=shipping', ''), { status: 401 });
    await assert.rejects(response(route, '?project=a&q='), { status: 400 });
    await assert.rejects(response(route, `?project=a&q=${'x'.repeat(201)}`), { status: 400 });
  }
  const p = await response(projectRoute, '?project=a&q=shipping');
  assert.ok(p.results.every(hit => hit.project.id === 'a'));
  assert.ok(p.results.some(hit => hit.thread.id === 'a'));
  const a = await response(globalRoute, '?q=shipping');
  assert.ok(a.results.some(hit => hit.project.id === 'b'));
  const one = await response(projectRoute, '?project=a&thread=a-tops&q=shipping');
  assert.deepEqual(one.results, [{ index: 0, role: 'user', snippet: 'Shipping invoice #410.' }]);
  const literal = await response(globalRoute, '?q=%5BEU%5D');
  assert.deepEqual(literal.results.map(hit => hit.project.id), ['a', 'b']);
});
