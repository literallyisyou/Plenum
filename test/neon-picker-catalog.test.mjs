import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { toEntries } from '../lib/antigravity.mjs';
import { CATALOG, parseRef, setAntigravityModels } from '../lib/providers.mjs';
import { checkRef } from '../lib/council.mjs';
import { canRun } from '../lib/agents.mjs';
import { createTeam } from '../lib/team.mjs';

test('Neon choices follow the Antigravity account catalog without creating an API option', () => {
  const offered = toEntries([
    { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon High' },
    { modelId: 'gemini-4-neon-low', name: 'Gemini 4 Neon Low' },
  ]);
  const accountNeon = () => CATALOG.filter(c => c.provider === 'antigravity' && c.id.includes('neon'));
  const high = 'antigravity:gemini-4-neon-high';
  const low = 'antigravity:gemini-4-neon-low';
  const team = createTeam({
    dir: path.resolve('test', 'unused-' + randomUUID()),
    catalog: () => CATALOG,
    providers: () => ({ antigravity: { installed: true, signedIn: true } }),
    keys: () => [],
    listStates: () => ({ antigravity: { ok: true } }),
  });
  try {
    assert.equal(accountNeon().length, 0);
    setAntigravityModels(offered);
    assert.deepEqual(accountNeon().map(c => c.id), ['gemini-4-neon-high', 'gemini-4-neon-low']);
    assert.equal(parseRef('neon'), high);
    assert.equal(checkRef(low, 'Seat'), low);
    assert.ok(canRun(high, 'edit').ok);
    assert.equal(team.registry().filter(c => c.provider === 'antigravity' && c.ref.includes('neon')).length, 2);
    assert.ok(!CATALOG.some(c => c.provider === 'googleai' && c.id.includes('neon')));
    setAntigravityModels([]);
    assert.equal(accountNeon().length, 0);
    assert.equal(checkRef(low, 'Saved seat'), low);
    assert.ok(!team.registry().some(c => c.ref === low));
  } finally {
    setAntigravityModels([]);
  }
});
