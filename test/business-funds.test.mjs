import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('registered business funds tool enforces context and validates, retries and reconciles an invoice', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'plenum-funds-'));
  const old = process.env.MUSE_CONSOLE_HOME;
  process.env.MUSE_CONSOLE_HOME = dir;
  t.after(async () => {
    if (old === undefined) delete process.env.MUSE_CONSOLE_HOME;
    else process.env.MUSE_CONSOLE_HOME = old;
    await rm(dir, { recursive: true, force: true });
  });

  const { bindBusinessFunds, BUSINESS_FUNDS_TOOL, createBusinessFunds } = await import('../lib/business-funds.mjs');
  const { loadTools, runTool, toolsFor } = await import('../lib/tools.mjs');
  const { callTool, listTools } = await import('../lib/routes/mcp.mjs');
  const { parts } = await import('../lib/prompt-parts/60-business.mjs');
  const project = { id: 'inventory', path: path.join(dir, 'workspace') };
  await mkdir(project.path);
  const ref = 'openai:gpt-6.2-sol';
  const cliRef = 'codex:gpt-6.2-sol';
  const business = 'b_example';
  const key = 'a5'.repeat(32);
  const invoice = { id: 'invoice-001', quote: 'frozen-quote', account: 'business-account', payee: 'vendor-001', currency: 'USD', amount: 1800 };
  const signing = (mode, nonce, body) => createHmac('sha256', Buffer.from(key, 'hex')).update(`plenum-funds-v1\n${mode}\n${nonce}\n`).update(body).digest('hex');
  const operations = [];
  const nonces = new Set();
  const payments = [];
  let receipt = null;
  let corrupt = false;
  let revokeBeforePay = false;
  let remaining = 5000;
  const file = path.join(dir, 'business-funds.json');
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/plenum-funds/v1') return res.writeHead(404).end();
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const nonce = req.headers['x-plenum-funds-nonce'];
    assert.equal(req.headers['x-plenum-funds-mac'], signing('request', nonce, bytes));
    assert.match(nonce, /^\d+-[a-f0-9]{32}$/);
    assert.ok(!nonces.has(nonce));
    nonces.add(nonce);
    const payload = JSON.parse(bytes);
    assert.equal(payload.business, business);
    assert.equal(payload.project, project.id);
    assert.deepEqual(payload.scope, { account: invoice.account, allowance: 'delegation-1', currency: 'USD', payees: [invoice.payee], perInvoice: 2000, total: 5000 });
    operations.push(payload.operation);
    let result;
    if (payload.operation === 'list') {
      result = { invoices: [{ ...invoice, status: 'open' }, { ...invoice, id: 'unapproved', payee: 'out-of-scope', status: 'open' }] };
    } else if (payload.operation === 'invoice') {
      if (revokeBeforePay) await rm(file);
      result = payload.invoiceId === invoice.id ? { ...invoice, ...(receipt ? { status: receipt.status, receipt } : { status: 'open' }) } : { ...invoice, id: payload.invoiceId, payee: 'out-of-scope', status: 'open' };
    } else {
      assert.equal(payload.operation, 'pay');
      assert.deepEqual(payload.invoice, invoice);
      assert.match(payload.key, /^[a-f0-9]{64}$/);
      payments.push(payload.key);
      if (payments.length === 1) return res.socket.destroy();
      assert.equal(payload.key, payments[0]);
      if (!receipt && remaining >= invoice.amount) {
        remaining -= invoice.amount;
        receipt = { ...invoice, key: payload.key, receipt: 'opaque-receipt', status: 'submitted' };
        return res.socket.destroy();
      }
      result = receipt;
    }
    const response = Buffer.from(JSON.stringify(result));
    res.writeHead(200, { 'X-Plenum-Funds-Mac': corrupt ? '0'.repeat(64) : signing('response', nonce, response) }).end(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const grant = { project: project.id, port: server.address().port, account: invoice.account, allowance: 'delegation-1', key, currency: 'USD', payees: [invoice.payee], models: [ref, cliRef], perInvoice: 2000, total: 5000 };
  const configure = (fields = {}) => writeFile(file, JSON.stringify({ version: 1, grants: { [business]: { ...grant, ...fields } } }));
  await Promise.all([configure(), writeFile(path.join(dir, 'businesses.json'), JSON.stringify({
    v: 1, businesses: [{ id: business, name: 'Inventory', status: 'active', projects: [project.id], leads: [ref, cliRef] }],
  }))]);
  await loadTools();
  let writable = true;
  const context = (cli = false, projectRoot = project.path) => {
    const fresh = { project, root: projectRoot, ref: cli ? cliRef : ref, signal: new AbortController().signal, caller: { role: 'chat' } };
    bindBusinessFunds(fresh, () => writable, { cli });
    return fresh;
  };
  let ctx = context();
  const offer = target => toolsFor(target).some(tool => tool.name === BUSINESS_FUNDS_TOOL);
  const invoke = (input, target = ctx) => runTool(BUSINESS_FUNDS_TOOL, input, target);
  const bridgeList = target => callTool({ ctx: target, calls: 0 }, { name: BUSINESS_FUNDS_TOOL, input: { action: 'list' }, id: 'call-1' });
  assert.equal(offer(ctx), true);
  assert.equal((await listTools({ ctx })).some(tool => tool.name === BUSINESS_FUNDS_TOOL), false);
  const absentCli = context(true);
  assert.equal((await listTools({ ctx: absentCli })).some(tool => tool.name === BUSINESS_FUNDS_TOOL), false);
  assert.equal((await bridgeList(absentCli)).ok, false);
  assert.match(await parts[0].text({ ...ctx, fundsMode: 'api' }), /may use business_funds/);
  assert.doesNotMatch(await parts[0].text({ ...ctx, fundsMode: 'api', readOnly: true }), /may use business_funds/);
  assert.doesNotMatch(await parts[0].text({ ...absentCli, fundsMode: 'cli' }), /may use business_funds/);
  assert.equal(offer({ ...ctx, project: { id: 'other' } }), false);
  assert.equal(offer({ ...ctx, ref: 'codex:unlisted' }), false);
  assert.equal(offer({ ...ctx, agent: {} }), false);
  assert.equal(offer({ ...ctx, readOnly: true }), false);
  writable = false;
  assert.equal((await invoke({ action: 'list' })).denied, true);
  writable = true;

  const result = await invoke({ action: 'list' }, { ...ctx });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.output), [{ invoiceId: invoice.id, payee: invoice.payee, amountMinor: 1800, currency: 'USD' }]);
  assert.equal((await invoke({ action: 'pay', invoiceId: invoice.id, amount: 10 })).denied, true);
  assert.equal((await invoke({ action: 'pay', invoiceId: 'unapproved' })).denied, true);
  assert.equal(payments.length, 0);
  corrupt = true;
  assert.equal((await invoke({ action: 'list' })).denied, true);
  corrupt = false;

  await configure({ allowCliTeam: true });
  assert.equal(offer(ctx), false);
  assert.equal((await listTools({ ctx: absentCli })).some(tool => tool.name === BUSINESS_FUNDS_TOOL), false);
  const cli = context(true);
  assert.equal(offer(cli), false);
  assert.equal((await listTools({ ctx: cli })).some(tool => tool.name === BUSINESS_FUNDS_TOOL), true);
  assert.equal((await bridgeList(cli)).ok, true);
  assert.equal((await invoke({ action: 'list' }, cli)).denied, true);
  await configure();
  assert.equal(offer(ctx), false);
  assert.equal((await listTools({ ctx: cli })).some(tool => tool.name === BUSINESS_FUNDS_TOOL), false);
  assert.equal(offer(context(false, dir)), false);
  const duplicate = path.join(project.path, 'business-funds.json');
  await link(file, duplicate);
  assert.equal(offer(context()), false);
  await rm(duplicate);
  ctx = context();

  revokeBeforePay = true;
  assert.equal((await invoke({ action: 'pay', invoiceId: invoice.id })).denied, true);
  assert.equal(offer(ctx), false);
  assert.equal(payments.length, 0);
  revokeBeforePay = false;
  await configure();
  assert.equal(offer(ctx), false);
  ctx = context();

  const attempt = { action: 'pay', invoiceId: invoice.id };
  assert.match((await invoke(attempt)).output, /outcome is unknown/);
  const reopened = createBusinessFunds({ dir });
  assert.match((await reopened.run(attempt, { ...ctx })).output, /outcome is unknown/);
  const submitted = await reopened.run(attempt, { ...ctx });
  assert.deepEqual(JSON.parse(submitted.output), { invoiceId: invoice.id, status: 'submitted', receipt: 'opaque-receipt' });
  receipt.status = 'settled';
  assert.equal((await invoke(attempt)).summary, 'Invoice settled');
  assert.equal(payments.length, 2);
  assert.equal(remaining, 3200);
  assert.ok(operations.includes('invoice'));
});
