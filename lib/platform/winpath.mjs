import { execFile } from 'node:child_process';
import { existsSync, promises as fsp, statSync } from 'node:fs';
import path from 'node:path';

// A command-line tool that was installed while Plenum runs (Windows only).
//
// A Windows program gets its PATH once, when it starts. An installer (Cursor, Grok Build, Antigravity, npm, the Muse Code setup) adds its
// folder to the PATH in the registry, and a program that is already running never sees it. So a CLI installed while Plenum runs used to
// stay "Not installed" until Plenum was started again. This module is the second look: when a tool was NOT found the usual way, it reads
// the PATH value from the registry and looks in the folders that are on it but not on the PATH this process has.
//
// The contract (the tests pin each line). It is made for findExecutable in lib/proc.mjs, which is where the product looks for a CLI on
// Windows; locateCommand in ./index.mjs calls it after a miss of where.exe and of the tools folder.
//   locateOnRegistryPath(name, { env, searched, fresh })  resolves to the full path of the tool, or null. It never rejects.
//   forgetRegistryPath()                                   drops what is kept, so the next call reads the registry again (a Refresh).
//   registryPathWanted({ platform, env })                  whether this process takes the second look at all (see below).
// What it never does: write the registry, change the PATH of this process (a child must not inherit a surprise), look anywhere when the
// tool was found the usual way, put a registry folder in front of the PATH, or wait: the registry is read with reg.exe in the background,
// both keys at once, each with a 3 second limit, and every lookup that starts in the meantime shares that one read.
// What is asked for: the value named Path ("reg query <key> /v Path") and nothing else, so no other variable of the user (a key, for
// example) is read. One exception: a variable that an entry of that Path names and this process does not have, because the same
// installer just made it (%PNPM_HOME%, %VOLTA_HOME%, %NVM_HOME%). Such a name is asked for by itself, at most four of them, and never
// one that looks like a secret (KEY, TOKEN, SECRET, PASSWORD or CREDENTIAL in its name). Its value is only ever used as a folder to look in.
// What is kept: the PATH values for 5 minutes (a status read must not start reg.exe every few seconds while some CLI is missing, which
// is the usual state) and the file lists of the new folders for 30 seconds. A Refresh drops both. A run (fresh) reads both again unless
// the last read began less than 2 seconds ago.
// Known limit: reg.exe writes its answer in the console's code page, so a folder whose name has letters outside ASCII may come back
// spelled wrong. Such a folder is then not found, which is the answer from before this module; starting Plenum again finds it.

// Windows builds a PATH from the computer's value and then the user's, so the new folders are looked at in that order.
export const REGISTRY_PATH_KEYS = ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'HKCU\\Environment'];
const READ_MS = 3000;
const KEEP_MS = 300_000;
const FOLDERS_KEEP_MS = 30_000;
const SHARE_MS = 2000;
// Folders read at one time. The new folders are few (often none), and the server's other file reads need the threads too.
const FOLDERS_AT_ONCE = 3;
// How many variables of the registry are asked for because an entry of the PATH names them (see the top).
const NAMES_AT_MOST = 4;
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL/i;
const win = path.win32;

// Windows names of environment variables are not case-sensitive. process.env answers that way by itself; a plain object does not.
function envValue(env, name) {
  if (!env) return undefined;
  if (env[name] !== undefined) return env[name];
  const upper = name.toUpperCase();
  for (const key of Object.keys(env)) if (key.toUpperCase() === upper) return env[key];
  return undefined;
}

// The switch. The second look is off unless PLENUM_PATH_REFRESH is 1, and only the desktop app sets that, for the server it starts
// (serverEnv in desktop/main.cjs, never in its smoke mode): that server's PATH was built from the registry when it started, so the
// registry is where a newer PATH is. Everything else stays off: a plain `node server.mjs`, and every test, whether its server is a
// plain process or a utility process of a hidden Electron. A test must only ever see the PATH it was given, and the real computer's
// CLIs are on the registry PATH.
// The switch of this process is read once, when this module loads, and then taken out of the environment, so that nothing the server
// starts (a CLI, a command of the shell tool, a test run that a model starts from a chat) inherits it.
const SWITCH = 'PLENUM_PATH_REFRESH';
function takeSwitch(env) {
  const value = envValue(env, SWITCH);
  for (const key of Object.keys(env)) if (key.toUpperCase() === SWITCH) delete env[key];
  return value;
}
const ownSwitch = takeSwitch(process.env);

export function registryPathWanted({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return false;
  return (env === process.env ? ownSwitch : envValue(env, SWITCH)) === '1';
}

// The value called `name` in the answer of "reg query <key> /v <name>", or '' when there is none. A line of that answer is
// "    Path    REG_EXPAND_SZ    C:\one;%USERPROFILE%\two". Only text values count (REG_SZ and REG_EXPAND_SZ).
export function parseRegistryValue(out, name) {
  const wanted = String(name ?? '').toLowerCase();
  for (const line of String(out ?? '').split(/\r?\n/)) {
    const m = line.match(/^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i);
    if (m && m[1].toLowerCase() === wanted) return m[2].trim();
  }
  return '';
}
export const parseRegistryPath = out => parseRegistryValue(out, 'Path');

// %NAME% becomes the value of that variable, as Windows does it for a REG_EXPAND_SZ value. A name that is not set stays as written
// (and its folder is then left out by pathFolders). A name never reaches across a ";", so "50%;C:\x;100%" is left alone.
export function expandVariables(value, env = process.env) {
  return String(value ?? '').replace(/%([^%;]+)%/g, (all, name) => envValue(env, name) ?? all);
}

// The names that the PATH values hold as %NAME% and that env does not have: each once, in the order they are written. Only a plain
// name counts, and never one that looks like a secret.
export function unsetNames(values, env = process.env) {
  const seen = new Set();
  const out = [];
  for (const value of values ?? []) {
    for (const [, name] of String(value ?? '').matchAll(/%([^%;]+)%/g)) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (envValue(env, name) === undefined && /^[a-z_][\w()]{0,63}$/i.test(name) && !SECRET_NAME.test(name)) out.push(name);
    }
  }
  return out;
}

// One spelling for a folder: no quotes, no "." or ".." parts, no slash at the end (a drive's own folder keeps it).
function tidyFolder(dir) {
  const bare = String(dir ?? '').trim().replace(/^"(.*)"$/, '$1').trim();
  if (!bare) return '';
  const tidy = win.normalize(bare).replace(/\\+$/, '');
  return /^[a-z]:$/i.test(tidy) ? `${tidy}\\` : tidy;
}

// The folders of a PATH value, tidied. Only a folder on a drive (C:\...) counts. An empty or relative entry means "the current folder"
// to a shell and is left out, so a tool planted in a project folder is never picked up (the rule of findOnPath). A network folder
// (\\server\share) is left out too: reading one that is not reachable can take a long time. So is one that still holds a %NAME%.
function pathFolders(value) {
  return String(value ?? '').split(';').map(tidyFolder).filter(dir => /^[a-z]:\\/i.test(dir) && !/%[^%;]+%/.test(dir));
}

// The folders that are on the registry's PATH (values: the computer's, then the user's, as read) and not on `searched`, the PATH that
// was already looked through. Compared without regard to case or a slash at the end; each folder once, in the registry's order.
export function newRegistryFolders(values, searched, env = process.env) {
  const have = new Set(pathFolders(searched).map(dir => dir.toLowerCase()));
  const out = [];
  for (const value of values ?? []) {
    for (const dir of pathFolders(expandVariables(value, env))) {
      const key = dir.toLowerCase();
      if (have.has(key)) continue;
      have.add(key);
      out.push(dir);
    }
  }
  return out;
}

// reg.exe by its full path when it is there: its folder may be missing from an odd PATH, and Node would otherwise search every PATH folder.
function regProgram(env) {
  const root = envValue(env, 'SystemRoot') || envValue(env, 'windir');
  const full = root && /^[a-z]:\\/i.test(root) ? win.join(root, 'System32', 'reg.exe') : null;
  return full && existsSync(full) ? full : 'reg.exe';
}

// Resolves to the answer of `work`, or to `late` when it takes longer than ms. Never rejects.
function within(ms, work, late) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(late), ms);
    timer.unref?.();
    Promise.resolve(work).then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(late);
      },
    );
  });
}

// Asks the registry for one value of one key. '' for a key without it, a reg.exe that fails or is missing, or no answer in time.
function readValue(key, name, { run, env, timeoutMs }) {
  const answer = new Promise(resolve => {
    try {
      run(regProgram(env), ['query', key, '/v', name], { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' }, (err, out) => resolve(err ? '' : parseRegistryValue(out, name)));
    } catch {
      resolve('');
    }
  });
  // reg.exe is ended by its own time limit; the second limit here covers a runner that never answers.
  return within(timeoutMs + 250, answer, '');
}

// The two PATH values with the variables filled in that only the registry has. An installer that makes a variable and puts
// %THAT_VARIABLE% on the PATH in the same run (pnpm, Volta and nvm do) would otherwise leave an entry this process cannot read. The
// user's value of a name wins over the computer's, as Windows has it, and a %NAME% inside it is filled from env. A name that neither
// key has stays as written, and its entry is then left out.
async function withRegistryVariables(values, { run, env, timeoutMs }) {
  const names = unsetNames(values, env).slice(0, NAMES_AT_MOST);
  if (!names.length) return values;
  const filled = new Map();
  await Promise.all(names.map(async name => {
    const [machine, user] = await Promise.all(REGISTRY_PATH_KEYS.map(key => readValue(key, name, { run, env, timeoutMs })));
    const value = expandVariables(user || machine, env);
    if (value) filled.set(name.toLowerCase(), value);
  }));
  return values.map(value => String(value ?? '').replace(/%([^%;]+)%/g, (all, name) => filled.get(name.toLowerCase()) ?? all));
}

// What is kept between lookups: when the last read of the registry began, its answer (a promise of the two values), and the file
// lists of the new folders as a map from the folder in lower case to { at, files }.
const shared = { at: 0, read: null, folders: new Map() };

export function forgetRegistryPath(cache = shared) {
  cache.at = 0;
  cache.read = null;
  cache.folders = new Map();
}

// A kept answer is used for its time (keepMs); a run (fresh) only shares one that began in the last 2 seconds.
const usable = (at, fresh, now, keepMs) => now() - at < (fresh ? SHARE_MS : keepMs);

function registryValues({ run, env, fresh, now, cache, timeoutMs }) {
  if (cache.read && usable(cache.at, fresh, now, KEEP_MS)) return cache.read;
  cache.at = now();
  cache.read = Promise.all(REGISTRY_PATH_KEYS.map(key => readValue(key, 'Path', { run, env, timeoutMs }))).then(values => withRegistryVariables(values, { run, env, timeoutMs }));
  return cache.read;
}

// The files of one folder as a map from the lower-case name to the name as the folder spells it (folders are left out). A folder that
// is missing, refused or too slow holds nothing.
function folderFiles(dir, { readDir, fresh, now, cache, timeoutMs }) {
  cache.folders ??= new Map();
  const key = dir.toLowerCase();
  const hit = cache.folders.get(key);
  if (hit && usable(hit.at, fresh, now, FOLDERS_KEEP_MS)) return hit.files;
  const files = within(timeoutMs, (async () => {
    const found = new Map();
    for (const entry of await readDir(dir, { withFileTypes: true })) if (!entry.isDirectory()) found.set(entry.name.toLowerCase(), entry.name);
    return found;
  })(), new Map());
  cache.folders.set(key, { at: now(), files });
  return files;
}

function isRegularFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

// Resolves to the full path of `name` in a folder that is on the registry's PATH but not on `searched`, or to null. It never rejects.
// The choice among several files is the one of the usual lookup: <name> or <name><an extension of PATHEXT>; a real .exe first, then a
// .cmd or .bat shim, then the first one.
//   env       where %NAME% values, PATHEXT and SystemRoot come from (the process's own by default)
//   searched  the PATH that was already looked through (env's PATH by default)
//   fresh     true for a run: read the registry and the folders again unless that was done in the last 2 seconds
// wanted, run, readDir, isFile, now, cache and timeoutMs replace the real ones in the tests.
export async function locateOnRegistryPath(name, {
  platform = process.platform,
  env = process.env,
  searched = envValue(env, 'PATH'),
  fresh = false,
  wanted = registryPathWanted({ platform, env }),
  run = execFile,
  readDir = fsp.readdir,
  isFile = isRegularFile,
  now = Date.now,
  cache = shared,
  timeoutMs = READ_MS,
} = {}) {
  const bare = String(name ?? '');
  if (platform !== 'win32' || !wanted || !/^[\w.-]+$/.test(bare) || bare === '.' || bare === '..') return null;
  try {
    const folders = newRegistryFolders(await registryValues({ run, env, fresh, now, cache, timeoutMs }), searched, env);
    if (!folders.length) return null;
    const exts = String(envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').map(e => e.trim().toLowerCase()).filter(Boolean);
    const pick = async again => {
      const lists = new Array(folders.length);
      let next = 0;
      const worker = async () => {
        while (next < folders.length) {
          const at = next++;
          lists[at] = await folderFiles(folders[at], { readDir, fresh: again, now, cache, timeoutMs });
        }
      };
      await Promise.all(Array.from({ length: Math.min(FOLDERS_AT_ONCE, folders.length) }, worker));
      const lines = [];
      folders.forEach((dir, at) => {
        for (const ext of ['', ...exts]) {
          const real = lists[at].get(`${bare.toLowerCase()}${ext}`);
          if (real) lines.push(win.join(dir, real));
        }
      });
      return lines.find(l => /\.exe$/i.test(l)) ?? lines.find(l => /\.(cmd|bat)$/i.test(l)) ?? lines[0] ?? null;
    };
    let exe = await pick(fresh);
    // A file that a kept list names but that is gone (the CLI was removed) is looked for again in fresh lists.
    if (exe && !isFile(exe)) {
      forgetFolders(cache);
      exe = await pick(true);
    }
    return exe && isFile(exe) ? exe : null;
  } catch {
    return null;
  }
}

function forgetFolders(cache) {
  cache.folders = new Map();
}
