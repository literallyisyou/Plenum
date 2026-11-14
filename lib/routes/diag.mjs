// Help and diagnostics (the report is built in lib/diag.mjs, the page is public/ext-help.js).
//
//   GET  /api/diag[?fresh=1] -> { text, at, pending, logSource, canOpenLog }   (gated: it starts each tool found with --version)
//        text is the whole report as plain text, already redacted: versions, the build line, what is found, signed in and saved as yes or
//        no, sizes and counts, and the last 50 error lines. at is the time it was made. pending is how many tools had not answered when
//        the answer left (the page asks again in a moment). logSource is 'log' (the desktop app's server.log) or 'ring' (this run's own
//        errors). canOpenLog says whether the desktop app is there to open the log folder. fresh=1 reads the tools again.
//        It answers in under a second: the tools are asked at once and waited for 600 ms at most; a tool that is slow is read on in the
//        background and its answer is kept for a minute. It never starts a CLI with a prompt: only `<tool> --version`.
//   GET  /api/diag/basic     -> the same without looking for or starting any tool. Not gated, so a person who has not yet accepted
//        the License Agreement can still copy a report.
//   POST /api/diag/client-error { message, source?, line?, kind? } -> { ok: true, kept: boolean }
//        The page reports an error it caught (public/ext-help.js). One line goes to the log and to the report: the message cut to 240
//        characters, the script's file name and line, all through the same redaction. No stack, no URL query, no other field. At most 20
//        a minute; the same text once in 10 seconds. A POST waits for the License Agreement like every POST.
//   POST /api/diag/open-log  -> { ok, message? }   shows the log's folder in the file manager through the desktop app ('open-log-folder').
//        ok is false with a sentence for the person when there is no desktop app or it cannot do it.
//
// The desktop app's side is desktop/handlers/diag.cjs: 'diag-log' answers { lines } (the last lines of server.log) and 'open-log-folder'
// answers { ok }. Without that handler (an older desktop app) the report uses this run's own errors and says so.
//
// What a report may never hold is in the header of lib/diag.mjs, and a test per kind plants such a secret and searches the answer.
import { token } from '../auth.mjs';
import { API_PROVIDERS } from '../api-providers.mjs';
import { termsAccepted } from '../legal.mjs';
import { storedKey } from '../keys.mjs';
import { scrub as hubScrub } from '../hub.mjs';
import { APP_ROOT } from '../overlay.mjs';
import { knownProviders } from '../provider-status.mjs';
import { shellAvailable, shellRequest } from '../shell.mjs';
import { cleanLine, clientErrorLine, forgetTools, makeReport, makeRedactor, noteError, tapConsole } from '../diag.mjs';
import { refreshKeySecrets } from '../accounts.mjs';
import * as realStore from '../store.mjs';
import os from 'node:os';

// From here on what the server prints with console.error is also kept in memory, for a run without the desktop app's log file.
tapConsole();

const LOG_ASK_MS = 600;
const OPEN_ASK_MS = 4000;
// An older desktop app has no 'diag-log' handler and never answers; it is not asked again for 5 minutes, so the report stays quick.
const NO_ANSWER_MS = 5 * 60_000;
let silentUntil = 0;

const NEEDS_DESKTOP = "Opening a folder needs the Plenum desktop app. The log is the file server.log in Plenum's data folder.";
const OLD_DESKTOP = 'This version of the desktop app cannot open the folder from here. In Windows, open the folder %APPDATA%\\Plenum and look for server.log.';
const COULD_NOT = 'The folder could not be opened. In Windows, open the folder %APPDATA%\\Plenum and look for server.log.';

export const routes = [
  { method: 'GET', path: '/api/diag', handler: reportRoute, gated: true },
  { method: 'GET', path: '/api/diag/basic', handler: basicRoute },
  { method: 'POST', path: '/api/diag/client-error', handler: clientRoute },
  { method: 'POST', path: '/api/diag/open-log', handler: openLogRoute },
];

// What the desktop app's log holds, as { lines }, or null (no desktop app, no answer, an answer of the wrong shape).
export async function readShellLog({ request = shellRequest, available = shellAvailable, now = Date.now } = {}) {
  if (!available() || now() < silentUntil) return null;
  try {
    const answer = await request('diag-log', {}, { timeoutMs: LOG_ASK_MS });
    if (!Array.isArray(answer?.lines)) return null;
    return { lines: answer.lines.filter(l => typeof l === 'string').slice(-2000) };
  } catch {
    silentUntil = now() + NO_ANSWER_MS;
    return null;
  }
}

// The labels of the providers that have a key saved (names only, never a key).
async function savedKeyLabels() {
  const list = [['ANTHROPIC_API_KEY', 'Anthropic'], ...API_PROVIDERS.map(p => [p.envVar, p.label])];
  const found = await Promise.all(list.map(([envVar, label]) => storedKey(envVar).then(k => (k?.key ? label : null), () => null)));
  return found.filter(Boolean);
}

// The facts for one report, from the live server. `store` is the server's store; tests pass their own.
export const liveDeps = store => ({
  store,
  readLog: () => readShellLog(),
  providers: () => knownProviders(),
  keyLabels: savedKeyLabels,
  terms: st => termsAccepted(st),
  appRoot: APP_ROOT,
  scrubbers: [hubScrub],
});

async function answer({ res, json, store, withTools, fresh }) {
  if (fresh) forgetTools();
  const report = await makeReport({ ...liveDeps(store ?? realStore), withTools });
  return json(res, 200, { ...report, canOpenLog: shellAvailable() });
}

async function reportRoute({ res, json, url, store }) {
  return answer({ res, json, store, withTools: true, fresh: url?.searchParams?.get('fresh') === '1' });
}

async function basicRoute({ res, json, store }) {
  return answer({ res, json, store, withTools: false, fresh: false });
}

async function clientRoute({ req, res, json, readBody, store }) {
  const body = await readBody(req, 20_000);
  await refreshKeySecrets();
  const st = (store ?? realStore).get?.() ?? null;
  const projects = Array.isArray(st?.projects) ? st.projects.map(p => (typeof p?.path === 'string' ? p.path : '')).filter(Boolean) : [];
  let user = '';
  try {
    user = os.userInfo().username;
  } catch {
    user = process.env.USERNAME || '';
  }
  const redact = makeRedactor({ user, home: os.homedir(), dataHome: String((store ?? realStore).HOME ?? ''), appRoot: APP_ROOT, projects, secrets: () => [token()], scrubbers: [hubScrub] });
  const line = clientErrorLine(body, redact);
  if (line) {
    noteError(line);
    // The desktop app keeps stderr in server.log, so the line is in the log a person is asked for as well.
    console.error(`[${new Date().toISOString()}] ${cleanLine(line, redact)}`);
  }
  return json(res, 200, { ok: true, kept: line !== null });
}

async function openLogRoute({ res, json }) {
  if (!shellAvailable()) return json(res, 200, { ok: false, message: NEEDS_DESKTOP });
  try {
    const r = await shellRequest('open-log-folder', {}, { timeoutMs: OPEN_ASK_MS });
    return json(res, 200, r?.ok === true ? { ok: true } : { ok: false, message: COULD_NOT });
  } catch {
    return json(res, 200, { ok: false, message: OLD_DESKTOP });
  }
}
