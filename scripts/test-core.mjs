// Run the repository's Node tests in a fresh profile. The test processes
// inherit no provider credentials, shell configuration, or developer PATH.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = fileURLToPath(new URL('../test/', import.meta.url));
const tempBase = process.env.RUNNER_TEMP
  || (process.platform === 'win32' && fs.existsSync('D:/') ? 'D:/PlenumTest' : os.tmpdir());
fs.mkdirSync(tempBase, { recursive: true });
const root = fs.mkdtempSync(path.join(fs.realpathSync(tempBase), 'core-'));

try {
  const folders = {};
  for (const name of ['home', 'state', 'tmp', 'appdata', 'localappdata']) {
    folders[name] = path.join(root, name);
    fs.mkdirSync(folders[name]);
  }
  const env = {
    HOME: folders.home,
    USERPROFILE: folders.home,
    APPDATA: folders.appdata,
    LOCALAPPDATA: folders.localappdata,
    XDG_CONFIG_HOME: folders.appdata,
    XDG_DATA_HOME: folders.localappdata,
    XDG_STATE_HOME: folders.state,
    TMPDIR: folders.tmp,
    TEMP: folders.tmp,
    TMP: folders.tmp,
    MUSE_CONSOLE_HOME: folders.state,
    PLENUM_NO_SERVICES: '1',
    PLENUM_NO_SCHEDULER: '1',
    PLENUM_NO_SIGNIN_WINDOW: '1',
    PLENUM_TAILSCALE_CLI: 'off',
    PATH: '',
  };
  for (const name of ['SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  if (process.platform === 'win32' && env.SystemRoot) env.PATH = path.join(env.SystemRoot, 'System32');
  const result = spawnSync(process.execPath, ['--test'], { cwd: testDir, env, stdio: 'inherit', windowsHide: true });
  if (result.error) console.error(`Core tests could not start: ${result.error.message}`);
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
