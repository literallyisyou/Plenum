import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The temp folders Plenum makes for one run (a read-only seat's folder, a council's, an agent's, a compare's, ...) are removed by the run
// itself. A run that was cut off by a crash or by the shell being ended in Task Manager leaves its folder behind. This module clears
// those folders at the next start (DECISIONS: orphan sweep). It only ever touches a folder in the temp folder whose name is one of
// the names Plenum's own mkdtemp calls make: a known prefix, a dash and the six characters mkdtemp adds. Anything else in the temp
// folder is some other program's and is never looked at.
export const SCRATCH_PREFIXES = Object.freeze([
  'plenum-readonly', 'muse-council', 'plenum-agy', 'plenum-images', 'plenum-agent', 'plenum-compare', 'plenum-pipeline',
  'plenum-muse', 'plenum-tooltest', 'muse-review', 'plenum-gemini-auth', 'muse-console-update', 'muse-console-agents', 'muse-console',
]);
// mkdtemp adds six characters of [A-Za-z0-9]. A folder a person made with a plain word after the prefix ("plenum-agent-backup",
// "muse-console-update") is only lower-case letters, which real names do in 0.55 percent of cases; so a name counts only when its
// six characters hold an upper-case letter or a digit.
const NAME = new RegExp(`^(?:${SCRATCH_PREFIXES.join('|')})-(?=[A-Za-z0-9]{6}$)[a-z]*[A-Z0-9][A-Za-z0-9]*$`);
export const isScratchName = name => NAME.test(String(name));

// A folder that nothing has written to for this long belongs to a run that is over.
export const SCRATCH_MAX_AGE_MS = 12 * 60 * 60 * 1000;
// A folder written to since this computer started may belong to a run that is still going (of this Plenum, or of another one that shares
// the temp folder), however long ago the write was: no run survives a restart, so only a folder untouched since before the start counts
// as a leftover. A run that waits for a person for a day is still older than 12 hours but younger than the start of the computer.
// After a week it is taken for a leftover whatever the start time.
const LEFTOVER_MAX_MS = 7 * 24 * 60 * 60 * 1000;
export const scratchCutoff = (now, maxAgeMs, upMs = os.uptime() * 1000) => Math.max(Math.min(now - maxAgeMs, now - upMs - 60_000), now - Math.max(LEFTOVER_MAX_MS, maxAgeMs));

// The marker (the checker's N6): a folder counts as Plenum's scratch only when it holds this small file, which Plenum's own wrapper
// (makeScratch, below) writes the moment it makes the folder. A name alone is not enough: a person can make a folder with such a name.
// Until every mkdtemp call of Plenum goes through makeScratch, a folder made by one that does not has no marker and is never removed
// by a sweep (a leak, safe).
export const SCRATCH_MARKER = '.plenum-scratch';
const MARKER_TEXT = 'plenum-scratch 1\n';
export async function markScratch(dir) {
  await fs.writeFile(path.join(dir, SCRATCH_MARKER), `${MARKER_TEXT}${new Date().toISOString()} pid ${process.pid}\n`, { flag: 'wx' });
}
// True when `dir` holds the marker as a plain file (not a link, small, with Plenum's text).
export async function hasScratchMarker(dir) {
  try {
    const file = path.join(dir, SCRATCH_MARKER);
    const st = await fs.lstat(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 512) return false;
    return (await fs.readFile(file, 'utf8')).startsWith(MARKER_TEXT);
  } catch {
    return false;
  }
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// Makes a scratch folder the way every caller does (the same names) and writes the marker into it. Use it in place of
//   await fs.mkdtemp(path.join(os.tmpdir(), 'plenum-agent-'))      ->      await makeScratch('plenum-agent')
// (the prefix without its trailing dash; `tmp` defaults to os.tmpdir()). A marker that cannot be written does not fail the run: the folder
// is returned, and a sweep will leave it alone.
export async function makeScratch(prefix, tmp = os.tmpdir()) {
  if (!SCRATCH_PREFIXES.includes(prefix)) throw new Error(`"${prefix}" is not a scratch folder name Plenum uses.`);
  const dir = await fs.mkdtemp(path.join(tmp, `${prefix}-`));
  try {
    await markScratch(dir);
  } catch {
    // Unmarked: never swept.
  }
  return dir;
}

// Removes one scratch folder, only when it is directly in `tmp`, has a scratch name, holds the marker and is a real folder (not a link of
// any kind). Returns true when it was removed. Never throws.
export async function removeScratchDir(dir, tmp = os.tmpdir()) {
  try {
    if (typeof dir !== 'string' || !dir) return false;
    const resolved = path.resolve(dir);
    if (!samePath(path.dirname(resolved), tmp) || !isScratchName(path.basename(resolved))) return false;
    const st = await fs.lstat(resolved);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    if (!await hasScratchMarker(resolved)) return false;
    // The folder must be where its name says, with no link on the way (a junction swapped in for it would send the removal elsewhere).
    const real = await fs.realpath(resolved);
    if (!samePath(real, path.join(await fs.realpath(tmp), path.basename(resolved)))) return false;
    await fs.rm(resolved, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// Whether nothing in `dir` has been written since `cutoff` (a time in ms): the newest modification time of the folder and of everything
// inside it, down to any depth, is looked at, and the look stops at the first thing newer than the cutoff. A link or a junction is
// counted by its own time and never followed. At most MAX_WALK entries are looked at; with more, or with anything that cannot be
// read, the answer is "not known" (false) and the folder is kept. Returns true only when every entry is older than the cutoff.
export const MAX_WALK = 5000;
export async function untouchedSince(dir, cutoff, limit = MAX_WALK) {
  let seen = 0;
  const top = await fs.lstat(dir);
  if (top.mtimeMs > cutoff) return false;
  const stack = [dir];
  while (stack.length) {
    const here = stack.pop();
    let names;
    try {
      names = await fs.readdir(here);
    } catch {
      return false;
    }
    for (const name of names) {
      seen += 1;
      if (seen > limit) return false;
      let st;
      try {
        st = await fs.lstat(path.join(here, name));
      } catch {
        return false;
      }
      if (st.mtimeMs > cutoff) return false;
      if (st.isDirectory() && !st.isSymbolicLink()) stack.push(path.join(here, name));
    }
  }
  return true;
}

// Removes scratch folders in `tmp` that hold the marker and that nothing has touched for maxAgeMs AND since before the computer started
// (scratchCutoff; the newest time stamp of the folder and of every file inside), or for a week.
// keep is a Set (or a function) of folders that a live run still owns (lowercase, resolved); they are left alone whatever their age.
// upMs is how long the computer has been running (a test passes 0). Returns the names removed. Never throws.
export async function sweepScratch({ tmp = os.tmpdir(), now = Date.now(), maxAgeMs = SCRATCH_MAX_AGE_MS, keep = null, upMs = os.uptime() * 1000 } = {}) {
  const removed = [];
  let names;
  try {
    names = await fs.readdir(tmp);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!isScratchName(name)) continue;
    const dir = path.join(tmp, name);
    try {
      const held = typeof keep === 'function' ? keep(dir) : keep?.has(path.resolve(dir).toLowerCase());
      if (held) continue;
      const st = await fs.lstat(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      if (!await hasScratchMarker(dir)) continue;
      if (!await untouchedSince(dir, scratchCutoff(now, maxAgeMs, upMs))) continue;
      if (await removeScratchDir(dir, tmp)) removed.push(name);
    } catch {
      // Not ours to judge, or already gone.
    }
  }
  return removed;
}
