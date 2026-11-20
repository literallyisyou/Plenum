// Starts a packaged Windows or macOS app in its hidden smoke mode and checks startup or recovery.
//
//   node scripts/smoke-packaged.mjs [--exe <path to app executable>] [--crash] [--root <folder>] [--timeout <ms>] [--keep]
//
// What it does, in order:
//   1. Makes sealed folders for the run (temp, AppData, LocalAppData, home, state, user data). They go under RUNNER_TEMP on a CI runner, else on D:
//      when this PC has a D: drive (C: is small), else under the system temp folder; --root names them instead, and must be a new or empty folder
//      (one that holds anything is refused with exit 2, so nothing of the person's is ever deleted). It refuses a folder that is, or lies inside, the real %USERPROFILE%/.muse-console
//      or %APPDATA%/Plenum: the app that runs here never sees a real person's chats, keys or settings.
//   2. Picks a free port on 127.0.0.1 that is not 4317 (the port of an installed Plenum).
//   3. Starts the executable hidden with an allow-list environment: system tools on PATH, the sealed folders,
//      PLENUM_SMOKE=1 and that PORT (the app's hidden smoke mode: no window shows, no dialog is asked, it ends by itself with code 0 once its page
//      has loaded, or non-zero when it fails to start), and PLENUM_NO_SERVICES=1, PLENUM_NO_SCHEDULER=1, PLENUM_TAILSCALE_CLI=off. Nothing else of this
//      process's environment reaches it (no token, no key, no CLI on PATH). --crash adds PLENUM_SMOKE_CRASH_SERVER=1: the app ends the server once
//      and passes only when the server was started again and the page reconnected.
//   4. Asks GET /api/health on that port while it waits. The route is gated by the app's per-launch token (which only the app knows), so a 401 from it
//      is an answer too: it shows the server is up. The verdict is the app's own: exit code 0 and its server.log saying the page loaded.
//   5. Ends its own app process if startup times out and removes the sealed folders when the run passed.
// Exit code 0: it came up. 1: it did not (the log tail is printed). 2: the script could not run.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const option = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const crash = flag('--crash');
const keep = flag('--keep');
const TIMEOUT_MS = Number(option('--timeout') ?? 140_000);
const windows = process.platform === 'win32';
const mac = process.platform === 'darwin';
const stop = (code, text) => { console.error(`smoke-packaged: ${text}`); process.exit(code); };
if (!windows && !mac) stop(2, 'This smoke test supports Windows and macOS.');
if (mac && !option('--exe')) stop(2, 'On macOS, pass --exe with the path to Plenum.app/Contents/MacOS/Plenum.');
const EXE = path.resolve(option('--exe') ?? path.join(PROJECT, 'release', 'win-unpacked', 'Plenum.exe'));

if (!fs.statSync(EXE, { throwIfNoEntry: false })?.isFile()) stop(2, `${EXE} is not an app executable. Nothing was started.`);

// ---------- the sealed folders ----------
const norm = p => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const inside = (p, parent) => norm(p) === norm(parent) || norm(p).startsWith(norm(parent) + '/');
const real = [
  process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.muse-console'),
  os.homedir() && path.join(os.homedir(), '.muse-console'),
  process.env.APPDATA && path.join(process.env.APPDATA, 'Plenum'),
  mac && path.join(os.homedir(), 'Library', 'Application Support', 'Plenum'),
  process.env.MUSE_CONSOLE_HOME,
].filter(Boolean);
const stamp = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${process.pid}`;
// A CI runner's own temp folder when there is one, else D: when this PC has a D: drive (C: is small), else the system temp folder.
const defaultBase = process.env.RUNNER_TEMP ? path.join(process.env.RUNNER_TEMP, 'plenum-smoke') : fs.existsSync('D:/') ? 'D:/PlenumSmoke' : path.join(os.tmpdir(), 'plenum-smoke');
const root = path.resolve(option('--root') ?? path.join(defaultBase, `run-${stamp}`));
for (const r of real) if (inside(root, r) || inside(r, root)) stop(2, `${root} is, or holds, a folder of the real Plenum (${r}). Pick another --root. Nothing was started.`);
const dirs = Object.fromEntries(['tmp', 'appdata', 'localappdata', 'home', 'state', 'userdata'].map(n => [n, path.join(root, n)]));
// A folder the person named is never emptied: it must be new or empty. Only the run-<time>-<pid> folder this script chose is cleared first.
if (option('--root') !== undefined) {
  let entries = [];
  try {
    entries = fs.readdirSync(root);
  } catch (err) {
    if (err?.code !== 'ENOENT') stop(2, `${root} could not be read (${err?.code ?? 'error'}). Name a new or empty folder for --root. Nothing was started.`);
  }
  if (entries.length > 0) stop(2, `${root} is not empty. Name a new or empty folder for --root. Nothing was started.`);
} else {
  fs.rmSync(root, { recursive: true, force: true });
}
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

// ---------- a free port, never 4317 ----------
async function freePort() {
  for (let i = 0; i < 25; i++) {
    const port = await new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
    if (port !== 4317 && port >= 1024 && port <= 65535) return port;
  }
  throw new Error('no free port was found');
}
const port = await freePort();

// ---------- the allow-list environment ----------
const env = {};
for (const name of ['SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']) {
  if (process.env[name] !== undefined) env[name] = process.env[name];
}
env.PATH = windows ? `${process.env.SystemRoot ?? 'C:/Windows'}/System32` : '/usr/bin:/bin:/usr/sbin:/sbin';
Object.assign(env, {
  TEMP: dirs.tmp, TMP: dirs.tmp, TMPDIR: dirs.tmp,
  APPDATA: dirs.appdata, LOCALAPPDATA: dirs.localappdata, USERPROFILE: dirs.home, HOME: dirs.home,
  MUSE_CONSOLE_HOME: dirs.state,
  PLENUM_NO_SERVICES: '1', PLENUM_NO_SCHEDULER: '1', PLENUM_NO_SIGNIN_WINDOW: '1', PLENUM_TAILSCALE_CLI: 'off',
  PORT: String(port), PLENUM_SMOKE: '1',
});
if (crash) env.PLENUM_SMOKE_CRASH_SERVER = '1';
if (mac) env.ELECTRON_ENABLE_LOGGING = '1';

// ---------- start, wait, end ----------
const started = Date.now();
const child = spawn(EXE, [`--user-data-dir=${dirs.userdata}`], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
console.log(`Starting ${crash ? 'recovery' : 'plain'} smoke test on port ${port}.`);
let out = '';
child.stdout.on('data', d => { out += d; });
child.stderr.on('data', d => { out += d; });
let exited = false;
let health = null; // { status, ms } of the first answer of GET /api/health
let polling = true;
const poll = () => {
  if (!polling || health) return;
  const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1000 }, res => {
    res.resume();
    health ??= { status: res.statusCode, ms: Date.now() - started };
  });
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
};
const poller = setInterval(poll, 250);

// On Windows stop the whole process tree. On macOS keep normal launch
// semantics and signal the child through its own handle.
let ending = false;
function endTree() {
  if (ending || exited || child.exitCode !== null || !child.pid) return;
  ending = true;
  if (windows) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
}
const code = await new Promise(resolve => {
  const timer = setTimeout(() => { endTree(); resolve('timeout'); }, TIMEOUT_MS);
  child.on('exit', c => { exited = true; clearTimeout(timer); resolve(c); });
  child.on('error', e => { clearTimeout(timer); resolve(`spawn-error ${e.message}`); });
});
polling = false;
clearInterval(poller);
endTree(); // a no-op once the app has ended itself; it stops helpers if the app left some behind while it was still running

// ---------- the verdict ----------
const logs = [];
const walk = d => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/server\.log$/i.test(e.name)) logs.push(p); } };
walk(root);
const log = logs.map(p => fs.readFileSync(p, 'utf8')).join('\n');
const want = crash
  ? /smoke: ending with code 0: the server was started again and the page reconnected/
  : /smoke: ending with code 0: the page loaded/;
const loaded = want.test(log);
const checks = {
  'exit code 0': code === 0,
  'the log has the planned end': loaded,
  'the server answered: GET /api/health on its port, or the log shows the page loaded (the app asks that route first)': health !== null || loaded,
  'no dialog was asked for': !/^dialog:/m.test(log) && !/ dialog: /.test(log),
  'no error from the page console': !/smoke: page error/.test(log),
  'no fault in the log': !/Could not save state|uncaught|Unhandled/i.test(log) && (crash || !/the local server exited/i.test(log)),
  'it was not started on port 4317': port !== 4317,
};
console.log(`${crash ? 'CRASH' : 'PLAIN'} smoke of the packaged app: exit ${code} after ${Date.now() - started} ms on port ${port}; log files: ${logs.length}`);
console.log(`exe: ${EXE}`);
console.log(`sealed folders: ${root}`);
console.log(`health route: ${health ? `answered ${health.status} after ${health.ms} ms` : 'not seen by this script before the app ended (its own check passed if the log says the page loaded)'}`);
console.log(`start line: ${log.split('\n').find(l => /start: /.test(l)) ?? '(none)'}`);
for (const [k, v] of Object.entries(checks)) console.log(`${v ? 'ok  ' : 'FAIL'} ${k}`);
const passed = Object.values(checks).every(Boolean);
if (!passed) {
  console.log('--- log tail');
  console.log(log.slice(-2500));
  console.log('--- output tail');
  console.log(out.slice(-800));
  process.exitCode = 1;
} else if (!keep) {
  // Only the folder this run made (its name is run-<time>-<pid> under PlenumSmoke or plenum-smoke), never a folder the person named.
  if (!option('--root')) fs.rmSync(root, { recursive: true, force: true });
}
