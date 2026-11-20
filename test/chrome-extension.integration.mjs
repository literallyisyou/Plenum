import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

// Optional headless integration test. Use a locally installed Playwright Core
// and Chromium, and a disposable PLENUM_CHROME_TEST_DIR (on D: on Windows).
const engine = process.env.PLENUM_CHROME_PLAYWRIGHT;
const executable = process.env.PLENUM_CHROME_EXECUTABLE;
const baseDir = process.env.PLENUM_CHROME_TEST_DIR;
const enabled = Boolean(engine && executable && (baseDir || process.platform !== 'win32'));

test('two isolated portfolio panels retain edits, respect close, and keep private tab context out of shares', { skip: !enabled }, async t => {
  const { chromium } = createRequire(import.meta.url)(engine);
  const scratchRoot = await fs.realpath(baseDir || os.tmpdir());
  const dir = await fs.mkdtemp(path.join(scratchRoot, 'extension-'));
  let context, fixture;
  t.after(async () => {
    await context?.close();
    if (fixture?.listening) await new Promise(resolve => fixture.close(resolve));
    const target = await fs.realpath(dir);
    assert.equal(path.dirname(target), scratchRoot);
    assert.match(path.basename(target), /^extension-/);
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3 });
  });
  const ext = path.join(dir, 'unpacked');
  await fs.cp(fileURLToPath(new URL('../chrome-extension/', import.meta.url)), ext, { recursive: true });
  const origin = 'chrome-extension://oemhjeifgagepiidpdnngfeidkbibmgf';
  context = await chromium.launchPersistentContext(path.join(dir, 'profile'), {
    headless: true, executablePath: executable,
    args: ['--no-first-run', '--disable-extensions-except=' + ext, '--load-extension=' + ext],
  });
  const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
  const pages = [first, second];
  for (const page of pages) await page.goto(origin + '/portfolio.html');
  const packet = { version: 1, items: ['alpha', 'beta'].map(id => ({
    id, title: 'Sample ' + id, description: 'Synthetic item', skills: [], images: [],
  })) };
  const input = path.join(dir, 'packet.json');
  await fs.writeFile(input, JSON.stringify(packet));
  await fs.copyFile(input, path.join(ext, 'plenum-portfolio.local.json'));
  await first.locator('#packet').setInputFiles(input);
  await second.getByText('0 of 2 marked as entered').waitFor();
  await second.getByLabel('Portfolio item').selectOption('beta');
  await second.waitForFunction(() => !document.querySelector('#item').disabled);
  assert.equal(await first.locator('#item').inputValue(), 'alpha');
  await Promise.all(pages.map(page => page.getByLabel('Mark as entered').check()));
  await first.getByText('2 of 2 marked as entered').waitFor();
  await first.locator('#packet').setInputFiles(input);
  await first.waitForFunction(() => document.querySelector('#packet').value === '' && !document.querySelector('#packet').disabled);
  assert.equal(await first.locator('#progress').textContent(), '2 of 2 marked as entered');

  const corrupt = structuredClone(packet);
  corrupt.items[0].images = [{ filename: 'damaged.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }];
  await first.locator('#packet').setInputFiles({ name: 'damaged.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(corrupt)) });
  await first.getByText('Chrome could not read the gallery image damaged.png.').waitFor();
  assert.equal(await first.locator('#progress').textContent(), '2 of 2 marked as entered');
  await first.locator('#local-packet').click();
  await second.getByRole('button', { name: 'Refresh from Plenum' }).waitFor();
  await second.evaluate(() => {
    const read = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await read(...args);
      await new Promise(resolve => { window.resumePacketRead = resolve; });
      return response;
    };
  });
  await second.locator('#local-packet').click();
  await second.waitForFunction(() => typeof window.resumePacketRead === 'function');
  await first.locator('#close').click();
  await second.evaluate(() => window.resumePacketRead());
  await first.getByText('Cleared the packet from this Chrome profile.').waitFor();
  await second.locator('#workspace').waitFor({ state: 'hidden' });
  assert.equal((await first.evaluate(() => chrome.storage.local.get('portfolioPacket'))).portfolioPacket, null);

  fixture = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<main><p>Public introduction</p><div contenteditable>Private draft</div><p>Public ending</p></main>');
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const site = 'http://127.0.0.1:' + fixture.address().port + '/demo';
  const tab = await context.newPage();
  await tab.goto(site + '?filter=sample#private-section');
  await tab.evaluate(() => {
    document.title = location.host + location.pathname + location.search + location.hash;
    const range = new Range();
    range.setStart(document.querySelector('p').firstChild, 0);
    range.setEndAfter(document.querySelector('p:last-child').firstChild);
    getSelection().addRange(range);
  });
  await first.evaluate(() => chrome.storage.local.set({ capability: '0'.repeat(64) }));
  const popup = await context.newPage();
  await popup.addInitScript(targetURL => {
    const tabs = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async () => (await tabs({})).filter(item => item.url?.startsWith(targetURL));
    window.calls = [];
    window.fetch = async (_url, options) => {
      window.calls.push(JSON.parse(options.body));
      return new Response('{}', { status: 200 });
    };
  }, site);
  await popup.goto(origin + '/popup.html');
  await popup.locator('#share-tab').click();
  await popup.getByText('Shared. Review the tab', { exact: false }).waitFor();
  assert.deepEqual(await popup.evaluate(() => window.calls), [{ title: site, url: site, selection: '' }]);
  await popup.locator('#share-selection').click();
  await popup.getByText('Highlight a passage in the page and try again.').waitFor();
  await tab.evaluate(() => history.replaceState({}, '', '?filter=another'));
  await popup.locator('#share-tab').click();
  await popup.getByText('The tab changed. Open this menu again.').waitFor();
  assert.equal(await popup.evaluate(() => window.calls.length), 1);

  await popup.reload();
  await popup.locator('#share-tab').waitFor();
  await popup.evaluate(() => {
    window.fetch = async () => {
      await new Promise(resolve => { window.finishOldShare = resolve; });
      return Response.json({ error: 'Pair again.' }, { status: 401 });
    };
  });
  await popup.locator('#share-tab').click();
  await popup.waitForFunction(() => typeof window.finishOldShare === 'function');
  await first.evaluate(() => chrome.storage.local.set({ capability: '1'.repeat(64) }));
  await popup.evaluate(() => window.finishOldShare());
  await popup.getByText('Pair again.').waitFor();
  assert.equal(await first.evaluate(async () => (await chrome.storage.local.get('capability')).capability), '1'.repeat(64));
});
