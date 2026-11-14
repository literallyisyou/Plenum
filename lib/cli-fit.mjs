// Before a run: is this command line known not to fit the CLI that is installed? (DECISIONS: failed-reply buttons; audit cli-6, stage 2.)
//
// What Plenum knows today about a CLI's fit is what the CLI itself said: a run that it refused at its command line ("unknown option
// --x", lib/cli-errors.mjs kind 'flags-rejected'). This module remembers that refusal for the version that made it, so the next run
// that would send the same thing to the same version is refused here, in words, before the CLI is started and before any prompt is
// sent. Nothing is guessed from a help page: a CLI is held back only by its own refusal of the same option (or, when it named none, of
// exactly the same command line), and only while its version is the one that refused.
//
// The contract, pinned by build/v06/d-failed-reply/fit.test.mjs:
//   rememberRefusal(cli, { flag, args }, { probe, now }) -> Promise<boolean>
//     Call it when a run of `cli` failed with kind 'flags-rejected'. flag is the option the CLI named (or null), args the command line
//     that was sent. The CLI's version is read once with `--version` (never a prompt). Without a version nothing is remembered. A refusal
//     that named no option is remembered only for a short command line (at most ARGS_MAX arguments, none longer than ARG_MAX), so a
//     prompt that travelled as an argument is never kept.
//   knownMisfit(cli, args, { probe, now, model, label }) -> Promise<CliError | null>
//     Resolves to the error to throw instead of starting the CLI, or null (start it). It costs nothing when no refusal is on record for
//     this CLI. label is the name a person knows the CLI by (cliLabel(cli) when left out). With one on record it reads the version again: a version that changed, or that cannot be read, forgets the refusal and
//     the run starts. The error has kind 'flags-rejected', retryable false, before: true and the version.
//   forgetRefusals(cli?)  forgets one CLI's refusals, or all of them (tests; a sign that the CLI was reinstalled).
// The memory lives in this process only and each entry ends after KEEP_MS, so a wrong entry can never outlive a restart or an hour.
// probe(cli) -> Promise<{ version }> is lib/diag.mjs probeTool by default (hidden, ended after 4 seconds); the tests pass their own.

import { CliError, cliLabel } from './cli-errors.mjs';

export const KEEP_MS = 60 * 60 * 1000;
const ARGS_MAX = 6;
const ARG_MAX = 60;

// cli -> { version, at, flags: Set<string>, lines: Set<string> }
const refusals = new Map();

async function defaultProbe(cli) {
  // Loaded when it is needed: lib/diag.mjs reads lib/proc.mjs, which may call this module.
  const { probeTool } = await import('./diag.mjs');
  return probeTool(cli);
}

async function versionOf(cli, probe) {
  try {
    const found = await (probe ?? defaultProbe)(cli);
    return typeof found?.version === 'string' && found.version ? found.version : null;
  } catch {
    return null;
  }
}

const isFlag = value => typeof value === 'string' && /^--?[A-Za-z][A-Za-z0-9-]*$/.test(value);
const list = args => (Array.isArray(args) ? args.map(a => String(a ?? '')) : []);
// The command line as one text, when it is short enough to be a command line and not a prompt.
const lineOf = args => {
  const all = list(args);
  return all.length > 0 && all.length <= ARGS_MAX && all.every(a => a.length <= ARG_MAX) ? JSON.stringify(all) : null;
};
// True when args carry the option: as its own argument or as "--name=value".
const sends = (args, flag) => list(args).some(a => a === flag || a.startsWith(`${flag}=`));

export async function rememberRefusal(cli, { flag = null, args = [] } = {}, { probe, now = Date.now } = {}) {
  if (typeof cli !== 'string' || !cli) return false;
  const named = isFlag(flag) && sends(args, flag) ? flag : null;
  const line = named ? null : lineOf(args);
  if (!named && !line) return false;
  const version = await versionOf(cli, probe);
  if (!version) return false;
  let entry = refusals.get(cli);
  if (!entry || entry.version !== version) {
    entry = { version, at: now(), flags: new Set(), lines: new Set() };
    refusals.set(cli, entry);
  }
  entry.at = now();
  if (named) entry.flags.add(named);
  else entry.lines.add(line);
  return true;
}

export async function knownMisfit(cli, args = [], { probe, now = Date.now, model = null, label = cliLabel(cli) } = {}) {
  const entry = refusals.get(cli);
  if (!entry) return null;
  if (now() - entry.at > KEEP_MS) {
    refusals.delete(cli);
    return null;
  }
  const flag = [...entry.flags].find(f => sends(args, f)) ?? null;
  const line = flag ? null : lineOf(args);
  if (!flag && !(line && entry.lines.has(line))) return null;
  // The CLI may have updated itself since it refused: only the same version is held back.
  const version = await versionOf(cli, probe);
  if (version !== entry.version) {
    refusals.delete(cli);
    return null;
  }
  const what = flag ? `the option ${flag}` : 'the command';
  const verdict = {
    kind: 'flags-rejected',
    message: `${label} ${version} did not accept ${what} that Plenum sends, and it is still that version, so this run was not started and nothing was sent.`,
    next: `Update Plenum, or update ${label} and send the message again. Until then, pick another model.`,
    retryable: false,
    detail: '',
    flag,
    resetsAt: null,
  };
  return Object.assign(new CliError(cli, verdict, { code: null, partial: false, raw: '', stderr: '' }), { before: true, version, ...(model ? { model } : {}) });
}

export function forgetRefusals(cli) {
  if (cli === undefined) refusals.clear();
  else refusals.delete(cli);
}
