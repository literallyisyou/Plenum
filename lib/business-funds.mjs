import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';
import * as business from './business.mjs';
import { insideRoot } from './files.mjs';
import { HOME } from './store.mjs';

export const BUSINESS_FUNDS_TOOL = 'business_funds';
const BINDING = Symbol('business funds chat binding');
const BRIDGE = Symbol('business funds authenticated bridge');
const REVOKED = new WeakSet();
const LIMIT = 65_536;
const TIMEOUT_MS = 5000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const SECRET = /^[a-f0-9]{64}$/;
const PROTOCOL = 'plenum-funds-v1';
const ACTIONS = new Set(['list', 'pay']);
const RECEIPT_STATES = new Set(['submitted', 'settled']);
const unavailable = 'This turn has no delegated business funds. Ask the owner if payment is needed.';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const token = value => typeof value === 'string' && ID.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const deny = output => ({ ok: false, denied: true, summary: 'Business funds request refused', output });

// The server supplies this binding. It survives the tool-loop's shallow context copies, and JSON arguments cannot supply it.
export function bindBusinessFunds(ctx, writable, { cli = false } = {}) {
  if (typeof writable !== 'function' || !writable()) return;
  const identity = businessFunds.identity(ctx.project?.id, ctx.ref, [ctx.root, ctx.project?.path], cli);
  if (!identity) return;
  ctx[BINDING] = Object.freeze({ project: ctx.project?.id, ref: ctx.ref, signal: ctx.signal, cli, identity, writable });
}

export function markBusinessFundsBridge(ctx) {
  ctx[BRIDGE] = true;
  return ctx;
}

function plainConfig(file, roots) {
  let fd;
  try {
    const located = lstatSync(file);
    if (!located.isFile() || located.nlink !== 1) return null;
    const canonical = realpathSync(file);
    for (const root of new Set(roots)) {
      if (typeof root !== 'string' || !path.isAbsolute(root) || insideRoot(realpathSync(root), canonical)) return null;
    }
    fd = openSync(file, 'r');
    const opened = fstatSync(fd);
    const checked = lstatSync(file);
    if (!opened.isFile() || !checked.isFile() || opened.nlink !== 1 || checked.nlink !== 1 || opened.ino !== checked.ino
      || opened.dev !== checked.dev || opened.ino !== located.ino || opened.dev !== located.dev || opened.size > LIMIT) return null;
    const buffer = Buffer.alloc(LIMIT + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    return length && length <= LIMIT ? JSON.parse(buffer.subarray(0, length).toString('utf8')) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function grantOf(config, id, project, ref) {
  const grant = Object.hasOwn(config?.grants ?? {}, id) ? config.grants[id] : null;
  if (config?.version !== 1 || !object(grant) || grant.project !== project || !token(grant.project) || !token(grant.account) || !token(grant.allowance)
    || !Number.isInteger(grant.port) || grant.port < 1024 || grant.port > 65535 || typeof grant.key !== 'string' || !SECRET.test(grant.key)
    || typeof grant.currency !== 'string' || !/^[A-Z]{3}$/.test(grant.currency)
    || !Array.isArray(grant.models) || !grant.models.includes(ref) || !Array.isArray(grant.payees) || !grant.payees.length
    || grant.payees.length > 100 || !grant.payees.every(token) || !positive(grant.perInvoice) || !positive(grant.total) || grant.perInvoice > grant.total
    || (Object.hasOwn(grant, 'allowCliTeam') && typeof grant.allowCliTeam !== 'boolean')) return null;
  return grant;
}

const wireSignature = (key, direction, nonce, body) => createHmac('sha256', Buffer.from(key, 'hex'))
  .update(`${PROTOCOL}\n${direction}\n${nonce}\n`).update(body).digest('hex');

function adapterCall(grant, payload, signal) {
  const body = Buffer.from(JSON.stringify(payload));
  const nonce = `${Date.now()}-${randomBytes(16).toString('hex')}`;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
  return new Promise((resolve, reject) => {
    const call = request({ host: '127.0.0.1', port: grant.port, path: '/plenum-funds/v1', method: 'POST', signal: deadline, headers: {
      'Content-Type': 'application/json', 'Content-Length': body.length,
      'X-Plenum-Funds-Nonce': nonce, 'X-Plenum-Funds-Mac': wireSignature(grant.key, 'request', nonce, body),
    } }, res => {
      const mac = res.headers['x-plenum-funds-mac'];
      if (res.statusCode !== 200 || typeof mac !== 'string' || !SECRET.test(mac)) {
        res.destroy(new Error('Unsigned or failed adapter response'));
      }
      let bytes = 0;
      const chunks = [];
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > LIMIT) res.destroy(new Error('Adapter response exceeded limit'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        if (typeof mac !== 'string' || !SECRET.test(mac) || !timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(wireSignature(grant.key, 'response', nonce, raw), 'hex'))) {
          reject(new Error('Invalid response signature'));
          return;
        }
        try { resolve(JSON.parse(raw.toString('utf8'))); } catch (err) { reject(err); }
      });
    });
    call.on('error', reject);
    call.end(body);
  });
}

function invoiceOf(invoice, grant) {
  if (!object(invoice) || invoice.account !== grant.account || invoice.currency !== grant.currency || !token(invoice.id)
    || !token(invoice.quote) || !grant.payees.includes(invoice.payee) || !positive(invoice.amount) || invoice.amount > grant.perInvoice) return null;
  return { id: invoice.id, quote: invoice.quote, payee: invoice.payee, account: invoice.account, amount: invoice.amount, currency: invoice.currency };
}

// An account and invoice identify one payment across Plenum and adapter restarts and owner configuration revisions.
function paymentKey(invoice) {
  return createHash('sha256').update(JSON.stringify([PROTOCOL, invoice.account, invoice.id])).digest('hex');
}

const scopeOf = grant => ({ account: grant.account, allowance: grant.allowance, currency: grant.currency, payees: grant.payees, perInvoice: grant.perInvoice, total: grant.total });

function receiptOf(value, invoice, key) {
  if (!object(value) || !RECEIPT_STATES.has(value.status) || value.key !== key || !token(value.receipt)
    || Object.entries(invoice).some(([field, expected]) => value[field] !== expected)) return null;
  return { invoiceId: invoice.id, status: value.status, receipt: value.receipt };
}

export function createBusinessFunds({ dir = HOME, businessApi = business } = {}) {
  const file = path.join(dir, 'business-funds.json');

  function find(project, ref, roots, cli) {
    const owner = businessApi.businessFor(project);
    if (!owner?.leads?.includes(ref) || !businessApi.mayRun(owner.id).ok || ref.endsWith(':default')) return null;
    const grant = grantOf(plainConfig(file, roots), owner.id, project, ref);
    if (!grant || (cli && grant.allowCliTeam !== true)) return null;
    const identity = createHash('sha256').update(JSON.stringify([owner.id, grant])).digest('hex');
    return { id: owner.id, grant, identity };
  }

  function authorized(ctx) {
    const binding = ctx?.[BINDING];
    if (!binding || REVOKED.has(binding) || ctx.scope || ctx.agent || ctx.seatOnly || ctx.only || ctx.confine || ctx.computer || ctx.readOnly
      || ctx.caller?.role !== 'chat' || !ctx.signal || ctx.signal.aborted || binding.signal !== ctx.signal
      || binding.project !== ctx.project?.id || binding.ref !== ctx.ref || binding.cli !== (ctx[BRIDGE] === true) || !binding.writable()) return null;
    const latest = find(binding.project, binding.ref, [ctx.root, ctx.project.path], binding.cli);
    if (latest?.identity === binding.identity) return latest;
    REVOKED.add(binding);
    return null;
  }

  async function run(input, ctx) {
    if (!object(input) || !ACTIONS.has(input.action) || Object.keys(input).some(k => k !== 'action' && k !== 'invoiceId')
      || (input.action === 'pay' ? !token(input.invoiceId) : Object.hasOwn(input, 'invoiceId'))) {
      return deny('Use list, or pay with only an invoice ID returned by the adapter.');
    }
    const allowed = authorized(ctx);
    if (!allowed) return deny(unavailable);
    const { id, grant } = allowed;
    const call = (operation, data) => adapterCall(grant, { operation, business: id, project: grant.project, scope: scopeOf(grant), ...data }, ctx.signal);
    let submitting = false;
    try {
      if (input.action === 'list') {
        const listed = await call('list', {});
        if (!Array.isArray(listed?.invoices) || listed.invoices.length > 100) return deny('The adapter did not return a valid invoice list.');
        if (!sameGrant(allowed, authorized(ctx))) return deny(unavailable);
        const invoices = listed.invoices.flatMap(raw => {
          const invoice = invoiceOf(raw, grant);
          return invoice && raw.status === 'open' ? [{ invoiceId: invoice.id, payee: invoice.payee, amountMinor: invoice.amount, currency: invoice.currency }] : [];
        });
        return { ok: true, summary: 'Listed eligible invoices', output: JSON.stringify(invoices) };
      }
      const current = await call('invoice', { invoiceId: input.invoiceId });
      const invoice = invoiceOf(current, grant);
      if (!invoice || invoice.id !== input.invoiceId) return deny('The invoice is unavailable or outside the delegated funding scope.');
      if (!sameGrant(allowed, authorized(ctx))) return deny(unavailable);
      const key = paymentKey(invoice);
      let receipt = receiptOf(current.receipt, invoice, key);
      if (Object.hasOwn(current, 'receipt') && (!receipt || current.status !== receipt.status)) return deny('The adapter returned an inconsistent invoice status.');
      if (!receipt) {
        if (current.status !== 'open') return deny('The invoice is no longer open. Ask the owner to reconcile its status.');
        submitting = true;
        const result = await call('pay', { invoice, key });
        receipt = receiptOf(result, invoice, key);
        if (!receipt) return deny('Submission outcome could not be verified. Reconcile by checking the same invoice ID before using another payment path.');
      }
      return { ok: true, summary: receipt.status === 'settled' ? 'Invoice settled' : 'Payment submitted', output: JSON.stringify(receipt) };
    } catch {
      return deny(submitting ? 'Submission outcome is unknown. Retry only this same invoice ID or ask the owner to reconcile it.' : 'The business funds adapter is unavailable.');
    }
  }

  const identity = (project, ref, roots, cli) => find(project, ref, roots, cli)?.identity ?? null;
  return { available: ctx => Boolean(authorized(ctx)), identity, run };
}

function sameGrant(before, after) {
  return after?.identity === before.identity;
}

export const businessFunds = createBusinessFunds();
