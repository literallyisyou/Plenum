import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { orderModelCatalog } from '../lib/catalog-order.mjs';
import { directModelEntries } from '../lib/direct-models.mjs';
import { forgetModels, listModels, openRouterKeptIds, PICKER_CACHE_MS } from '../lib/openrouter.mjs';
import { prewarmProviderStatus, resetProviderStatus, statusPayload } from '../lib/provider-status.mjs';
import { setDirectModels } from '../lib/providers.mjs';

test('model ordering compares numeric versions, retains route groups and keeps the local default', () => {
  const rows = ['gpt-6-astra', 'gpt-6.1-terra', 'default', 'gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.10-sol', 'custom']
    .map(id => ({ provider: 'codex', id, label: id }));
  rows.splice(2, 0, { provider: 'googleai', id: 'gemini-4', label: 'Gemini 4' });
  assert.deepEqual(orderModelCatalog(rows).map(row => row.id), [
    'default', 'gpt-6.10-sol', 'gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6-astra', 'custom', 'gemini-4',
  ]);
  assert.equal(rows[0].id, 'gpt-6-astra');
});

test('provider discovery keeps chat models and rejects media and malformed lists', () => {
  const model = (name, methods = ['generateContent']) => ({ name: `models/${name}`, supportedGenerationMethods: methods });
  assert.deepEqual(directModelEntries('googleai', { models: [
    model('gemini-4-pro'), model('gemini-4-flash-image'), model('gemini-4-live'), model('gemini-4-tool', ['embedContent']),
  ] }).map(x => x.id), ['gemini-4-pro']);
  assert.throws(() => directModelEntries('anthropic', { data: [{ id: 'invalid' }] }), /no supported chat models/);
  assert.deepEqual(directModelEntries('anthropic', { data: [
    { id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5' },
  ] }), [{ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 (Anthropic API)' }]);
});

function overrideEnv(t, name, value) {
  const before = process.env[name];
  const put = value => value === undefined ? delete process.env[name] : process.env[name] = value;
  put(value);
  t.after(() => put(before));
}

test('the OpenRouter picker reads once daily and keeps a usable list on failure', async t => {
  overrideEnv(t, 'OPENROUTER_API_KEY', 'fixture-only-key');
  let now = 10_000;
  t.after(forgetModels);
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    if (now >= PICKER_CACHE_MS + 10_000) throw new Error('fixture offline');
    return Response.json({ data: [
      { id: 'openai/gpt-6.1-terra', name: 'GPT 6.1 Terra' },
      { id: 'openai/gpt-6.2-sol', name: 'GPT 6.2 Sol' },
      { id: 'openai/media', architecture: { output_modalities: ['image'] } },
    ] });
  });
  const first = await listModels({ now: () => now });
  assert.deepEqual(first.models.map(x => x.id), ['openai/gpt-6.2-sol', 'openai/gpt-6.1-terra']);
  now += PICKER_CACHE_MS - 1;
  assert.equal((await listModels({ now: () => now })).cached, true);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(openRouterKeptIds(now), first.models.map(x => x.id));
  now++;
  const fallback = await listModels({ now: () => now });
  assert.equal(fallback.stale, true);
  assert.deepEqual(fallback.models, first.models);
});

test('the server refreshes compatible lists after a day without a model picker open', async t => {
  overrideEnv(t, 'PLENUM_NO_SERVICES', undefined);
  overrideEnv(t, 'PLENUM_NO_SCHEDULER', undefined);
  overrideEnv(t, 'GOOGLE_AI_API_KEY', 'fixture-only-google-key');
  t.after(() => { resetProviderStatus(); setDirectModels('googleai', null); });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.timers.enable({ apis: ['setInterval'] });
  let accepted = false;
  resetProviderStatus({ read: async () => ({}), publish: () => {}, accepted: () => accepted });
  const fetch = t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.match(url, /^https:\/\/generativelanguage.googleapis.com\/v1beta\/models\?/);
    assert.equal(init.redirect, 'error');
    return Response.json({ models: [{ name: 'models/gemini-4-test', supportedGenerationMethods: ['generateContent'] }] });
  });
  prewarmProviderStatus();
  await statusPayload();
  assert.equal(fetch.mock.callCount(), 0);
  accepted = true;
  await statusPayload({ refresh: 'googleai' });
  assert.equal(fetch.mock.callCount(), 1);
  now += PICKER_CACHE_MS - 1;
  t.mock.timers.tick(60_000);
  assert.equal(fetch.mock.callCount(), 1);
  now++;
  t.mock.timers.tick(60_000);
  for (let i = 0; i < 20 && fetch.mock.callCount() < 2; i++) await sleep(5);
  assert.equal(fetch.mock.callCount(), 2);
});
