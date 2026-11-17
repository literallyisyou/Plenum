import { execFile } from 'node:child_process';
import { existsSync, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findExecutable, resolveLaunch, childEnv, killTree, startChild, stripAnsi } from './proc.mjs';
import { openLoginTerminal } from './platform/terminal.mjs';
import { noteSignedIn, signInWindows } from './signin-windows.mjs';

// Sign-in and key handling for the Accounts panel. Keys are never written to the app's state file or logs.
// Muse Code and Codex sign-in happens in their own terminal windows, so their credentials stay with those tools.
// The functions that differ by platform take the platform as a parameter that defaults to process.platform.

// The five provider key names are the envVar values in api-providers.mjs, plus ANTHROPIC_API_KEY. These are the
// names the key store holds (desktop/keyvault.cjs lists the same names). Keys are never written to the Windows
// user environment or any other plain-text place from here.
const SAVABLE = new Set(['ANTHROPIC_API_KEY', 'XAI_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'GOOGLE_AI_API_KEY', 'OPENROUTER_API_KEY']);

// Reads one user-level environment variable from the registry (Windows only). Elsewhere it reads this process's environment.
export function readUserEnv(name, platform = process.platform) {
  if (platform !== 'win32') return Promise.resolve(process.env[name] ?? null);
  return new Promise(resolve => {
    execFile('reg', ['query', 'HKCU\\Environment', '/v', name], { windowsHide: true, timeout: 5000 }, (err, out) => {
      if (err) return resolve(null);
      const m = String(out).match(new RegExp(`^\\s+${name}\\s+REG_\\w+\\s+(.*)$`, 'm'));
      resolve(m ? m[1].trim() : null);
    });
  });
}

// Runs a CLI to completion and returns its output. Used for short status checks. A CLI that has not finished within timeoutMs is
// ended with its whole process tree, and the answer says so, so a stuck check never holds the Accounts page or the setup wizard.
// The answer comes when the CLI exits, when it fails to start, or when the time is up (it does not wait for the output to close).
export async function runCli(command, args, timeoutMs = 15_000) {
  const launch = await resolveLaunch(command, args);
  if (!launch) return { code: null, output: '', error: `${command} is not installed or not on PATH.` };
  return new Promise(resolve => {
    const child = startChild(command, launch, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timer = null;
    const finish = result => {
      clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      killTree(child);
      finish({ code: null, output: stripAnsi(out).trim(), error: `${command} did not answer within ${Math.round(timeoutMs / 1000)} seconds.` });
    }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => finish({ code: null, output: '', error: e.message }));
    child.on('close', code => finish({ code, output: stripAnsi(out).trim(), error: stripAnsi(err).trim().slice(-800) }));
  });
}

// Opens a new terminal window that runs `command args` and stays open for the sign-in flow. How the window is opened
// on each platform is in lib/platform/terminal.mjs. It starts in the home folder, not the app folder, so a window left
// open never locks the app's files. A platform that cannot open one throws, with the reason in plain words.
export async function openSignIn(command, args, title, platform = process.platform) {
  const exe = await findExecutable(command, platform);
  if (!exe) throw new Error(`${command} is not installed or not on PATH.`);
  // The same cleaned environment the tool runs with, so it signs in the way it will be used.
  const opened = await openLoginTerminal({ command: exe, args, label: title }, { platform, env: childEnv(command), cwd: os.homedir() });
  if (!opened.ok) throw new Error(opened.reason);
}

// ---------- "signed in" for the programs with no sign-in check of their own (wave 5 f1, 16 Nov 2026) ----------
// Muse Code, Gemini CLI and Grok Build have no command that says whether they are signed in, so nothing called noteSignedIn for them
// (lib/signin-windows.mjs), and a sign-in notice of lib/signin-check.mjs ("Gemini CLI is still signed out") stayed up until the next council.
// Two things now say it, each only when it is news, because every listener acts on it (the notices are cleared, and lib/routines.mjs wakes
// a routine that waits for that sign-in; a "signed in" on every check woke such a routine again and again, wave 4 r1):
//   noteAnswered(program)    a turn of the program answered on its sign-in (lib/gemini.mjs, lib/grok.mjs, the Muse Code turns of server.mjs
//                            and lib/agent-run.mjs). Told once, then again only after something said it was signed out (noteSignedOut: a
//                            turn that said "not signed in", sign-in files that are gone) or while a sign-in window of it is on the list.
//   noteSignInFiles(program, onDisk, stampOf)
//                            what the program's status read of its sign-in files found (Accounts, the provider status, a council's check).
//                            Told when the files are there and the read before found none, or when a sign-in that the person opened in
//                            Accounts wrote them anew (their stamp differs from the one taken when that window opened). Files that are
//                            simply there again on every read are not news: an expired sign-in leaves its files behind.
// The program ids are those of lib/signin-check.mjs: 'muse', 'gemini', 'grok'.
const answeredSince = new Set(); // programs told signed in after an answer, with nothing since that said signed out
const filesSeen = new Map(); // program -> whether its last status read found sign-in files (true / false)
export function noteAnswered(provider) {
  if (!provider || (answeredSince.has(provider) && !signInWindows.has(provider))) return false;
  answeredSince.add(provider);
  noteSignedIn(provider);
  return true;
}
export function noteSignedOut(provider) {
  if (provider) answeredSince.delete(provider);
}
export function noteSignInFiles(provider, onDisk, stampOf = null) {
  if (!provider || typeof onDisk !== 'boolean') return false;
  const was = filesSeen.get(provider);
  filesSeen.set(provider, onDisk);
  if (!onDisk) {
    answeredSince.delete(provider);
    return false;
  }
  if (was === false) {
    noteSignedIn(provider);
    return true;
  }
  // The person chose Sign in in Accounts (the window's stamp was taken when it opened): a stamp that changed since is that sign-in.
  const open = signInWindows.get(provider);
  if (open?.by !== 'person' || typeof open.stamp !== 'string' || typeof stampOf !== 'function') return false;
  Promise.resolve().then(stampOf).then(text => {
    if (typeof text === 'string' && text && text !== open.stamp && signInWindows.get(provider) === open) noteSignedIn(provider);
  }).catch(() => {});
  return false;
}
// A Muse Code turn ended (server.mjs runTurn, lib/agent-run.mjs runAgent: Muse Code runs in lib/providers.mjs, which has no word of its own
// for this). provider is the turn's provider; anything but 'muse' is left alone, and so is Muse Code on META_API_KEY (a key, not a sign-in).
const museOnSignIn = provider => provider === 'muse' && !process.env.META_API_KEY;
export function museAnswered(provider) {
  return museOnSignIn(provider) ? noteAnswered('muse') : false;
}
export function museSignedOut(provider) {
  if (museOnSignIn(provider)) noteSignedOut('muse');
}
// For tests: forgets what was told.
export function resetSignInNews() {
  answeredSince.clear();
  filesSeen.clear();
}

// Muse Code keeps its saved sign-in here (the path its own installer reports).
const museAuthFile = () => path.join(os.homedir(), '.config', 'muse', 'auth.json');
export function museSignedIn() {
  const there = existsSync(museAuthFile());
  noteSignInFiles('muse', there, museSignInStamp);
  return there;
}

// When the files of a sign-in were last written, as one text that changes when a new sign-in is written: each file that exists with
// its time and size, '' when none exists. No file is opened. It is how a council sees that a sign-in was finished for a program that
// has no sign-in check of its own (lib/signin-check.mjs, DECISIONS item 154): a file that is there says nothing about whether the
// sign-in in it still works, a file that was just written does.
export async function signInStamp(files) {
  const parts = await Promise.all(files.map(async file => {
    try {
      const st = await fsp.stat(file);
      return st.isFile() ? `${path.basename(file)}:${Math.round(st.mtimeMs)}:${st.size}` : '';
    } catch {
      return '';
    }
  }));
  return parts.filter(Boolean).join('|');
}
export const museSignInStamp = () => signInStamp([museAuthFile()]);

// ---------- sign-in checks that answer in time ----------

// What the Accounts page is told when a check gave no answer in time. The page tests the sign-in value for truth, so the sentence
// carries the reason.
export const COULD_NOT_CHECK = name => `Plenum could not check ${name} just now. Press Refresh.`;

// Reads what `codex login status` said (the answer of runCli). Returns { loggedIn, status } and, when the check gave no answer,
// reason: 'timed_out'. loggedIn is true, false, or null when it is not known:
//  - no exit code (the CLI did not answer in time, or could not be started): null. A check that failed says nothing about the account.
//  - "Not logged in": false. That text holds the words "logged in", so it is looked for first; Codex prints it and exits with 1.
//  - exit code 0 and "Logged in ...": true.
//  - exit code 0 and other words: null (a Codex whose answer Plenum does not know is not called signed in).
//  - any other exit code with no "Not logged in" words: null, with the CLI's own first line as the status (a config error, a crash or
//    a killed process says nothing about the account). Only the CLI's own "Not logged in" is false.
// Codex prints its status on stderr, so both streams are read. The status is the CLI's first line, which the page shows: anything in
// it that is shaped like a key is taken out (redactSecrets, below), whatever the CLI itself masks.
export function codexLoginState(result) {
  const text = `${result?.output ?? ''}\n${result?.error ?? ''}`;
  const line = redactSecrets((text.split('\n').map(l => l.trim()).find(Boolean) ?? '').slice(0, 300));
  if (!result || !Number.isInteger(result.code)) return { loggedIn: null, status: COULD_NOT_CHECK('Codex'), reason: 'timed_out' };
  if (/not logged in/i.test(text)) return { loggedIn: false, status: line };
  if (result.code === 0) return /logged in/i.test(text) ? { loggedIn: true, status: line } : { loggedIn: null, status: line || COULD_NOT_CHECK('Codex') };
  return { loggedIn: null, status: line || COULD_NOT_CHECK('Codex') };
}

// Makes a slow check answer in time. check() is the check itself (a CLI run, a few seconds at worst); the function returned reads it:
//  - one check runs at a time: a second reader joins the one that is going on;
//  - an answer is kept for keepFor(value) milliseconds, and { fresh: true } asks again whatever is kept;
//  - a reader waits waitMs at most. The check is not ended then: it goes on in the background and its answer is kept for the next
//    reader. The reader gets the last answer that settled(value) accepted, if it is younger than lastGoodMs, marked stale: true;
//    otherwise { value: null, pending: true }.
//  - a check that throws gave no answer (a CLI that ran into its limit is thrown, see readCodex): nothing is kept from it, and its
//    readers get what a late check gives them, the last settled answer marked stale, or pending. So "no answer" never takes the
//    place of a good answer that is minutes old.
// The answer is { value } with stale or pending added. It never rejects.
// read.since(time) is the answer of a check that ended at or after that time ({ value }), or null: for a reader whose own wait ran
// out while it waited for something else. read.forget() drops what is kept.
export function softCheck(check, { waitMs = 3000, keepFor = () => 0, settled = () => true, lastGoodMs = 5 * 60_000, now = Date.now } = {}) {
  let running = null;
  let seen = null;
  let good = null;
  const start = () => {
    const mine = Promise.resolve().then(check).then(value => {
      seen = { at: now(), value };
      if (settled(value)) good = seen;
      return { value };
    }, () => null).finally(() => {
      if (running === mine) running = null;
    });
    running = mine;
    return mine;
  };
  const read = async ({ fresh = false, waitMs: wait = waitMs } = {}) => {
    if (!fresh && seen && now() - seen.at < keepFor(seen.value)) return { value: seen.value };
    const going = running ?? start();
    let timer;
    const late = new Promise(resolve => { timer = setTimeout(() => resolve(null), wait); });
    const answer = await Promise.race([going, late]);
    clearTimeout(timer);
    if (answer) return answer;
    // The check is late, or it gave no answer.
    return good && now() - good.at < lastGoodMs ? { value: good.value, stale: true } : { value: null, pending: true };
  };
  read.since = time => (seen && seen.at >= time ? { value: seen.value } : null);
  // Forgets what is kept, so the next reader asks again (after a sign-in window was opened). A check that is going on is left to end.
  read.forget = () => {
    seen = null;
    good = null;
  };
  return read;
}

// Codex's sign-in, for GET /api/accounts: { installed, loggedIn, status } and, when it applies, reason: 'timed_out' or stale: true.
// The CLI is asked with `codex login status`. A reader waits 3 seconds at most (the CLI itself gets 15), an answer of "signed in" is
// kept for 20 seconds and any other for 3 (that is the one a person is about to change), and Refresh asks again. A CLI that gave no
// answer (it ran into its limit, or could not be started) is thrown as "no answer", so softCheck falls back on the last real one.
const CODEX_WAIT_MS = 3000;
const CODEX_KEEP_MS = 20_000;
const CODEX_KEEP_UNSURE_MS = 3000;
const readCodex = softCheck(async () => {
  if (!(await findExecutable('codex'))) return { installed: false, loggedIn: false, status: '' };
  const result = await runCli('codex', ['login', 'status']);
  const state = codexLoginState(result);
  // No answer (a timeout, or a failure exit that did not say whether anybody is logged in) is thrown, so softCheck keeps the last real
  // one. An exit code 0 with words Plenum does not know is an answer: unknown, with the CLI's own line.
  if (state.reason === 'timed_out' || (state.loggedIn === null && result.code !== 0)) throw new Error('Codex gave no answer.');
  return { installed: true, ...state };
}, {
  waitMs: CODEX_WAIT_MS,
  keepFor: value => (value?.loggedIn === true ? CODEX_KEEP_MS : CODEX_KEEP_UNSURE_MS),
  settled: value => value?.installed === true && value.loggedIn !== null,
});

// With since (a time from Date.now()) nothing is asked: it is the answer of a check that ended at or after that time, or null. The
// Accounts route uses it when its own wait ran out and the CLI answered while the route waited for something else.
export async function codexLoginStatus({ fresh = false, waitMs, since } = {}) {
  if (since !== undefined) return readCodex.since(since)?.value ?? null;
  const answer = await readCodex({ fresh, waitMs });
  // The CLI itself just said "signed in": a sign-in window that was open for it is finished (lib/signin-windows.mjs).
  if (answer.value?.loggedIn === true && !answer.stale) noteSignedIn('codex');
  if (answer.value) return answer.stale ? { ...answer.value, stale: true } : answer.value;
  // No answer in time and none to fall back on. Whether the CLI is there is a quick lookup of its own.
  const installed = !!(await findExecutable('codex').catch(() => null));
  return installed ? { installed, loggedIn: null, status: COULD_NOT_CHECK('Codex'), reason: 'timed_out' } : { installed, loggedIn: false, status: '' };
}

// After a Codex sign-in window was opened: the kept answer is dropped, so the next read asks the CLI.
export function forgetCodexLogin() {
  readCodex.forget();
}

// ---------- text for the log ----------

// Text that is about to be written to the log, with anything that could be a key or the launch token taken out. `secrets` are exact
// values to remove (the launch token); the values of the key variables in this process's environment and the keys saved in the app
// (refreshKeySecrets, below) are removed too. Beyond those it works by shape, since a key Plenum has never seen can sit in an
// error text: the key forms of the providers (sk-..., xai-..., AIza... and the like), the token forms of GitHub, Tailscale and a
// Google sign-in, a signed web token (eyJ... . eyJ...), any 64 hex digits (the launch token's form), what follows a name such as
// authorization, bearer, api-key or token, the name and password inside a web address (//name:password@), the query of a web
// address, and the value that an "... is an invalid header value" error quotes (that value is a key or a token). It never throws.
const KEY_SHAPES = [
  /\b(?:sk|xai|gsk|pk|rk|key)-[A-Za-z0-9_\-]{8,}/g,
  /\bAIza[0-9A-Za-z_\-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\btskey-[A-Za-z0-9_\-]{8,}/g,
  /\beyJ[A-Za-z0-9_\-]{4,}\.eyJ[A-Za-z0-9_\-]{4,}(?:\.[A-Za-z0-9_\-]+)?/g,
  /\bya29\.[A-Za-z0-9_\-.]{8,}/g,
  /\b[a-f0-9]{64}\b/gi,
];
const NAMED_SECRET = /\b(authorization|bearer|x-api-key|x-plenum-token|api[-_ ]?key|token|secret|password)\b(?!\])(["']?\s*[:=]?\s*["']?)(?:bearer\s+)?[^\s"',;)]{6,}/gi;
const URL_QUERY = /(\bhttps?:\/\/[^\s?#"']+)[?#][^\s"']*/gi;
const URL_USER = /(\b[a-z][a-z0-9+.\-]{1,20}:\/\/)[^\s\/@"'<>]+@/gi;
const HEADER_VALUE = /"[^"]{0,4000}"(\s+is an invalid header value)/g;
// The keys saved in the app, as they were at the last refreshKeySecrets(). Under the desktop app they are in the memory of
// lib/keys.mjs and not in the environment, so the environment alone would miss them.
let savedSecrets = [];
let keyStore = null;
// Reads the saved keys again, so that redactSecrets takes out their exact values. lib/keys.mjs is loaded here on first use and not
// at the top, because it imports this module. It never rejects; when the keys cannot be read, what was known stays.
export async function refreshKeySecrets() {
  try {
    keyStore ??= await import('./keys.mjs');
    const found = await Promise.all([...SAVABLE].map(name => Promise.resolve().then(() => keyStore.storedKey(name)).then(k => k?.key ?? null, () => null)));
    savedSecrets = found.filter(key => typeof key === 'string' && key.length >= 6);
  } catch {
    // What was known stays.
  }
}
export function redactSecrets(text, secrets = []) {
  let out;
  try {
    out = String(text ?? '');
    const exact = [...secrets, ...savedSecrets, ...[...SAVABLE, 'META_API_KEY', 'PLENUM_TOKEN'].map(name => process.env[name])];
    for (const secret of exact) if (typeof secret === 'string' && secret.trim().length >= 6) out = out.split(secret.trim()).join('[secret]');
    out = out.replace(HEADER_VALUE, '"[secret]"$1');
    out = out.replace(URL_USER, '$1[secret]@');
    out = out.replace(URL_QUERY, '$1?[query]');
    for (const shape of KEY_SHAPES) out = out.replace(shape, '[key]');
    out = out.replace(NAMED_SECRET, '$1$2[secret]');
  } catch {
    out = '[text that could not be shown]';
  }
  return out;
}

// One fault as text for the log: what it was, the error's message and the first six lines of its stack, redacted and kept short.
// Headers, bodies and queries are never passed in here; `what` is a few words of the caller's own.
export function faultText(what, err, secrets = []) {
  let detail;
  try {
    const stack = err instanceof Error && typeof err.stack === 'string' ? err.stack.split('\n').slice(0, 7).join('\n') : '';
    const message = err instanceof Error ? `${err.name}: ${err.message}` : typeof err === 'string' ? err : `a value that is not an error (${typeof err})`;
    detail = stack && stack.includes(err.message) ? stack : stack ? `${message}\n${stack}` : message;
  } catch {
    detail = 'an error that could not be read';
  }
  return redactSecrets(`${what}: ${detail}`, secrets).slice(0, 3000);
}
