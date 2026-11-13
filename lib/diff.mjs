import { promises as fs } from 'node:fs';

// Previews for approval cards: a unified diff with line numbers and three lines of context, and the content of a new
// file. The card shows the text in a pre element, so everything here is plain text.

const CONTEXT = 3;
// The longest edit the search looks for, in changed lines. A bigger change is shown as every old line removed and
// every new line added: still exact, only not the shortest diff.
const MAX_EDITS = 2000;
// The largest existing file that is read for a diff.
const MAX_COMPARE = 2_000_000;
// The most characters an approval card shows for one detail.
const DETAIL_MAX = 40_000;
// Room kept free under the cap for the "more lines not shown" line.
const NOTE_ROOM = 100;

// The lines of a text as a diff counts them. A final newline does not start another line; noEol is true when the
// text ends without one.
function splitLines(text) {
  if (!text) return { lines: [], noEol: false };
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') return { lines: lines.slice(0, -1), noEol: false };
  return { lines, noEol: true };
}

// Myers' search for the shortest edit between two lists of line ids. Returns the steps in order: { t: 'eq', o, n },
// { t: 'del', o } or { t: 'ins', n }, where o and n are 0-based line indexes. Null when the edit is over MAX_EDITS.
function editSteps(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3); // v[off + k] is the furthest x reached on diagonal k
  const trace = []; // trace[d] holds the reach on diagonals -d..d before step d, for the walk back
  for (let d = 0; d <= max; d++) {
    if (d > MAX_EDITS) return null;
    trace.push(v.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      // Step down (an insertion) or right (a deletion), whichever reaches further.
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) return walkBack(trace, n, m);
    }
  }
  return null;
}

// Walks the trace back from the end point to the start, and returns the steps in order.
function walkBack(trace, n, m) {
  const steps = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    let px = 0;
    let py = 0;
    if (d > 0) {
      const k = x - y;
      const vd = trace[d];
      const pk = k === -d || (k !== d && vd[k - 1 + d] < vd[k + 1 + d]) ? k + 1 : k - 1;
      px = vd[pk + d];
      py = px - pk;
    }
    while (x > px && y > py) { steps.push({ t: 'eq', o: x - 1, n: y - 1 }); x--; y--; }
    if (d > 0) steps.push(x === px ? { t: 'ins', n: py } : { t: 'del', o: px });
    x = px;
    y = py;
  }
  return steps.reverse();
}

// A unified diff of two texts: the changed lines with three lines of context, the old and new line numbers beside
// each line, and a header per block. Returns "No changes." when the texts are the same.
export function unifiedDiff(oldText, newText, label) {
  if (oldText === newText) return 'No changes.';
  const a = splitLines(oldText);
  const b = splitLines(newText);
  // The search compares small integer ids. A last line without its newline is a different line from the same text with one.
  const ids = new Map();
  const idOf = (line, noEol) => {
    const key = `${noEol ? 'N' : 'L'}${line}`;
    if (!ids.has(key)) ids.set(key, ids.size);
    return ids.get(key);
  };
  const ka = a.lines.map((line, i) => idOf(line, a.noEol && i === a.lines.length - 1));
  const kb = b.lines.map((line, i) => idOf(line, b.noEol && i === b.lines.length - 1));
  const steps = editSteps(ka, kb) ?? [
    ...a.lines.map((_, o) => ({ t: 'del', o })),
    ...b.lines.map((_, n) => ({ t: 'ins', n })),
  ];
  // Changes closer together than two context blocks share one hunk.
  const hunks = [];
  steps.forEach((s, i) => {
    if (s.t === 'eq') return;
    const from = Math.max(0, i - CONTEXT);
    const to = Math.min(steps.length - 1, i + CONTEXT);
    const last = hunks[hunks.length - 1];
    if (last && from <= last.to + 1) last.to = to;
    else hunks.push({ from, to });
  });
  if (!hunks.length) return 'No changes.';
  const width = String(Math.max(a.lines.length, b.lines.length, 1)).length;
  const num = n => (n === undefined ? ' '.repeat(width) : String(n).padStart(width));
  // A side with no lines in the hunk is numbered by the line before it, as unified diffs do.
  const before = (key, i) => {
    for (let j = i; j >= 0; j--) if (steps[j][key] !== undefined) return steps[j][key] + 1;
    return 0;
  };
  const out = [`--- ${label}`, `+++ ${label}`];
  for (const { from, to } of hunks) {
    const part = steps.slice(from, to + 1);
    const oldRows = part.filter(s => s.t !== 'ins');
    const newRows = part.filter(s => s.t !== 'del');
    const oldStart = oldRows.length ? oldRows[0].o + 1 : before('o', from - 1);
    const newStart = newRows.length ? newRows[0].n + 1 : before('n', from - 1);
    out.push(`@@ -${oldStart},${oldRows.length} +${newStart},${newRows.length} @@`);
    for (const s of part) {
      const marker = s.t === 'del' ? '-' : s.t === 'ins' ? '+' : ' ';
      const side = s.t === 'ins' ? b : a;
      const i = s.t === 'ins' ? s.n : s.o;
      const oldNo = s.o === undefined ? undefined : s.o + 1;
      const newNo = s.n === undefined ? undefined : s.n + 1;
      out.push(`${marker} ${num(oldNo)} ${num(newNo)} ${side.lines[i].replace(/\r$/, '')}`);
      if (side.noEol && i === side.lines.length - 1) out.push('\\ No newline at end of file');
    }
  }
  return out.join('\n');
}

// Caps card text at max characters. Past the cap, the last line says how many lines are not shown.
export function capDetail(text, max = DETAIL_MAX) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const lines = s.split('\n');
  const room = max - NOTE_ROOM;
  const kept = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > room) break;
    kept.push(line);
    used += line.length + 1;
  }
  const more = lines.length - kept.length;
  const plural = more === 1 ? 'line' : 'lines';
  if (kept.length) return `${kept.join('\n')}\n…${more} more ${plural} not shown`;
  // The first line alone is longer than the room, so it is cut.
  return `${lines[0].slice(0, room)}\n…line cut short${more ? `, and ${more} more ${plural} not shown` : ''}`;
}

// ---------- line endings and encoding ----------
// The rules for an edit's line endings live here, so the approval card (planEdit, editDetail) and the write (runEdit, runWrite)
// use the same ones and cannot differ.

// How a text ends its lines: 'crlf' when every line break is \r\n (Windows), 'lf' when none is, 'mixed' when both occur and
// 'none' when the text has no line break.
export function eolOf(text) {
  let crlf = 0;
  let lf = 0;
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) {
    if (at > 0 && text.charCodeAt(at - 1) === 13) crlf += 1;
    else lf += 1;
  }
  if (!crlf && !lf) return 'none';
  if (crlf && lf) return 'mixed';
  return crlf ? 'crlf' : 'lf';
}

const toLf = s => s.replace(/\r\n/g, '\n');
const toCrlf = s => s.replace(/\r?\n/g, '\r\n');
// True when a text has a \n with no \r before it.
const hasBareLf = s => /(^|[^\r])\n/.test(s);

// What an edit searches in, what it searches for, what it puts there, and how the result goes back to the file's own line endings.
// The exact text is tried first, so every edit that matches as written works as it always did. A file whose line breaks are all
// \r\n is the one case with more to it, because a model reads and writes lines with \n:
// - old text with no bare \n that is in the file: matched as written; the new text's line breaks become \r\n.
// - otherwise the file, the old text and the new text are all compared with \n line breaks, and the result gets \r\n back. (Old text
//   with a bare \n is never matched as written in such a file: it could only match by splitting a \r\n pair.)
// A file with mixed line endings is matched as written only, and the new text goes in as given.
function editTerms(text, oldText, newText) {
  const same = s => s;
  if (eolOf(text) !== 'crlf') return { hay: text, needle: oldText, put: newText, back: same };
  if (!hasBareLf(oldText) && text.includes(oldText)) return { hay: text, needle: oldText, put: toCrlf(newText), back: same };
  return { hay: toLf(text), needle: toLf(oldText), put: toLf(newText), back: s => s.replace(/\n/g, '\r\n') };
}

// How many times an edit's old text is in the text, counted the way replaceText matches it.
export function countMatches(text, oldText) {
  const { hay, needle } = editTerms(text, oldText, '');
  return needle ? hay.split(needle).length - 1 : 0;
}

// The text after an edit: the first match replaced, or every match when replaceAll is set. count is how many were replaced.
// The file's line endings are kept (see editTerms).
export function replaceText(text, oldText, newText, replaceAll) {
  const { hay, needle, put, back } = editTerms(text, oldText, newText);
  if (replaceAll) {
    const parts = hay.split(needle);
    return parts.length > 1 ? { updated: back(parts.join(put)), count: parts.length - 1 } : { updated: text, count: 0 };
  }
  const at = hay.indexOf(needle);
  if (at < 0) return { updated: text, count: 0 };
  return { updated: back(hay.slice(0, at) + put + hay.slice(at + needle.length)), count: 1 };
}

// The content a whole-file write puts on disk, given the file's text now (undefined for a new file or one that cannot be compared).
// A file whose line breaks are all \r\n keeps them when the new content has only \n. Content that already has a \r\n is written as given.
export function keepLineEndings(current, content) {
  if (typeof current !== 'string' || eolOf(current) !== 'crlf') return content;
  return eolOf(content) === 'lf' ? toCrlf(content) : content;
}

// The bytes of a file as text that can be edited and written back without loss: { text }, or { why } when it cannot. The text is
// decoded strictly, so a file in another encoding (Latin-1, Windows-1252, UTF-16) is never turned into replacement characters and
// written back damaged. A UTF-8 byte order mark stays in the text as its first character, so it is written back too.
export function editableText(bytes) {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    return { why: 'it is UTF-16 text, not UTF-8' };
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { why: 'it is not UTF-8 text (it uses another encoding, or is not text at all)' };
  }
  if (text.includes('\u0000')) return { why: 'it looks like a binary file or UTF-16 text' };
  return { text };
}

// The file as it is now: { text } when it can be compared, { missing: true } when there is no file, else { why }.
async function currentFile(file) {
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) return { why: 'it is not a file' };
    if (st.size > MAX_COMPARE) return { why: 'it is too large to compare' };
    const text = await fs.readFile(file, 'utf8');
    return text.includes('\u0000') ? { why: 'it is not a text file' } : { text };
  } catch (err) {
    return err.code === 'ENOENT' ? { missing: true } : { why: 'it could not be read' };
  }
}

// The lines of some content, numbered, for a card that shows content rather than a change.
function numbered(text) {
  const { lines } = splitLines(text);
  const width = String(Math.max(lines.length, 1)).length;
  return lines.map((line, i) => `${String(i + 1).padStart(width)}  ${line.replace(/\r$/, '')}`).join('\n');
}

// The content write_file puts in a file: the content as given, or with the file's Windows line endings when the file has them and the
// content has none (keepLineEndings). planWrite, runWrite and writeFullText all go through it, so the card and the write agree.
export async function writeContent(file, content) {
  return keepLineEndings((await currentFile(file)).text, content);
}

// The whole text of the detail for a write_file approval, before the card cap: a diff against the file as it is now, or, for a new
// file, its content and line count. The card shows capDetail of it, and Show all (fullDetail) gets the rest.
export async function writeFullText(file, content, label) {
  const cur = await currentFile(file);
  if (cur.missing) {
    if (!content) return 'Creates an empty file.';
    const count = splitLines(content).lines.length;
    return `Creates a new file, ${count} ${count === 1 ? 'line' : 'lines'} (${Buffer.byteLength(content)} bytes):\n\n${numbered(content)}`;
  }
  if (cur.text === undefined) return `Replaces the existing file, which is not shown as a diff because ${cur.why}. New content:\n\n${numbered(content)}`;
  // The card compares what the write will hold: a file with Windows line endings keeps them (writeContent).
  content = keepLineEndings(cur.text, content);
  if (cur.text === content) return 'Replaces the existing file with the same content, so nothing changes.';
  return `Replaces the existing file.\n\n${unifiedDiff(cur.text, content, label)}`;
}

// The detail for a write_file approval, capped for the card.
export async function writeDetail(file, content, label) {
  return capDetail(await writeFullText(file, content, label));
}

// The detail for an edit_file approval: the diff of the file before and after the replacement. When the file cannot be
// compared or the old text is not in it, only the two snippets are shown, and the card says so.
export async function editDetail(file, oldText, newText, replaceAll, label) {
  const cur = await currentFile(file);
  if (cur.text !== undefined) {
    const { updated, count } = replaceText(cur.text, oldText, newText, replaceAll);
    if (count) return capDetail(unifiedDiff(cur.text, updated, label));
  }
  const why = cur.missing ? 'The file does not exist'
    : cur.text !== undefined ? 'The old text was not found in the file'
      : `The file was not compared, because ${cur.why}`;
  return capDetail(`${why}. Only the two snippets are shown.\n\n${unifiedDiff(oldText, newText, label)}`);
}
