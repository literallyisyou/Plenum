// What a failed CLI run means, in plain words with a next step. One table for every command-line agent Plenum starts (Muse Code,
// Codex, Claude Code, Gemini CLI, and Cursor and Grok Build when they run through lib/proc.mjs), so a failure reads the same wherever
// it shows: the chat, a council seat, a relay hop, an agent.
//
// This module is pure: it starts nothing and reads no file. The contract, pinned by build/v06/ultra-f1-cli-failures/classify.test.mjs:
//   classifyCliFailure(cli, { code, stderr, text, events, partial, model, unreadable, transcript, keys, signedIn })
//     cli        the command as lib/proc.mjs names it: muse, codex, claude, gemini, agent, cursor-agent, grok, agy
//     code       the exit code (null when the process was ended by a signal)
//     stderr     the end of what the CLI wrote to its error output
//     text       what the CLI itself reported as the failure (an error event, a result's error). NEVER the reply the model wrote: a
//                reply that talks about rate limits or signing in must not be read as a failure.
//     events     structured failure objects, read before any text: an error or result event, or Claude Code's rate_limit_event
//     partial    part of a reply was already written when the run failed
//     model      the model's name as the app shows it, for the sentence about a model that is not offered
//     unreadable the CLI's output could not be read as its output format
//     transcript the error output is a progress log that holds the prompt, the model's words and its tools' output (Codex in plain
//                text): only what follows the CLI's last "ERROR" line is read for the cause, or all of it when it is a few lines only
//     keys       key values to take out, besides everything that looks like a key
//     cutWords   with partial: the first sentence to use in place of cutOffWords (lib/acp.mjs says how an ACP agent's reply ended)
//     signedIn   true when the CLI's own sign-in check, asked AFTER this failure, said that it is signed in. A sign-in failure is then
//                not "not signed in": it is sign-in-refused, which says so and offers sending again (lib/claude-cli.mjs asks the check)
//     checkSilent true when that check, asked AFTER this failure, gave no answer (it ran into its time limit, or wrote something that
//                says neither). Whether anybody is signed in is then not known, and "not signed in" is not said: the failure is
//                sign-in-refused in words that say the check gave no answer (15 Nov 2026; until then the old sentence stood)
//   -> { kind, message, next, retryable, detail, flag, resetsAt }
//     kind       not-signed-in | sign-in-refused | sign-in-busy | model-unavailable | quota | overloaded | network | flags-rejected | bad-output |
//                crashed | unknown
//                sign-in-busy: the program could not renew its sign-in because another process of it was renewing it at the same moment.
//                The wording is the programs' own (Claude Code's error page: "Failed to refresh OAuth token: another Claude Code process is
//                refreshing it ..."); it is read only from what the CLI reported and from the end of its error output, never from a reply.
//     message    what happened, one or two plain sentences, with no exit code and no process name
//     next       what to do now
//     retryable  sending the same message again can work without changing anything (FAILURE_ACTIONS lists 'retry' for the kind)
//     detail     the CLI's own words: the line that gave the cause, or the last lines when the cause is unknown; keys taken out, short
//     flag       flags-rejected only: the option the CLI refused, when it named one
//     resetsAt   quota only: the time the limit resets in milliseconds, when an event carried it
//   cliError(cli, facts) -> CliError: an Error whose message is "<message> <next>" and then the detail on its own lines. It carries the
//     verdict's fields and code, partial, cli, stderr (the CLI's error output, keys taken out) and raw (the text in the old
//     "<command> exited with code N:" form, keys taken out, which the adapters match their own cases on: a session that is gone,
//     Muse Code's "not offered", Gemini's exit code 41).
// How the cause is decided: structured fields first; then what the CLI reported (text, the events' own words); then the END of its error
// output, the last few lines only, read from the last line back. A CLI's own error is its last word; what stands above it (a warning, a
// tool's output, a line of a log) is not the cause, and is never shown as the detail.
// Nothing here ever picks another model: the next step only says that the person can.
//   FAILURE_ACTIONS: for each kind, the buttons the page offers under the failed reply, in order: 'retry' (put the message back to send
//     it again; only where sending again can work), 'sign-in' (open Accounts at the program's card; it presses nothing there),
//     'pick-model' (open the model menu; the person picks), 'open-log' (show Plenum's log file). The page's copy of this table is
//     CLI_ACTIONS in public/ext-turns.js; build/v06/d-failed-reply/table.test.mjs pins that the two are the same.
//   An option that a version of a CLI refused once ('flags-rejected') is remembered by lib/cli-fit.mjs, which says so in words before
//     the next run that would send it again to the same version.

export const CLI_LABELS = Object.freeze({
  muse: 'Muse Code',
  codex: 'Codex',
  claude: 'Claude Code',
  gemini: 'Gemini CLI',
  agent: 'Cursor',
  'cursor-agent': 'Cursor',
  cursor: 'Cursor',
  grok: 'Grok Build',
  agy: 'Antigravity',
  antigravity: 'Antigravity',
});
// The buttons under a failed reply, by kind (see the top of this file). 'retry' stands exactly where sending again can work.
export const FAILURE_ACTIONS = Object.freeze({
  'not-signed-in': Object.freeze(['sign-in']),
  // The CLI's sign-in was refused for one run while its own check says it is signed in: sending again can work, and so can signing in again.
  'sign-in-refused': Object.freeze(['retry', 'sign-in']),
  // The CLI could not renew its sign-in because another process of it was renewing it at that moment: sending again can work.
  'sign-in-busy': Object.freeze(['retry', 'sign-in']),
  'model-unavailable': Object.freeze(['pick-model']),
  quota: Object.freeze(['pick-model']),
  overloaded: Object.freeze(['retry', 'pick-model']),
  network: Object.freeze(['retry']),
  'flags-rejected': Object.freeze(['pick-model', 'open-log']),
  'bad-output': Object.freeze(['retry', 'open-log']),
  crashed: Object.freeze(['retry', 'open-log']),
  unknown: Object.freeze(['retry', 'open-log']),
});

export const cliLabel = cli => (Object.hasOwn(CLI_LABELS, cli) ? CLI_LABELS[cli] : String(cli ?? 'The CLI'));

// The words of a sign-in-refused failure that name it. lib/team.mjs reads them in a failed task's text, so a program that is signed in
// is not marked "needs sign-in" for the next tasks.
export const SIGN_IN_REFUSED_WORDS = 'sign-in was refused for this reply';

// ---------- keys ----------

const KEY_REMOVED = '[key removed]';
// The shapes of the keys and tokens the providers issue, then the name and password inside an address, then anything that is given as
// the value of a key, token or password, then any long unbroken word (a token of an unknown shape). A value counts only when it can be
// a secret: it holds a digit or is long, so "token: expired" and "Basic authentication failed" keep their words. A session id (36
// characters with dashes) and a request id stay readable.
const KEY_SHAPES = [
  [/\bsk-[A-Za-z0-9_-]{12,}/g, KEY_REMOVED],
  [/\bxai-[A-Za-z0-9_-]{12,}/g, KEY_REMOVED],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, KEY_REMOVED],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat|gsk|glpat|key)_[A-Za-z0-9_]{16,}/g, KEY_REMOVED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, KEY_REMOVED],
  [/(\/\/)[^/\s:@]+:[^@\s/]+@/g, `$1${KEY_REMOVED}@`],
  [/\b(Bearer|Basic)\s+(?=[A-Za-z0-9._~+/=-]*\d|[A-Za-z0-9._~+/=-]{20,})[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${KEY_REMOVED}`],
  [/\b((?:api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|secret|password|passwd|authorization)["']?\s*[:=]\s*["']?)(?!\[key removed\]|Bearer\b|Basic\b)(?=[^\s"',;]*\d|[^\s"',;]{16,})[^\s"',;]{6,}/gi, `$1${KEY_REMOVED}`],
  [/\b(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{32,}\b/g, '[hidden]'],
  [/(?=[A-Za-z0-9_+=-]*[A-Za-z0-9])[A-Za-z0-9_+=-]{40,}/g, '[hidden]'],
];
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

// The text with every key taken out. keys are exact values to remove first (a key this run was given).
export function redactSecrets(text, keys = []) {
  let out = String(text ?? '').replace(ANSI, '');
  for (const key of keys) if (typeof key === 'string' && key.length >= 4) out = out.split(key).join(KEY_REMOVED);
  for (const [shape, put] of KEY_SHAPES) out = out.replace(shape, put);
  return out;
}

// ---------- the tables ----------

// Each kind: the exact values a structured field can carry, and the words in the CLI's failure text. The text tables are only ever
// used on what the CLI reported as a failure (see `text` above) and on the end of its error output.
const FLAGS = /\b(?:unknown|unrecognized|unrecognised|unexpected|no such) (?:option|argument|flag|switch|command|subcommand)s?\b|\binvalid (?:option|flag|switch)\b/i;
const USAGE = /^\s*usage:/i;
// The option the refusal names: "--name" as written, or (yargs: "Unknown argument: name") the bare name after a colon.
const FLAG_NAME = /(?:^|[\s'"`:=(])(--?[A-Za-z][A-Za-z0-9-]*)/;
const BARE_FLAG = /\b(?:option|argument|flag)s?:\s*['"`]?([A-Za-z][A-Za-z0-9-]+)/i;

// A status number counts only where the text gives it as one: after "status", "code", "HTTP" or "error", in brackets, or as the start
// of the line before a colon. A bare number is not read: it can be a line number in a stack ("index.js:429:13") or a port
// ("127.0.0.1:401").
const statusIs = numbers => new RegExp(`(?:\\b(?:status|code|https?(?:\\/[\\d.]+)?)\\b(?:\\s+(?:code|status))?\\W{0,4}|\\berror\\W{0,3}|(?<![\\w.\\]])[\\[(])(?:${numbers})\\b(?![:.]\\d)|^\\W{0,3}(?:${numbers})\\b(?=\\s*(?:$|[:,;–—-]))(?![:.]\\d)`, 'i');
const STATUS_401 = statusIs('401');
const STATUS_429 = statusIs('429');
const STATUS_BUSY = statusIs('50[0234]|529');

const SIGN_IN_TAGS = /^(?:FatalAuthenticationError|authentication_error|authentication_failed|unauthenticated|unauthorized|invalid_api_key|401)$/i;
const SIGN_IN = /\bnot (?:logged|signed) in\b|\b(?:please|you must|you need to|must) (?:log ?in|sign ?in|login|re-?authenticate|run \/login)\b|\blogin required\b|\brun [`'"]?[\w-]+ (?:auth )?login\b|\bset an auth method\b|\binvalid (?:x-)?api[ -]?key\b|\bincorrect api key\b|\bunauthori[sz]ed\b|\bauthentication (?:failed|required|error|token)\b|\bauthentication_error\b|FatalAuthenticationError|\b(?:oauth |access |refresh )?token (?:has |is )?expired\b|\bno (?:valid )?credentials\b|\bcredentials (?:not found|are missing|missing|have expired|expired)\b|\bsign in again\b|\blog ?in again\b|\bsession (?:has )?expired\b/i;
// A program's report that it could not renew its sign-in because another process of it was renewing it ("Failed to refresh OAuth token:
// another Claude Code process is refreshing it or exited mid-refresh" in a headless run, "Could not refresh your login because another
// Claude Code process is refreshing it" in the interactive one). Both sentences end in "sign in again", so this is looked for first.
const SIGN_IN_BUSY = /\b(?:failed to|could not|couldn't|unable to) refresh (?:the |your )?(?:oauth )?(?:token|login)\b[^\n]*\banother\b[^\n]{0,40}\bprocess\b/i;
// A line about an MCP server's own login is the CLI reporting on that one server, not on its account (B-48).
const MCP_LINE = /\bMCP\b/i;

const MODEL_TAGS = /^(?:model_not_found|model_not_available|unsupported_model|invalid_model)$/i;
// "not found" and the like must be said of the model: "the model tried to open notes.txt: file not found" is about a file.
const OF_THE_MODEL = '(?:(?!\\b(?:files?|path|directory|folder|command)\\b)[^\\n]){0,60}?';
const MODEL = new RegExp(`does not exist or you lack access|may not exist or you may not have access|\\bmodels?\\b${OF_THE_MODEL}(?:\\bnot found\\b|\\bis not found\\b|\\bdoes not exist\\b|\\bdoesn't exist\\b|\\bis not available\\b|\\bno longer (?:available|offered|supported)\\b|\\b(?:is|was|has been|been) (?:deprecated|decommissioned|retired)\\b)|\\bmodels?\\b[^\\n]{0,60}\\bis not supported\\b[^\\n]{0,40}\\b(?:account|plan|subscription)\\b|\\b(?:unknown|invalid|unsupported|unrecognized) model\\b|\\bmodel_not_found\\b|\\bno such model\\b|\\bissue with the selected model\\b|\\bnot_found_error\\b[^\\n]{0,80}\\bmodel\\s*:|\\bmodel\\s*:[^\\n]{0,80}\\bnot_found_error\\b`, 'i');
// Anthropic's answer for a model it has retired: the type not_found_error, and a message that is "model: <id>".
const NOT_FOUND_TAG = /^not_found_error$/i;
const MODEL_FIELD = /^model\s*:/i;

const QUOTA_TAGS = /^(?:usage_limit_reached|usage_limit_exceeded|rate_limit_error|rate_limit_exceeded|rate_limited|insufficient_quota|quota_exceeded|RESOURCE_EXHAUSTED|429|rate-limit-rejected)$/i;
const QUOTA = /\brate[ _-]?limit|\busage[ _-]?limit|\bquota\b|RESOURCE_EXHAUSTED|\btoo many requests\b|\b(?:hit|reached|exceeded)\b[^\n]{0,30}\blimit\b|\blimit (?:reached|exceeded|hit)\b|\bout of (?:credits|usage|quota)\b|\binsufficient (?:credits?|quota|balance)\b|\bcredit balance is too low\b/i;
// Limits that are not the plan's: the length of the chat, a step, time or retry limit, a command's time limit ("the 120 second limit").
// These words are taken out of a line before it is read for a plan limit, so what else the line says still counts ("exceeded retry
// limit, last status: 429" is a plan limit; "... last status: 503" is a busy service).
const NOT_A_PLAN_LIMIT = /\bcontext[ _-](?:window|length|size)(?:[ _-]limit)?\b|\bcontext[ _-]limit\b|\bmax(?:imum)?[ _-]?(?:turns|steps|tokens|retries)\b|\b(?:time|step|turn|retry)s?[ _-]?limit\b|\b\d+[ -]?(?:seconds?|secs?|minutes?|mins?|hours?|milliseconds?|ms|s|m)[ -](?:time ?)?limit\b/gi;
const isPlanLimit = line => {
  const rest = line.replace(NOT_A_PLAN_LIMIT, ' ');
  return QUOTA.test(rest) || STATUS_429.test(rest);
};

const BUSY_TAGS = /^(?:overloaded_error|overloaded|server_overloaded|UNAVAILABLE|service_unavailable|529|503|502)$/i;
const BUSY = /\boverloaded\b|\bservice unavailable\b|\bbad gateway\b|\bserver (?:is )?(?:busy|overloaded)\b|\btemporarily unavailable\b|\bat capacity\b|\binternal server error\b/i;

const NETWORK = /\b(?:ENOTFOUND|ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EAI_AGAIN|UND_ERR_[A-Z_]+)\b|\bgetaddrinfo\b|\bfetch failed\b|\bsocket hang up\b|\bnetwork (?:error|is unreachable|request failed|connection)\b|\b(?:could not|couldn't|unable to|failed to) (?:connect|resolve|reach)\b|\bconnection (?:refused|reset|timed out|error|closed|failed|was closed)\b|\brequest timed out\b|\bno internet\b|\bproxy (?:error|authentication|connect)\b|\bcertificate (?:has expired|verify failed|is not trusted)\b|\bself[- ]signed certificate\b|\bstream disconnected\b|\berror sending request\b/i;

// What one line says, in this order (a line can hold the words of two kinds: "401 Unauthorized ... rate limit page").
const KINDS = [
  ['not-signed-in', line => !MCP_LINE.test(line) && (SIGN_IN.test(line) || STATUS_401.test(line))],
  ['model-unavailable', line => MODEL.test(line)],
  ['quota', isPlanLimit],
  ['overloaded', line => BUSY.test(line) || STATUS_BUSY.test(line)],
  ['network', line => NETWORK.test(line)],
];
const TEST_OF = Object.fromEntries(KINDS);
const kindOf = line => KINDS.find(([, says]) => says(line))?.[0] ?? null;

// How many lines of the end of the error output are read for the cause.
const TAIL_LINES = 6;
// A line of a stack ("at run (index.js:429:13)") or of punctuation only ("}", "^") says nothing about the cause and is not counted.
const STACK_FRAME = /^at\s+.*(?::\d+(?::\d+)?\)?|<anonymous>\)?|\(native\)|\(index \d+\))$/;
const meaningful = line => !STACK_FRAME.test(line) && /[A-Za-z0-9]/.test(line);
// The CLI's own error line in a progress log: Codex writes its errors as "ERROR: ...".
const OWN_ERROR = /^ERROR\b/;

// The lines of the error output that can name the cause. In a progress log (`transcript`) that is what follows the CLI's last own error
// line; a log with no such line is not read at all, unless the output is only a few lines (then it is no log: the CLI failed before it
// started its work, for example on its command line or its sign-in).
function ownLines(errs, transcript) {
  const lines = errs.filter(meaningful);
  if (!transcript) return lines;
  const at = lines.findLastIndex(line => OWN_ERROR.test(line));
  if (at >= 0) return lines.slice(at);
  return lines.length > TAIL_LINES ? [] : lines;
}

// Exit codes that mean the process was ended, not that it reported an error: the abort, kill and segfault codes of macOS and Linux
// (128 + the signal), and Windows' NTSTATUS values (0xC0000005 and the like, which Node reports as large positive numbers).
const isCrashCode = code => code === null || code === 134 || code === 137 || code === 139 || (Number.isInteger(code) && (code >= 0xC0000000 || code < 0));

const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const linesOf = text => String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const str = value => (typeof value === 'string' ? value : Number.isFinite(value) ? String(value) : '');

// What the structured events say: the exact values of their type, status and code fields (tags), their own failure text, and a reset time.
function readEvents(events) {
  const tags = [];
  const said = [];
  let resetsAt = null;
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== 'object') continue;
    const error = ev.error && typeof ev.error === 'object' ? ev.error : null;
    for (const value of [ev.subtype, ev.code, ev.status, error?.type, error?.code, error?.status, ev.errorType]) {
      const tag = str(value);
      if (tag) tags.push(tag);
    }
    for (const value of [ev.message, typeof ev.error === 'string' ? ev.error : error?.message, ev.is_error === true ? ev.result : null]) {
      if (typeof value === 'string' && value.trim()) said.push(value);
    }
    // Claude Code's rate_limit_event: { status: 'allowed' | 'allowed_warning' | 'rejected', resetsAt (seconds), rateLimitType }.
    const limit = ev.rate_limit_info && typeof ev.rate_limit_info === 'object' ? ev.rate_limit_info : ev.rateLimitType ? ev : null;
    if (limit?.status === 'rejected') {
      tags.push('rate-limit-rejected');
      const at = Number(limit.resetsAt);
      if (Number.isFinite(at) && at > 0) resetsAt = at < 1e12 ? at * 1000 : at;
    }
  }
  return { tags, said, resetsAt };
}

// ---------- the verdict ----------

export function classifyCliFailure(cli, { code = null, stderr = '', text = '', events = [], partial = false, model = null, unreadable = false, transcript = false, keys = [], cutWords = '', signedIn = false, checkSilent = false } = {}) {
  const label = cliLabel(cli);
  const seen = readEvents(events);
  // What the CLI reported (a line is looked at once), and its error output: every line, the lines that can name the cause, their end.
  const said = [...new Set(linesOf(redactSecrets([text, ...seen.said].filter(Boolean).join('\n'), keys)))];
  const errs = linesOf(redactSecrets(stderr, keys));
  const own = ownLines(errs, transcript);
  const end = own.slice(-TAIL_LINES);
  // The last line that says a thing: of the CLI's own report first, then of the end of its error output.
  const last = says => said.findLast(says) ?? end.findLast(says) ?? null;
  const tagged = re => seen.tags.some(tag => re.test(tag));
  // A sign-in failure of a CLI whose own check then says "signed in" is a refusal of that one run, and is named as that.
  // One whose check gave no answer is named as that too, in its own words: nobody said that the account is signed out.
  const silent = signedIn !== true && checkSilent === true;
  const named = kind => (kind === 'not-signed-in' && (signedIn === true || silent) ? 'sign-in-refused' : kind);
  const verdict = (kind, hit, extra = {}) => words(label, named(kind), { partial, model, cutWords, silent, detail: hit ? clip(hit, 240) : '', ...extra });

  if (unreadable) return verdict('bad-output', clip([...new Set([...said, ...errs])].slice(0, 3).join('\n'), 200));

  // A command line the CLI refused. Looked for first, because the usage text that follows it lists every command the CLI has ("login",
  // "model") and would otherwise read as a sign-in or a model failure. Only a run that wrote nothing can be one. The refusal stands at
  // the start of the error output (commander, clap) or at its end (yargs prints its usage first), so every line that can name the
  // cause is looked at; in a progress log those are the lines after the CLI's own last error line, never a tool's output.
  if (!partial) {
    const edge = [...said, ...own];
    const refused = edge.find(line => FLAGS.test(line)) ?? null;
    if (refused || (code === 2 && edge.some(line => USAGE.test(line)))) {
      // Only the line that names the refusal is kept: what follows it is the CLI's whole help page.
      const first = refused ?? '';
      const bare = BARE_FLAG.exec(first)?.[1];
      const flag = FLAG_NAME.exec(first)?.[1] ?? (bare ? `--${bare}` : null);
      return verdict('flags-rejected', first, { flag });
    }
  }

  // A sign-in that another process was renewing. Its line also says "sign in again", and the event's code for it is server_error. In
  // what the CLI reported it comes before the tags, so that code is not read as anything else. In the error output it comes after them
  // (below): a run whose events name another cause keeps that cause when a renewal collision was logged and recovered earlier. Only
  // the CLI's own words are read (never an MCP server's line), and a sign-in check changes nothing here.
  const busyLine = lines => lines.findLast(line => !MCP_LINE.test(line) && SIGN_IN_BUSY.test(line));
  const saidBusy = busyLine(said);
  if (saidBusy) return verdict('sign-in-busy', saidBusy);

  // Structured fields first. Gemini CLI's own exit code for a sign-in failure is 41.
  if (tagged(SIGN_IN_TAGS) || (cli === 'gemini' && code === 41)) return verdict('not-signed-in', last(TEST_OF['not-signed-in']));
  const modelField = tagged(NOT_FOUND_TAG) ? said.find(line => MODEL_FIELD.test(line)) : null;
  if (tagged(MODEL_TAGS) || modelField) return verdict('model-unavailable', last(TEST_OF['model-unavailable']) ?? modelField);
  if (tagged(QUOTA_TAGS)) return verdict('quota', last(isPlanLimit), { resetsAt: seen.resetsAt });
  if (tagged(BUSY_TAGS)) return verdict('overloaded', last(TEST_OF.overloaded));
  const endBusy = busyLine(end);
  if (endBusy) return verdict('sign-in-busy', endBusy);

  // Then the words: of the CLI's own report, then of the end of its error output, each from its last line back. The first line that
  // says a cause is the cause, and it is the detail.
  for (const group of [said, end]) {
    for (let i = group.length - 1; i >= 0; i -= 1) {
      const kind = kindOf(group[i]);
      if (kind) return verdict(kind, group[i], kind === 'quota' ? { resetsAt: seen.resetsAt } : {});
    }
  }

  // No cause could be read. The last lines the CLI wrote are the detail (its report when it made one, else its error output).
  const tail = clip((said.length ? said : own.length ? own : errs).slice(-4).join('\n'), 600);
  return words(label, isCrashCode(code) ? 'crashed' : 'unknown', { partial, model, cutWords, detail: tail });
}

function words(label, kind, { partial, model, detail = '', flag = null, resetsAt = null, cutWords = '', silent = false }) {
  const again = 'send the message again';
  const table = {
    'not-signed-in': [`${label} is not signed in.`, `Open Accounts and choose "Sign in to ${label}", then ${again}.`],
    'sign-in-refused': [silent ? `${label}'s ${SIGN_IN_REFUSED_WORDS}, and ${label}'s own sign-in check gave no answer, so Plenum cannot tell whether it is signed in.` : `${label}'s ${SIGN_IN_REFUSED_WORDS}, although ${label}'s own check says it is signed in.`, `Send the message again. If it is refused again, open Accounts and choose "Sign in again" on the ${label} card.`],
    'sign-in-busy': [`${label} could not renew its sign-in for this reply, because another ${label} process on this PC was renewing it at the same moment.`, `Send the message again in a minute. If it keeps happening, close other ${label} windows, or open Accounts and choose "Sign in again" on the ${label} card.`],
    'model-unavailable': [`${label} does not offer ${model || 'this model'} to this account, or the model has been retired.`, `Pick another model in the model menu, then ${again}.`],
    quota: [`${label} has reached a usage limit${resetsAt ? ` (it resets ${resetWords(resetsAt)})` : ''}.`, `Wait until the limit resets, or pick another model, then ${again}.`],
    overloaded: [`${label}'s service is busy or not answering right now.`, `Wait a minute, then ${again}, or pick another model.`],
    network: [`${label} could not reach its service.`, `Check the internet connection, then ${again}.`],
    'flags-rejected': [`${label} did not accept ${flag ? `the option ${flag}` : 'the command'} that Plenum sent, so nothing ran. The CLI has probably updated itself.`, 'Update Plenum. Until then, pick another model.'],
    'bad-output': [`${label} sent output Plenum could not read.`, `Send the message again. If it happens again, ${label} may have updated itself: update Plenum.`],
    crashed: [`${label} closed before it finished: it crashed, or another program ended it.`, 'Send the message again.'],
    unknown: [`${label} stopped with an error${partial ? '' : ' before it replied'}.`, `Send the message again. If it keeps failing, check ${label} in Accounts.`],
  };
  const [cause, next] = table[kind];
  const retryable = FAILURE_ACTIONS[kind].includes('retry');
  // A reply that was cut off says so first: what is on screen is not the whole answer.
  const cut = cutWords || cutOffWords(label);
  const message = !partial ? cause : kind === 'unknown' ? cut : kind === 'crashed' ? `${cut} It crashed, or another program ended it.` : `${cut} ${cause}`;
  return { kind, message, next, retryable, detail, flag, resetsAt };
}

// The first sentence of a failure that came after part of a reply. An adapter that words a failure of its own uses it too.
export const cutOffWords = label => `${label} stopped before its reply was finished, so what it wrote is incomplete.`;

function resetWords(ms) {
  const at = new Date(ms);
  if (Number.isNaN(at.getTime())) return 'later';
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const sameDay = at.toDateString() === new Date().toDateString();
  return sameDay ? `at ${time}` : `on ${at.toLocaleDateString([], { weekday: 'long' })} at ${time}`;
}

// ---------- the error ----------

export class CliError extends Error {
  constructor(cli, verdict, { code = null, partial = false, raw = '', stderr = '' } = {}) {
    super(`${verdict.message} ${verdict.next}${verdict.detail ? `\n${verdict.detail}` : ''}`);
    this.name = 'CliError';
    this.cli = cli;
    this.kind = verdict.kind;
    this.next = verdict.next;
    this.retryable = verdict.retryable;
    this.detail = verdict.detail;
    this.code = code;
    this.partial = partial;
    this.raw = raw;
    this.stderr = stderr;
    if (verdict.flag) this.flag = verdict.flag;
    if (verdict.resetsAt) this.resetsAt = verdict.resetsAt;
  }
}

// The error for a failed run. facts are classifyCliFailure's, plus command: the process name for the raw text (cli when left out).
export function cliError(cli, facts = {}) {
  const { code = null, stderr = '', text = '', partial = false, keys = [], command = cli } = facts;
  const clean = redactSecrets(stderr, keys).trim();
  const tail = redactSecrets([text, stderr].filter(part => String(part ?? '').trim()).join('\n'), keys).trim();
  const raw = `${command} exited with code ${code}${tail ? `:\n${tail}` : ''}`;
  return new CliError(cli, classifyCliFailure(cli, facts), { code, partial: Boolean(partial), raw, stderr: clean });
}

export const isCliError = err => err instanceof CliError;
