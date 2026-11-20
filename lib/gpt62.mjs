// GPT-6.2 Astra and GPT-6.2 Sol (OpenAI, released 17 Nov 2026; DECISIONS item 199). What Plenum knows about the two models that is not a
// row of a table (the catalog, prices and windows stay in their own tables) lives here, so the adapters and the Codex route read one place.
//
//   GPT62_MODELS          [{ id, name }]: the API ids gpt-6.2-astra and gpt-6.2-sol. The Codex route uses the same ids.
//   isGpt62(id)           true for either id (any case), on the API route or the Codex route
//   gpt62Effort(effort)   the reasoning effort a 6.2 request carries: low, medium, high, xhigh or max, never 'none' (OpenAI refuses it for
//                         6.2). 'none' and 'minimal' go as low; anything else unexpected goes as high, Plenum's default everywhere.
//   CODEX_MIN_VERSION     '0.169.0', the oldest Codex CLI that runs 6.2; CODEX_UPDATE is the command that installs it
//   codexFits(version)    true (that version runs 6.2), false (it is older), or null (no version to judge)
//   codexVersionGate(id)  before a Codex run on a 6.2 model: the error to throw when the installed Codex is older, else null
//   codexTooOldAfter(err, id)  after a failed Codex run on a 6.2 model: the same error when Codex is older, or when Codex itself said that it
//                         needs a newer version; else null (the failure keeps its own words)
//   forgetCodexVersion()  forgets the kept reading (tests)
//
// The version is read with `codex --version` only (lib/diag.mjs probeTool: hidden, ended after a few seconds, never a prompt). A version
// that fits is kept for FIT_KEEP_MS, so a run does not wait for the read every time; one that is too old is never kept, so the send after
// an update is let through at once; one that cannot be read is kept for UNKNOWN_KEEP_MS and lets the run start (Codex then says what it
// says, and codexTooOldAfter reads it). Nothing here picks another model.
import { CliError } from './cli-errors.mjs';

export const GPT62_MODELS = Object.freeze([
  Object.freeze({ id: 'gpt-6.2-astra', name: 'GPT-6.2 Astra' }),
  Object.freeze({ id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol' }),
]);
const IDS = new Set(GPT62_MODELS.map(m => m.id));
export const isGpt62 = id => IDS.has(String(id ?? '').trim().toLowerCase());
const nameOf = id => GPT62_MODELS.find(m => m.id === String(id ?? '').toLowerCase())?.name ?? String(id ?? 'This model');

// The efforts 6.2 takes, as OpenAI names them. UNVERIFIED for 6.2 itself: the GPT-6 models' page lists low to max (build\research\
// frontier.json); that 'none' is refused comes from the release notes in the brief of 17 Nov 2026.
export const GPT62_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export function gpt62Effort(effort) {
  const v = String(effort ?? '').trim().toLowerCase();
  if (GPT62_EFFORTS.includes(v)) return v;
  return v === 'none' || v === 'minimal' ? 'low' : 'high';
}

export const CODEX_MIN_VERSION = '0.169.0';
export const CODEX_UPDATE = `npm install -g @openai/codex@${CODEX_MIN_VERSION}`;
export const FIT_KEEP_MS = 10 * 60_000;
export const UNKNOWN_KEEP_MS = 60_000;

// "0.169.0", "0.170.1-alpha.2" -> { parts: [0, 170, 1], pre: true }, or null.
function parse(version) {
  const m = /^v?(\d{1,6})\.(\d{1,6})(?:\.(\d{1,6}))?(-[0-9A-Za-z.-]+)?$/.exec(String(version ?? '').trim());
  return m ? { parts: [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)], pre: Boolean(m[4]) } : null;
}
const MIN = parse(CODEX_MIN_VERSION).parts;

export function codexFits(version) {
  const v = parse(version);
  if (!v) return null;
  for (let i = 0; i < 3; i++) if (v.parts[i] !== MIN[i]) return v.parts[i] > MIN[i];
  // 0.169.0 itself fits; a pre-release of it (0.169.0-alpha.2) comes before it.
  return !v.pre;
}

let kept = null; // { at, version, fits } for a reading that fits or could not be read
export function forgetCodexVersion() {
  kept = null;
}

async function defaultProbe() {
  // Loaded when needed: lib/diag.mjs reads lib/proc.mjs, which lib/providers.mjs (this file's caller) also reads.
  const { probeTool } = await import('./diag.mjs');
  return probeTool('codex');
}

// The installed Codex version as { version, fits } ({ version: null, fits: null } when there is none to read).
async function reading({ probe = defaultProbe, now = Date.now } = {}) {
  if (kept && now() - kept.at < (kept.fits ? FIT_KEEP_MS : UNKNOWN_KEEP_MS)) return kept;
  let found = null;
  try {
    found = await probe();
  } catch {
    found = null;
  }
  // Not installed: nothing to judge here; the run itself says that Codex is not installed, with its install line.
  if (found && found.found === false) return { version: null, fits: null };
  const version = typeof found?.version === 'string' && found.version ? found.version : null;
  const fits = codexFits(version);
  const out = { at: now(), version, fits };
  if (fits !== false) kept = out;
  else kept = null;
  return out;
}

// The error that names the old Codex. version is the version read (null when only Codex's own words said it is too old).
function tooOld(id, version, { label = 'Codex', detail = '', said = false } = {}) {
  const name = nameOf(id);
  const has = version ? `this PC has ${label} ${version}` : `${label} said that the version on this PC is too old`;
  const verdict = {
    kind: 'flags-rejected',
    message: said
      ? `${name} needs ${label} ${CODEX_MIN_VERSION} or newer, and ${has}.`
      : `${name} needs ${label} ${CODEX_MIN_VERSION} or newer, and ${has}, so this run was not started and nothing was sent.`,
    next: `Update ${label}: run ${CODEX_UPDATE} in a terminal, then send the message again. Until then, pick another model.`,
    retryable: false,
    detail,
    flag: null,
    resetsAt: null,
  };
  return Object.assign(new CliError('codex', verdict, { code: null, partial: false, raw: '', stderr: '' }), {
    before: !said,
    ...(version ? { version } : {}),
    needsVersion: CODEX_MIN_VERSION,
    update: CODEX_UPDATE,
  });
}

export async function codexVersionGate(id, opts = {}) {
  if (!isGpt62(id)) return null;
  const { version, fits } = await reading(opts);
  return fits === false ? tooOld(id, version, opts) : null;
}

// Codex's own words for "this model needs a newer Codex" (its 400 answer for a model newer than the CLI, as OpenAI words it for other
// models: "The '<model>' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.").
const NEWER = /\b(?:requires?|needs?)\s+(?:a\s+)?(?:newer|later|more recent|updated)\s+(?:version|release)\b|\bplease\s+(?:upgrade|update)\b[^\n]{0,40}\b(?:codex|cli|app|version)\b|\bupgrade\s+(?:codex|to\s+(?:the\s+)?(?:latest|a\s+newer))\b|\bnot\s+supported\s+(?:by|in|on)\s+this\s+version\b|\bminimum\s+(?:client\s+)?version\b/i;

export async function codexTooOldAfter(err, id, opts = {}) {
  if (!isGpt62(id) || !err || err.partial) return null;
  const words = [err.raw, err.detail, err.stderr, err.message].filter(w => typeof w === 'string').join('\n');
  // Read again (a reading that fits is kept, a reading that is too old never is): the version may be known by now.
  const { version, fits } = await reading(opts);
  if (fits === false) return tooOld(id, version, { ...opts, detail: err.detail ?? '', said: true });
  if (fits !== true && NEWER.test(words)) return tooOld(id, null, { ...opts, detail: err.detail ?? '', said: true });
  return null;
}
