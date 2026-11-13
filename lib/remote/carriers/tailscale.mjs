// The Tailscale carrier (MOBILE.json desktop.new_files, lib/remote/carriers/tailscale.mjs; feature mob-04). Owned by mob-04.
//
// Plenum runs the user's own Tailscale command-line tool, and only after the consent the Tailscale switch is (the phone-tailscale notice
// says so). Plenum never bundles Tailscale, never signs in and never reads its account. The commands are fixed argument lists run with
// execFile, never a shell (the one exception is a Windows .cmd file, which only the test shim is; it still runs with fixed arguments):
//   tailscale status --json                                   the ts.net name and whether the computer is connected
//   tailscale serve --bg --https=443 http://127.0.0.1:<port>  the Bridge's loopback listener, behind a real https name
//   tailscale serve --https=443 off                           when the switch goes off, and only if this Plenum set the serve up
// Plenum takes down ONLY the handler it set (https on port 443). It never runs `tailscale serve reset`: that removes every serve handler
// on the computer, also the ones other programs set (on 12 Nov 2026 it took away the hub's share on port 8790). The handler is taken down
// only when Plenum set it up: the carrier remembers the ts.net name it served (through ctx.remember, which the Bridge keeps in
// state.json's phones.tailscale.name) and clears it afterwards. A computer whose serve config Plenum never touched is left alone.
// stop() without a context (the Bridge closing) leaves the serve config alone; the next launch sets it again or the switch off removes it.
//
// PLENUM_TAILSCALE_CLI=off in the environment means "there is no Tailscale here": nothing is looked for and nothing runs. Every sealed
// test run sets it (seal.sh, battery3.sh, the mobile runner, the sealed-server helper), because a test that switched this carrier on in
// a real server used to run the owner's real Tailscale. A test that wants a CLI passes its own stand-in through options.locate.
//
// Status. Without the CLI: { installed: false, message: 'Install Tailscale' } and nothing runs. Not connected or not signed in: nothing is
// served and the message says so. Nothing here logs a name, an argument list's output or a key.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const SERVE_HTTPS_PORT = 443;
export const INSTALL_TEXT = 'Install Tailscale';
const STATUS_TIMEOUT_MS = 20_000;
const SERVE_TIMEOUT_MS = 30_000;
const RESET_TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 512 * 1024;
const NAME_RE = /^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})*\.ts\.net$/;
const SECRETISH = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|PRIVATE|KEY)/i;

// The CLI, found on PATH or in the usual install places. Relative PATH entries are ignored.
export function locateTailscale({ env = process.env, platform = process.platform, names, fixedPaths, exists = fs.existsSync } = {}) {
  if (String(env.PLENUM_TAILSCALE_CLI ?? '').trim().toLowerCase() === 'off') return null; // sealed test runs: there is no Tailscale here
  const win = platform === 'win32';
  const wanted = names ?? (win ? ['tailscale.exe'] : ['tailscale']);
  const pathValue = env.PATH ?? env.Path ?? env.path ?? '';
  for (const raw of String(pathValue).split(win ? ';' : ':')) {
    const dir = raw.replace(/^"|"$/g, '');
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const name of wanted) {
      const full = path.join(dir, name);
      if (exists(full)) return full;
    }
  }
  const places = fixedPaths ?? (win
    ? [path.join(env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')]
    : platform === 'darwin'
      ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale']
      : ['/usr/bin/tailscale', '/usr/sbin/tailscale', '/usr/local/bin/tailscale']);
  for (const full of places) if (exists(full)) return full;
  return null;
}

// The environment a child gets: the process environment without anything that looks like a secret.
export function childEnvOf(env) {
  const out = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value === 'string' && !SECRETISH.test(key)) out[key] = value;
  }
  return out;
}

// Runs one CLI command with a fixed argument list. Resolves { ok, stdout, stderr, code }; never rejects.
export function runCli(bin, args, { timeoutMs, env, platform = process.platform } = {}) {
  return new Promise(resolve => {
    const shim = platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    const file = shim ? (process.env.ComSpec || 'cmd.exe') : bin;
    const argv = shim ? ['/d', '/s', '/c', `"${bin}" ${args.join(' ')}`] : args;
    try {
      execFile(file, argv, {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT,
        env: childEnvOf(env ?? process.env),
        windowsVerbatimArguments: shim,
      }, (error, stdout, stderr) => {
        resolve({ ok: !error, code: error ? (error.code ?? error.signal ?? 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
    } catch {
      resolve({ ok: false, code: 'spawn', stdout: '', stderr: '' });
    }
  });
}

/**
 * @param {object} [options]
 * @param {object} [options.locate]     options for locateTailscale (tests inject names, env and fixedPaths)
 * @param {object} [options.env]        the environment the CLI runs with (default process.env, secrets removed)
 * @param {(bin: string, args: string[], o: object) => Promise<object>} [options.run]   runs one command (default runCli)
 */
export function createTailscaleCarrier(options = {}) {
  const locateOptions = options.locate ?? {};
  const run = options.run ?? runCli;
  const env = options.env ?? process.env;
  let ctx = null;
  let bin = null; // the CLI last found
  let installed = false;
  let ready = false; // serve is set up for the current listener port
  let name = ''; // the ts.net name served
  let served = null; // { bin, target } once serve succeeded in this process
  let message = '';
  let error = '';
  let queue = Promise.resolve();

  const serial = fn => {
    const run2 = queue.then(fn, fn);
    queue = run2.catch(() => {});
    return run2;
  };

  function status(enabled = ctx?.settings?.().enabled === true) {
    return {
      on: enabled,
      installed,
      ready,
      name: ready ? name : '',
      origins: ready && name ? [`https://${name}`] : [],
      message: enabled && !ready ? message : '',
      error,
    };
  }

  function found() {
    bin = locateTailscale({ env: locateOptions.env ?? process.env, ...locateOptions });
    installed = Boolean(bin);
    return bin;
  }

  async function setUp(next) {
    const port = next.listener.port();
    if (!port) {
      ready = false;
      error = 'no-listener';
      message = 'Plenum is not listening yet. Turn Phones on first.';
      return;
    }
    const target = `http://127.0.0.1:${port}`;
    if (served && served.bin === bin && served.target === target && ready) return;
    const st = await run(bin, ['status', '--json'], { timeoutMs: STATUS_TIMEOUT_MS, env });
    let parsed = null;
    try {
      parsed = JSON.parse(st.stdout);
    } catch {
      parsed = null;
    }
    if (!st.ok || !parsed || typeof parsed !== 'object') {
      ready = false;
      error = 'status';
      message = 'Tailscale did not answer. Open Tailscale and try again.';
      return;
    }
    if (parsed.BackendState !== 'Running') {
      ready = false;
      error = 'not-running';
      message = parsed.BackendState === 'NeedsLogin'
        ? 'Sign in to Tailscale on this computer, then try again.'
        : 'Connect Tailscale on this computer, then try again.';
      return;
    }
    const dns = String(parsed?.Self?.DNSName ?? '').replace(/\.$/, '').toLowerCase();
    if (!NAME_RE.test(dns)) {
      ready = false;
      error = 'no-name';
      message = 'Tailscale has no https name for this computer. Turn on MagicDNS and HTTPS certificates in the Tailscale admin console.';
      return;
    }
    const set = await run(bin, ['serve', '--bg', `--https=${SERVE_HTTPS_PORT}`, target], { timeoutMs: SERVE_TIMEOUT_MS, env });
    if (!set.ok) {
      ready = false;
      error = 'serve';
      message = 'Tailscale would not serve Plenum. Check that HTTPS certificates are on for your tailnet, then try again.';
      return;
    }
    served = { bin, target };
    name = dns;
    ready = true;
    error = '';
    message = '';
    next.remember?.({ name: dns });
  }

  function start(next) {
    return serial(async () => {
      ctx = next;
      if (next.settings?.().enabled !== true) return status(false);
      if (!found()) {
        ready = false;
        error = 'installed';
        message = INSTALL_TEXT;
        return status(true);
      }
      await setUp(next);
      return status(true);
    });
  }

  // With a context (the switch went off in this Bridge) Plenum's own handler (https 443) is taken down when Plenum set it up, now or in an
  // earlier launch (the remembered name). Never `serve reset`: other programs' handlers on this computer stay. Without a context (the
  // Bridge is closing) nothing is changed.
  function stop(next) {
    return serial(async () => {
      const marker = served !== null || Boolean(next?.settings?.().name);
      const wasServed = served;
      served = null;
      ready = false;
      name = '';
      error = '';
      message = '';
      if (next && (marker || wasServed) && found()) {
        const reset = await run(bin, ['serve', `--https=${SERVE_HTTPS_PORT}`, 'off'], { timeoutMs: RESET_TIMEOUT_MS, env });
        if (reset.ok) next.remember?.({ name: '' });
        else error = 'reset';
      }
      if (next) ctx = next;
      return status(false);
    });
  }

  async function hints() {
    if (!ready || !name || !ctx) return [{ kind: 'tailscale', on: false, label: 'Tailscale' }];
    const key = ctx.registry.pathKey();
    if (!key) return [{ kind: 'tailscale', on: false, label: 'Tailscale' }];
    return [{ kind: 'tailscale', on: true, label: 'Tailscale', url: `wss://${name}/b/${key}`, web: `https://${name}/p/${key}/` }];
  }

  return { start, stop, status: () => status(ctx?.settings?.().enabled === true), hints };
}

const carrier = createTailscaleCarrier();
export default carrier;
