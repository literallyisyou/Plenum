import fs from 'node:fs';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { APP_ROOT } from './updates.mjs';
import { credentialPaths, pathFor, plenumDataDirs, systemDirs, systemMessage } from './platform/paths.mjs';

// Places the agent never touches, whatever the approval mode: credential stores, and the operating system's folders
// for writes. Muse Console's own source is changed through propose_update, so it is not written directly.
// The lists of credential and system folders are in lib/platform/paths.mjs, for Windows, macOS and Linux. Every function
// here takes its options last: platform defaults to process.platform, home to the user's folder and appRoot to Plenum's
// own folder, so a test can ask what a macOS or Linux path would do. A platform other than the one running cannot be
// checked against this machine's disk, so its paths are judged as written (no links are followed).
// The credential list is the sign-in folders under the home folder plus Plenum's own data folders (%APPDATA%\Plenum on
// Windows, ~/Library/Application Support/Plenum on macOS, ~/.config/Plenum on Linux), where the desktop app keeps its saved keys.
const HOME = os.homedir();
const CREDENTIAL_MESSAGE = 'That folder holds credentials and is off limits.';
const PLENUM_MESSAGE = 'Plenum changes its own files through propose_update, so they are not written directly.';
const NETWORK_MESSAGE = 'Plenum could not reach that network location to check it. Check the connection, or use a folder on this PC.';
const lower = p => p.toLowerCase();
// The state folder in use is off limits too. By default it is ~/.muse-console (already in credentialPaths), but
// MUSE_CONSOLE_HOME can move it, and it holds state.json, checkpoints and the applied-updates overlay. Only this machine's
// own setting counts, so a check for another platform is not affected.
const stateHome = platform => {
  const dir = process.env.MUSE_CONSOLE_HOME;
  return platform === process.platform && typeof dir === 'string' && pathFor(platform).isAbsolute(dir) ? [pathFor(platform).resolve(dir)] : [];
};
const secretPaths = (home, platform) => [...credentialPaths(home, platform), ...plenumDataDirs({ platform, home }), ...stateHome(platform)];
const SECRET_PATHS = secretPaths(HOME, process.platform);
export const SECRET_DIRS = SECRET_PATHS.map(lower);
const under = (dir, p, sep) => p === dir || p.startsWith(dir + sep);

// The folder that holds every thread's isolated copy (pro-02, lib/worktree.mjs): %LOCALAPPDATA%\PlenumWT on Windows, ~/.plenum-wt on macOS
// and Linux. It is read from the environment each time, so a test can point LOCALAPPDATA somewhere else. It is never under ~/.muse-console
// (which is off limits to every tool, so a copy there could not be read by its own agent) and never under OneDrive.
export function worktreeRoot({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const P = pathFor(platform);
  if (platform === 'win32') {
    const given = env?.LOCALAPPDATA;
    const local = typeof given === 'string' && given && P.isAbsolute(given) ? given : P.join(home, 'AppData', 'Local');
    return P.join(local, 'PlenumWT');
  }
  return P.join(home, '.plenum-wt');
}

// True when a path is the isolated-copies folder or lies inside it. The path is compared as written and as it really is (links followed),
// and so is the folder, so a link into a copy is caught too. Only the platform that is running has a disk to ask.
export function insideWorktreeRoot(p, options = {}) {
  return copyOfWorktree(p, options) !== null;
}

// Which isolated copy a path belongs to: the lower-case path of the copy's own folder (the first folder under the copies folder),
// '' for the copies folder itself, and null for a path outside it. A path is judged as written and as it really is; when the two
// differ the one that is inside the copies folder counts. Used to tell "my own copy" from "another thread's copy" (lib/tools.mjs).
export function copyOfWorktree(p, { platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const P = pathFor(platform);
  if (typeof p !== 'string' || !p) return null;
  const root = worktreeRoot({ platform, home, env: platform === process.platform ? env : {} });
  // The real forms come first, so a path and a folder that were both resolved name the same copy the same way.
  const forms = [...new Set([lower(resolvedPlace(p, platform)), lower(P.resolve(p))])];
  for (const place of new Set([lower(resolvedPlace(root, platform)), lower(P.resolve(root))])) {
    for (const f of forms) {
      if (!isWithin(f, place, P.sep)) continue;
      const first = f.slice(trimSep(place).length + 1).split(/[\\/]/)[0];
      return first ? `${trimSep(place)}${P.sep}${first}` : '';
    }
  }
  return null;
}

// File names that mark a file as holding a secret, wherever it sits in a project. This is the one list for everything that must not
// copy such a file somewhere else: the turn snapshots (lib/shadow.mjs) leave these files out whatever a .gitignore says, and a rewind
// neither writes nor removes them. Nothing in this file refuses a path because of it. A pattern is matched against the file's name only
// (not its folders), ignoring case, and '*' stands for any run of characters. The exceptions are names that look like a secret's but hold
// none: the example files that projects commit, and public keys.
export const SECRET_FILE_PATTERNS = Object.freeze([
  '.env', '.env.*',
  '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore', '*.kdbx',
  'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*',
  '.netrc', '_netrc', '.npmrc', '.pypirc', '.git-credentials',
  'credentials.json', 'client_secret*.json', 'service-account*.json', '*.tfstate',
]);
export const SECRET_FILE_EXCEPTIONS = Object.freeze(['.env.example', '.env.sample', '.env.template', 'id_*.pub']);

const nameMatcher = glob => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
const SECRET_NAME_RES = SECRET_FILE_PATTERNS.map(nameMatcher);
const SECRET_EXCEPTION_RES = SECRET_FILE_EXCEPTIONS.map(nameMatcher);

// True when the last part of a path (written with / or \) is a secret file name: it fits a SECRET_FILE_PATTERNS entry and no
// SECRET_FILE_EXCEPTIONS entry.
export function isSecretFileName(p) {
  const name = String(p ?? '').split(/[\\/]/).pop();
  if (!name || SECRET_EXCEPTION_RES.some(re => re.test(name))) return false;
  return SECRET_NAME_RES.some(re => re.test(name));
}

// The last part of a path as a diff header or a ---/+++ line writes it (a quoted path has its quotes dropped).
const headerName = text => {
  const t = text.replace(/\t.*$/, '').trim().replace(/^"|"$/g, '');
  return t.slice(t.lastIndexOf('/') + 1);
};

// The diff without the sections of secret files. A section starts at its "diff --git" line, which no line inside a section can
// imitate (those start with a space, +, - or a backslash), and its header lines run to the first hunk. A section is dropped when any
// name in its header is a secret file name: the "diff --git" line, a ---/+++ line or a rename or copy line. The snapshot diffs
// (lib/shadow.mjs) and @diff in a git folder (lib/files.mjs workingDiff) both use it, so a secret file's change reaches no model.
export function dropSecretSections(text) {
  if (!text.includes('diff --git ')) return text;
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith('diff --git ')) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !lines[end].startsWith('diff --git ')) end += 1;
    const names = [headerName(lines[i].slice('diff --git '.length))];
    for (let k = i + 1; k < end && !lines[k].startsWith('@@'); k += 1) {
      const m = /^(?:--- |\+\+\+ |rename (?:from|to) |copy (?:from|to) )(.*)$/.exec(lines[k]);
      if (m) names.push(headerName(m[1]));
    }
    if (!names.some(isSecretFileName)) out.push(...lines.slice(i, end));
    i = end;
  }
  return out.join('\n');
}

// True when the path is a credential folder or is inside one. realPath should already be resolved; it is normalised
// here as well, so a trailing separator or forward slashes cannot slip past the check. Each credential folder is compared
// as written and as it really is: a resolved path never matches a folder that is reached through a junction or symlink
// (for example ~/.ssh moved to another drive with a link left in its place), unless the folder's own real place is listed.
// On Windows a network spelling of a folder on this PC (\\localhost\C$\..., \\?\UNC\127.0.0.1\C$\...) is read as the drive path it is, and any other
// network or device path is judged by the file identity of the folder it opens (see networkRefusal below). One that cannot be read counts as a credential path.
export function isCredentialPath(realPath, { platform = process.platform, home = HOME, appRoot = APP_ROOT } = {}) {
  const P = pathFor(platform);
  const s = spell(realPath, platform);
  if (s.net !== null) return networkRefusal(s.net, { platform, home, appRoot, write: false }) !== null;
  const forms = s.path === realPath ? [realPath] : [s.path, resolvedPlace(s.path, platform)];
  return forms.some(f => {
    const p = lower(P.resolve(f));
    return credentialPlaces(home, platform).some(d => under(d, p, P.sep));
  });
}

// The credential folders as written and as they really are, lower-cased. Resolving them asks the disk, and the file index
// asks for every file it walks, so the list is kept for a few seconds; a folder linked elsewhere meanwhile is still caught
// as written, and as it really is once the list is read again.
const PLACES_MS = 5000;
const placesCache = new Map();
function credentialPlaces(home, platform) {
  // The environment is part of the key: APPDATA and MUSE_CONSOLE_HOME can change what the list holds.
  const key = [platform, home, process.env.APPDATA, process.env.LOCALAPPDATA, process.env.MUSE_CONSOLE_HOME].join('\u0000');
  const now = Date.now();
  const hit = placesCache.get(key);
  if (hit && now - hit.at < PLACES_MS) return hit.places;
  const places = [...new Set(secretPaths(home, platform).flatMap(s => placesOf(s, platform)))];
  if (placesCache.size > 16) placesCache.clear();
  placesCache.set(key, { at: now, places });
  return places;
}

// What a write into another thread's isolated copy is refused with (pro-02). It holds in every approval mode.
export const OTHER_COPY_MESSAGE = "That folder is another thread's isolated copy. Each thread changes only its own copy.";

// realPath should already be resolved (no symlinks left to follow).
// copyRoot (pro-02) is the folder the run works in. When it is given, a write into the isolated copies folder is allowed only into the
// copy that copyRoot belongs to; a run whose folder is not a copy cannot write into any copy. Callers that do not pass it are unchanged.
export function checkAccess(realPath, { write = false, platform = process.platform, home = HOME, appRoot = APP_ROOT, copyRoot } = {}) {
  const P = pathFor(platform);
  const s = spell(realPath, platform);
  if (s.net !== null) {
    const message = networkRefusal(s.net, { platform, home, appRoot, write });
    if (message) throw new Error(message);
    return;
  }
  // A drive spelling of a network path is judged as written and as it really is (links and junctions followed): it has not been resolved by the caller.
  const forms = s.path === realPath ? [realPath] : [s.path, resolvedPlace(s.path, platform)];
  for (const form of forms) {
    const p = lower(form);
    if (isCredentialPath(form, { platform, home })) throw new Error(CREDENTIAL_MESSAGE);
    if (write && systemDirs(platform).map(lower).some(d => underSystem(d, p, P.sep))) throw new Error(systemMessage(platform));
    if (write && under(lower(appRoot), p, P.sep)) throw new Error(PLENUM_MESSAGE);
  }
  if (write && typeof copyRoot === 'string' && copyRoot) {
    const copy = copyOfWorktree(forms[forms.length - 1], { platform, home });
    if (copy !== null && copy !== copyOfWorktree(copyRoot, { platform, home })) throw new Error(OTHER_COPY_MESSAGE);
  }
}

// ---------- network spellings of a path (Windows) ----------

// A folder of this PC can be named through the network: \\localhost\C$\Users\me\.ssh, \\127.0.0.1\C$\..., \\<this PC's name>\C$\...,
// \\?\UNC\localhost\C$\... and \\.\C:\... all open the same folder as C:\Users\me\.ssh, but none of them looks like it as text. So a path is
// first spelled one way (spell): a drive share of this PC becomes the drive path and is judged like one. Every other network or device path
// is judged by what it opens, the file identity (device and file number) of the folder and of each folder above it, compared with the
// identity of each guarded place. A path whose place cannot be read is not used: when the place cannot be told, it is not safe.
// Ordinary network use is not touched: a share on another computer opens a folder that is none of the guarded places, so it passes.
const lowerHost = h => h.toLowerCase().replace(/\.$/, '');
const canonIp = a => {
  try {
    return new URL(`http://[${a}]`).hostname;
  } catch {
    return a;
  }
};
const ADDRESS_MS = 5000;
let addressCache = { at: 0, set: new Set() };
function localAddresses() {
  const now = Date.now();
  if (now - addressCache.at < ADDRESS_MS) return addressCache.set;
  const set = new Set(['[::1]']);
  try {
    for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) set.add(canonIp(String(i.address).replace(/%.*$/, '')));
  } catch {
    // The list of this PC's addresses is a help; localhost, 127.x and the PC's name are still known.
  }
  addressCache = { at: now, set };
  return set;
}

// True when a network host name or address is this PC: localhost, a loopback or interface address (IPv4, IPv6, or the ipv6-literal.net
// spelling), or its name. A name or address that is this PC under another name is not known here; the identity check catches it.
function isLocalHost(name) {
  let host = lowerHost(name);
  const literal = /^(.+)\.ipv6-literal\.net$/.exec(host);
  if (literal) host = literal[1].replace(/s\d+$/, '').replace(/-/g, ':');
  const mine = lowerHost(os.hostname());
  if (host === 'localhost' || host === mine || host.startsWith(`${mine}.`)) return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true;
  return localAddresses().has(canonIp(host));
}

// How a path is written for the checks on Windows: { path, net }. path is the text to compare (a drive path when the path was a drive
// spelling: \\localhost\C$\x, \\?\C:\x or \\?\UNC\127.0.0.1\C$\x become C:\x); net is the text of a network or device path that is not a
// drive of this PC (and so is judged by identity), or null. Other platforms and ordinary drive paths come back as they were.
function spell(p, platform) {
  if (platform !== 'win32' || typeof p !== 'string') return { path: p, net: null };
  const t = p.replace(/\//g, '\\');
  if (!t.startsWith('\\\\')) return { path: p, net: null };
  const drive = /^\\\\[?.]\\([a-z]:)(\\.*)?$/i.exec(t);
  if (drive) return { path: drive[1] + (drive[2] ?? '\\'), net: null };
  const unc = /^\\\\[?.]\\UNC(?:\\(.*))?$/i.exec(t);
  if (!unc && /^\\\\[?.](?:\\|$)/.test(t)) return { path: t, net: t };
  const body = unc ? `\\\\${unc[1] ?? ''}` : t;
  const m = /^\\\\([^\\]+)(?:\\([^\\]+))?(\\.*)?$/.exec(body);
  if (m && m[2] && /^[a-z]\$$/i.test(m[2]) && isLocalHost(m[1])) return { path: `${m[2][0]}:${m[3] || '\\'}`, net: null };
  return { path: body, net: body };
}

// The same folding for a caller outside this file (lib/tools.mjs reads the words of a shell command): the drive path of a network spelling
// of this PC's drive, or the text as it was.
export const foldLocalNetwork = (p, platform = process.platform) => {
  const s = spell(p, platform);
  return s.net === null ? s.path : p;
};

// The file identity of a path (device and file number, which a link or a network name cannot change), or null when it cannot be read.
// An identity that was read is kept for a few seconds, because the file index asks for every file it walks.
const ID_MS = 5000;
const idCache = new Map();
// A path on another computer is looked up in a helper thread that the caller waits for no longer than STAT_WAIT_MS. The lookup itself blocks
// until the network gives up (21 seconds for a computer that is not there), and the server's one thread would stand still for all of it, with
// the page, the streams and Stop. A computer that did not answer is remembered for DEAD_MS, so a path on it costs one wait and not one for
// every file. A missing file on a computer that answers is quick and marks nothing.
const STAT_WAIT_MS = 4000;
const DEAD_MS = 30_000;
const deadHosts = new Map();
const STAT_WORKER = String.raw`
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
parentPort.on('message', ({ p, flag, out }) => {
  let state = 2;
  try {
    const st = fs.statSync(p, { bigint: true });
    if (st.ino !== 0n) {
      out[0] = BigInt.asUintN(64, st.dev);
      out[1] = BigInt.asUintN(64, st.ino);
      state = 1;
    }
  } catch {
    state = 2;
  }
  Atomics.store(flag, 0, state);
  Atomics.notify(flag, 0);
});
`;
let statWorker = null;
// The identity text of a path asked of the helper thread: a string, null (no such file, or no identity), 'timeout', or undefined when the
// helper cannot be used (the caller then asks for itself).
function statAway(p) {
  try {
    if (!statWorker) {
      statWorker = new Worker(STAT_WORKER, { eval: true });
      statWorker.unref();
      statWorker.on('error', () => { statWorker = null; });
    }
    const flag = new Int32Array(new SharedArrayBuffer(4));
    const out = new BigUint64Array(new SharedArrayBuffer(16));
    statWorker.postMessage({ p, flag, out });
    if (Atomics.wait(flag, 0, 0, STAT_WAIT_MS) === 'timed-out') {
      // The helper is still inside the lookup: it is let go and the next lookup gets a new one.
      const stuck = statWorker;
      statWorker = null;
      stuck.terminate().catch(() => {});
      return 'timeout';
    }
    return flag[0] === 1 ? `${out[0]}:${out[1]}` : null;
  } catch {
    statWorker = null;
    return undefined;
  }
}
function hostOf(p) {
  const m = /^\\\\([^\\]+)\\/.exec(p);
  return m && m[1] !== '?' && m[1] !== '.' ? m[1].toLowerCase() : null;
}
function hostIsDead(host) {
  const at = deadHosts.get(host);
  if (at === undefined) return false;
  if (Date.now() - at < DEAD_MS) return true;
  deadHosts.delete(host);
  return false;
}
function idOf(p) {
  const hit = idCache.get(p);
  const now = Date.now();
  if (hit && now - hit.at < ID_MS) return hit.id;
  const host = hostOf(p);
  if (host && hostIsDead(host)) return null;
  let id = null;
  const away = host ? statAway(p) : undefined;
  if (away === 'timeout') {
    if (deadHosts.size > 64) deadHosts.clear();
    deadHosts.set(host, Date.now());
    return null;
  }
  if (away !== undefined) id = away;
  else {
    try {
      const st = fs.statSync(p, { bigint: true });
      if (st.ino !== 0n) id = `${st.dev}:${st.ino}`;
    } catch {
      id = null;
    }
  }
  if (id !== null) {
    if (idCache.size > 4000) idCache.clear();
    idCache.set(p, { at: now, id });
  }
  return id;
}

// The identities of a path and of each folder above it, up to the share or drive root. exact: the path itself exists (a file that is not
// there yet is judged by the folders above it). null when not even the root can be read.
function chainIds(text) {
  const W = pathFor('win32');
  const ids = [];
  let exact = false;
  let cur = text;
  for (;;) {
    const id = idOf(cur);
    if (id !== null) {
      if (cur === text) exact = true;
      ids.push(id);
    }
    const parent = W.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return ids.length ? { ids, exact } : null;
}

// The identities of the places the guard keeps from, kept for a few seconds like placesCache. self: each place that exists; up: each of
// them and every folder above it (a folder with the identity of one of these holds the place).
const guardedCache = new Map();
function guardedIds(platform, home, appRoot) {
  const key = [platform, home, appRoot, process.env.APPDATA, process.env.LOCALAPPDATA, process.env.MUSE_CONSOLE_HOME].join('\u0000');
  const hit = guardedCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < PLACES_MS) return hit.value;
  const make = list => {
    const self = new Set();
    const up = new Set();
    for (const place of list) {
      const c = chainIds(place);
      if (!c || !c.exact) continue;
      self.add(c.ids[0]);
      for (const id of c.ids) up.add(id);
    }
    return { self, up };
  };
  const value = {
    credential: make(credentialPlaces(home, platform)),
    plenum: make(placesOf(appRoot, platform)),
    system: make(systemDirs(platform)),
    home: make(placesOf(home, platform)),
  };
  if (guardedCache.size > 16) guardedCache.clear();
  guardedCache.set(key, { at: now, value });
  return value;
}

// Why a network or device path may not be used (a plain message), or null. It is refused when the folder it opens, or a folder above it, is one
// of the guarded places (credentials for any use; the Windows folders and Plenum's own folder for a write), and when its place cannot be read.
// Only the platform that is running has a disk to ask.
function networkRefusal(net, { platform, home, appRoot, write }) {
  if (platform !== process.platform) return null;
  const chain = chainIds(net);
  if (!chain) return NETWORK_MESSAGE;
  const g = guardedIds(platform, home, appRoot);
  const inside = set => chain.ids.some(id => set.has(id));
  if (inside(g.credential.self)) return CREDENTIAL_MESSAGE;
  if (write && inside(g.system.self)) return systemMessage(platform);
  if (write && inside(g.plenum.self)) return PLENUM_MESSAGE;
  return null;
}

// The same for folderRisk, in the order of riskAt: the folder may not be the user folder or hold it, be or hold a credential place, be or
// hold Plenum's folder, or be inside a system folder.
function networkRisk(net, { platform, home, appRoot }) {
  if (platform !== process.platform) return null;
  const chain = chainIds(net);
  if (!chain) return NETWORK_MESSAGE;
  const g = guardedIds(platform, home, appRoot);
  const inside = set => chain.ids.some(id => set.has(id));
  const holds = set => chain.exact && set.has(chain.ids[0]);
  if (holds(g.home.up)) return HOME_MESSAGE;
  if (inside(g.credential.self)) return CREDENTIAL_MESSAGE;
  if (holds(g.credential.up)) return HOLDS_CREDENTIAL_MESSAGE;
  if (inside(g.plenum.self)) return PLENUM_MESSAGE;
  if (holds(g.plenum.up)) return HOLDS_PLENUM_MESSAGE;
  if (inside(g.system.self)) return systemMessage(platform);
  return null;
}

// ---------- folderRisk: may a folder be granted to an agent as an extra writable folder? ----------

const MAX_LINKS = 32;
const ROOT_MESSAGE = 'A whole drive or filesystem root cannot be an extra folder. Name a folder inside it.';
const HOME_MESSAGE = 'That folder is your user folder or contains it, so it could reach your sign-in files there. Name a narrower folder.';
const HOLDS_CREDENTIAL_MESSAGE = 'That folder contains a credential folder, so it is off limits. Name a narrower folder.';
const HOLDS_PLENUM_MESSAGE = 'That folder contains the Plenum source folder, so it is off limits. Name a narrower folder.';
const COPY_MESSAGE = 'That folder is a thread\'s isolated copy. Open its thread instead.';

// Returns null when a folder is safe to grant to an agent as an extra writable folder, or a short plain message
// saying why not. Refused: a drive or filesystem root; the user's folder or any folder above it; a credential folder,
// anything inside one, or a folder that holds one; Plenum's own folder, anything inside it, or a folder that holds it;
// the system folders (Windows, or the macOS and Linux ones); and the folder of the threads' isolated copies with everything in it
// (pro-02: a copy cannot be added as a project or handed to an agent as an extra folder). copiesOk: true leaves that last rule out,
// for the one caller that checks the copies folder itself (lib/worktree.mjs, before it makes the folder). Links and junctions
// are followed, and the path as written is checked as well.
export function folderRisk(absPath, { platform = process.platform, home = HOME, appRoot = APP_ROOT, copiesOk = false } = {}) {
  const P = pathFor(platform);
  const s = typeof absPath === 'string' ? spell(absPath, platform) : { path: '', net: null };
  const text = s.path;
  if (!text || !P.isAbsolute(text)) return 'The folder must be a full path.';
  if (s.net !== null) return networkRisk(s.net, { platform, home, appRoot });
  const written = lower(P.resolve(text));
  const real = lower(resolvedPlace(text, platform));
  const ctx = { P, platform, home, appRoot, copiesOk };
  for (const p of new Set([written, real])) {
    const message = riskAt(p, ctx);
    if (message) return message;
  }
  return null;
}

// The reason a resolved, lower-cased folder is refused, or null. Each reference place is compared as written and as
// it really is, so a link to a credential folder is caught as well as the folder itself.
function riskAt(p, { P, platform, home, appRoot, copiesOk }) {
  if (trimSep(p) === trimSep(lower(P.parse(p).root))) return ROOT_MESSAGE;
  if (placesOf(home, platform).some(h => isWithin(h, p, P.sep))) return HOME_MESSAGE;
  const secrets = secretPaths(home, platform).flatMap(s => placesOf(s, platform));
  if (secrets.some(s => isWithin(p, s, P.sep))) return CREDENTIAL_MESSAGE;
  if (secrets.some(s => isWithin(s, p, P.sep))) return HOLDS_CREDENTIAL_MESSAGE;
  const plenum = placesOf(appRoot, platform);
  if (plenum.some(a => isWithin(p, a, P.sep))) return PLENUM_MESSAGE;
  if (plenum.some(a => isWithin(a, p, P.sep))) return HOLDS_PLENUM_MESSAGE;
  if (systemDirs(platform).map(lower).some(s => (trimSep(s) ? isWithin(p, s, P.sep) : p === s))) return systemMessage(platform);
  if (!copiesOk) {
    const copies = placesOf(worktreeRoot({ platform, home, env: platform === process.platform ? process.env : {} }), platform);
    if (copies.some(c => isWithin(p, c, P.sep))) return COPY_MESSAGE;
  }
  return null;
}

// True when p is inside the system folder dir or is it. The filesystem root is in the POSIX list, and everything is
// inside it, so it counts only as itself.
function underSystem(dir, p, sep) {
  return trimSep(dir) ? under(dir, p, sep) : p === dir;
}

// True when p is the folder dir or lies inside it. Both are lower-cased and resolved.
function isWithin(p, dir, sep) {
  return p === dir || p.startsWith(trimSep(dir) + sep);
}

// A root keeps its trailing separator in a path; this drops it, so 'c:\' and 'c:' compare the same way.
function trimSep(s) {
  return s.replace(/[\\/]+$/, '');
}

// The two forms of a place that the checks compare: as written, and as it really is (links followed).
function placesOf(p, platform) {
  return [...new Set([lower(pathFor(platform).resolve(spell(p, platform).path)), lower(resolvedPlace(p, platform))])];
}

// The place a path really is. Symlinks and junctions are followed as far as the path exists, and the part that does
// not exist yet is kept as written after the part that does. A link to a missing place is followed to where it points.
// Falls back to the path as written when nothing can be resolved. Only the platform that is running has a disk to ask.
function resolvedPlace(p, platform, depth = 0) {
  const P = pathFor(platform);
  const full = P.resolve(spell(p, platform).path);
  if (platform !== process.platform) return full;
  let dir = full;
  const tail = [];
  for (;;) {
    try {
      return P.join(fs.realpathSync.native(dir), ...tail);
    } catch {
      const target = linkTarget(dir);
      if (target !== null && depth < MAX_LINKS) {
        return resolvedPlace(P.resolve(P.dirname(dir), target, ...tail), platform, depth + 1);
      }
      const parent = P.dirname(dir);
      if (parent === dir) return full;
      tail.unshift(P.basename(dir));
      dir = parent;
    }
  }
}

// Where a link points, or null when the path is not a link (or cannot be read).
function linkTarget(p) {
  try {
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
}
