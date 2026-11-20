import assert from 'node:assert/strict';
import test from 'node:test';
import { childEnv } from '../lib/proc.mjs';

test('a Windows Codex child omits the inherited Desktop Core marker', () => {
  const source = {
    CODEX_APP_RUNTIME_CLI_PATH: 'C:\\Desktop\\codex.exe',
    CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY: 'CodexDesktop',
    codex_windows_registered_core: '1',
    CODEX_PERMISSION_PROFILE: ':workspace',
  };
  const env = childEnv('codex', { source, platform: 'win32' });

  assert.equal(Object.hasOwn(env, 'codex_windows_registered_core'), false);
  assert.equal(env.CODEX_PERMISSION_PROFILE, ':workspace');
  assert.equal(source.codex_windows_registered_core, '1');
  assert.equal(childEnv('shell', { source, platform: 'win32' }).codex_windows_registered_core, '1');
  assert.equal(childEnv('codex', { source, platform: 'linux', exists: () => false }).codex_windows_registered_core, '1');
});

test('a standalone Windows Codex environment keeps its explicit Core setting', () => {
  const source = { CODEX_WINDOWS_REGISTERED_CORE: '1' };
  const env = childEnv('codex', { source, platform: 'win32' });

  assert.equal(env.CODEX_WINDOWS_REGISTERED_CORE, '1');
});
