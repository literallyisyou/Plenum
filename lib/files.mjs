import { promises as fs } from 'node:fs';
import path from 'node:path';
import { checkAccess, dropSecretSections, isSecretFileName } from './guard.mjs';
import { IMAGE_NAME, MAX_IMAGES, imageLimitMessage, imageTypeOf, loadImageFile } from './images.mjs';
import { MAX_FILES, PDF_MARK, PDF_NAME, loadDocumentFile, pdfRefusal, pdfTypeOf } from './attachments.mjs';
import { DIFF_SAFE, runGit } from './git-run.mjs';

const MAX_ATTACH = 100_000;
// True when the bytes are valid UTF-8 (a lossy decode is what this rule is about).
const strictUtf8 = bytes => {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
};
const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', 'dist', 'build', '.next', '__pycache__']);
// The punctuation that may follow a mention in a sentence. It is taken off the end of a mention that is not a file as typed.
const MENTION_TAIL = /[.,;:!?)\]}'"]+$/;
// How many @ tokens of a message are looked at, and how many of them may name something (a file, an image, a PDF, an absolute path typed
// in full). Only those count: a quoted or bracketed scoped package in pasted code or package.json ('@mui/material', "@types/node":) is a
// token that names nothing, so it does not take the place of a real file (tools-6).
const MENTIONS_LOOKED_AT = 50;
const MENTIONS_NAMED = 10;

// B-39: the block of a file named with @ starts with "--- file: <name> ---" and ends with "--- end: <name> ---", and the model is
// told those lines bound the data. A line of the file that looks like the end marker would close the block early, so such lines
// are changed: the leading dashes become "- - -", and "<<END FILE" (the marker of an attached file) gets a space after its "<<".
// Ordinary lines, a dash in the middle of a line, a Markdown rule and "--- end of day" are left as they are. Look-alike characters
// (full-width letters and colons, dash characters other than the hyphen) are folded before the test, so a look-alike marker is caught.
// Pattern matching is a mitigation, not proof against every look-alike; a random token per turn would be the stronger fix.
const INVISIBLE = '\\u200B-\\u200D\\u2060\\uFEFF';
const FORGED_MARKER = new RegExp(`^[\\s${INVISIBLE}]*-{2,}[ \\t]*(?:file|end)[ \\t]*:`, 'i');
const LEADING_DASHES = new RegExp(`^([\\s${INVISIBLE}]*)[-\\u2010-\\u2015\\u2212\\uFE58\\uFE63\\uFF0D]+`);

// The line as a reader would see it, with the look-alikes folded to the plain characters the markers use.
function foldLine(line) {
  return line.normalize('NFKC').replace(/[‐-―−﹘﹣]/g, '-').replace(/[：﹕]/g, ':');
}

// The text of a file as it goes into a @path block, with any line that could close the block changed (see above).
export function frameFileText(text) {
  const withoutEnd = String(text).replace(/<<(?=\s*END\s+FILE)/gi, '<< ');
  return withoutEnd
    .split('\n')
    .map(line => {
      const folded = foldLine(line);
      let out = line;
      // The ASCII form was changed above; a full-width "＜＜" that folds to it is changed here.
      if (/<<\s*END\s+FILE/i.test(folded)) out = out.replace(/＜{2}/g, '<< ');
      if (FORGED_MARKER.test(folded)) out = out.replace(LEADING_DASHES, (_, lead) => `${lead}- - -`);
      return out;
    })
    .join('\n');
}

export function insideRoot(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..');
}

// Resolves @path mentions inside the project. Claude gets the file contents inline.
// The CLI agents (Muse Code, Codex) get only the path, since they can read the file themselves.
// An image (told by its first bytes: PNG, JPEG, GIF or WebP) is loaded instead of read as text, for a model that takes
// images. imageRoom is how many more images the message may hold (the page may have sent some already). A PDF (also told by
// its first bytes) is loaded the same way for a model that takes one (takesPdf: Claude through an API key), up to pdfRoom of
// them; for any other model it is refused without being read. The result is { text, blocks, attached, images, documents, refused,
// refusedDocuments }: refused holds a plain message for each image that could not be attached, refusedDocuments the same for PDFs.
// blocks are the inlined files on their own (the same blocks text ends with; empty when inline is off), for a caller such as the
// council that puts them in a prompt of its own rather than after the message.
export async function expandFileMentions(message, root, { inline, imageRoom = MAX_IMAGES, takesPdf = false, pdfRoom = MAX_FILES }) {
  // A mention starts after white space, at the start, or after an opening bracket or quote: "(@b.txt)" names b.txt. The path as typed
  // is tried first; when it is not a file, the punctuation of the sentence around it is taken off its end ("@a.txt," "@src/app.js?"
  // "@b.txt)."), so a mention at the end of a clause attaches the file instead of being dropped without a word (tools-6).
  // The first MENTIONS_LOOKED_AT tokens are looked at, and the first MENTIONS_NAMED of them that name something are taken (see the loop).
  const typed = [...new Set([...message.matchAll(/(?:^|[\s(\[{"'])@(\S+)/g)].map(m => m[1]))].slice(0, MENTIONS_LOOKED_AT);
  const refs = [];
  for (const raw of typed) {
    const bare = raw.replace(MENTION_TAIL, '');
    const asTyped = bare === raw || !bare ? true : (await fs.stat(path.resolve(root, raw)).catch(() => null))?.isFile() === true;
    const rel = asTyped ? raw : bare;
    if (!refs.includes(rel)) refs.push(rel);
  }
  const attached = [];
  const blocks = [];
  const images = [];
  const documents = [];
  const refused = new Set();
  const refusedDocuments = new Set();
  // loadImageFile does the checks (credential folders, the project once links are followed, size, type). A refusal is kept
  // with its reason for the person to read.
  const takeImage = async file => {
    if (images.length >= imageRoom) {
      refused.add(imageLimitMessage());
      return;
    }
    try {
      images.push(await loadImageFile(file, root));
    } catch (err) {
      refused.add(err.message);
    }
  };
  // The same for a PDF, which only Claude through an API key takes. Any other model is refused before the file is read.
  const takeDocument = async file => {
    if (!takesPdf) {
      refusedDocuments.add(pdfRefusal(path.basename(file)));
      return;
    }
    if (documents.length >= pdfRoom) {
      refusedDocuments.add(`At most ${MAX_FILES} files can go with one message.`);
      return;
    }
    try {
      documents.push(await loadDocumentFile(file, root));
    } catch (err) {
      refusedDocuments.add(err.message);
    }
  };
  // The mentions taken so far that name something: an image or a PDF named outside the project (taken or refused with its reason), an
  // absolute path typed in full (attached or refused), a file of the project. A token that names nothing is passed over and not counted.
  let named = 0;
  for (const rel of refs) {
    if (named >= MENTIONS_NAMED) break;
    const abs = path.resolve(root, rel);
    if (!insideRoot(root, abs)) {
      // An image or a PDF named outside the project is looked at by the same checks, so it is refused with the reason and
      // not skipped without a word.
      if (IMAGE_NAME.test(rel)) {
        named++;
        await takeImage(abs);
        continue;
      }
      if (PDF_NAME.test(rel)) {
        named++;
        await takeDocument(abs);
        continue;
      }
      // A full absolute path the user typed is attached for Claude; the credential and system-folder guards still apply.
      if (!(path.isAbsolute(rel) && inline)) continue;
      try {
        checkAccess(abs);
      } catch (err) {
        named++;
        blocks.push(`--- file: ${rel} not attached (${err.message}) ---`);
        continue;
      }
    }
    const st = await fs.stat(abs).catch(() => null);
    if (!st?.isFile()) continue;
    named++;
    // B-18: a link inside the project (a junction or a symbolic link) can lead to a credential folder, and the lexical check above
    // does not follow it. The place the path really is goes through the same check as any file, before it is opened, attached or
    // read. A refusal says so in the block (with the reason, which names no path); nothing is read.
    try {
      checkAccess(await fs.realpath(abs));
    } catch (err) {
      const reason = err?.code ? 'it cannot be read' : err.message;
      if (inline) blocks.push(`--- file: ${rel} not attached (${reason}) ---`);
      continue;
    }
    if (await imageTypeOf(abs)) {
      await takeImage(abs);
      continue;
    }
    if (await pdfTypeOf(abs)) {
      await takeDocument(abs);
      continue;
    }
    attached.push(rel);
    if (!inline) continue;
    if (st.size > MAX_ATTACH) {
      blocks.push(`--- file: ${rel} skipped (${st.size} bytes; limit ${MAX_ATTACH}) ---`);
      continue;
    }
    const bytes = await fs.readFile(abs);
    // A PDF header after other bytes (C-47) is not a PDF to Plenum. When such a file is not UTF-8 it would be inlined with its bytes
    // replaced, so it is named as refused in the block instead.
    if (bytes.subarray(0, 1024).includes(PDF_MARK) && !strictUtf8(bytes)) {
      blocks.push(`--- file: ${rel} not attached (a PDF with bytes before its %PDF- header) ---`);
      continue;
    }
    const text = bytes.toString('utf8');
    if (text.includes('\u0000')) {
      blocks.push(`--- file: ${rel} skipped (binary) ---`);
      continue;
    }
    blocks.push(`--- file: ${rel} ---\n${frameFileText(text)}\n--- end: ${rel} ---`);
  }
  return { text: inline && blocks.length ? `${message}\n\n${blocks.join('\n\n')}` : message, blocks: inline ? blocks : [], attached, images, documents, refused: [...refused], refusedDocuments: [...refusedDocuments] };
}

// Shallow tree (3 levels) so the model knows what is in the project.
export async function listTree(root, max = 300) {
  const out = [];
  const queue = [{ dir: '', depth: 0 }];
  while (queue.length && out.length < max) {
    const { dir, depth } = queue.shift();
    const entries = await fs.readdir(path.join(root, dir), { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (SKIP.has(entry.name) || out.length >= max) continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        if (depth < 2) queue.push({ dir: rel, depth: depth + 1 });
      } else {
        out.push(rel);
      }
    }
  }
  return out;
}

// One git command for the advisor and @diff, through lib/git-run.mjs (repository programs off). null when git fails.
const DIFF_MAX_BYTES = 8 * 1024 * 1024;
async function git(args, cwd) {
  const r = await runGit(args, { cwd, maxBuffer: DIFF_MAX_BYTES });
  return r.ok ? r.stdout : null;
}

// What workingDiff says in place of a diff it could not get. Each names the cause and the next step, so the model does not tell the
// person there is nothing to review (tools-4).
export const DIFF_TOO_LARGE = 'The diff is too large to show here (over 8 MB). Name the files to review with @path.';
export const DIFF_TOO_SLOW = 'git took too long to produce the diff. Try again.';
const DIFF_FAILED = 'git could not produce the diff.';

// What changed in the working tree. Returns null when the folder is not a git repo,
// so the advisor can say its review is unverified. The diff runs with DIFF_SAFE, so no fsmonitor, external diff or textconv
// program of the repository runs, and runGit empties its filter drivers (DECISIONS item 30).
// A secret file (.env, a key, a credential file: isSecretFileName) is left out, both its diff and its name in the untracked list, as the
// turn snapshots leave it out (C-40). The text is not cut here: expandMessage cuts every @ block at 100 KB (lib/hooks/30-mentions.mjs).
// A diff over 8 MB, or one git needs more than its time limit for, is answered with a line that says so (DIFF_TOO_LARGE, DIFF_TOO_SLOW)
// and never with a part of the diff or with "no changes". The plain `git diff` (changes not yet staged) stands in for `git diff HEAD`
// only in a repository that has no commit yet. maxBuffer and timeoutMs are for the tests.
export async function workingDiff(root, { maxBuffer = DIFF_MAX_BYTES, timeoutMs } = {}) {
  const inside = await git(['rev-parse', '--is-inside-work-tree'], root);
  if (!inside || inside.trim() !== 'true') return null;
  const run = args => runGit(['diff', ...DIFF_SAFE, ...args], { cwd: root, maxBuffer, timeoutMs });
  let made = await run(['HEAD']);
  if (!made.ok && !made.tooBig && !made.timedOut && (await git(['rev-parse', '--verify', '-q', 'HEAD'], root)) === null) made = await run([]);
  const diff = made.ok ? dropSecretSections(made.stdout) : made.tooBig ? DIFF_TOO_LARGE : made.timedOut ? DIFF_TOO_SLOW : DIFF_FAILED;
  const untracked = ((await git(['ls-files', '--others', '--exclude-standard'], root)) ?? '').split('\n').filter(name => name && !isSecretFileName(name));
  const parts = [];
  if (diff.trim()) parts.push(diff.trimEnd());
  if (untracked.length) parts.push(`New untracked files:\n${untracked.join('\n')}`);
  return parts.join('\n\n') || '(no changes in the working tree)';
}
