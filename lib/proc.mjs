import { spawn, execFile } from 'node:child_process';
import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { forgetRegistryPath, isExecutableFile, killGroupPlan, killTreePlan, locateCommand, locateOnRegistryPath, ownsProcessGroup, pathWithCliDirs, shellFor, toolsDir, usesCmdShim } from './platform/index.mjs';
import { cliError, cliLabel } from './cli-errors.mjs';
import { knownMisfit, rememberRefusal } from './cli-fit.mjs';
import { forgetChild, recordChild, sweepOnce } from './child-ledger.mjs';

// Process helpers shared by the CLI adapters and the run_command tool.
// On Windows, .cmd shims go through cmd.exe because Node refuses to spawn them directly.
// What differs between Windows, macOS and Linux (finding a tool, the shell, ending a process tree) is decided in
// lib/platform/, and the functions here that depend on it take the platform as a parameter that defaults to process.platform.

const found = new Map();

// Muse Console keeps its own copies of the Claude and Codex CLIs here, so they are found however
// the app was started. (%APPDATA%\npm is not reliable: a program installed from a packaged app can
// land in that app's private copy of AppData, which nothing else can see.)
export const TOOLS_DIR = toolsDir();

// The PATH a CLI is looked up on and run with. It is built here, in one place: the PATH the process has, then (macOS and
// Linux only) each common CLI folder that exists and is not on it yet (cliDirs in lib/platform/index.mjs). An app started
// from a desktop launcher gets a short PATH, and this puts Homebrew, npm's global folder and the user's own bin folders
// back. childEnv gives it to a child as its PATH and findExecutable searches it, so a tool is found in the same folders
// it can later be run from. Nothing is put in front of what the user already has, and on Windows the PATH comes back
// exactly as it was. home and exists replace the real ones in the tests.
export function cliSearchPath(env = process.env, { platform = process.platform, home, exists } = {}) {
  return pathWithCliDirs(env.PATH, { platform, home, exists });
}

// The augmented PATH is searched first, so a tool that is on PATH (and any test shim placed there) is always the one used.
// The tools folder is the fallback for an app started without the right PATH.
// Windows reads the PATH folders in Node (windowsLocate, what where.exe does); macOS and Linux search PATH in Node, with no shell (locateCommand
// in lib/platform/index.mjs).
// An answer, a miss included, is kept for 10 seconds per platform, name, PATH and PATHEXT (DECISIONS item 91): the status route looks for
// seven CLIs and must not ask where.exe for each of them on every call. Two calls for the same name at the same moment share one lookup.
// A kept path is still checked against the file with the same test the lookup uses, so a CLI that was removed is looked for again.
// forgetExecutables() drops every kept answer (a refresh does it), so a CLI installed while Plenum runs is found within 10 seconds or at
// Refresh. A run (forRun: resolveLaunch) never trusts a kept miss or a kept listing and looks again, so a CLI installed a moment ago still starts.
// env, home, exists, isExecutable and toolsDir replace the real ones in the tests.
const FOUND_MS = 10_000;
export function forgetExecutables() {
  found.clear();
  listings.clear();
  forgetRegistryPath();
}

// The files of each PATH folder, read once per 10 seconds and shared by every name looked for in that time, as [{ dir, files }] with files a
// map from the lower-case name to the name as the folder spells it (folders are left out). A folder that cannot be read holds nothing, but a
// folder that failed for a reason other than being absent (a lock, a refusal, a slow share) marks the whole listing `failed`, and that
// listing and a miss found with it are kept for 1 second, not 10: a miss caused by a read error is not "not installed".
// Three folders are read at a time: several hundred reads started in one go would hold the whole server while they start, and fill the
// few threads that every other file read of the server needs.
const listings = new Map();
const FAILED_KEEP_MS = 1000;
function listingOf(search, fresh = false) {
  const hit = listings.get(search);
  if (!fresh && hit && Date.now() - hit.at < FOUND_MS) return hit.promise;
  const dirs = [...new Set(String(search ?? '').split(';').map(d => d.trim().replace(/^"(.*)"$/, '$1')).filter(d => d && path.win32.isAbsolute(d)))];
  const promise = (async () => {
    const out = new Array(dirs.length);
    let next = 0;
    const worker = async () => {
      while (next < dirs.length) {
        const at = next++;
        const files = new Map();
        try {
          for (const entry of await fsp.readdir(dirs[at], { withFileTypes: true })) if (!entry.isDirectory()) files.set(entry.name.toLowerCase(), entry.name);
        } catch (err) {
          // A folder that is missing holds nothing here; any other failure also holds nothing, and is remembered.
          if (!['ENOENT', 'ENOTDIR'].includes(err?.code)) out.failed = true;
        }
        out[at] = { dir: dirs[at], files };
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, dirs.length) }, worker));
    // A listing with a failed folder is kept for a second only.
    const mine = listings.get(search);
    if (out.failed && mine?.promise === promise) mine.at = Date.now() - FOUND_MS + FAILED_KEEP_MS;
    return out;
  })();
  listings.set(search, { at: Date.now(), promise });
  return promise;
}

// What where.exe does, in Node: every file called <name> or <name><extension of PATHEXT> in the PATH folders, in order; a real .exe is
// preferred, then a .cmd or .bat shim (extensionless npm shims are shell scripts and cannot be spawned on Windows), then the first one.
// The tools folder's own .cmd shim is the fallback. where.exe is a program, and starting a program is a blocking call for the whole
// server that takes 100 ms and more with a long PATH, seven times for every status read, so Windows reads the folders itself.
async function windowsLocate(name, search, pathext, toolsFolder, fresh = false, doubt = {}) {
  const exts = String(pathext || '.COM;.EXE;.BAT;.CMD').split(';').map(e => e.trim().toLowerCase()).filter(Boolean);
  const pick = async again => {
    const lines = [];
    const listing = await listingOf(search, again);
    if (listing.failed) doubt.failed = true;
    for (const { dir, files } of listing) {
      for (const ext of ['', ...exts]) {
        const real = files.get(`${name.toLowerCase()}${ext}`);
        if (real) lines.push(path.win32.join(dir, real));
      }
    }
    return lines.find(l => /\.exe$/i.test(l)) ?? lines.find(l => /\.(cmd|bat)$/i.test(l)) ?? lines[0] ?? null;
  };
  let exe = await pick(fresh);
  // A file that the kept listing names but that is gone (the CLI was removed) is looked for again in a fresh listing.
  if (exe && !fresh && !isExecutableFile(exe)) exe = await pick(true);
  if (exe) return exe;
  const fallback = toolsFolder ? path.win32.join(toolsFolder, 'node_modules', '.bin', `${name}.cmd`) : null;
  return fallback && existsSync(fallback) ? fallback : null;
}
export function findExecutable(name, platform = process.platform, { env = process.env, home, exists, isExecutable, toolsDir: tools = TOOLS_DIR, forRun = false, registry } = {}) {
  const search = cliSearchPath(env, { platform, home, exists });
  const key = `${platform}:${name}:${search ?? ''}:${env.PATHEXT ?? ''}`;
  const hit = found.get(key);
  if (hit?.pending) return hit.pending;
  if (hit && Date.now() - hit.at < FOUND_MS) {
    if (hit.path && (isExecutable ?? isExecutableFile)(hit.path)) return Promise.resolve(hit.path);
    if (!hit.path && !forRun) return Promise.resolve(null);
  }
  const scan = platform === 'win32' && !isExecutable && /^[\w.-]+$/.test(name);
  // doubt.failed is set when a PATH folder could not be listed: a miss found then is kept for a second, not for 10.
  const doubt = {};
  const usual = scan ? windowsLocate(name, search, env.PATHEXT, tools, forRun, doubt) : locateCommand(name, { platform, env: { PATH: search }, toolsDir: tools, isExecutable });
  // A CLI that was installed while Plenum runs: its installer put its folder on the PATH in the registry, which a running program never
  // sees. Only when the tool is not found the usual way, the folders that are new on the registry's PATH are looked in too
  // (lib/platform/winpath.mjs; off unless the desktop app switched it on). The answer is the full path, which is what a run starts.
  // registry replaces the real reader in the tests.
  const lookup = scan ? usual.then(exe => exe ?? locateOnRegistryPath(name, { platform, env, searched: search, fresh: forRun, ...registry })) : usual;
  const pending = lookup.then(
    exe => {
      // A lookup that was overtaken by a forgetExecutables() (or a newer lookup) leaves the kept answers as they are.
      if (found.get(key)?.pending === pending) found.set(key, { path: exe ?? null, at: !exe && doubt.failed ? Date.now() - FOUND_MS + FAILED_KEEP_MS : Date.now() });
      return exe;
    },
    err => {
      if (found.get(key)?.pending === pending) found.delete(key);
      throw err;
    },
  );
  found.set(key, { ...(hit ?? {}), pending, at: hit?.at ?? 0 });
  return pending;
}

// The options every child process is started with. macOS and Linux start it in its own process group (detached), so that
// killTree can signal the whole group; Windows keeps its console hidden and uses taskkill /t instead.
export function spawnOptions({ cwd, env, stdio, verbatim = false }, platform = process.platform) {
  return { cwd, env, windowsHide: true, stdio, windowsVerbatimArguments: verbatim, detached: ownsProcessGroup(platform) };
}

// Starts every child process of the CLI adapters and the shell tool: streamProcess and runShell here, capture and the run
// in lib/claude-cli.mjs, and the Codex app server in lib/usage.mjs. This is the one place that calls spawn, so every child
// gets the same three things: spawnOptions (detached on macOS and Linux, so killTree can signal its whole group), the
// environment from childEnv(command) with `env` added on top, and `launch` (a resolveLaunch result, or { file, argv,
// verbatim } for the shell) as the program to start. platform, source and spawner replace the real ones in the tests,
// which is how a test sees the options built without starting anything.
export function startChild(command, launch, { cwd, env, stdio, platform = process.platform, source = process.env, spawner = spawn }) {
  // On Windows Node looks for a program named without a folder in every PATH folder first, before it starts it. With a long PATH that
  // search costs 200 to 500 ms of the whole server's time for each child (measured with 300 folders), so the system's own programs are
  // started by their full path. Only the real spawn is given the full path; a stand-in spawner sees the name as before.
  const file = spawner === spawn && platform === 'win32' ? systemProgram(launch.file) : launch.file;
  const real = spawner === spawn;
  // The first child of this process also starts the sweep of what an earlier Plenum left running (lib/child-ledger.mjs). It runs in
  // the background and is never waited for. This child's line is written in the same tick, so the sweep can read it; it is never ended,
  // because its owner is this process (ownerAlive). Off unless PLENUM_SWEEP=1 (this build ships with it off).
  if (real) sweepOnce();
  const child = spawner(file, launch.argv, spawnOptions({
    cwd,
    env: { ...childEnv(command, { source, platform }), ...env },
    stdio,
    verbatim: launch.verbatim,
  }, platform));
  // Written down by program, process id and start time, and taken out when it ends, so a crash that leaves it running can be cleaned up
  // at the next start. Only real children: a test's stand-in spawner starts nothing. No environment and no prompt is written.
  if (real && child?.pid) {
    const entry = recordChild(child, { command, file: launch.file, argv: launch.argv, cwd, platform });
    if (entry) {
      const forget = () => forgetChild(child.pid, { spawnedAt: entry.spawnedAt });
      child.once('exit', forget);
      child.once('error', forget);
    }
  }
  return child;
}

// A server process (node server.mjs, or the desktop app's server-entry) looks for what an earlier run left behind shortly after it starts,
// even before it has started a child. Other processes that load this module (tests, tools) do not; their first child does it.
if (/(^|[\\/])(server\.mjs|server-entry\.cjs)$/.test(String(process.argv[1] ?? ''))) setTimeout(() => sweepOnce(), 1500).unref();

// The full path of a program of Windows' System32 folder (cmd.exe, taskkill) when it is there, else the name as given.
const systemPrograms = new Map();
export function systemProgram(file) {
  const name = String(file);
  if (!/^[a-z0-9]+(\.exe)?$/i.test(name)) return name;
  if (!systemPrograms.has(name)) {
    const root = process.env.SystemRoot || process.env.windir;
    const full = root && path.win32.isAbsolute(root) ? path.win32.join(root, 'System32', /\.exe$/i.test(name) ? name : `${name}.exe`) : null;
    systemPrograms.set(name, full && existsSync(full) ? full : name);
  }
  return systemPrograms.get(name);
}

// ---------- the start gate ----------
// One gate for the whole process, so that two processes of one signed-in CLI never start in the same instant (wave 4, 16 Nov 2026). A
// council, a routine, a chat and team tasks can each start Claude Code at the same moment, and two processes that renew the sign-in
// with the same one-use token collide: one of them fails with "another Claude Code process is refreshing it" (kind sign-in-busy). A
// council already starts its own seats apart (lib/council-again.mjs apart); this gate spaces every start of the same CLI, whoever asks.
//   - Two starts of one CLI begin at least gapMs apart, measured from the previous start of that CLI, in the order they arrived (one
//     promise chain per CLI). Only starts that overlap are spaced: when the previous process of that CLI has already ended, the next one
//     starts at once, so runs one after the other are never slowed.
//   - After noteSignInBusy(command) (a run of that CLI failed because another process was renewing its sign-in), new starts of that CLI
//     wait until holdMs after the report, so the renewal can finish first.
//   - A Stop (the signal) ends a wait at once: the start does not happen, and the starts behind it move up.
// The CLIs with a sign-in of their own: claude, codex, gemini, muse, agy, grok and Cursor's CLI (cursor-agent, or agent: one sign-in, so
// one chain). Every other command (the shell, node in a test) passes at once.
// The times are read once from PLENUM_START_GAP_MS and PLENUM_START_HOLD_MS when they are set (0 turns that part off); a test sets them,
// the clock and the timer with configureStartGate.
export const START_GATE = Object.freeze({ gapMs: 2_000, holdMs: 20_000 });
const START_KEYS = Object.freeze({ claude: 'claude', codex: 'codex', gemini: 'gemini', muse: 'muse', agy: 'agy', grok: 'grok', 'cursor-agent': 'cursor', agent: 'cursor' });
const startLanes = new Map(); // key -> { tail, last, holdUntil }
let startTimesFromEnv = null;
let startOverride = {};

function startKey(command) {
  const name = path.basename(String(command ?? '')).toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, '');
  return Object.hasOwn(START_KEYS, name) ? START_KEYS[name] : null;
}
function envMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
function startTimes() {
  startTimesFromEnv ??= { gapMs: envMs('PLENUM_START_GAP_MS', START_GATE.gapMs), holdMs: envMs('PLENUM_START_HOLD_MS', START_GATE.holdMs) };
  return {
    gapMs: Number.isFinite(startOverride.gapMs) ? startOverride.gapMs : startTimesFromEnv.gapMs,
    holdMs: Number.isFinite(startOverride.holdMs) ? startOverride.holdMs : startTimesFromEnv.holdMs,
  };
}
const startNow = () => (typeof startOverride.now === 'function' ? startOverride.now() : Date.now());
// Waits ms: true when the time passed, false when the signal ended the wait.
function startSleep(ms, signal) {
  if (typeof startOverride.sleep === 'function') return Promise.resolve(startOverride.sleep(ms, signal)).then(Boolean);
  return new Promise(resolve => {
    if (signal?.aborted) return resolve(false);
    const stop = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}
function laneOf(key) {
  let lane = startLanes.get(key);
  if (!lane) {
    lane = { tail: Promise.resolve(), last: null, holdUntil: 0 };
    startLanes.set(key, lane);
  }
  return lane;
}
// How long a start that came now would wait for the gap and the hold (the queue in front of it not counted).
function waitOf(lane) {
  const { gapMs } = startTimes();
  const at = startNow();
  const gap = gapMs > 0 && lane.last && !lane.last.ended ? lane.last.at + gapMs - at : 0;
  return Math.max(0, lane.holdUntil - at, gap);
}

// For tests: the gap, the hold, the clock and the timer ({ gapMs, holdMs, now, sleep(ms, signal) -> boolean }). Returns a function that
// puts the real ones back. resetStartGate() forgets every start and every hold, and reads the environment again at the next start.
export function configureStartGate(options = {}) {
  const before = startOverride;
  startOverride = { ...startOverride, ...options };
  return () => { startOverride = before; };
}
export function resetStartGate() {
  startLanes.clear();
  startOverride = {};
  startTimesFromEnv = null;
}

// Waits for this command's turn to start. Resolves { end } when the process may start now (call end() when the process has ended, so a
// run after it is not held), or null when the signal ended the wait (nothing may start). A command with no sign-in of its own passes at
// once. Never throws.
export async function enterStartGate(command, { signal } = {}) {
  const key = startKey(command);
  if (!key) return { end() {} };
  if (signal?.aborted) return null;
  const lane = laneOf(key);
  const prev = lane.tail;
  let release = () => {};
  lane.tail = new Promise(resolve => { release = resolve; });
  try {
    // The starts in front of this one first (arrival order). A Stop meanwhile ends this wait at once; the chain behind it still waits
    // for the ones in front, so their order holds.
    const ahead = await new Promise(resolve => {
      if (signal?.aborted) return resolve(false);
      const stop = () => resolve(false);
      signal?.addEventListener('abort', stop, { once: true });
      prev.then(() => {
        signal?.removeEventListener('abort', stop);
        resolve(true);
      });
    });
    if (!ahead) {
      prev.then(release);
      return null;
    }
    // A hold that is reported while this start waits counts too, so the wait is looked at again after each sleep.
    for (let ms = waitOf(lane); ms > 0; ms = waitOf(lane)) {
      if (!(await startSleep(ms, signal)) || signal?.aborted) {
        release();
        return null;
      }
    }
    if (signal?.aborted) {
      release();
      return null;
    }
    const token = { at: startNow(), ended: false, end() { token.ended = true; } };
    lane.last = token;
    release();
    return token;
  } catch {
    release();
    return { end() {} };
  }
}

// The same gate as a yes or no: true when the process may start now, false when the signal ended the wait. A caller that cannot say when
// its process ended uses this; its start then counts as running for the whole gap. Never throws.
export async function startGate(command, { signal } = {}) {
  return (await enterStartGate(command, { signal })) !== null;
}

// A run of this command failed because another process of it was renewing its sign-in (kind sign-in-busy): new starts of it wait until
// holdMs after now.
export function noteSignInBusy(command) {
  const key = startKey(command);
  const { holdMs } = startTimes();
  if (!key || !(holdMs > 0)) return;
  const lane = laneOf(key);
  lane.holdUntil = Math.max(lane.holdUntil, startNow() + holdMs);
}

// How many milliseconds a start of this command that came now would still wait (0 when none), for a page or a card that wants to say
// so: startHeldWords(command) is the sentence.
export function startHeldFor(command) {
  const key = startKey(command);
  const lane = key ? startLanes.get(key) : null;
  return lane ? Math.ceil(waitOf(lane)) : 0;
}
export const startHeldWords = command => `${cliLabel(startKey(command) ?? String(command ?? ''))} is renewing its sign-in. This turn starts in a few seconds.`;

// Ends a child and everything it started. A run is stopped here: the abort signal of /cancel (and the run timeout) reach
// this function through the listeners in streamProcess, runShell and the Claude adapter, and the timers of capture and the
// Codex app server call it too. Windows runs taskkill /t.
// macOS and Linux signal the child's process group (negative pid), which is the child's own group because startChild
// starts it detached; with no such group (a child started some other way) the signal goes to the child alone.
// run and signalGroup replace execFile and process.kill in the tests, so a test never ends a real process.
// The kill starts at once, as before, and the function returns a promise that no caller has to wait for. On Windows the promise resolves
// true when taskkill reported that the tree is gone (or the child has ended by the time the limit passes), and false when that did
// not happen within limitMs: taskkill is looked at (a taskkill that failed or hung used to leave the tree running with Stop already
// shown). When the FIRST taskkill has returned with an error while Node still counts the child as running, it is run once more after
// retryMs: never a second one beside a first that is still working, and never more than one retry. The child itself is never killed
// first: with a .cmd shim the child is cmd.exe, and taskkill /t walks down from it, so a dead cmd.exe would leave the CLI behind. Two
// calls for one child share the first call's promise. Several children are ended at the same time: each call is independent.
// The limit only answers the caller that waits on a Stop. It does not end the work and it is not a failure: on a busy PC, or with
// several kills at once, taskkill needs longer than the limit and still ends the tree a moment later (wave 7: the log said "did not
// end" for programs that had ended). The warning is printed only when taskkill has really failed: both tries returned an error and the
// child is still running a moment after the second, or a try gave no answer for hungMs. It carries the first line taskkill wrote, so
// the log says why. Then, as the last resort, the child itself is ended (child.kill()): what it started may stay, but a CLI behind a
// shim that reads its input ends with it.
// taskkill's exit code is not the judge of a failure, the child is: taskkill also exits with an error (128 or 255) when a helper of
// the tree had gone by itself while it ended the rest. So after an error the child is looked at again, at once and after retryMs
// (Node reports an exit a moment after the process has gone). 128 with no "could not be terminated" line is "no such process": gone.
export const KILL_LIMIT_MS = 2500;
export const KILL_RETRY_MS = 400;
export const KILL_HUNG_MS = 15_000;
const PARTLY_ENDED = /could not be terminated/i;
const killing = new WeakMap();
export function killTree(child, platform = process.platform, { run = execFile, signalGroup = (pid, signal) => process.kill(pid, signal), limitMs = KILL_LIMIT_MS, retryMs = KILL_RETRY_MS, hungMs = KILL_HUNG_MS } = {}) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  const plan = killTreePlan(child.pid, platform);
  if (plan) {
    const open = killing.get(child);
    if (open) return open;
    const file = run === execFile && platform === 'win32' ? systemProgram(plan.file) : plan.file;
    const gone = () => child.exitCode !== null || child.signalCode !== null;
    // answered: the promise has its answer (at the limit at the latest). over: the work has ended (taskkill reported, or failed).
    let answered = false;
    let over = false;
    const done = new Promise(resolve => {
      const timers = [];
      const later = (fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref?.();
        timers.push(timer);
        return timer;
      };
      const answer = ok => {
        if (answered) return;
        answered = true;
        resolve(ok);
      };
      const close = ok => {
        if (over) return;
        over = true;
        timers.forEach(clearTimeout);
        killing.delete(child);
        answer(ok);
      };
      // taskkill has really failed: said in the log with its own first line, and the child itself is ended as the last resort.
      const failed = said => {
        if (over) return;
        const line = String(said ?? '').split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? '';
        console.warn(`[plenum] A program did not end when it was stopped (process ${child.pid})${line ? `: ${line.slice(0, 200)}` : '.'}`);
        try {
          child.kill();
        } catch {
          // It has gone meanwhile, or it cannot be ended from here either.
        }
        close(false);
      };
      const attempt = tries => {
        let back = false;
        const hung = later(() => { if (!back) { back = true; failed('taskkill gave no answer.'); } }, hungMs);
        run(file, plan.args, { windowsHide: true }, (err, out, errText) => {
          if (back || over) return;
          back = true;
          clearTimeout(hung);
          if (!err) return close(true);
          const said = String(errText ?? '').trim() || String(err.code ?? err.message ?? '');
          // 128 is taskkill's "no such process": the tree was already gone. With a "could not be terminated" line it is not that.
          if (err.code === 128 && !PARTLY_ENDED.test(said)) return close(true);
          if (gone()) return close(true);
          later(() => {
            if (over) return;
            if (gone()) close(true);
            else if (tries < 2) attempt(2);
            else failed(said);
          }, retryMs);
        });
      };
      later(() => answer(gone()), limitMs);
      attempt(1);
    });
    if (!over) killing.set(child, done);
    return done;
  }
  const group = killGroupPlan(child.pid, platform);
  if (group) {
    try {
      signalGroup(group.pid, group.signal);
      return Promise.resolve(true);
    } catch {
      // There is no group of that name, so the child is signalled alone.
    }
  }
  child.kill('SIGTERM');
  return Promise.resolve(true);
}

// Keys and settings that would make a CLI bill a per-token API key instead of its subscription login are kept
// out of its child process. Each rule is an exact name, or a prefix that ends in "_". Names are compared in
// upper case, because Windows environment variable names are not case-sensitive.
// On macOS and Linux the common CLI folders are added to the end of its PATH when they exist and are not on it
// (an app started from Finder gets a short PATH). source, platform, home and exists replace the real ones in the tests.
export function childEnv(command, { source = process.env, platform = process.platform, home, exists } = {}) {
  const env = { ...source, NO_COLOR: '1' };
  const cliPath = cliSearchPath(env, { platform, home, exists });
  if (cliPath !== env.PATH) env.PATH = cliPath;
  const names = Object.keys(env);
  // Codex Desktop hands its own tools a registered Core launch marker. A CLI started by Plenum does not inherit
  // Codex Desktop's Windows package identity, so its launcher rejects that marker before it can run a command.
  // Remove it only from Codex children of Plenum started in that Desktop environment. Keep the CLI's sandbox profile
  // and managed policy, and leave a standalone shell's explicit configuration alone.
  const inheritedDesktopCore = command === 'codex' && platform === 'win32'
    && ['CODEX_APP_RUNTIME_CLI_PATH', 'CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY'].every(
      marker => names.some(key => key.toUpperCase() === marker && env[key]),
    );
  // Claude Code's own keys and settings: ANTHROPIC_ would bill a key, CLAUDE_ holds its settings, and CLAUDECODE is
  // the marker Claude Code sets on the processes it starts. Every CLI except the shell gets this rule.
  const agent = ['ANTHROPIC_', 'CLAUDE_', 'CLAUDECODE'];
  // API keys for the providers. Every child loses these, the shell included. The API adapters read their keys with
  // keyFor on every request, and Codex uses its own sign-in, so no child needs one in its environment. CURSOR_API_KEY and
  // GROK_CODE_XAI_API_KEY (an xAI key under its Grok name) are named here too, so the shell and the other CLIs do not get them.
  const providerKeys = ['XAI_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'GOOGLE_AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'CURSOR_API_KEY', 'GROK_CODE_XAI_API_KEY'];
  const rules = {
    // Claude takes the agent rule, so it keeps its subscription login.
    claude: agent,
    // Codex bills an OPENAI_API_KEY instead of the ChatGPT login. Every OPENAI_ variable is removed, so no other
    // OPENAI_ setting can do the same.
    codex: [...agent, 'OPENAI_'],
    // These make Gemini use a Gemini or Google API key, Vertex AI or Code Assist instead of the Google sign-in,
    // so they are removed.
    gemini: [...agent, 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_GCA'],
    // Muse keeps the OPENAI_ rule and also drops the other providers' keys, so a run cannot bill a key from
    // another provider.
    muse: [...agent, 'OPENAI_', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'GOOGLE_AI_API_KEY', 'OPENROUTER_API_KEY'],
    // The shell keeps every other variable. The Anthropic keys and the CLAUDE_CODE_ settings go from this rule,
    // because they can switch a claude started from run_command to another login. The provider keys go as well.
    shell: ['ANTHROPIC_', 'CLAUDE_CODE_'],
    // Cursor's CLI (`agent`, or `cursor-agent`) keeps its Cursor account sign-in. A saved or inherited CURSOR_API_KEY would bill
    // instead, so it goes, with every other CURSOR_ setting (lib/cursor.mjs).
    agent: [...agent, 'CURSOR_API_KEY', 'CURSOR_'],
    'cursor-agent': [...agent, 'CURSOR_API_KEY', 'CURSOR_'],
    // Grok Build (`grok`) keeps its SuperGrok or X Premium sign-in. Every XAI_ setting (a saved key among them) and every GROK_ setting
    // (GROK_CODE_XAI_API_KEY is a third-party name for the same key) goes, so a key never bills in place of the sign-in (lib/grok.mjs).
    grok: [...agent, 'XAI_', 'GROK_'],
    // Antigravity (`agy`) keeps its Google sign-in. GEMINI_API_KEY, Vertex AI and ADC switch it to a key or a project, so they go
    // (lib/antigravity.mjs).
    agy: [...agent, 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_GCA', 'AGY_ADC_AUTH'],
  };
  // A command with no rules of its own gets the agent rule, the same as before. The provider keys go for every command.
  const own = Object.hasOwn(rules, command) ? rules[command] : agent;
  // META_API_KEY is Muse Code's key (README.md: it is passed to Muse Code), so only the muse run keeps it. Every other
  // child, the shell included, loses it.
  const drop = [...own, ...providerKeys, ...(command === 'muse' ? [] : ['META_API_KEY'])];
  if (inheritedDesktopCore) drop.push('CODEX_WINDOWS_REGISTERED_CORE');
  for (const key of names) {
    const name = key.toUpperCase();
    if (drop.some(rule => (rule.endsWith('_') ? name.startsWith(rule) : name === rule))) delete env[key];
  }
  return env;
}

// The key routes the person chose in Accounts. They are kept in the state file as plain values, never a key: keyRoutes
// = { gemini, codex, claude }. A run passes a saved provider key to its own child only through its env (startChild adds
// `env` on top of childEnv), and only when the route says so. childEnv above still removes every key from every child.
//   gemini: true (the default) sends the saved Google AI key to Gemini CLI whenever one is saved; false signs in with Google.
//   codex:  false (the default) uses the ChatGPT sign-in; true sends the saved OpenAI API key to Codex.
//   claude: 'cli' (Claude Code with the subscription) or 'api' (the Anthropic API key); null means automatic, which is the
//           CLI when it is installed and the API otherwise. A choice that was made is never switched on its own.
//   geminiModels: the route chosen for one Gemini CLI model, by its catalog id ('default' is the CLI's default model): 'key' (the
//           saved Google AI key) or 'sign-in' (the Gemini subscription, through the Google sign-in). A model with no entry follows the
//           gemini switch. Only plain ids and the two values are kept; lib/routes/keys.mjs saves only ids the catalog lists.
// st is the state object (lib/store.mjs get()). The function takes it as a parameter, so this module imports nothing new.
export const GEMINI_MODEL_ROUTES = Object.freeze(['key', 'sign-in']);
const GEMINI_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export function keyRoutesFrom(st) {
  const r = st && typeof st.keyRoutes === 'object' && st.keyRoutes !== null ? st.keyRoutes : {};
  const models = r.geminiModels && typeof r.geminiModels === 'object' && !Array.isArray(r.geminiModels) ? r.geminiModels : {};
  // Read it with Object.hasOwn, so an id such as "constructor" can never read as an inherited value. The id pattern keeps
  // "__proto__" out (an id starts with a letter or digit).
  const geminiModels = {};
  for (const [id, route] of Object.entries(models)) {
    if (GEMINI_MODEL_ID.test(id) && GEMINI_MODEL_ROUTES.includes(route)) geminiModels[id] = route;
  }
  return {
    gemini: r.gemini !== false,
    codex: r.codex === true,
    claude: r.claude === 'cli' || r.claude === 'api' ? r.claude : null,
    geminiModels,
  };
}

// Passes a stream through with the key taken out of what it carries. Each text piece has the key replaced, so a CLI that
// prints its key (in a reply, or in the failure text it writes to its output) does not put it on screen or in a transcript.
// A piece can end with the start of the key, cut by the chunk boundary, so that part is held back and joined to the next
// piece; it is shown when the stream ends. An error it throws has the key taken out of its message and its stack, so a key
// a run was given never reaches a message, a log or the screen (the CLI's own stderr is the usual source of such text).
// The stack is a separate string that carries its own copy of the message (V8 writes it the first time it is read, and an
// error rebuilt from text can have one set outright), so changing err.message alone can leave the key in err.stack.
// The error of a failed run (lib/cli-errors.mjs) also carries the CLI's words in fields of its own (raw, detail), so every text
// field of the error is cleaned, not only the two that every error has.
// key may be null.
const KEY_REMOVED = '[key removed]';
export async function* withoutKey(key, stream) {
  let held = '';
  try {
    for await (const piece of stream) {
      if (!key || typeof piece !== 'string') {
        if (held) {
          yield held;
          held = '';
        }
        yield piece;
        continue;
      }
      const clean = (held + piece).split(key).join(KEY_REMOVED);
      const keep = partialKeyLength(clean, key);
      const shown = clean.slice(0, clean.length - keep);
      held = clean.slice(clean.length - keep);
      if (shown) yield shown;
    }
    if (held) yield held;
  } catch (err) {
    if (key && err) {
      for (const field of new Set(['message', 'stack', ...Object.keys(err)])) {
        if (typeof err[field] === 'string' && err[field].includes(key)) err[field] = err[field].split(key).join(KEY_REMOVED);
      }
    }
    throw err;
  }
}

// The length of the longest end of text that is the start of key (and shorter than key); 0 when there is none.
function partialKeyLength(text, key) {
  for (let n = Math.min(key.length - 1, text.length); n > 0; n -= 1) {
    if (text.endsWith(key.slice(0, n))) return n;
  }
  return 0;
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = s => s.replace(ANSI, '');

// cmd.exe quoting for .cmd shims. A value with a character cmd.exe would read (" % ! ^ & | < >) is refused, not rewritten:
// a rewritten folder is a different folder, and the CLI would run in it with no error. The values that reach here are paths
// and settings, which the CLI adapters have already checked for plain names.
const CMD_UNSAFE = /["%!^&|<>]/;
function cmdArg(value, command) {
  const text = String(value);
  if (CMD_UNSAFE.test(text)) {
    throw new Error(`${command} cannot start on Windows with this command line: a value in it has characters cmd.exe cannot pass (" % ! ^ & | < >). If it is a folder, rename it, or use one without these characters.`);
  }
  // Backslashes at the end are doubled: the program reads \" as a quote that belongs to the value, so "D:\Data\" would take the closing
  // quote and every argument after it into this one (a folder typed with a backslash at its end). \\" is a backslash and the end.
  return `"${text.replace(/[\r\n]+/g, ' ').replace(/(\\+)$/, '$1$1')}"`;
}

export async function resolveLaunch(command, args, platform = process.platform) {
  const exe = await findExecutable(command, platform, { forRun: true });
  if (!exe) return null;
  if (usesCmdShim(exe, platform)) {
    // cmd.exe cannot open batch files at paths over 260 characters.
    if (exe.length > 240) {
      throw new Error(`${command} shim path is too long for cmd.exe (${exe.length} characters). Install ${command} to a shorter folder, or use its .exe.`);
    }
    const quoted = [exe, ...args].map(part => cmdArg(part, command));
    return { file: 'cmd.exe', argv: ['/d', '/s', '/c', `"${quoted.join(' ')}"`], verbatim: true };
  }
  return { file: exe, argv: args, verbatim: false };
}

// How long a run keeps reading after its CLI has exited. A helper process the CLI started can inherit the output pipes and
// hold them open after the CLI is gone, so a run cannot wait for the end of the output. Whatever arrives in this time is kept.
const EXIT_GRACE_MS = 300;
const STDOUT_HIGH_WATER = 512 * 1024;
const STDOUT_LOW_WATER = STDOUT_HIGH_WATER / 2;
const STDERR_TAIL = 4_000;
const STDERR_LINE_HEAD = 1_000;
const STDERR_LINE_MAX = STDERR_LINE_HEAD + STDERR_TAIL;

// Resolves when `done` does, or after `ms`, whichever comes first.
function settleWithin(done, ms) {
  let timer;
  return Promise.race([done, new Promise(resolve => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
}

// An ANSI escape that the end of a chunk cuts short (ESC, or ESC [ and some of its parameters). It is held back and joined to
// the next chunk, so an escape split across two chunks is still stripped. A held part longer than MAX_HELD_ESCAPE is not an
// escape a CLI writes, so it is shown as it arrived.
const OPEN_ESCAPE = /\u001b(\[[0-9;?]*[ -/]*)?$/;
const MAX_HELD_ESCAPE = 64;
function openEscapeAt(text) {
  const match = OPEN_ESCAPE.exec(text);
  return match && text.length - match.index <= MAX_HELD_ESCAPE ? match.index : -1;
}

// Streams stdout chunks. Optional `input` is written to stdin and closed. `env` adds variables for
// this run. `onStderrLine` sees each stderr line; a line it returns true for is left out of error text.
// A run that exits non-zero with no output throws. The error says what happened in plain words with a next step (cliError in
// lib/cli-errors.mjs: not signed in, a model that is not offered, a usage limit, no network, a rejected option, ...), never the exit
// code; the code, the kind and the old "<command> exited with code N:" text are fields of the error (code, kind, raw).
// After output, a non-zero exit (an exit by a signal has no code and counts as one) means the reply was cut off, unless the CLI had
// said that its turn was over. Only the adapter knows that, so it passes `completed`: a function that answers true once the CLI's own
// end marker was read (Codex's turn.completed, Gemini's result event). With `completed` given and answering false, the run throws
// after the text it has yielded, with partial: true on the error, so a cut-off reply is never taken for a finished one. A CLI with
// no end marker (Muse Code, Codex in plain text) passes () => false. A caller that passes no `completed` gets what it always got: a
// non-zero exit after output is not an error (a CLI can exit non-zero after a complete answer). `onExit({ code, stderr })` is told
// about every non-zero exit that was not thrown. A Stop is never an error.
// "Output" is text a person could see: a CLI that printed only a blank line or spaces before it failed has written nothing, so its
// failure is a run with no output (partial: false), whatever `completed` answers.
// `model` (optional) is the model's name as the app shows it, for the sentence about a model the account is not offered.
// `transcript` (optional, true for Codex in plain text) says that the CLI's error output is its progress log, with the prompt and the
// model's words in it: the cause of a failure is then read only from the CLI's own last error line (lib/cli-errors.mjs).
// `onActivity` (optional) is called each time the CLI writes anything, on stdout or stderr. It is how an agent's idle clock knows the
// CLI is still at work while it thinks or runs its own tools and has no reply text yet (lib/agent-run.mjs). If it throws, the run goes on.
export async function* streamProcess({ command, args, cwd, signal, input, hint, env, onStderrLine, onExit, onActivity, completed, model, transcript = false }) {
  const launch = await resolveLaunch(command, args);
  if (!launch) throw new Error(`${command} is not on PATH. ${hint ?? ''}`.trim());
  // An option this version of the CLI has already refused is said in words here, before the CLI is started (lib/cli-fit.mjs).
  const misfit = await knownMisfit(command, args, { model });
  if (misfit) throw misfit;
  // The start gate (above): a second process of the same signed-in CLI starts apart from the first, and after a sign-in that another
  // process was renewing. A Stop during that wait ends the run with nothing started.
  const slot = await enterStartGate(command, { signal });
  // A Stop that came while the launch was being found ends the run before anything starts. Nothing is awaited between
  // this check and the abort listener below, so a Stop cannot land in that gap unseen.
  if (!slot || signal?.aborted) {
    slot?.end();
    return;
  }
  let child;
  try {
    child = startChild(command, launch, { cwd, env, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  } catch (err) {
    slot.end();
    throw err;
  }
  child.once('exit', () => slot.end());
  child.once('error', () => slot.end());
  if (input != null) {
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  }
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stderr = '';
  let spawnError = null;
  let partial = '';
  let lineTruncated = false;
  const keep = text => { stderr = (stderr + text).slice(-STDERR_TAIL); };
  function addStderr(text) {
    const combined = partial + text;
    if (combined.length > STDERR_LINE_MAX) {
      partial = combined.slice(0, STDERR_LINE_HEAD) + combined.slice(-STDERR_TAIL);
      lineTruncated = true;
    } else partial = combined;
  }
  function flushStderr(ending) {
    const line = (lineTruncated
      ? partial.slice(0, STDERR_LINE_HEAD) + ' …[stderr line truncated]… ' + partial.slice(STDERR_LINE_HEAD)
      : partial) + ending;
    partial = '';
    lineTruncated = false;
    try {
      if (onStderrLine(line)) return;
    } catch {
      // A failed observer leaves the line available for provider error diagnosis.
    }
    keep(line);
  }
  const active = () => {
    try {
      onActivity?.();
    } catch {
      // A broken listener must not stop the run.
    }
  };
  child.stderr.on('data', d => {
    active();
    if (!onStderrLine) return keep(d);
    let start = 0;
    let end;
    while ((end = d.indexOf('\n', start)) >= 0) {
      addStderr(d.slice(start, end));
      flushStderr('\n');
      start = end + 1;
    }
    addStderr(d.slice(start));
  });
  // The exit of the CLI is what ends the run, not the end of its output (see EXIT_GRACE_MS).
  let exitCode = null;
  const exited = new Promise(resolve => {
    child.once('exit', code => { exitCode = code; resolve(); });
    child.on('error', err => { spawnError = err; resolve(); });
  });
  // Apply pipe backpressure while the caller is busy consuming output.
  const queue = [];
  let queued = 0;
  let paused = false;
  let streamEnded = false;
  let leaving = false;
  let finished = false;
  let wake = null;
  const poke = () => { const go = wake; wake = null; go?.(); };
  const leave = () => {
    leaving = true;
    child.stdout.pause();
    poke();
  };
  let graceTimer = null;
  let graceStarted = 0;
  let graceRemaining = EXIT_GRACE_MS;
  let childExited = false;
  const armGrace = () => {
    if (!childExited || finished || paused || leaving || graceTimer) return;
    graceStarted = performance.now();
    graceTimer = setTimeout(leave, graceRemaining);
  };
  child.stdout.on('data', chunk => {
    active();
    queue.push(chunk);
    queued += chunk.length;
    if (!paused && queued >= STDOUT_HIGH_WATER && !leaving) {
      paused = true;
      child.stdout.pause();
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
        // A slow consumer must still get the bytes waiting in the pipe at exit.
        graceRemaining = Math.max(0, graceRemaining - (performance.now() - graceStarted));
      }
    }
    poke();
  });
  child.stdout.on('end', () => { streamEnded = true; poke(); });
  child.stdout.on('error', () => { streamEnded = true; poke(); });
  exited.then(() => {
    childExited = true;
    armGrace();
  });
  const stop = () => { killTree(child); leave(); };
  signal?.addEventListener('abort', stop, { once: true });
  const stderrEnded = new Promise(resolve => { child.stderr.on('end', resolve); child.stderr.on('error', resolve); });
  // Whether anything a person could see was yielded: a blank line, spaces or colour codes alone are not a reply.
  let shown = false;
  let held = '';
  try {
    for (;;) {
      if (signal?.aborted) break;
      if (queue.length) {
        const chunk = queue.shift();
        queued -= chunk.length;
        if (paused && !leaving && queued <= STDOUT_LOW_WATER) {
          paused = false;
          child.stdout.resume();
          armGrace();
        }
        const text = held + chunk;
        const at = openEscapeAt(text);
        held = at < 0 ? '' : text.slice(at);
        const clean = stripAnsi(at < 0 ? text : text.slice(0, at));
        if (clean) {
          shown ||= /\S/.test(clean);
          yield clean;
        }
        continue;
      }
      if (streamEnded || leaving) break;
      await new Promise(resolve => { wake = resolve; });
    }
    if (signal?.aborted) return;
    if (held) {
      const rest = stripAnsi(held);
      shown ||= /\S/.test(rest);
      yield rest;
    }
    await exited;
    await settleWithin(stderrEnded, EXIT_GRACE_MS);
    // A Stop that came after the last output and before the exit ended the process: its exit code is the kill's, not a failure.
    if (signal?.aborted) return;
    if (partial) flushStderr('');
    if (spawnError) throw spawnError;
    const code = exitCode;
    const tail = stripAnsi(stderr).trim().slice(-1500);
    if (code !== 0) {
      // Nothing came back (a blank line is nothing): the run failed. Something came back and the adapter says the CLI never finished
      // its turn: the reply was cut off. A CLI can also exit non-zero after a complete answer (for example a background MCP login
      // failing), which is no error.
      const cutOff = shown && typeof completed === 'function' && !completed();
      if (!shown || cutOff) {
        const failure = cliError(command, { code, stderr: tail, partial: cutOff, model, transcript: transcript === true });
        // A refused option is remembered for this version of the CLI, so the next run says so before it starts (lib/cli-fit.mjs).
        if (failure.kind === 'flags-rejected') rememberRefusal(command, { flag: failure.flag ?? null, args }).catch(() => {});
        // Another process of this CLI was renewing its sign-in: the next starts of it wait for that renewal (the start gate).
        if (failure.kind === 'sign-in-busy') noteSignInBusy(command);
        throw failure;
      }
      onExit?.({ code, stderr: tail });
    }
  } finally {
    finished = true;
    clearTimeout(graceTimer);
    signal?.removeEventListener('abort', stop);
    slot.end();
    // Both pipes are let go, so a helper that still holds them cannot keep the run open.
    child.stdout.destroy();
    child.stderr.destroy();
    // After a Stop the run ends once the tree is gone, or after KILL_LIMIT_MS at the most (the Stop's own kill is the one waited for).
    if (signal?.aborted) await killTree(child);
    else killTree(child);
  }
}

// How much of a long output the shell tool keeps from its start: a quarter of maxOutput. The rest of the room goes to the end, where
// the failure summary of a long build is.
const SHELL_HEAD_SHARE = 0.25;
// The line that stands where output was dropped, between the start and the end that were kept. It is under 100 characters for any
// count (lib/tools/20-command.mjs leaves that much room for it).
export const droppedMarker = n => `\n…[${n} characters of output dropped here; the start and the end are kept]…\n`;
const lastChars = (text, n) => (n > 0 ? text.slice(-n) : '');

// Runs one shell command to completion (used by the run_command tool). `shell` is a shellFor() result. Without one the
// command runs as it always has: cmd.exe on Windows, /bin/sh elsewhere. The run_command tool passes the platform's own
// choice (lib/tools.mjs).
// Resolves { code, output, timedOut, aborted, error, droppedChars }. An output of up to maxOutput characters is kept whole. Of a longer
// one the start (a quarter of maxOutput) and the end (the rest) are kept, with droppedMarker(n) between them, and droppedChars is n: the
// number of characters, colour codes not counted, that were written and are not in `output`. It is 0 when nothing was dropped. Memory
// stays bounded while the command runs: the start is kept once, and of what follows only the end.
export function runShell(command, { cwd, timeoutMs = 120_000, signal, maxOutput = 30_000, shell = shellFor(process.platform, { windows: 'cmd' }) }) {
  if (signal?.aborted) {
    return Promise.resolve({ code: null, output: '', timedOut: false, aborted: true, error: undefined, droppedChars: 0 });
  }
  return new Promise(resolve => {
    const child = startChild('shell', { file: shell.file, argv: shell.argv(command), verbatim: shell.verbatim }, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const headMax = Math.max(0, Math.floor(maxOutput * SHELL_HEAD_SHARE));
    const tailMax = Math.max(0, maxOutput - headMax);
    // head: the first headMax characters. rest: what followed them, cut back to its last tailMax characters whenever it has grown to
    // twice that. total: every character written so far. All three are counted after the colour codes are taken out, so the number
    // that is reported is a number of characters a person would have seen.
    let head = '';
    let rest = '';
    let total = 0;
    // The start of a colour code that a chunk ended in the middle of (see openEscapeAt).
    let held = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let exitInfo = null;
    let graceTimer = null;
    const ended = new Set();
    const keep = clean => {
      if (!clean) return;
      total += clean.length;
      let more = clean;
      if (head.length < headMax) {
        const room = headMax - head.length;
        head += more.slice(0, room);
        more = more.slice(room);
      }
      if (!more) return;
      rest += more;
      if (rest.length > tailMax * 2) rest = lastChars(rest, tailMax);
    };
    const add = d => {
      const text = held + d;
      const at = openEscapeAt(text);
      held = at < 0 ? '' : text.slice(at);
      keep(stripAnsi(at < 0 ? text : text.slice(0, at)));
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      signal?.removeEventListener('abort', onAbort);
      // Both pipes are let go here: a helper process the shell started can hold them open after the shell has finished.
      child.stdout.destroy();
      child.stderr.destroy();
      if (held) {
        keep(stripAnsi(held));
        held = '';
      }
      // Nothing was dropped when what followed the start still fits the room for the end.
      let text = head + rest;
      let droppedChars = 0;
      if (total - head.length > tailMax) {
        // A cut never leaves half of a character that is written as a pair (an emoji): the half goes with what is dropped.
        const start = /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
        let end = lastChars(rest, tailMax);
        if (/^[\uDC00-\uDFFF]/.test(end)) end = end.slice(1);
        droppedChars = total - start.length - end.length;
        text = `${start}${droppedMarker(droppedChars)}${end}`;
      }
      resolve({ code, output: text, timedOut, aborted, error, droppedChars });
    };
    // The command ends at the shell's exit, once both of its outputs have ended, or EXIT_GRACE_MS after the exit when an
    // output is still held open (see streamProcess).
    const onEnded = name => {
      ended.add(name);
      if (exitInfo && ended.size === 2) finish(exitInfo.code);
    };
    child.stdout.on('end', () => onEnded('out'));
    child.stderr.on('end', () => onEnded('err'));
    child.on('exit', code => {
      exitInfo = { code };
      if (ended.size === 2) finish(code);
      else graceTimer = setTimeout(() => finish(code), EXIT_GRACE_MS);
    });
    child.on('error', err => finish(null, err.message));
    const timer = setTimeout(() => { timedOut = true; killTree(child); finish(null); }, timeoutMs);
    const onAbort = () => { aborted = true; killTree(child); finish(null); };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}
