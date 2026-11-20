import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHROME_ORIGIN, chromeExtensionRequest, routes } from '../lib/routes/chrome-share.mjs';

test('Chrome shares require a one-use pairing code and a revocable capability', async () => {
  const root = '/api/chrome-share/';
  assert.equal(chromeExtensionRequest('GET', root + 'status'), false);
  assert.equal(chromeExtensionRequest('POST', root + 'code'), false);
  assert.equal(chromeExtensionRequest('POST', '/api/chat'), false);
  assert.equal(chromeExtensionRequest('OPTIONS', root + 'share'), true);
  const httpError = (status, message) => Object.assign(new Error(message), { status });
  function call(name, body, headers = {}, method = 'POST', remoteAddress = '127.0.0.1') {
    const url = new URL(root + name, 'http://127.0.0.1:4317');
    const route = routes.find(row => row.path === url.pathname && row.method === method);
    return Promise.resolve().then(() => route.handler({
      req: { headers, socket: { remoteAddress } }, url, json: (_res, _code, payload) => payload,
      readBody: async () => body, httpError, events: { publish() {} },
    }));
  }
  const chrome = { origin: CHROME_ORIGIN };
  await assert.rejects(call('code', {}, {}, 'POST', '192.0.2.1'), { status: 403 });
  await assert.rejects(call('code', {}, { 'x-plenum-device': 'mock-phone' }), { status: 403 });
  const code = (await call('code', {})).code;
  await assert.rejects(call('pair', { code }, { origin: 'https://example.com' }), { status: 403 });
  await assert.rejects(call('pair', { code: '0'.repeat(32) }, chrome), { status: 403 });
  const { capability } = await call('pair', { code }, chrome);
  await assert.rejects(call('pair', { code }, chrome), { status: 403 });
  await assert.rejects(call('share', { url: 'https://example.com' }, chrome), { status: 401 });
  chrome['x-plenum-chrome'] = capability;
  await assert.rejects(call('share', { url: 'file:///C:/private' }, chrome), { status: 400 });
  await call('share', { url: 'https://user:password@example.com/doc?secret=yes#token', title: 'Article', selection: 'Read this.' }, chrome);
  await assert.rejects(call('share', { url: 'https://example.com/new' }, chrome), { status: 409 });
  const { share } = await call('status', undefined, {}, 'GET');
  assert.equal(share.url, 'https://example.com/doc');
  assert.equal(share.selection, 'Read this.');
  await assert.rejects(call('take', { id: 'another' }), { status: 409 });
  const received = await call('take', { id: share.id });
  assert.deepEqual(received.share, share);
  assert.equal((await call('status', undefined, {}, 'GET')).share, null);
  await call('revoke', {});
  await assert.rejects(call('share', { url: 'https://example.com' }, chrome), { status: 401 });
});
