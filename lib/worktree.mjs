// Isolated copies of a project for its threads (pro-02): one git worktree per thread, on a branch of its own, in a folder outside the project.
//
// Where: %LOCALAPPDATA%\PlenumWT\<8 hex> on Windows, ~/.plenum-wt/<8 hex> elsewhere (worktreeRoot in lib/guard.mjs). Never under
// ~/.muse-console, which is off limits to every tool, and never under OneDrive, so an agent's writes do not start a sync.
//
// What this file does, and what the rest of the app does with it:
//   - slugOf, branchFor, checkBranch   the branch name `plenum/<slug>-<4 hex>` (the slug is the thread's name, a-z 0-9 and -, at most 32)
//   - normalizeSettings, settingsOf    the project's copy settings (project.worktree: setup command, its time limit, the files to copy in)
//   - createWorktree                   an async generator: makes the copy, copies the listed files, runs the setup command, and yields the
//                                      events the stream shows ({ type: 'notice', text, output? } and a last { type: 'worktree', ... })
//   - uncommittedIn, staleNotice       the files in the project folder that are not committed, which a new copy will not have (it starts
//                                      from the last commit): createWorktree says so in one notice (kind 'worktree-stale-base'), and
//                                      repoInfo counts them for the New thread panel. A new folder that holds nothing but files of
//                                      the copy setting does not count (Plenum copies those in)
//   - keepWorktree, discardWorktree    commit the copy's changes on its branch and remove the folder / remove the folder (branch kept)
//   - mergeWorktree                    an async generator: Phase 2, merges the branch into the base after a click-only approval card
//   - worktreeStatus                   the branch and the number of changed files, for the chip
// The record of a copy (state.json worktrees[threadId]) and what the rest of Plenum reads from it are in lib/scope.mjs.
//
// Every git call goes through runGit (lib/git-run.mjs): fsmonitor off, an empty hooks folder (so post-checkout, pre-commit and merge hooks
// never run), no terminal prompt, and the trimmed environment of lib/git-env.mjs. Each call is a fixed list; the only variable parts are the
// copy's folder and branch (made here) and the base git reported. Filters set in the repository's own configuration can still run on a
// checkout, as they do when the person runs git (the residual risk of DECISIONS item 30). The setup command goes through the deny list and
// run_command's runner, with the provider keys stripped from its environment.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DIFF_SAFE, runGit } from './git-run.mjs';
import { gitStatus } from './git-status.mjs';
import { checkAccess, folderRisk, isCredentialPath, worktreeRoot } from './guard.mjs';
import { checkCommand } from './denylist.mjs';
import { capDetail } from './diff.mjs';
import { insideRoot } from './files.mjs';
import { runShell } from './proc.mjs';
import { shellFor } from './platform/index.mjs';
import { chatModeOf, denyPatternsOf } from './projects.mjs';
import { commandCredentialHit, cutFull } from './tools.mjs';
import { holdWorktree, ownWorktreePath, worktreeOf, worktreeRecord } from './scope.mjs';

export { worktreeRoot };

export const SETUP_MAX = 300;
export const COPY_MAX_FILES = 20;
export const COPY_MAX_BYTES = 1024 * 1024;
export const TIMEOUT = Object.freeze({ min: 5, max: 900, default: 120 });
export const MESSAGE_MAX = 200;
const ADD_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 30_000;
// Removing a copy deletes every file in it, node_modules included, which can take minutes on Windows. git is given this long before it is
// stopped, so a slow delete is not cut off half way.
const REMOVE_TIMEOUT_MS = 300_000;
// The most file names the notice about uncommitted work lists; the rest are counted.
const STALE_LISTED = 5;
const SETUP_OUTPUT_MAX = 30_000;
const SETUP_TAIL = 2000;
// The branches Plenum makes. Only a name like this is ever deleted.
const BRANCH_RE = /^plenum\/[a-z0-9-]{1,32}-[0-9a-f]{4}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const COMMIT_ID = /^[0-9a-f]{40,64}$/;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const fail = (status, message) => Object.assign(new Error(message), { status });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = p => fs.stat(p).then(() => true, () => false);
// True when something is at the path, a link that leads nowhere included (fs.stat follows a link, so it would call that missing).
const present = p => fs.lstat(p).then(() => true, () => false);
const chars = text => Array.from(String(text));

// ---------- names ----------

// The thread's name as a branch part: lower case, every run of other characters one '-', no '-' at either end, at most 32 characters.
// A name with nothing usable in it ('???') is 'thread'.
export function slugOf(name) {
  const slug = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 32).replace(/-+$/, '');
  return slug || 'thread';
}

export const hex = bytes => randomBytes(bytes).toString('hex');
export const branchFor = name => `plenum/${slugOf(name)}-${hex(2)}`;
export const isPlenumBranch = name => typeof name === 'string' && BRANCH_RE.test(name);

// True when git accepts the name as a branch name.
export async function checkBranch(cwd, name) {
  if (!isPlenumBranch(name)) return false;
  const r = await runGit(['check-ref-format', '--branch', name], { cwd, timeoutMs: 10_000 });
  return r.ok;
}

// The last useful line of git's complaint, without its fatal: or error: prefix, at most 300 characters.
export function gitError(r, fallback = 'git did not answer') {
  if (r?.notFound) return 'git is not installed.';
  if (r?.timedOut) return 'git took too long to answer.';
  if (r?.tooBig) return 'git printed too much.';
  // git says most things on stderr, but a refusal such as "nothing to commit" is on stdout.
  const said = String(r?.stderr ?? '').trim() ? r.stderr : r?.stdout;
  const lines = String(said ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const pick = [...lines].reverse().find(l => /^(fatal|error):/i.test(l)) ?? lines.at(-1) ?? '';
  return (pick.replace(/^(fatal|error):\s*/i, '') || fallback).slice(0, 300);
}

// ---------- the project's copy settings ----------

function wholeSeconds(raw) {
  if (raw === undefined || raw === null || raw === '') return TIMEOUT.default;
  const n = typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : raw;
  if (!Number.isInteger(n) || n < TIMEOUT.min || n > TIMEOUT.max) throw new Error(`The time limit is a whole number of seconds from ${TIMEOUT.min} to ${TIMEOUT.max}.`);
  return n;
}

// Why one project-relative path cannot be copied, or ''. The path is checked as written; copyFiles checks the real file again.
export function copyShape(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return 'is empty';
  if (CONTROL.test(text)) return 'has a control character in it';
  if (chars(text).length > 260) return 'is longer than 260 characters';
  if (text.startsWith('~') || path.isAbsolute(text) || /^[a-zA-Z]:/.test(text) || text.startsWith('\\\\') || text.startsWith('/')) return 'must be a path inside the project, not an absolute one';
  const slashed = text.replace(/\\/g, '/');
  const segments = slashed.split('/');
  if (segments.includes('..')) return 'must stay inside the project, so it cannot go up a folder';
  if (segments.some(s => s.toLowerCase() === '.git')) return 'must not be inside .git';
  if (slashed.endsWith('/')) return 'names a folder; name the files in it';
  // Windows cannot hold a '*' or '?' in a file name, so a wildcard there can never match and is refused when it is saved (C-13).
  // Elsewhere such a name is a legal file name and is still copied as written.
  if (process.platform === 'win32' && /[*?]/.test(slashed)) return 'is a pattern; wildcards are not supported, so name each file';
  return '';
}

// The path as it is kept: forward slashes, no leading ./ and no repeated slashes.
const tidy = text => String(text).trim().replace(/\\/g, '/').split('/').filter(s => s !== '' && s !== '.').join('/');

// The list of files to copy, from an array or from text with one path per line. Throws an Error with the message the person reads.
export function normalizeCopyList(raw, project) {
  if (raw === undefined || raw === null || raw === '') return [];
  const lines = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/\r?\n/) : null;
  if (!lines) throw new Error('The files to copy are a list of paths, one per line.');
  const out = [];
  for (const entry of lines) {
    if (typeof entry !== 'string') throw new Error('Each file to copy is a path in the project.');
    if (!entry.trim()) continue;
    const why = copyShape(entry);
    if (why) throw new Error(`"${entry.trim().slice(0, 80)}" ${why}.`);
    const rel = tidy(entry);
    if (!rel) continue;
    if (project?.path && isCredentialPath(path.resolve(project.path, ...rel.split('/')))) throw new Error(`"${rel.slice(0, 80)}" is in a folder that holds credentials. Credential folders are never copied.`);
    if (!out.some(x => x.toLowerCase() === rel.toLowerCase())) out.push(rel);
  }
  if (out.length > COPY_MAX_FILES) throw new Error(`Name at most ${COPY_MAX_FILES} files to copy.`);
  return out;
}

// Why the setup command must not run, or null: a deny-list rule (the built-in ones and the project's patterns) or a credential folder.
export function setupRefusal(command, project, root) {
  const hit = checkCommand(command, denyPatternsOf(project), { projectRoot: root ?? project?.path });
  if (hit?.blocked) return { kind: 'rule', rule: String(hit.rule || 'command deny list') };
  if (commandCredentialHit(command, { root: root ?? project?.path })) return { kind: 'credential' };
  return null;
}

// Validates what the page sends and returns what is stored: { setup, setupTimeoutSec, copy }. Throws an Error with the message the person
// reads; a setup command that a rule blocks is refused with the rule's name.
export function normalizeSettings(input, project) {
  if (!isObject(input)) throw new Error('Send the setup command, its time limit and the files to copy.');
  const raw = input.setup === undefined || input.setup === null ? '' : input.setup;
  if (typeof raw !== 'string') throw new Error('The setup command must be text.');
  const setup = raw.trim();
  if (CONTROL.test(setup)) throw new Error('A setup command is one line, with no control characters.');
  if (chars(setup).length > SETUP_MAX) throw new Error(`A setup command is at most ${SETUP_MAX} characters.`);
  if (setup) {
    const refused = setupRefusal(setup, project);
    if (refused?.kind === 'rule') throw new Error(`That command is blocked by ${refused.rule}, so Plenum will not run it in a new copy.`);
    if (refused) throw new Error('That command names a folder that holds credentials, so Plenum will not run it in a new copy.');
  }
  return { setup, setupTimeoutSec: wholeSeconds(input.setupTimeoutSec), copy: normalizeCopyList(input.copy, project) };
}

// The settings a project has, read on their own: a stored value that no longer validates is read with defaults.
export function settingsOf(project) {
  const raw = isObject(project?.worktree) ? project.worktree : {};
  const sec = Number.isInteger(raw.setupTimeoutSec) && raw.setupTimeoutSec >= TIMEOUT.min && raw.setupTimeoutSec <= TIMEOUT.max ? raw.setupTimeoutSec : TIMEOUT.default;
  let copy = [];
  try {
    copy = normalizeCopyList(Array.isArray(raw.copy) ? raw.copy : [], project);
  } catch {
    copy = (Array.isArray(raw.copy) ? raw.copy : []).filter(p => typeof p === 'string' && !copyShape(p)).map(tidy).slice(0, COPY_MAX_FILES);
  }
  return { setup: typeof raw.setup === 'string' ? raw.setup.trim().slice(0, SETUP_MAX) : '', setupTimeoutSec: sec, copy };
}

// Keeps the settings on the project, beside its other records (not in project.settings, which a settings save replaces).
export function storeSettings(project, settings) {
  const same = settings.setup === '' && settings.setupTimeoutSec === TIMEOUT.default && settings.copy.length === 0;
  if (same) delete project.worktree;
  else project.worktree = { setup: settings.setup, setupTimeoutSec: settings.setupTimeoutSec, copy: settings.copy };
}

// ---------- the repository ----------

// What the New thread panel needs to know: whether the project folder is a git repository (the toggle is shown only then), and how many
// files in it are not committed, with the first names (a copy starts from the last commit, so it will not have them).
export async function repoInfo(project) {
  const st = await gitStatus(project.path);
  const left = await uncommittedOf(st, project);
  return {
    repo: st.repo === true, noGit: st.noGit === true, branch: st.repo ? st.branch : '', detached: st.repo ? st.detached : false,
    uncommitted: left.count, uncommittedNames: left.names,
  };
}

// A file name as it is compared: Windows does not tell upper case from lower case.
const foldName = p => (process.platform === 'win32' ? String(p).toLowerCase() : String(p));

// True when a new folder that git lists as one entry ('config/') holds nothing the copy will miss: every file in it that git would list is
// one the project's copy setting names, so Plenum copies it in. One read-only git call for that folder (the folder name is one git itself
// printed, and it is passed as a literal path). When git does not answer, or lists too much, the folder counts as uncommitted work.
async function onlyCopySettingFiles(project, folder, ours) {
  const r = await runGit(['ls-files', '--others', '--exclude-standard', '-z', '--', `:(literal)${folder}`], { cwd: project.path, timeoutMs: 10_000, maxBuffer: 256 * 1024 });
  if (!r.ok) return false;
  const files = r.stdout.split('\0').filter(Boolean);
  return files.length > 0 && files.every(f => ours.has(foldName(f)));
}

// The uncommitted work in an answer of gitStatus for the project folder: { count, names }. count is every changed, untracked and unmerged
// entry (an untracked folder is one entry, as git lists it, and its name ends in '/'); names are the first STALE_LISTED paths, as git
// wrote them (relative to the project folder). The files the project's copy setting names do not count, because Plenum copies those into
// the copy itself, and neither does a new folder that holds only such files. An answer that is not a repository counts nothing.
async function uncommittedOf(st, project) {
  if (st?.repo !== true) return { count: 0, names: [] };
  const copy = settingsOf(project).copy.map(foldName);
  const ours = new Set(copy);
  const paths = [...(st.changed ?? []), ...(st.untracked ?? [])];
  const kept = [];
  for (const p of paths) {
    const name = foldName(p);
    if (ours.has(name)) continue;
    if (name.endsWith('/') && copy.some(c => c.startsWith(name)) && (await onlyCopySettingFiles(project, String(p), ours))) continue;
    kept.push(p);
  }
  const count = Math.max(0, (st.changedCount ?? 0) + (st.untrackedCount ?? 0) + (st.unmerged ?? 0) - (paths.length - kept.length));
  return { count, names: kept.slice(0, STALE_LISTED).map(p => String(p).slice(0, 120)) };
}

// The files in the project folder that are not committed: { count, names } (see uncommittedOf). One read-only git status, and one more
// read for each new folder that holds a file of the copy setting.
export async function uncommittedIn(project) {
  return uncommittedOf(await gitStatus(project.path), project);
}

// The notice a new copy gets when the project folder has uncommitted work, or '' when it has none. base is the branch the copy starts from
// (the commit, for a detached head). A name that ends in '/' is a new folder, so the notice then speaks of files or folders. When no
// name is known (every entry is a file with a merge conflict, which the status read counts without a name), it gives the number alone.
export function staleNotice({ count, names }, { base, baseKind } = {}) {
  if (!Number.isInteger(count) || count <= 0) return '';
  const known = Array.isArray(names) ? names : [];
  const from = baseKind === 'commit' ? `commit ${String(base ?? '').slice(0, 7)}` : `the last commit of ${base}`;
  const folders = known.some(n => String(n).endsWith('/'));
  const noun = count === 1 ? (folders ? 'folder' : 'file') : folders ? 'files or folders' : 'files';
  const what = count === 1 ? `1 ${noun} in the project folder is not committed, so the copy does not have it` : `${count} ${noun} in the project folder are not committed, so the copy does not have them`;
  const them = count === 1 ? 'it' : 'them';
  const more = count > known.length ? ` and ${count - known.length} more` : '';
  const listed = known.length ? `${known.join(', ')}${more}` : '';
  const list = listed ? `: ${listed.length > 300 ? `${listed.slice(0, 297)}…` : listed}` : '';
  return `The copy starts from ${from}. ${what}${list}. Commit ${them} first if this thread needs ${them}.`;
}

// The base a copy starts from: the branch the project folder is on, or the commit when the head is detached. Throws a 409 when the
// repository has no commit yet (a copy needs something to start from).
export async function detectBase(cwd) {
  const head = await runGit(['rev-parse', '--verify', '-q', 'HEAD'], { cwd, timeoutMs: 10_000 });
  if (!head.ok) throw fail(409, 'This repository has no commits yet. Make a first commit, then make the copy.');
  const sym = await runGit(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd, timeoutMs: 10_000 });
  const branch = sym.ok ? sym.stdout.trim() : '';
  if (branch && !branch.startsWith('-')) return { base: branch, baseKind: 'branch' };
  const rev = await runGit(['rev-parse', 'HEAD'], { cwd, timeoutMs: 10_000 });
  const commit = rev.stdout.trim();
  if (!rev.ok || !COMMIT_ID.test(commit)) throw fail(409, 'Plenum could not tell which commit the project folder is on.');
  return { base: commit, baseKind: 'commit' };
}

// The folder of the project inside its repository, written with '/' ('' when the project is the top of it).
async function projectPrefix(cwd) {
  const r = await runGit(['rev-parse', '--show-prefix'], { cwd, timeoutMs: 10_000 });
  const prefix = r.ok ? r.stdout.trim().replace(/\/+$/, '') : '';
  return prefix && !prefix.split('/').includes('..') ? prefix : '';
}

// Makes the copies folder if it is not there and checks it: it must pass folderRisk (the one rule about copies aside, which is about what
// is inside it), must not be inside the project, must not contain the project, and must not be under OneDrive. Returns the folder.
export async function ensureRoot(project) {
  const root = worktreeRoot();
  await fs.mkdir(root, { recursive: true });
  const real = await fs.realpath(root).catch(() => root);
  const risk = folderRisk(real, { copiesOk: true }) ?? folderRisk(root, { copiesOk: true });
  if (risk) throw fail(409, `Plenum cannot keep isolated copies in ${root}: ${risk}`);
  const projectReal = await fs.realpath(project.path).catch(() => project.path);
  if (insideRoot(projectReal, real) || insideRoot(real, projectReal)) throw fail(409, 'The folder for isolated copies is inside this project, or the project is inside it, so no copy can be made.');
  if (real.split(/[\\/]+/).some(part => /^onedrive(\s|$|-)/i.test(part))) {
    throw fail(409, `The folder for isolated copies (${real}) is inside OneDrive, which would sync every edit an agent makes. Move it out of OneDrive.`);
  }
  return root;
}

// ---------- making a copy ----------

// Whatever an earlier try left: the git worktree, a half-made folder, and the branch when it has no commits beyond the base.
async function cleanupAttempt(project, { path: wtPath, branch, base }) {
  if (wtPath && ownWorktreePath(wtPath)) {
    await runGit(['worktree', 'remove', '--force', wtPath], { cwd: project.path, timeoutMs: GIT_TIMEOUT_MS });
    if (await exists(wtPath)) await fs.rm(wtPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }).catch(() => {});
    await runGit(['worktree', 'prune'], { cwd: project.path, timeoutMs: GIT_TIMEOUT_MS });
  }
  if (isPlenumBranch(branch) && typeof base === 'string' && base && !base.startsWith('-')) {
    const there = await runGit(['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { cwd: project.path, timeoutMs: 10_000 });
    if (there.ok) {
      const ahead = await runGit(['rev-list', '--count', `${base}..${branch}`], { cwd: project.path, timeoutMs: 10_000 });
      if (ahead.ok && ahead.stdout.trim() === '0') await runGit(['branch', '-D', branch], { cwd: project.path, timeoutMs: 10_000 });
    }
  }
}

// Copies the listed project files into the copy. Each source and target is checked as it really is: not outside the project or the copy, not
// refused by checkAccess or isCredentialPath, a regular file of at most 1 MB. Returns { copied: [rel], skipped: [{ rel, why }] }.
export async function copyFiles({ from, to, list }) {
  const copied = [];
  const skipped = [];
  const realFrom = await fs.realpath(from);
  const realTo = await fs.realpath(to);
  for (const rel of list) {
    try {
      const why = copyShape(rel);
      if (why) throw new Error(why);
      const parts = tidy(rel).split('/');
      const src = path.resolve(realFrom, ...parts);
      if (!insideRoot(realFrom, src)) throw new Error('is outside the project');
      const realSrc = await fs.realpath(src).catch(() => null);
      if (!realSrc) throw new Error('is not there');
      try {
        checkAccess(realSrc);
      } catch {
        throw new Error('is in a folder that holds credentials or system files');
      }
      if (isCredentialPath(realSrc)) throw new Error('is in a folder that holds credentials');
      if (!insideRoot(realFrom, realSrc)) throw new Error('is a link that leaves the project');
      const info = await fs.stat(realSrc);
      if (!info.isFile()) throw new Error('is not a file');
      if (info.size > COPY_MAX_BYTES) throw new Error('is over 1 MB');
      const dst = path.resolve(realTo, ...parts);
      if (!insideRoot(realTo, dst)) throw new Error('would be outside the copy');
      await fs.mkdir(path.dirname(dst), { recursive: true });
      const realDir = await fs.realpath(path.dirname(dst));
      if (!insideRoot(realTo, realDir)) throw new Error('would leave the copy through a link');
      const target = path.join(realDir, path.basename(dst));
      const there = await fs.lstat(target).catch(() => null);
      if (there?.isSymbolicLink()) throw new Error('is a link in the copy');
      try {
        checkAccess(target, { write: true });
      } catch {
        throw new Error('would be written into a folder that Plenum never writes in');
      }
      if (isCredentialPath(target)) throw new Error('would be written into a folder that holds credentials');
      await fs.copyFile(realSrc, target);
      copied.push(tidy(rel));
    } catch (err) {
      skipped.push({ rel: String(rel).slice(0, 120), why: err.message });
    }
  }
  return { copied, skipped };
}

const tail = (text, n) => {
  const list = chars(text);
  return list.length <= n ? String(text) : list.slice(-n).join('');
};

// Makes a thread's copy. An async generator over the events the stream sends; the record in state.json is saved at each step, and it ends
// as 'ready' or 'failed'. store is lib/store.mjs (get, saveOrFail); scope is the thread's scope (lib/scope.mjs); signal stops it.
export async function* createWorktree({ store, project, scope, signal }) {
  const st = store.get();
  const rec = worktreeRecord(st, scope.id);
  if (!rec || !['creating', 'failed'].includes(rec.state)) {
    throw fail(409, rec ? 'This thread already has an isolated copy.' : 'This thread was not made with an isolated copy.');
  }
  const release = holdWorktree(scope.id);
  if (!release) throw fail(409, 'This thread\'s isolated copy is being made already.');
  const previous = { path: rec.path, branch: rec.branch, base: rec.base };
  let wtPath = '';
  let branch = '';
  let base = '';
  const failWith = async message => {
    await cleanupAttempt(project, { path: wtPath || previous.path, branch: branch || previous.branch, base: base || previous.base });
    st.worktrees[scope.id] = { state: 'failed', error: message, requestedAt: rec.requestedAt };
    await store.saveOrFail();
    return { type: 'notice', kind: 'worktree-failed', text: `The isolated copy could not be made: ${message}.` };
  };
  try {
    if (previous.path || previous.branch) await cleanupAttempt(project, previous);
    let root;
    let found;
    let sub;
    try {
      root = await ensureRoot(project);
      found = await detectBase(project.path);
      sub = await projectPrefix(project.path);
    } catch (err) {
      yield await failWith(String(err.message).replace(/\.$/, ''));
      yield { type: 'worktree', state: 'failed', error: st.worktrees[scope.id].error };
      return;
    }
    base = found.base;
    // A name git accepts and no branch has yet; a clash is rare (4 hex digits), so a few tries are plenty.
    for (let i = 0; i < 8 && !branch; i += 1) {
      const candidate = branchFor(scope.name);
      if (!(await checkBranch(project.path, candidate))) continue;
      const taken = await runGit(['rev-parse', '--verify', '-q', `refs/heads/${candidate}`], { cwd: project.path, timeoutMs: 10_000 });
      if (!taken.ok) branch = candidate;
    }
    if (!branch) {
      yield await failWith('git did not accept a branch name for this thread');
      yield { type: 'worktree', state: 'failed', error: st.worktrees[scope.id].error };
      return;
    }
    for (let i = 0; i < 8; i += 1) {
      const candidate = path.join(root, hex(4));
      if (!(await exists(candidate))) {
        wtPath = candidate;
        break;
      }
    }
    if (!wtPath) {
      yield await failWith('no free folder name was found');
      yield { type: 'worktree', state: 'failed', error: st.worktrees[scope.id].error };
      return;
    }
    st.worktrees[scope.id] = { state: 'creating', path: wtPath, branch, base, baseKind: found.baseKind, sub, requestedAt: rec.requestedAt ?? Date.now() };
    await store.saveOrFail();
    yield { type: 'notice', text: `Creating an isolated copy on ${branch}…` };

    // The copy starts from the last commit. What the person changed in the project folder and has not committed is not in it, so the stream
    // says which files those are. Read before the copy is made; a read that fails says nothing and stops nothing.
    const stale = staleNotice(await uncommittedIn(project).catch(() => ({ count: 0, names: [] })), found);
    if (stale) yield { type: 'notice', kind: 'worktree-stale-base', text: stale };

    const added = await runGit(['worktree', 'add', '-b', branch, wtPath, base], { cwd: project.path, timeoutMs: ADD_TIMEOUT_MS });
    if (signal?.aborted) {
      yield await failWith('it was stopped before the copy was ready');
      yield { type: 'worktree', state: 'failed', error: st.worktrees[scope.id].error };
      return;
    }
    if (!added.ok) {
      yield await failWith(gitError(added, 'git could not make the copy').replace(/\.$/, ''));
      yield { type: 'worktree', state: 'failed', error: st.worktrees[scope.id].error };
      return;
    }
    const folder = sub ? path.join(wtPath, ...sub.split('/')) : wtPath;

    // The files the project asked to have copied in.
    const settings = settingsOf(project);
    let copied = [];
    if (settings.copy.length) {
      const result = await copyFiles({ from: project.path, to: folder, list: settings.copy });
      copied = result.copied;
      if (copied.length) {
        const names = copied.join(', ');
        yield { type: 'notice', text: `Copied ${copied.length} ${copied.length === 1 ? 'file' : 'files'}: ${names.length > 300 ? `${names.slice(0, 297)}…` : names}` };
      }
      for (const item of result.skipped) yield { type: 'notice', text: `Not copied: ${item.rel} ${item.why}.` };
    }

    // The setup command, through the deny list and run_command's runner.
    if (settings.setup) {
      const planMode = chatModeOf(project) === 'plan' || scope.chatMode === 'plan';
      const refused = planMode ? { kind: 'plan' } : setupRefusal(settings.setup, project, folder);
      if (refused?.kind === 'plan') yield { type: 'notice', text: 'Setup not run: plan mode is on.' };
      else if (refused?.kind === 'rule') yield { type: 'notice', text: `Setup not run: blocked by ${refused.rule}.` };
      else if (refused) yield { type: 'notice', text: 'Setup not run: it names a folder that holds credentials.' };
      else {
        yield { type: 'notice', text: `Running setup: ${settings.setup}` };
        const began = Date.now();
        const run = await runShell(settings.setup, { cwd: folder, timeoutMs: settings.setupTimeoutSec * 1000, signal, maxOutput: SETUP_OUTPUT_MAX, shell: shellFor() });
        const seconds = ((Date.now() - began) / 1000).toFixed(1);
        if (run.code === 0 && !run.timedOut && !run.aborted) {
          yield { type: 'notice', text: `Setup finished (exit 0, ${seconds} s).` };
        } else {
          const how = run.timedOut ? `timed out after ${settings.setupTimeoutSec} s` : run.aborted ? 'stopped' : run.error ? `did not start: ${run.error}` : `exit ${run.code}`;
          yield { type: 'notice', kind: 'worktree-setup-failed', text: `Setup failed (${how}). The copy is ready, but its dependencies may be missing.`, output: tail(String(run.output ?? '').trimEnd(), SETUP_TAIL) };
        }
      }
    }

    st.worktrees[scope.id] = { state: 'ready', path: wtPath, branch, base, baseKind: found.baseKind, sub, createdAt: Date.now(), ...(copied.length ? { copied } : {}) };
    await store.saveOrFail();
    yield { type: 'worktree', state: 'ready', branch, base };
  } finally {
    release();
  }
}

// ---------- the copy's state ----------

// The project a thread belongs to: the one whose thread list holds it (state.json keeps the lists by project id), or null.
function projectOfThread(st, id) {
  return (Array.isArray(st?.projects) ? st.projects : []).find(p => (st.threads?.[p?.id]?.list ?? []).some(e => e?.id === id)) ?? null;
}

// The commits on the copy's branch that its base does not have: what deleting the branch would drop. Counted in a folder of the repository, which
// has every copy's branch, so it still works when the copy's folder is gone. null when git cannot say.
async function commitsOnBranch(cwd, wt) {
  if (!cwd || !isPlenumBranch(wt.branch) || typeof wt.base !== 'string' || !wt.base || wt.base.startsWith('-')) return null;
  const r = await runGit(['rev-list', '--count', `${wt.base}..${wt.branch}`], { cwd, timeoutMs: 10_000 });
  const n = r.ok ? Number(r.stdout.trim()) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// The branch and the number of changed files in the copy, for the chip. A copy that is not ready gets only its state, and a missing one its
// ahead too. ahead is the commits on the copy's branch beyond its base (null when git cannot say): Discard asks about them before it deletes the
// branch, which drops them.
export async function worktreeStatus(st, id) {
  const wt = worktreeOf(st, id);
  if (!wt) return null;
  const project = projectOfThread(st, id);
  if (wt.state === 'missing') {
    const ahead = await commitsOnBranch(project?.path, wt);
    return { state: wt.state, branch: wt.branch, base: wt.base, ahead, ...(wt.error ? { error: wt.error } : {}) };
  }
  if (wt.state !== 'ready') return { state: wt.state, branch: wt.branch, base: wt.base, ...(wt.error ? { error: wt.error } : {}) };
  const ahead = await commitsOnBranch(project?.path ?? wt.path, wt);
  const s = await gitStatus(wt.path);
  if (!s.repo) return { state: 'ready', branch: wt.branch, base: wt.base, files: null, ahead, error: s.error ?? 'git did not answer' };
  // The files Plenum itself copied in (a .env) are not changes the thread made, so the count leaves them out.
  const ours = new Set((wt.copied ?? []).map(rel => (wt.sub ? `${wt.sub}/${rel}` : rel)));
  const own = s.untracked.filter(p => ours.has(p)).length;
  const files = s.changedCount + s.untrackedCount - own + s.unmerged;
  return { state: 'ready', branch: s.branch || wt.branch, base: wt.base, baseKind: wt.baseKind, files, clean: files === 0, ahead, behind: s.behind };
}

// ---------- committing, keeping and discarding ----------

export const defaultMessage = name => `Plenum thread: ${String(name ?? '').replace(CONTROL, ' ').trim()}`.slice(0, MESSAGE_MAX);

// A one-line commit message of at most 200 characters; an empty one takes the default.
export function cleanMessage(raw, name) {
  const text = typeof raw === 'string' ? raw.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim() : '';
  if (!text) return defaultMessage(name);
  return chars(text).slice(0, MESSAGE_MAX).join('');
}

// The files copied into the copy that git does not track: they stay out of the commit, so a .env that was copied in is never committed.
async function untrackedCopies(wt) {
  const out = [];
  for (const rel of Array.isArray(wt.copied) ? wt.copied : []) {
    if (typeof rel !== 'string' || copyShape(rel)) continue;
    const spec = wt.sub ? `${wt.sub}/${rel}` : rel;
    const tracked = await runGit(['ls-files', '--error-unmatch', '--', spec], { cwd: wt.path, timeoutMs: 10_000 });
    if (!tracked.ok) out.push(`:(exclude,literal)${spec}`);
  }
  return out;
}

// True when git itself answers that the folder is not a working tree of a repository (it ran and said no). A git that is missing or did
// not answer in time is not a refusal.
async function refusedByGit(folder) {
  const r = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: folder, timeoutMs: 10_000 });
  return !r.ok && !r.notFound && !r.timedOut && typeof r.code === 'number';
}

// Commits everything in the copy on its branch ('add -A', then 'commit --no-verify'). Nothing to commit is not an error. When git has no user
// name (or no email), the commit is made as Plenum and `note` says so. Resolves { committed, note }.
export async function commitCopy(wt, message) {
  // A copy whose .git file is gone (a removal that stopped half way) is no longer a copy for git: a git command in it would fail, or answer
  // for whatever repository lies above the folder. Nothing is read or committed there; Discard removes what is left.
  if (!(await present(path.join(wt.path, '.git')))) {
    throw fail(409, `This isolated copy was partly removed already, so Plenum cannot read its changes. What was committed is on ${wt.branch}. Press Discard to remove what is left of the folder; the branch stays.`);
  }
  const dirty = await runGit(['status', '--porcelain'], { cwd: wt.path, timeoutMs: GIT_TIMEOUT_MS });
  if (!dirty.ok) {
    // The .git file is there, but git will not work in the folder: the repository's record of the copy is gone (pruned, or deleted by
    // hand). That is the half-removed case seen from the other side, and it gets the same kind of answer. A git that is missing, slow or
    // printed too much says so itself.
    if (!dirty.notFound && !dirty.timedOut && !dirty.tooBig && (await refusedByGit(wt.path))) {
      throw fail(409, `Plenum cannot read this isolated copy any more: git no longer accepts the folder as a copy. What was committed is on ${wt.branch}. Press Discard to remove the folder; the branch stays.`);
    }
    throw fail(500, `Plenum could not read the copy: ${gitError(dirty)}.`);
  }
  if (!dirty.stdout.trim()) return { committed: false, note: '' };
  const skip = await untrackedCopies(wt);
  const add = await runGit(skip.length ? ['add', '-A', '--', '.', ...skip] : ['add', '-A'], { cwd: wt.path, timeoutMs: ADD_TIMEOUT_MS });
  if (!add.ok) throw fail(500, `Plenum could not stage the changes: ${gitError(add)}.`);
  // Files copied in from the project (a .env) stay out of the commit, so a copy that holds nothing else has nothing to commit.
  if (skip.length) {
    const staged = await runGit(['diff', '--cached', '--name-only'], { cwd: wt.path, timeoutMs: GIT_TIMEOUT_MS });
    if (!staged.ok) throw fail(500, `Plenum could not read the staged changes: ${gitError(staged)}.`);
    if (!staged.stdout.trim()) return { committed: false, note: '' };
  }
  const name = (await runGit(['config', 'user.name'], { cwd: wt.path, timeoutMs: 10_000 })).stdout.trim();
  const email = (await runGit(['config', 'user.email'], { cwd: wt.path, timeoutMs: 10_000 })).stdout.trim();
  const identity = [...(name ? [] : ['-c', 'user.name=Plenum']), ...(email ? [] : ['-c', 'user.email=plenum@localhost'])];
  const commit = await runGit([...identity, 'commit', '--no-verify', '-m', message], { cwd: wt.path, timeoutMs: ADD_TIMEOUT_MS });
  if (!commit.ok) throw fail(500, `Plenum could not commit the changes: ${gitError(commit)}.`);
  const note = !name ? 'Committed as Plenum, because git has no user name set.' : !email ? 'Committed with a placeholder email, because git has no user email set.' : '';
  return { committed: true, note };
}

// The most paths an error names; the rest are counted.
const LISTED_MAX = 10;

// The message for a copy that git lists work in, so it is not removed: the paths (at most LISTED_MAX, then how many more) for the person to
// commit before trying again. lines are `git status --porcelain` lines: two status letters, a space, then the path.
function uncommittedMessage(lines) {
  const paths = lines.map(line => line.slice(3).trimEnd());
  const shown = paths.slice(0, LISTED_MAX).join(', ');
  const more = paths.length > LISTED_MAX ? ` and ${paths.length - LISTED_MAX} more` : '';
  return `The isolated copy was not removed, because it has changes that are not committed: ${shown}${more}. Commit them, then try again.`;
}

// Unlinks every link inside dir (a symbolic link, or a junction on Windows) without ever walking through one, so that the delete that
// follows cannot reach a folder outside the copy. A recursive delete once followed a junction and emptied the folder it led to.
async function unlinkLinksIn(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) await fs.unlink(full).catch(() => fs.rmdir(full).catch(() => {}));
    else if (entry.isDirectory()) await unlinkLinksIn(full);
  }
}

// Why the system would not delete something, in plain words.
function deleteError(err, fallback) {
  const where = typeof err?.path === 'string' && err.path ? err.path : fallback;
  if (['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(err?.code)) return `a program is using ${where} (${err.code})`;
  return `${where} could not be deleted (${err?.code || String(err?.message ?? 'unknown error').slice(0, 120)})`;
}

// What is left of a copy after git could not remove it, or said it had and left something. A removal that was stopped half way leaves a
// folder git no longer accepts as a copy (its .git file is gone), so 'worktree remove' refuses it for ever; and Git for Windows does not
// remove a junction, so the folders above one stay behind a removal it reports as done. This deletes the folder itself, and only a folder
// that is exactly a copy's own place under the copies folder and really lies there. A link in that place is unlinked, never walked, and so is every link
// inside. Resolves '' when nothing is left, else the reason in plain words.
async function removeLeftover(wt) {
  if (!ownWorktreePath(wt.path)) return 'the folder is not where Plenum keeps its copies';
  const info = await fs.lstat(wt.path).catch(() => null);
  if (!info) return '';
  try {
    if (info.isSymbolicLink()) {
      await fs.unlink(wt.path).catch(() => fs.rmdir(wt.path));
      return '';
    }
    if (!info.isDirectory()) return `${wt.path} is not a folder`;
    const real = await fs.realpath(wt.path);
    const root = await fs.realpath(worktreeRoot());
    if (real === root || !insideRoot(root, real)) return `${wt.path} leads outside the folder Plenum keeps its copies in`;
    await unlinkLinksIn(real);
    await fs.rm(real, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch (err) {
    return deleteError(err, wt.path);
  }
  return (await present(wt.path)) ? `${wt.path} is still there` : '';
}

// Removes the copy's folder: 'worktree remove', and only when that refuses while the copy has nothing uncommitted left (ignored files such as
// node_modules remain) '--force'. A copy that git lists work in is never forced: the removal throws a 500 that names the paths. Discard is the
// one caller that forces, because it says the changes are lost. When git cannot finish a removal that may force (an earlier removal stopped
// half way, or a program holds a file), or reports a removal as done and still leaves a folder (a copy that holds a junction, as pnpm, a
// workspace or a linked node_modules makes), what is left is deleted as a folder (removeLeftover) and git's record of the copy is pruned. A
// folder that is already gone is pruned. Throws a 500 with the reason when the folder is still there.
async function removeCopy(project, wt, { force = false } = {}) {
  // Whether a forced removal may run: Discard asks for it, and Keep allows it only when git listed no work below.
  let mayForce = force;
  let removed = await runGit(force ? ['worktree', 'remove', '--force', wt.path] : ['worktree', 'remove', wt.path], { cwd: project.path, timeoutMs: REMOVE_TIMEOUT_MS });
  if (!removed.ok && !force && (await exists(wt.path))) {
    // Refused although everything is committed: what is left is ignored files (node_modules) and the files Plenum itself copied in, which
    // are not the person's work. Anything else that git lists is, and the copy is then kept as it is.
    const left = await runGit(['status', '--porcelain'], { cwd: wt.path, timeoutMs: GIT_TIMEOUT_MS });
    const ours = new Set((Array.isArray(wt.copied) ? wt.copied : []).map(rel => `?? ${wt.sub ? `${wt.sub}/${rel}` : rel}`));
    const work = left.ok ? left.stdout.split(/\r?\n/).filter(line => line.trim() && !ours.has(line.trim())) : null;
    if (work?.length) throw fail(500, uncommittedMessage(work));
    // Nothing listed: a forced removal is allowed. When git did not say what is there, it is not.
    if (work) {
      mayForce = true;
      removed = await runGit(['worktree', 'remove', '--force', wt.path], { cwd: project.path, timeoutMs: REMOVE_TIMEOUT_MS });
    }
  }
  // A program that holds a file open (an editor, a dev server) can make Windows refuse for a moment. Only a removal that may force retries,
  // and not one that ran out of time (git would only be stopped again).
  for (let i = 0; i < 2 && mayForce && !removed.ok && !removed.timedOut && (await exists(wt.path)); i += 1) {
    await sleep(500);
    removed = await runGit(['worktree', 'remove', '--force', wt.path], { cwd: project.path, timeoutMs: REMOVE_TIMEOUT_MS });
  }
  // git could not finish: where the removal may force, what is left is deleted as a folder. A copy that git lists work in never gets here,
  // and neither does a Keep whose copy git could not read.
  // git can also say it removed the copy and still leave something: Git for Windows does not remove a junction, so the folders above it
  // stay (and the copy's .git file is gone by then). git checked the copy for uncommitted work before it deleted anything (a removal
  // without --force refuses otherwise), so what is left is not work: it is deleted as a folder too, links unlinked and never walked.
  let leftover = '';
  if ((mayForce || removed.ok) && (await present(wt.path))) leftover = await removeLeftover(wt);
  if (!(await present(wt.path))) {
    await runGit(['worktree', 'prune'], { cwd: project.path, timeoutMs: GIT_TIMEOUT_MS });
    return;
  }
  const why = leftover || gitError(removed);
  throw fail(500, `The isolated copy could not be removed: ${why}. Close any program that uses ${wt.path}, then try again.`);
}

// The thread's copy when it is in one of the states, else a 400 or 409 that says why.
export function needCopy(scope, states = ['ready']) {
  const wt = scope?.worktree;
  if (!wt) throw fail(400, 'This thread has no isolated copy.');
  if (states.includes(wt.state)) return wt;
  if (wt.state === 'creating') throw fail(409, 'The isolated copy is still being made.');
  if (wt.state === 'closing') throw fail(409, 'Another change to this isolated copy is in progress.');
  if (wt.state === 'missing') throw fail(409, 'This thread\'s isolated copy is missing. Discard it, or close the thread.');
  throw fail(409, 'This thread\'s isolated copy could not be made. Try again, or use the project folder.');
}

// Keep branch: commits the copy's changes on its branch and removes the folder. Resolves { branch, committed, note }. The caller closes the
// thread and drops the record, and has checked that the thread is not running and not in plan mode.
export async function keepWorktree({ project, scope, message }) {
  const wt = needCopy(scope, ['ready']);
  const release = holdWorktree(scope.id);
  if (!release) throw fail(409, 'Another change to this isolated copy is in progress.');
  try {
    const done = await commitCopy(wt, cleanMessage(message, scope.name));
    try {
      await removeCopy(project, wt);
    } catch (err) {
      throw fail(err.status ?? 500, done.committed ? `The changes are committed on ${wt.branch}. ${err.message}` : err.message);
    }
    return { branch: wt.branch, base: wt.base, committed: done.committed, note: done.note };
  } finally {
    release();
  }
}

// Discard: removes the folder with everything not committed in it. The branch is kept unless deleteBranch is true, and only a branch
// whose name starts with plenum/ is ever deleted. Resolves { branch, branchDeleted, warning }.
export async function discardWorktree({ project, scope, deleteBranch = false }) {
  const wt = needCopy(scope, ['ready', 'missing']);
  const release = holdWorktree(scope.id);
  if (!release) throw fail(409, 'Another change to this isolated copy is in progress.');
  try {
    if (wt.path && ownWorktreePath(wt.path)) await removeCopy(project, wt, { force: true });
    let branchDeleted = false;
    let warning = '';
    if (deleteBranch === true && isPlenumBranch(wt.branch) && wt.branch.startsWith('plenum/')) {
      const del = await runGit(['branch', '-D', wt.branch], { cwd: project.path, timeoutMs: 10_000 });
      branchDeleted = del.ok;
      if (!del.ok) warning = `The copy was removed, but the branch ${wt.branch} could not be deleted: ${gitError(del)}.`;
    }
    return { branch: wt.branch, branchDeleted, warning };
  } finally {
    release();
  }
}

// A thread that is closed (or its project removed) while its copy is failed or missing: whatever is left of the copy goes, the branch only
// when it has no commits beyond its base. The record itself is dropped by the caller.
export async function forgetWorktree({ project, st, id }) {
  const rec = worktreeRecord(st, id);
  if (!rec) return;
  try {
    await cleanupAttempt(project, { path: rec.path, branch: rec.branch, base: rec.base });
  } catch {
    // Best effort: a failure leaves the folder for the person to remove.
  }
}

// ---------- Phase 2: merge into the base ----------

// The branch the project folder is on now, or '' for a detached head or no answer.
async function currentBranch(cwd) {
  const r = await runGit(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd, timeoutMs: 10_000 });
  return r.ok ? r.stdout.trim() : '';
}

// Throws a 409 unless the project folder is on the base branch and has no uncommitted change to a tracked file.
async function checkProjectReady(project, wt) {
  if (wt.baseKind !== 'branch') throw fail(409, 'This copy was made from a detached head, so there is no branch to merge into. Keep the branch and merge it yourself.');
  const here = await currentBranch(project.path);
  if (here !== wt.base) throw fail(409, `The project folder is on ${here || 'no branch'}, not on ${wt.base}. Switch it to ${wt.base} first.`);
  const dirty = await runGit(['status', '--porcelain', '--untracked-files=no'], { cwd: project.path, timeoutMs: GIT_TIMEOUT_MS });
  if (!dirty.ok) throw fail(500, `Plenum could not read ${project.name}: ${gitError(dirty)}.`);
  if (dirty.stdout.trim()) throw fail(409, `Commit or stash the changes in ${project.name} first.`);
}

// What a merge needs before it starts, as a 409 that says what to do: a ready copy, the project folder on the base branch, and no uncommitted
// change to a tracked file there. The route calls it before it opens the stream, so a refusal is an ordinary error answer.
export async function mergePreflight({ project, scope }) {
  const wt = needCopy(scope, ['ready']);
  await checkProjectReady(project, wt);
  return wt;
}

// Merges the copy's branch into the base. An async generator over the events the stream sends. It commits the copy as Keep does (without
// removing it), shows a click-only approval card with the whole diff (approve is approvalRequester(send, signal)), and on approval runs
// 'merge --no-ff --no-edit' with no strategy option and no --force. A conflict is listed and the merge aborted, so the project folder is
// left as it was; it is never resolved here. Last events: { type: 'merged' }, { type: 'conflict' }, { type: 'declined' } or { type: 'error' }.
export async function* mergeWorktree({ project, scope, approve, signal }) {
  const wt = await mergePreflight({ project, scope });
  const release = holdWorktree(scope.id);
  if (!release) throw fail(409, 'Another change to this isolated copy is in progress.');
  try {
    const done = await commitCopy(wt, cleanMessage('', scope.name));
    if (done.committed) yield { type: 'notice', text: done.note ? `Committed the copy's changes. ${done.note}` : 'Committed the copy\'s changes on its branch.' };
    const ahead = await runGit(['rev-list', '--count', `${wt.base}..${wt.branch}`], { cwd: project.path, timeoutMs: 10_000 });
    if (!ahead.ok) throw fail(500, `Plenum could not compare ${wt.branch} with ${wt.base}: ${gitError(ahead)}.`);
    if (ahead.stdout.trim() === '0') {
      yield { type: 'notice', text: `Nothing to merge: ${wt.branch} has no commits beyond ${wt.base}.` };
      yield { type: 'declined', nothing: true };
      return;
    }
    const range = `${wt.base}...${wt.branch}`;
    const names = await runGit(['diff', ...DIFF_SAFE, '--name-only', '-z', range], { cwd: project.path, timeoutMs: GIT_TIMEOUT_MS });
    const diff = await runGit(['diff', ...DIFF_SAFE, range], { cwd: project.path, timeoutMs: GIT_TIMEOUT_MS });
    if (!names.ok || !diff.ok) throw fail(500, `Plenum could not read the changes to merge: ${gitError(names.ok ? diff : names)}.`);
    const count = names.stdout.split('\0').filter(Boolean).length;
    const detail = capDetail(diff.stdout);
    const card = {
      summary: `Merge ${wt.branch} into ${wt.base} (${count} ${count === 1 ? 'file' : 'files'})`,
      detail,
      clickOnly: true,
      ...(detail.length < diff.stdout.length ? { fullDetail: cutFull(diff.stdout) } : {}),
    };
    const allowed = await approve(card);
    if (!allowed) {
      yield { type: 'declined', reason: typeof card.reason === 'string' ? card.reason : '' };
      return;
    }
    if (signal?.aborted) {
      yield { type: 'declined' };
      return;
    }
    // The card may have waited for minutes: the project folder must still be what it was.
    await checkProjectReady(project, wt);
    const name = (await runGit(['config', 'user.name'], { cwd: project.path, timeoutMs: 10_000 })).stdout.trim();
    const email = (await runGit(['config', 'user.email'], { cwd: project.path, timeoutMs: 10_000 })).stdout.trim();
    const identity = [...(name ? [] : ['-c', 'user.name=Plenum']), ...(email ? [] : ['-c', 'user.email=plenum@localhost'])];
    const merged = await runGit([...identity, 'merge', '--no-ff', '--no-edit', wt.branch], { cwd: project.path, timeoutMs: ADD_TIMEOUT_MS });
    if (merged.ok) {
      yield { type: 'merged', branch: wt.branch, base: wt.base, text: `Merged ${wt.branch} into ${wt.base}.` };
      return;
    }
    const unmerged = await runGit(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: project.path, timeoutMs: GIT_TIMEOUT_MS });
    const files = unmerged.ok ? unmerged.stdout.split('\0').filter(Boolean) : [];
    // Whatever stopped the merge, the project folder goes back to how it was.
    await runGit(['merge', '--abort'], { cwd: project.path, timeoutMs: GIT_TIMEOUT_MS });
    if (files.length) {
      yield {
        type: 'conflict',
        files,
        text: `Merge stopped: these files conflict: ${files.join(', ')}. Nothing was merged. Resolve them yourself, or ask the thread to rebase its branch on ${wt.base}.`,
      };
      return;
    }
    yield { type: 'error', message: `The merge did not finish and nothing was merged: ${gitError(merged, 'git stopped the merge')}.` };
  } finally {
    release();
  }
}
