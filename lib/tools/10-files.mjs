// Registry shape. lib/tools.mjs is the engine; each model tool lives in one file here.
// Every lib/tools/NN-name.mjs (NN two digits, name lowercase letters, digits and hyphens) is loaded by loadTools() in
// file-name order, and exports `tools`, an array of entries:
//   {
//     name: string,                     // lowercase letters, digits and underscores, starting with a letter
//     description: string,
//     input_schema: object,             // the Anthropic shape; lib/openai-compat.mjs converts it
//     run(input, ctx, stamp) -> { ok, summary, output, denied? },
//     plan?(input, ctx) -> card | null, // a card { summary, detail, fullDetail?, defaultDeny?, blocked? } asks for approval
//                                       // unless ctx.mode is 'auto' or 'all' (a scoped:'write' tool whose path is outside the
//                                       // project still asks in 'auto'; runTool decides that from input.path, not from the card)
//     describe?(input) -> string,       // one line for the step row (default: the name)
//     command?(input) -> string,        // the shell text the deny list checks (run_command); a hit always asks, Deny first
//     stamped?: true,                   // the card is fingerprint-stamped and run refuses a file that changed since
//     scoped?: 'off' | 'refuse' | 'write', // what a delegated coder (ctx.scope) gets: 'off' = not offered and refused with
//                                       // refusal if called; 'refuse' = offered but refused with refusal; 'write' = offered and
//                                       // limited to the task's scope; undefined = allowed
//     refusal?: string,                 // the text for 'off' and 'refuse'
//     when?(ctx) -> boolean,            // offered only when true (for example ctx.computer or ctx.browser)
//   }
// or a raw entry { raw: object, when? }: the object is sent to the model exactly as given (a computer toolset, say). A raw
// entry has no name, plan or run, is never offered to a delegated coder, and is skipped by describeCall.
// The approval, scope, stamp, checkpoint and deny-list rules are applied by runTool (lib/tools.mjs), never by a tool file.
// Names in a tool file's exports are checked by registerTools: a duplicate name is refused.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { checkpointFile, assertUnchanged, clip, display, editPlanDetail, fingerprint, planDetail, resolveTarget, sha256 } from '../tools.mjs';
import { countMatches, editableText, eolOf, replaceText, writeContent, writeFullText } from '../diff.mjs';
import { checkAccess, copyOfWorktree, isCredentialPath, isSecretFileName, worktreeRoot } from '../guard.mjs';
import { MAX_LINE, STOPPED_MESSAGE, TOO_SLOW_MESSAGE, checkPattern, regexMatcher } from '../safe-regex.mjs';

const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', 'dist', 'build', '.next', '__pycache__']);
const MAX_READ = 2_000_000;
const MAX_SEARCH_FILE = 1_000_000;
const MAX_HITS = 100;
// The most one search_text call looks at: this many files, or this long. Past either, the search ends with what it has and says so.
// The values are in an object so that a test can lower them; nothing in the app changes them.
export const searchBudget = { files: 20_000, ms: 10_000 };
const STOPPED_EARLY = 'Search stopped early; name a narrower folder.';

// ---------- helpers ----------

// Writes the content to a sibling temp file, then renames it over the target, so a half-written file is never left in place.
// B-88: a failed write or rename removes its temp file, so nothing is left in the project; the original error is still thrown.
async function writeAtomic(abs, content) {
  // A folder cannot be written over, and its temp file would land beside it (or inside the project for "src"), so refuse before any file is made.
  if ((await fs.stat(abs).catch(() => null))?.isDirectory()) throw new Error(`${abs} is a folder, so nothing was written.`);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// True when the file already holds exactly these bytes.
async function holds(abs, bytes) {
  try {
    const st = await fs.stat(abs);
    return st.isFile() && st.size === bytes.length && (await fs.readFile(abs)).equals(bytes);
  } catch {
    return false;
  }
}

// The text a write tool is given, as a string. A missing or null value is an error, not an empty text (an empty string is how a model
// deletes text or makes an empty file), and an object or a list is refused rather than written as "[object Object]". The plan and the run
// both read the text here, so the card and the write cannot differ.
function textArg(input, key) {
  const v = input?.[key];
  if (v === undefined || v === null) throw new Error(`${key} is required. Send the full text as a string${key === 'new_string' ? ' (an empty string deletes the text)' : ''}.`);
  if (typeof v === 'object') throw new Error(`${key} must be a string, not an object or a list.`);
  return String(v);
}

// For read-type tools: a plan (so approval is asked) only when the path is outside the project.
async function planOutside(verb, input, ctx) {
  const t = await resolveTarget(ctx.root, input.path ?? '.');
  if (!t.outside) return null;
  return {
    summary: `${verb} outside the project: ${t.realTarget}`,
    detail: 'This path is not in the project folder. Approve only if you want Claude to look at it.',
  };
}

// ---------- read-only tools ----------

async function listDir(input, ctx) {
  const t = await resolveTarget(ctx.root, input.path ?? '.');
  const entries = await fs.readdir(t.realTarget, { withFileTypes: true });
  entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
  const shown = entries.slice(0, 400).map(e => (e.isDirectory() ? `${e.name}/` : e.name));
  const more = entries.length > 400 ? `\n…${entries.length - 400} more` : '';
  return { ok: true, summary: `${entries.length} entries in ${display(t)}`, output: `${display(t)}/\n${shown.join('\n')}${more}` };
}

async function readFileTool(input, ctx) {
  const t = await resolveTarget(ctx.root, input.path);
  const st = await fs.stat(t.realTarget);
  if (!st.isFile()) throw new Error(`${display(t)} is not a file.`);
  if (st.size > MAX_READ) throw new Error(`${display(t)} is ${st.size} bytes, over the ${MAX_READ} byte read limit. Use search_text to find the part you need.`);
  const raw = await fs.readFile(t.realTarget);
  if (raw.length >= 2 && ((raw[0] === 0xff && raw[1] === 0xfe) || (raw[0] === 0xfe && raw[1] === 0xff))) {
    throw new Error(`${display(t)} is UTF-16 text, which read_file cannot show yet. It reads UTF-8 text only.`);
  }
  const text = raw.toString('utf8');
  if (text.includes('\u0000')) throw new Error(`${display(t)} looks like a binary file.`);
  // What the model should know about the file before it edits it, as lines in square brackets above the numbered text.
  const notes = [];
  if (editableText(raw).text === undefined) notes.push('[This file is not UTF-8 text, so some characters are shown as \ufffd. edit_file will not change it.]');
  const eol = eolOf(text);
  if (eol === 'crlf') notes.push('[Line endings: CRLF (Windows). edit_file and write_file keep them.]');
  if (eol === 'mixed') notes.push('[Mixed line endings (CRLF and LF). With edit_file, replace one line at a time: an old_string over several lines may not match.]');
  // A Windows line ending's \r is not part of the line.
  const lines = text.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const offset = Math.max(1, Math.floor(Number(input.offset) || 1));
  const limit = Math.min(2000, Math.max(1, Math.floor(Number(input.limit) || 400)));
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const numbered = slice.map((l, i) => `${String(offset + i).padStart(5)}  ${l}`).join('\n');
  const rest = lines.length - (offset - 1 + slice.length);
  const more = rest > 0 ? `\n…${rest} more lines. Call again with offset=${offset + slice.length}.` : '';
  return {
    ok: true,
    summary: `Read ${display(t)}, lines ${offset}-${offset + slice.length - 1} of ${lines.length}`,
    output: clip(`${notes.length ? `${notes.join('\n')}\n` : ''}${numbered}${more}`),
  };
}

// For search_text: a card only when the folder is outside the project, and one that says what a search does there.
async function planSearch(input, ctx) {
  const t = await resolveTarget(ctx.root, input.path ?? '.');
  if (!t.outside) return null;
  return {
    summary: `Search every file under ${t.realTarget} (outside the project)`,
    detail: 'This path is not in the project folder. Every text file under it is read, and the lines that match go to the model. '
      + 'Sign-in folders, files named like secrets (.env, key files) and other threads\' isolated copies are skipped. '
      + 'Approve only if you want the model to look there.',
  };
}

const foldCase = p => (process.platform === 'win32' ? p.toLowerCase() : p);
const within = (dir, p) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

// What a search may enter and read on its way down, whatever folder it started in. resolveTarget checks only the start folder, so
// without this a search of the user folder (or anything above it) would read the sign-in folders inside it. Never entered or read,
// in every mode (the floor): a credential folder or file (isCredentialPath, and whatever checkAccess refuses for a read).
// Also skipped: another thread's isolated copy (the run's own copy and a copy the search was pointed at are read), and, outside
// the project, a file named like a secret (.env, a key file). Links and junctions are never followed, so every path here is real.
async function searchGuard(t) {
  const offLimits = p => {
    if (isCredentialPath(p)) return true;
    try {
      checkAccess(p);
    } catch {
      return true;
    }
    return false;
  };
  const root = foldCase(t.realRoot);
  const copies = worktreeRoot();
  const copyRoots = [...new Set([copies, await fs.realpath(copies).catch(() => copies)].map(c => foldCase(path.resolve(c))))];
  const own = new Set([copyOfWorktree(t.realRoot), copyOfWorktree(t.realTarget)].filter(Boolean));
  return {
    dir(p) {
      if (offLimits(p)) return false;
      if (!copyRoots.some(c => within(c, foldCase(p)))) return true;
      const copy = copyOfWorktree(p);
      // '' is the copies folder itself: it is entered, and each copy in it is judged when the walk reaches it.
      return !copy || own.has(copy);
    },
    file: (p, name) => !offLimits(p) && (within(root, foldCase(p)) || !isSecretFileName(name)),
  };
}

async function searchText(input, ctx) {
  const t = await resolveTarget(ctx.root, input.path ?? '.');
  const pattern = String(input.pattern ?? '');
  if (!pattern) throw new Error('Give a pattern to search for.');
  // A model's regular expression never runs on the server's thread (lib/safe-regex.mjs): a slow one would stop every chat and
  // Stop itself. Its length and syntax are checked here; the matching is done in a worker that is ended when it takes too long or
  // the run is stopped. The walk, the reads and the guard stay here. A plain-text search is a simple includes and stays here too.
  if (input.regex) checkPattern(pattern);
  const matcher = input.regex ? regexMatcher(pattern, { signal: ctx.signal }) : null;
  const target = await fs.stat(t.realTarget).catch(() => null);
  const oneFile = !!target?.isFile();
  const base = !t.outside ? t.realRoot : oneFile ? path.dirname(t.realTarget) : t.realTarget;
  const guard = await searchGuard(t);
  const hits = [];
  const started = Date.now();
  let seen = 0;
  let early = false;
  let longLines = 0;
  const overBudget = () => {
    if (!early && (seen >= searchBudget.files || Date.now() - started > searchBudget.ms)) early = true;
    return early;
  };
  const scan = async full => {
    const st = await fs.stat(full).catch(() => null);
    if (!st || st.size > MAX_SEARCH_FILE) return;
    const text = await fs.readFile(full, 'utf8').catch(() => '');
    if (!text || text.includes('\u0000')) return;
    const lines = text.split('\n');
    const room = MAX_HITS - hits.length;
    let found = [];
    if (matcher) {
      const got = await matcher.lines(text, room);
      found = got.hits;
      longLines += got.long;
    } else {
      for (let i = 0; i < lines.length && found.length < room; i++) if (lines[i].includes(pattern)) found.push(i);
    }
    const name = path.relative(base, full).split(path.sep).join('/');
    for (const i of found) hits.push(`${name}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
  };
  const walk = async dir => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (hits.length >= MAX_HITS || overBudget()) return;
      if (ctx.signal?.aborted) throw new Error(STOPPED_MESSAGE);
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      // A link or a junction is neither a folder nor a file here, so it is never followed.
      if (e.isDirectory()) {
        if (guard.dir(full)) await walk(full);
      } else if (e.isFile()) {
        seen += 1;
        if (guard.file(full, e.name)) await scan(full);
      }
    }
  };
  let slow = false;
  try {
    if (ctx.signal?.aborted) throw new Error(STOPPED_MESSAGE);
    // A path that names one file searches that file.
    if (oneFile) await scan(t.realTarget);
    else await walk(t.realTarget);
  } catch (err) {
    if (err?.message !== TOO_SLOW_MESSAGE) throw err;
    slow = true;
  } finally {
    matcher?.close();
  }
  const found = hits.length ? hits.join('\n') : 'No matches.';
  if (slow) {
    return {
      ok: false,
      summary: 'Search stopped: the pattern took too long',
      output: `${TOO_SLOW_MESSAGE}${hits.length ? `\nFound before that:\n${found}` : ''}`,
    };
  }
  const notes = [];
  if (longLines) notes.push(`${longLines} line${longLines === 1 ? '' : 's'} longer than ${MAX_LINE} characters ${longLines === 1 ? 'was' : 'were'} not tested (a regular expression search skips them).`);
  if (early) notes.push(STOPPED_EARLY);
  return {
    ok: true,
    summary: `${hits.length} match${hits.length === 1 ? '' : 'es'} for "${pattern.slice(0, 60)}" in ${display(t)}${early ? ' (stopped early)' : ''}`,
    output: [found, ...notes].join('\n'),
  };
}

// ---------- tools that need approval ----------

async function planWrite(input, ctx) {
  const t = await resolveTarget(ctx.root, input.path, { write: true });
  // The file's Windows line endings are kept (writeContent), in the card and in the write alike.
  const content = await writeContent(t.realTarget, textArg(input, 'content'));
  const bytes = Buffer.byteLength(content);
  return { summary: `Write ${display(t)} (${bytes} bytes)`, ...planDetail(await writeFullText(t.realTarget, content, display(t))) };
}

// stamp (set when a card was shown) is what the file held then. If it holds something else now, nothing is written.
async function runWrite(input, ctx, stamp) {
  const t = await resolveTarget(ctx.root, input.path, { write: true });
  const given = textArg(input, 'content');
  if (stamp) assertUnchanged(stamp, t.realTarget, await fingerprint(t.realTarget));
  const content = await writeContent(t.realTarget, given);
  // A write that leaves the file as it is changes nothing, so it needs no checkpoint.
  if (!(await holds(t.realTarget, Buffer.from(content)))) {
    await checkpointFile({ projectId: ctx.projectId, projectPath: ctx.root, absPath: t.realTarget, label: `Write ${t.rel}` });
  }
  await writeAtomic(t.realTarget, content);
  const kept = content === given ? '' : ' The file\'s Windows line endings (CRLF) were kept.';
  return { ok: true, summary: `Wrote ${display(t)}`, output: `Wrote ${Buffer.byteLength(content)} bytes to ${display(t)}.${kept}` };
}

// The file's bytes as the text an edit works on. A file that is not UTF-8 text (Latin-1, UTF-16, a binary file) is refused here, in
// the plan and in the run: decoded loosely it would be written back with its other characters replaced.
function editText(raw, t) {
  const got = editableText(raw);
  if (got.text === undefined) {
    throw new Error(`${display(t)} was not changed, because ${got.why}, and an edit could damage its characters. Use write_file to replace the whole file, or change it in another program.`);
  }
  return got.text;
}

// The message for an old_string that is not in the file. In a file with mixed line endings the usual cause is a line break.
function notFound(text, oldS, t) {
  const mixed = eolOf(text) === 'mixed' && oldS.includes('\n')
    ? ' The file mixes Windows and Unix line endings, so an old_string over several lines may not match: replace one line at a time.'
    : '';
  return `old_string was not found in ${display(t)}.${mixed} Read the file again and copy the text exactly.`;
}

async function planEdit(input, ctx) {
  const t = await resolveTarget(ctx.root, input.path, { write: true });
  const oldS = textArg(input, 'old_string');
  const newS = textArg(input, 'new_string');
  if (!oldS) throw new Error('old_string must not be empty.');
  if (oldS === newS) throw new Error('old_string and new_string are identical; nothing to change.');
  const raw = await fs.readFile(t.realTarget).catch(() => {
    throw new Error(`${display(t)} does not exist. Use write_file to create it.`);
  });
  const text = editText(raw, t);
  // Counted the way replaceText matches (lib/diff.mjs), so a file with Windows line endings matches an old_string written with \n.
  const count = countMatches(text, oldS);
  if (count === 0) throw new Error(notFound(text, oldS, t));
  if (count > 1 && !input.replace_all) {
    throw new Error(`old_string matches ${count} times in ${display(t)}. Add surrounding lines to make it unique, or set replace_all.`);
  }
  // The card shows the file before and after the same replacement that runEdit makes.
  const updated = replaceText(text, oldS, newS, !!input.replace_all).updated;
  return {
    summary: `Edit ${display(t)} (${count} replacement${count > 1 ? 's' : ''})`,
    ...editPlanDetail(text, updated, display(t)),
  };
}

// The edit is made on the bytes that are compared with the stamp, so it cannot land on a newer version of the file.
async function runEdit(input, ctx, stamp) {
  const t = await resolveTarget(ctx.root, input.path, { write: true });
  const oldS = textArg(input, 'old_string');
  const newS = textArg(input, 'new_string');
  let raw = null;
  try {
    raw = await fs.readFile(t.realTarget);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (stamp) assertUnchanged(stamp, t.realTarget, raw ? sha256(raw) : 'absent');
  if (!raw) throw new Error(`${display(t)} does not exist. Use write_file to create it.`);
  const text = editText(raw, t);
  const { updated, count } = replaceText(text, oldS, newS, !!input.replace_all);
  // Without a stamp (auto mode) the file may still have changed since the plan, so a missing match is an error, not a silent no-op.
  if (!count) throw new Error(notFound(text, oldS, t));
  await checkpointFile({ projectId: ctx.projectId, projectPath: ctx.root, absPath: t.realTarget, label: `Edit ${t.rel}` });
  await writeAtomic(t.realTarget, updated);
  return { ok: true, summary: `Edited ${display(t)}`, output: `Replaced ${count} occurrence${count > 1 ? 's' : ''} in ${display(t)}.` };
}

export const tools = [
  {
    name: 'list_dir',
    description: 'List the files and folders in a directory. Relative paths start at the project folder; absolute paths (for example C:\\Users\\name\\Documents) work too. Folders end with /.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory. Default "." (the project folder).' } },
      additionalProperties: false,
    },
    describe: input => input.path || '.',
    plan: (i, c) => planOutside('List folder', i, c),
    run: listDir,
  },
  {
    name: 'read_file',
    description: 'Read a text file with line numbers. Accepts relative or absolute paths. Use offset and limit to page through long files.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the project folder or absolute.' },
        offset: { type: 'integer', description: '1-based line to start at. Default 1.' },
        limit: { type: 'integer', description: 'Maximum lines to return. Default 400, maximum 2000.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    describe: input => String(input.path ?? ''),
    plan: (i, c) => planOutside('Read', i, c),
    run: readFileTool,
  },
  {
    name: 'search_text',
    description: 'Search text files under a directory for a pattern. Returns up to 100 matches as path:line: text.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Directory to search. Default "." (the project folder).' },
        regex: { type: 'boolean', description: 'Treat pattern as a JavaScript regular expression. Default false.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    describe: input => `"${clip(String(input.pattern ?? ''), 80)}" in ${input.path || '.'}`,
    plan: planSearch,
    run: searchText,
  },
  {
    name: 'write_file',
    description: 'Create a file or overwrite it with the full content. Relative or absolute path. Needs user approval unless approvals are on auto.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    stamped: true,
    scoped: 'write',
    describe: input => String(input.path ?? ''),
    plan: planWrite,
    run: runWrite,
  },
  {
    name: 'edit_file',
    description: 'Replace exact text in an existing file. Relative or absolute path. old_string must match exactly once unless replace_all is true. Needs user approval unless approvals are on auto.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', description: 'Exact text to replace, including whitespace.' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean', description: 'Replace every match. Default false.' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
    stamped: true,
    scoped: 'write',
    describe: input => String(input.path ?? ''),
    plan: planEdit,
    run: runEdit,
  },
];
