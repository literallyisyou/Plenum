import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeComputerRoute } from '../lib/claude-cli.mjs';
import { computerSupportDetail } from '../lib/computer/support.mjs';

test('Claude desktop readiness and dispatch agree with the chosen billing route', async () => {
  const model = 'anthropic:claude-fable-5-2';
  const cases = [
    { route: 'cli', preference: 'cli', key: true, expected: 'cli', level: 'bridge' },
    { route: 'cli', preference: null, key: true, expected: 'api', level: 'unverified' },
    { route: 'cli', preference: null, key: false, expected: 'cli', level: 'bridge' },
    { route: 'api', preference: 'api', key: true, expected: 'api', level: 'unverified' },
    { route: 'api', preference: 'api', key: false, expected: 'api', level: 'no' },
  ];
  for (const c of cases) {
    let keyChecks = 0;
    const hasKey = async () => { keyChecks++; return c.key; };
    assert.equal(await claudeComputerRoute(c.route, hasKey, c.preference), c.expected);
    const readiness = await computerSupportDetail(model, {
      claudeCli: async () => c.route === 'cli',
      hasAnthropicKey: hasKey,
      routePreference: c.preference,
    });
    assert.equal(readiness.level, c.level);
    if (c.preference === 'cli') assert.equal(keyChecks, 0);
  }
});
