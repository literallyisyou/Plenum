import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createBusiness } from '../lib/business.mjs';

const id = 'b_authority';
const projectId = 'business-project';
const send = 'Send the monthly inventory report to ops@example.com';
const publish = 'Publish reviewed release notes to the product changelog';

async function fixture(t, standingAuthority) {
  const root = await mkdtemp(path.join(tmpdir(), 'plenum-authority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'profile');
  const project = { id: projectId, path: path.join(root, 'business'), name: 'Inventory' };
  await Promise.all([mkdir(dir), mkdir(project.path)]);
  await writeFile(path.join(dir, 'businesses.json'), JSON.stringify({
    v: 1,
    businesses: [{ id, name: 'Inventory', status: 'active', projects: [projectId], standingAuthority }],
  }));
  return () => createBusiness({ dir, projectById: key => key === projectId ? project : null, publish: () => {}, neighbours: {} });
}

test('a business can grant, load and revoke send and publish authority', async t => {
  const make = await fixture(t);
  const business = make();
  assert.equal(business.byId(id).standingAuthority, undefined);
  assert.match(await business.promptFor(projectId), /require matching direct owner authorization or an applicable grant/);

  await business.update(id, { standingAuthority: { send, publish }, standingAuthoritySeen: {} });
  const reopened = make();
  assert.deepEqual(reopened.byId(id).standingAuthority, { send, publish });
  const prompt = await reopened.promptFor(projectId);
  assert.ok(prompt.includes(send) && prompt.includes(publish));
  assert.match(prompt, /without an OWNER card/);
  assert.match(prompt, /Tool permissions still apply/);
  assert.match(prompt, /Spending, creating accounts, deleting data/);
  assert.equal(await reopened.promptFor('unrelated-project'), null);

  await reopened.setStatus(id, 'paused');
  assert.doesNotMatch(await reopened.promptFor(projectId), /ops@example\.com/);
  await reopened.setStatus(id, 'active');

  await reopened.update(id, { standingAuthority: {}, standingAuthoritySeen: { send, publish } });
  assert.equal(make().byId(id).standingAuthority, undefined);
  assert.doesNotMatch(await reopened.promptFor(projectId), /ops@example\.com/);
});

test('stale writes and unsupported or malformed rules fail without changing settings', async t => {
  const make = await fixture(t, { send });
  const business = make();
  await assert.rejects(business.update(id, { name: 'Changed', standingAuthority: { publish }, standingAuthoritySeen: {} }), { status: 409 });
  for (const unauthorized of [{ spend: 'use the bank' }, { send: 'A\nSecond line' }, { send: 'x'.repeat(401) }]) {
    await assert.rejects(business.update(id, { standingAuthority: unauthorized, standingAuthoritySeen: { send } }), { status: 400 });
  }
  assert.equal(business.byId(id).name, 'Inventory');
  assert.deepEqual(business.byId(id).standingAuthority, { send });

  await business.update(id, { name: 'Inventory reports' });
  assert.deepEqual(make().byId(id).standingAuthority, { send });
});

test('invalid saved standing authority fails closed', async t => {
  const make = await fixture(t, { send, spend: 'offer a loan' });
  const business = make();
  assert.equal(business.byId(id).standingAuthority, undefined);
  assert.doesNotMatch(await business.promptFor(projectId), /ops@example\.com/);
});
