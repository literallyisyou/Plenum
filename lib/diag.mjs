import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildInfo } from './build-info.mjs';
import { token } from './auth.mjs';
import { redactSecrets, refreshKeySecrets } from './accounts.mjs';
import { childEnv, findExecutable, killTree, resolveLaunch, stripAnsi, systemProgram } from './proc.mjs';

// The diagnostics report (routes in lib/routes/diag.mjs, page in public/ext-help.js).
//
// A report is what a person pastes to a stranger to say what is wrong, so everything about it is decided by what it may NOT hold. It is
// built from a short list of facts picked one by one, never from a state, a settings object or a log read whole:
//   - versions (this build's line, Node, Electron, Chrome, the operating system and its architecture), the CLIs found with the version
//     each prints for --version (the digits only), and for each tool and each saved key only yes or no;
//   - sizes and counts (how many projects, chats and messages, how big the state file and its copies are, how long the server has run);
//   - the data folder and the app folder as paths with the user's name taken out, a project only as its last folder's name;
//   - the last error lines of the log, each cut short, with keys, tokens, e-mail addresses and paths taken out.
// It never holds a key, the launch token, the text of a chat, a prompt, the content of a file, a project's path beyond its last folder name,
// the user's name, an e-mail address, a phone's name or pairing data, or a hub key. Nothing is sent anywhere: the route answers the page
// that asked, and the page shows the text, copies it or saves it when the person presses a button.
//
// ONE redaction (makeRedactor) cleans every piece of text that reaches the report. It adds to lib/accounts.mjs redactSecrets (keys by
// value and by shape, the launch token, text after bearer / token / password, the query of a web address) with what a report needs:
//   1. a project's folder becomes `<project: name>` (its last folder's name only), the data folder `<data folder>`, the app folder `<app>`;
//   2. the home folder and the user's name in a path become `~`;
//   3. any other path is cut to its last name: `C:\Clients\Acme\notes.txt` is `...\notes.txt` and `~\Documents\Acme\x` is `~\...\x`.
//      Only the data folder, the app folder, Windows' own folders and AppData keep their path;
//   4. an e-mail address becomes `[email]`;
//   5. a long quoted run (40 characters or more) in a log line becomes `"[text left out]"`, because a program that fails often quotes what
//      it was given (a prompt, a message) and a line of error text must not carry that.
// Where this differs from desktop/error-box.cjs (the shell's "Copy details" for an error box): the shell redacts with desktop/log.cjs
// makeRedactor, which hides the user's name, the home folder, the exact values it was given (the launch token), the key shapes of
// the providers and bearer values, and nothing else. It does not know the projects, so a project's full path stays, and it does not cut
// other paths, e-mail addresses or long quoted text. The shell has no state to read, so it cannot know a project's folder, and its box
// holds the box's own words and the log's last lines, which the person has already seen on the screen. The report is made to be
// pasted to a stranger and goes through the stricter rules above. Both copy only by the person's own press.
//
// Known limit, said on the page: a line of error text can quote anything a program printed. The rules above take out what has a shape
// (keys, tokens, paths, addresses, long quotes); a short word of a person's own inside an error line cannot be known. The page shows the
// whole report before anything is copied, so the person reads it first.

export const MAX_ERROR_LINES = 50;
const LINE_MAX = 300;
const RING_MAX = 200;
const VERSION_TTL_MS = 60_000;
const PROBE_MS = 4000;

// ---------- the one redaction ----------

const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const slashless = p => String(p).replace(/[\\/]+$/, '');
// A pattern for a path in either spelling of the separator, so a path written with / matches one written with \.
const pathRe = p => new RegExp(escapeRe(slashless(p)).replace(/\\\\|\//g, '[\\\\/]'), 'gi');
const lastName = p => String(p).split(/[\\/]+/).filter(Boolean).pop() ?? '';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const LONG_QUOTE = /(["'`])(?:(?!\1)[^\r\n]){40,}\1/g;
// An absolute Windows path: the drive, folders (a folder name may hold spaces) and a last name without spaces.
const WIN_PATH = /[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])*[^\\/:*?"<>|\s'`,;()]*/g;
// A path that starts with ~ (after the home folder was replaced), the same way.
const HOME_PATH = /~[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])*[^\\/:*?"<>|\s'`,;()]*/g;
const POSIX_HOME = /(^|[\s"'(=])(?:\/Users\/|\/home\/)[^/\s"']+/g;
// A path that may stay whole: Windows' own folders and the places a program keeps its own data.
const KEEP_ABSOLUTE = /^[A-Za-z]:[\\/](?:Windows|Program Files|Program Files \(x86\)|ProgramData)(?:[\\/]|$)/i;
const KEEP_HOME = /^~[\\/](?:AppData|\.muse-console|\.claude|\.codex|\.gemini|\.cursor)(?:[\\/]|$)/i;

// Options: user, home (the user's name and home folder), dataHome (Plenum's data folder), appRoot (the install folder), projects (the
// project folders' paths), secrets (a function that gives exact values to hide), scrubbers (functions text => text that know more secrets,
// such as the hub's scrub for the agent keys it holds). Returns text => clean text. It never throws.
export function makeRedactor({ user = '', home = '', dataHome = '', appRoot = '', projects = [], secrets = () => [], scrubbers = [] } = {}) {
  const userRe = user && user.length >= 2 ? new RegExp(`([\\\\/]Users[\\\\/])${escapeRe(user)}(?![A-Za-z0-9_.-])`, 'gi') : null;
  // The name on its own (an error says "for <name>"): the whole word, in any case.
  const nameRe = user && user.length >= 3 ? new RegExp(`(?<![A-Za-z0-9])${escapeRe(user)}(?![A-Za-z0-9])`, 'gi') : null;
  const homeRe = home && home.length > 3 ? pathRe(home) : null;
  // Longest first, so a folder inside another folder is named by its own path.
  const named = [];
  for (const p of projects) if (typeof p === 'string' && p.length > 3) named.push({ re: pathRe(p), to: `<project: ${lastName(p)}>` });
  if (dataHome && dataHome.length > 3) named.push({ re: pathRe(dataHome), to: '<data folder>' });
  if (appRoot && appRoot.length > 3) named.push({ re: pathRe(appRoot), to: '<app>' });
  named.sort((a, b) => b.re.source.length - a.re.source.length);

  const cut = (match, keep) => (keep.test(match) ? match : `${/^~/.test(match) ? '~\\...' : '...'}\\${lastName(match)}`);
  return text => {
    try {
      let out = String(text ?? '');
      // The exact secrets first, whatever they sit inside.
      let list = [];
      try {
        list = secrets() ?? [];
      } catch {
        list = [];
      }
      for (const secret of list) if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join('[hidden]');
      for (const scrub of scrubbers) if (typeof scrub === 'function') out = String(scrub(out));
      out = redactSecrets(out, []);
      for (const { re, to } of named) out = out.replace(re, to);
      if (homeRe) out = out.replace(homeRe, '~');
      if (userRe) out = out.replace(userRe, '$1~');
      out = out.replace(POSIX_HOME, '$1~');
      if (nameRe) out = out.replace(nameRe, '~');
      out = out.replace(EMAIL, '[email]');
      out = out.replace(LONG_QUOTE, '$1[text left out]$1');
      out = out.replace(HOME_PATH, m => cut(m, KEEP_HOME));
      out = out.replace(WIN_PATH, m => cut(m, KEEP_ABSOLUTE));
      return out;
    } catch {
      return '[text that could not be shown]';
    }
  };
}

// One line of the log as the report shows it: cut short, then cleaned.
export const cleanLine = (line, redact) => redact(String(line ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').slice(0, LINE_MAX)).trimEnd();

// ---------- the last error lines ----------

// A line of a log that says something went wrong, or the stack line under one. The log holds other things too (a start, a stop).
const ERRORISH = /\b(error|errors|failed|failure|fails|could not|cannot|can't|unable|unexpected|fault|exception|rejected|refused|denied|timed out|gave up|crashed|exited|exit code|EPERM|EACCES|ENOENT|EBUSY|ECONN\w*|ETIMEDOUT)\b/i;
const STACK = /^\s+at\s/;

// The last `n` lines of a log's text lines that tell of an error (and the stack lines that belong to them), in order, cleaned.
export function errorLines(lines, redact, n = MAX_ERROR_LINES) {
  const kept = [];
  let inError = false;
  for (const raw of Array.isArray(lines) ? lines : []) {
    const line = String(raw ?? '');
    if (!line.trim()) continue;
    if (ERRORISH.test(line)) {
      inError = true;
      kept.push(line);
    } else if (inError && STACK.test(line)) {
      kept.push(line);
    } else {
      inError = false;
    }
  }
  return kept.slice(-n).map(line => cleanLine(line, redact)).filter(Boolean);
}

// What this process wrote with console.error since it started (the server's own faults, the page's reports), for a run without the desktop
// app, where there is no log file to read. Memory only, RING_MAX lines. The text is cleaned again when a report is made.
const ring = [];
let tapped = false;
export function noteError(text) {
  for (const piece of String(text ?? '').split(/\r?\n/)) {
    if (!piece.trim()) continue;
    ring.push(piece.slice(0, 600));
    if (ring.length > RING_MAX) ring.shift();
  }
}
// Wraps console.error once, so the text still goes where it went and is also kept in the ring. Never throws, never changes what is printed.
export function tapConsole(target = console) {
  if (tapped || !target || typeof target.error !== 'function') return false;
  tapped = true;
  const original = target.error.bind(target);
  target.error = (...args) => {
    try {
      noteError(args.map(a => (typeof a === 'string' ? a : a instanceof Error ? a.stack ?? a.message : String(a))).join(' '));
    } catch {
      // Keeping a copy must never stop the print.
    }
    return original(...args);
  };
  return true;
}
export const ringLines = () => [...ring];
export const clearRing = () => { ring.length = 0; };

// ---------- what the page reports (POST /api/diag/client-error) ----------

const CLIENT_LIMIT = 20;
const CLIENT_WINDOW_MS = 60_000;
const CLIENT_SAME_MS = 10_000;
const clientTimes = [];
const clientSeen = new Map();

// The one line the log gets for an error the page reported, or null when it is not a usable report or too many came (20 a minute, the same
// text once in 10 seconds). Only a short message and the name of the script file and its line are taken: never a stack, a URL's query or any
// other field the page sent.
export function clientErrorLine(body, redact, now = Date.now()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const message = typeof body.message === 'string' ? body.message.replace(/\s+/g, ' ').trim().slice(0, 240) : '';
  if (!message) return null;
  let file = typeof body.source === 'string' ? body.source.split(/[?#]/)[0].split('/').pop().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 60) : '';
  const lineNo = Number.isInteger(body.line) && body.line > 0 && body.line < 10_000_000 ? body.line : null;
  const kind = body.kind === 'rejection' ? 'a promise that failed' : 'an error';
  const where = file ? ` (${file}${lineNo ? `:${lineNo}` : ''})` : '';
  const text = cleanLine(`The page reported ${kind}: ${message}${where}`, redact);
  while (clientTimes.length && now - clientTimes[0] > CLIENT_WINDOW_MS) clientTimes.shift();
  if (clientTimes.length >= CLIENT_LIMIT) return null;
  const last = clientSeen.get(text);
  if (last !== undefined && now - last < CLIENT_SAME_MS) return null;
  if (clientSeen.size > 100) clientSeen.clear();
  clientSeen.set(text, now);
  clientTimes.push(now);
  return text;
}
export function forgetClientErrors() {
  clientTimes.length = 0;
  clientSeen.clear();
}

// ---------- the tools and their versions ----------

// The tools Plenum drives, as [name on the PATH, what a person calls it].
export const TOOLS = [
  ['claude', 'Claude Code'],
  ['codex', 'Codex'],
  ['gemini', 'Gemini CLI'],
  ['muse', 'Muse Code'],
  ['cursor-agent', 'Cursor'],
  ['grok', 'Grok Build'],
  ['agy', 'Antigravity'],
];

// The digits of a version that a tool prints for --version ("claude 2.1.4 (build)" gives "2.1.4"), or null. Nothing else the tool printed is kept.
export function versionOf(output) {
  const m = /(?:^|[^\w.])v?(\d{1,4}(?:\.\d{1,5}){1,3}(?:-[0-9A-Za-z.]{1,20})?)/.exec(stripAnsi(String(output ?? '')));
  return m ? m[1] : null;
}

// Asks one tool for its version: it is looked for first, and a tool that is found is started once with --version (no prompt, no network by
// Plenum's own hand), hidden and ended after PROBE_MS. Resolves { found, version, timedOut }; never rejects.
export async function probeTool(name, { find = findExecutable, launchOf = resolveLaunch, start = spawn, limitMs = PROBE_MS } = {}) {
  try {
    if (!(await find(name))) return { found: false, version: null, timedOut: false };
    const launch = await launchOf(name, ['--version']);
    if (!launch) return { found: false, version: null, timedOut: false };
    return await new Promise(resolve => {
      let out = '';
      let done = false;
      let timer = null;
      let child = null;
      const finish = result => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result);
      };
      try {
        child = start(process.platform === 'win32' ? systemProgram(launch.file) : launch.file, launch.argv, { env: childEnv(name), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: launch.verbatim });
      } catch {
        finish({ found: true, version: null, timedOut: false });
        return;
      }
      timer = setTimeout(() => {
        try {
          killTree(child);
        } catch {
          // Already gone.
        }
        finish({ found: true, version: null, timedOut: true });
      }, limitMs);
      child.stdout?.on('data', d => { if (out.length < 4000) out += d; });
      child.stderr?.on('data', () => {});
      child.on('error', () => finish({ found: true, version: null, timedOut: false }));
      child.on('close', () => finish({ found: true, version: versionOf(out), timedOut: false }));
    });
  } catch {
    return { found: false, version: null, timedOut: false };
  }
}

// The answers are kept for a minute and a read that is running is shared, so pressing Copy again does not start every tool again.
const kept = new Map(); // name -> { at, result }
const reading = new Map(); // name -> promise
export function forgetTools() {
  kept.clear();
  reading.clear();
}

// { name, label, found, version, timedOut, pending } for each tool. All the tools are asked at once; the answer waits for them at most waitMs
// (the route's whole answer has to come in under a second), and a tool that has not answered is pending: its read goes on and the next
// report has it. probe replaces the real one in the tests.
export async function toolVersions({ waitMs = 600, probe = probeTool, tools = TOOLS, now = Date.now } = {}) {
  const starts = tools.map(([name]) => {
    const hit = kept.get(name);
    if (hit && now() - hit.at < VERSION_TTL_MS) return Promise.resolve(hit.result);
    if (!reading.has(name)) {
      const p = Promise.resolve()
        .then(() => probe(name))
        .catch(() => ({ found: false, version: null, timedOut: false }))
        .then(result => {
          kept.set(name, { at: now(), result });
          return result;
        })
        .finally(() => reading.delete(name));
      reading.set(name, p);
    }
    return reading.get(name);
  });
  let timer;
  const clock = new Promise(resolve => { timer = setTimeout(resolve, waitMs, 'late'); });
  const settled = starts.map(p => p.then(r => ({ r })));
  const first = await Promise.race([Promise.all(settled), clock]);
  clearTimeout(timer);
  const answers = first === 'late' ? await Promise.all(settled.map(p => Promise.race([p, Promise.resolve(null)]))) : first;
  return tools.map(([name, label], i) => {
    const r = answers[i]?.r ?? null;
    return r ? { name, label, found: r.found === true, version: r.version ?? null, timedOut: r.timedOut === true, pending: false } : { name, label, found: null, version: null, timedOut: false, pending: true };
  });
}

// ---------- the facts ----------

const yesNo = v => (v === true ? 'yes' : v === false ? 'no' : 'not known');
const withTimeout = (promise, ms, fallback) => {
  let timer;
  return Promise.race([Promise.resolve(promise).catch(() => fallback), new Promise(resolve => { timer = setTimeout(resolve, ms, fallback); })]).finally(() => clearTimeout(timer));
};
const mb = bytes => (bytes < 1024 * 1024 ? `${Math.max(0, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const num = v => (Number.isFinite(v) && v >= 0 ? v : 0);

// Counts of the state: projects, chats (threads with a transcript) and messages. Only the sizes of arrays are read, never a message.
export function stateCounts(st) {
  const projects = Array.isArray(st?.projects) ? st.projects.length : 0;
  let chats = 0;
  let messages = 0;
  const all = st?.chats && typeof st.chats === 'object' ? Object.values(st.chats) : [];
  for (const rows of all) {
    if (!Array.isArray(rows)) continue;
    chats += 1;
    messages += rows.length;
  }
  return { projects, chats, messages };
}

async function fileSize(file) {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return null;
  }
}

// The size of the state file and the number and size of its dated copies. Names are read and sized; a file is never opened.
async function storeSizes(store) {
  const home = String(store?.HOME ?? '');
  const out = { stateBytes: home ? await fileSize(path.join(home, 'state.json')) : null, copies: 0, copyBytes: 0 };
  try {
    const folder = typeof store?.backupsFolder === 'function' ? store.backupsFolder() : '';
    const names = folder ? (await fsp.readdir(folder)).filter(n => /^state-.*\.json$/.test(n)).slice(-200) : [];
    out.copies = names.length;
    for (const name of names) out.copyBytes += (await fileSize(path.join(folder, name))) ?? 0;
  } catch {
    // No folder yet.
  }
  return out;
}

function storeWords(health) {
  if (!health) return 'read normally';
  if (health.recovered === 'backup') return 'the saved file could not be read, so the last good copy was loaded';
  if (health.recovered === 'defaults') return 'the saved file and its copy could not be read, so Plenum started empty (the damaged file was kept)';
  if (health.unread) return 'the saved file could not be read this time, so Plenum started from a copy';
  return 'recovered at start';
}

// The system facts, from this process alone.
export function systemFacts({ platform = process, osModule = os, now = Date.now } = {}) {
  const v = platform.versions ?? {};
  return {
    os: `${({ Windows_NT: 'Windows', Darwin: 'macOS' })[osModule.type()] ?? osModule.type()} ${osModule.release()}`,
    arch: osModule.arch(),
    node: v.node ?? process.version.replace(/^v/, ''),
    electron: v.electron ?? null,
    chrome: v.chrome ?? null,
    cpus: osModule.cpus?.().length ?? 0,
    memoryGb: Math.round((osModule.totalmem?.() ?? 0) / 1024 / 1024 / 1024),
    serverMinutes: Math.round(num(platform.uptime?.()) / 60),
    rssMb: Math.round(num(platform.memoryUsage?.().rss) / 1024 / 1024),
    now: new Date(now()).toISOString(),
  };
}

// Builds one report. deps: { store, redact, tools (the answers of toolVersions), providers (the last provider snapshot or null), savedKeys
// (the labels of the providers that have a key saved), terms (true / false), log ({ lines, source } or null), sizes, build, system, folders }.
// Everything here is a plain fact already; the text goes through redact once more on its way out, as a belt over the braces.
export function reportText(f, redact) {
  const L = [];
  const add = (...lines) => L.push(...lines);
  add('Plenum diagnostics', `Made: ${f.system.now}`, '');
  add('Build', `  ${f.build.line}`);
  if (f.build.builtAt) add(`  Built: ${f.build.builtAt}`);
  add('', 'System', `  ${f.system.os} (${f.system.arch}), ${f.system.cpus} cores, ${f.system.memoryGb} GB memory`, `  Node ${f.system.node}${f.system.electron ? `, Electron ${f.system.electron}` : ''}${f.system.chrome ? `, Chrome ${f.system.chrome}` : ''}`);
  add(`  The server has run for ${f.system.serverMinutes} minutes and holds ${f.system.rssMb} MB`);
  add('', 'Plenum', `  License Agreement accepted: ${yesNo(f.terms)}`, `  Data folder: ${f.folders.data}`, `  App folder: ${f.folders.app}`);
  const c = f.counts;
  add(`  ${c.projects} project${c.projects === 1 ? '' : 's'}, ${c.chats} chat${c.chats === 1 ? '' : 's'}, ${c.messages} message${c.messages === 1 ? '' : 's'}`);
  add(`  State file: ${f.sizes.stateBytes === null ? 'not found' : mb(f.sizes.stateBytes)}; ${f.sizes.copies} saved cop${f.sizes.copies === 1 ? 'y' : 'ies'}, ${mb(f.sizes.copyBytes)}`);
  add(`  At start: ${storeWords(f.health)}`, `  The last save failed: ${yesNo(f.saveFailed)}`);
  add('', 'Tools found on this computer');
  if (!f.tools) add('  Not read (the report was made without looking for them).');
  else {
    for (const t of f.tools) {
      const state = t.pending ? 'still being read, press Refresh in a moment' : !t.found ? 'not found' : t.version ? `found, version ${t.version}` : t.timedOut ? 'found, did not answer for --version in time' : 'found, version not readable';
      add(`  ${t.label}: ${state}`);
    }
  }
  add('', 'Signed in (as far as Plenum last read it)');
  const p = f.providers;
  if (!p) add('  Not read yet.');
  else {
    add(`  Claude: ${yesNo(p.anthropic?.credentials)}`, `  Codex: ${p.codex ? (p.codex.installed ? 'found; sign-in is checked in Accounts' : 'not installed') : 'not known'}`);
    add(`  Gemini CLI: ${yesNo(p.gemini?.signedIn)}`, `  Cursor: ${yesNo(p.cursor?.signedIn)}`, `  Grok Build: ${yesNo(p.grok?.signedIn)}`, `  Antigravity: ${yesNo(p.antigravity?.signedIn)}`);
  }
  add(`  API keys saved: ${f.savedKeys.length ? f.savedKeys.join(', ') : 'none'}`);
  add('', `Last error lines (up to ${MAX_ERROR_LINES}; ${f.log?.source === 'log' ? "from Plenum's log file" : f.log ? 'from this run of the server' : 'no log could be read'})`);
  if (!f.log || f.log.lines.length === 0) add('  None.');
  else for (const line of f.log.lines) add(`  ${line}`);
  add('', 'Nothing in this report is sent anywhere. It holds no key, token, chat, prompt or file. A line of error text can still quote something a program printed: read it before you share it.');
  return redact(L.join('\n'));
}

// Gathers the facts and makes the report. Resolves { text, at, pending, logSource } (the route adds canOpenLog). It never rejects: a part that cannot be read
// is said so in its place. deps.* replace the real readers in the tests.
export async function makeReport({ store, withTools = true, readLog = async () => null, providers = () => null, keyLabels = async () => [], terms = () => null, toolsFn = toolVersions, home = os.homedir(), user = safeUser(), appRoot = '', scrubbers = [], waitMs = 600, now = Date.now } = {}) {
  let st = null;
  try {
    st = store?.get?.() ?? null;
  } catch {
    st = null;
  }
  const dataHome = String(store?.HOME ?? '');
  const projects = Array.isArray(st?.projects) ? st.projects.map(p => (typeof p?.path === 'string' ? p.path : '')).filter(Boolean) : [];
  const redact = makeRedactor({ user, home, dataHome, appRoot, projects, secrets: () => [token()], scrubbers });
  // The two folders are shown by their place under the home folder, so the same redaction without the names it gives them.
  const where = makeRedactor({ user, home, projects, secrets: () => [token()], scrubbers });
  const [tools, log, sizes, saved] = (await Promise.all([
    withTimeout(refreshKeySecrets(), 400, null),
    withTools ? withTimeout(Promise.resolve().then(() => toolsFn({ waitMs })), waitMs + 100, null) : null,
    withTimeout(Promise.resolve().then(readLog).catch(() => null), 650, null),
    withTimeout(Promise.resolve().then(() => storeSizes(store)), 500, { stateBytes: null, copies: 0, copyBytes: 0 }),
    withTimeout(Promise.resolve().then(keyLabels).catch(() => []), 500, []),
  ])).slice(1);
  const lines = log ? errorLines(log.lines, redact) : errorLines(ringLines(), redact);
  const facts = {
    build: buildInfo(),
    system: systemFacts({ now }),
    terms: terms(st),
    folders: { data: where(dataHome) || 'not known', app: where(appRoot) || 'not known' },
    counts: stateCounts(st),
    sizes,
    health: store?.health?.() ?? null,
    saveFailed: typeof store?.saveFailure === 'function' ? store.saveFailure() !== null : null,
    tools,
    providers: providers(),
    savedKeys: Array.isArray(saved) ? saved.map(String) : [],
    log: { lines, source: log ? 'log' : 'ring' },
  };
  const text = reportText(facts, redact);
  return { text, at: facts.system.now, pending: (tools ?? []).filter(t => t.pending).length, logSource: facts.log.source };
}

function safeUser() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME || process.env.USER || '';
  }
}
