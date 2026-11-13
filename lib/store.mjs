import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishState } from './events.mjs';
import { RENAME_WAITS, isLockError, writeFileAtomic } from './atomic-write.mjs';

export const HOME = process.env.MUSE_CONSOLE_HOME || path.join(os.homedir(), '.muse-console');
const FILE = path.join(HOME, 'state.json');
// The copy of the saved state from before the latest save. A damaged state.json is recovered from it (see recover).
const BAK = `${FILE}.bak`;
// The dated copies of the state file (see "Dated copies" below): <HOME>/backups/state-<yyyymmdd-hhmm>.json.
const BACKUPS = path.join(HOME, 'backups');
const MAX_MESSAGES = 300;
// A state file that cannot be read (busy or locked, not damaged) is read again this many times, WAIT_MS apart, before it is
// treated as unreadable. Antivirus or an indexer can hold it for a moment at start.
const READ_RETRIES = 3;
const READ_WAIT_MS = 200;

const LEGACY_ADVISOR = 'anthropic:claude-opus-5-5';
const defaults = () => ({
  projects: [], // { id, name, path, settings } (settings: the project's own overrides, see lib/projects.mjs)
  activeProject: null, // project id
  model: 'muse:muse-spark-1.2',
  advisor: null, // null means off. A new profile starts Off: the old default (Claude Opus 5.5) needs an API key a first-time person has not added.
  advisorAuto: false,
  approvals: 'ask', // 'ask' pauses for each edit or command; 'auto' runs them
  sessionMode: 'transcript', // 'native' resumes each CLI's own session; 'transcript' resends the chat
  relay: { autoRoute: false, countdownSec: 3, hops: null, stopOnError: true, dedupe: false },
  theme: 'system', // 'system' follows Windows; 'dark' and 'light' override it
  chats: {}, // project id -> messages
});

// The waits of the save scheduler (see "When a save runs" below). tuneSaves changes them, for tests.
const tuned = {
  // Between the tries of one rename onto a locked state file (lib/atomic-write.mjs).
  renameWaits: RENAME_WAITS,
  // After a save that failed, the state is saved again after 10 s, then 30 s, then every 60 s until a save works.
  retryMs: [10_000, 30_000, 60_000],
  // A draft save (persistQuiet) waits until this long after the last write ended, so several streaming replies share one write.
  quietGapMs: 2000,
  // The longest flush() waits for the disk before it gives up, so a disk that hangs cannot stop Plenum from closing.
  flushLimitMs: 2000,
};

let state = defaults();
// The write that is running, or null: { promise, open, covers }. open is true until the write has taken its text from the state, so
// a change made before that is in it. covers is the value of `changes` the text holds.
let running = null;
// The one write that waits to start, or null: { promise, resolve, now, full, timer }. Every caller that cannot join the running write
// shares it. now means it starts as soon as no write runs; otherwise it is a draft save and waits for the quiet gap (timer). full
// means persist() asked for it, so it may make a dated copy; a draft save, a re-save after a failure and flush() never do.
let pending = null;
// Counts the save requests. `saved` is the count the last write that worked covered, so the state is unsaved while they differ.
let changes = 0;
let saved = 0;
let lastWriteEnd = 0;
// The timed re-save after a failed save, and how many have been scheduled since a save last worked.
let retryTimer = null;
let retryStep = 0;
// Set when the last save was refused because another Plenum changed the state file. That refusal is never tried again by itself.
let conflict = false;
// Set when the state file could not be moved aside, or could not be read at all. Until a save replaces it, that file must not
// be copied over the backup.
let keepBackup = false;
// Set when the state file could not be read at start (see unreadable). It may hold newer data than the backup, so the first
// save copies it aside as state.json.unread-<time> before replacing it.
let keepUnread = false;
// What load() did about a damaged or unreadable state file, or null. The page shows it once; ackHealth() clears it for this run.
let healthState = null;
// The message of the last save that failed, or null once a save has worked. publicState carries it (see saveFailure).
let saveFailureMessage = null;
// The state file's text as this process last read or wrote it, or null when there was no file. undefined means the file could not
// be read at start, so there is nothing to compare with (see writeState).
let known = null;
// Whether `known` is known to hold a valid state: it was parsed at start, or this process wrote it. A save then does not parse the
// file again before it copies it.
let knownValid = false;
// Whether the backup already holds the text `known`. Two saves in a row that wrote the same text leave nothing new to copy.
let bakHoldsKnown = false;
// How many chats and messages the state in `known` holds ({ chats, messages }), or null when that is not known. A dated copy of
// that text takes the numbers from here, so the text is not parsed to count them (see "Dated copies").
let knownCounts = null;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
// What a state holds, for the list of dated copies: the chats that have a message, and the messages in them.
function countsOf(st) {
  let chats = 0;
  let messages = 0;
  for (const list of Object.values(isObject(st?.chats) ? st.chats : {})) {
    if (!Array.isArray(list) || list.length === 0) continue;
    chats += 1;
    messages += list.length;
  }
  return { chats, messages };
}
const validText = text => {
  try {
    asState(text);
    return true;
  } catch {
    return false;
  }
};

export async function load() {
  await loadFile();
  await setAsideBadChats();
  markInterrupted();
  return state;
}

async function loadFile() {
  // Temp files left by a save that was killed between its write and its rename are removed first.
  await removeStaleTemps();
  let text;
  try {
    text = await readStateFile();
  } catch (err) {
    known = null;
    knownCounts = null;
    // A file that is missing is a fresh start, unless a backup exists. Any other read error is not proof of damage, so nothing is
    // renamed.
    if (err.code === 'ENOENT') await missing();
    else await unreadable(err);
    return state;
  }
  known = text;
  knownValid = false;
  knownCounts = null;
  try {
    state = asState(text);
    knownValid = true;
    knownCounts = countsOf(state);
  } catch (err) {
    await recover(err);
  }
  return state;
}

// Parses the text of a state file. The file must hold an object, its projects (when present) must be a list of objects and its
// chats (when present) must be an object. Any other shape throws, so the caller recovers, instead of starting with a value that
// fails later.
function asState(text) {
  // A UTF-8 byte-order mark is not part of JSON text, and an editor may add one. It is removed, as lib/rules.mjs does for its files.
  const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!isObject(parsed)) throw new Error('The state file does not hold an object.');
  if (parsed.projects !== undefined && !(Array.isArray(parsed.projects) && parsed.projects.every(isObject))) {
    throw new Error('The project list is not a list of projects.');
  }
  if (parsed.chats !== undefined && !isObject(parsed.chats)) throw new Error('The chat store is not an object.');
  const fresh = defaults();
  const loaded = { ...fresh, ...parsed };
  // A state file that has no advisor key is one an old build wrote when that build's default was Claude Opus 5.5: it keeps that default, so
  // nobody's advisor changes on its own. Only a new profile (no state file) starts with the advisor Off.
  if (!Object.hasOwn(parsed, 'advisor')) loaded.advisor = LEGACY_ADVISOR;
  // A model or advisor that is not text (a file an older build damaged: "/model __proto__" saved {}) would fail every chat, so the default
  // takes its place. An advisor of null is how it is turned off.
  if (typeof loaded.model !== 'string') loaded.model = fresh.model;
  if (loaded.advisor !== null && typeof loaded.advisor !== 'string') loaded.advisor = fresh.advisor;
  return loaded;
}

// Reads the state file. A read that fails for a reason other than a missing file is tried again, up to READ_RETRIES times.
// The last error is thrown when every try fails.
async function readStateFile() {
  for (let tries = 0; ; tries++) {
    try {
      return await fs.readFile(FILE, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT' || tries >= READ_RETRIES) throw err;
      await new Promise(resolve => setTimeout(resolve, READ_WAIT_MS));
    }
  }
}

// A damaged state file is renamed, never deleted, so its content stays on disk. The backup is loaded when it reads,
// and a fresh state otherwise. The outcome is kept for the page (health()) until it is acknowledged.
async function recover(err) {
  const corruptFile = `${FILE}.corrupt-${stamp()}`;
  let kept = null;
  try {
    await fs.rename(FILE, corruptFile);
    kept = corruptFile;
    known = null;
  } catch {
    // The damaged file stays where it is (another program holds it), so the next save must not copy it over the backup. It is
    // copied aside now instead. If even the copy fails, the next save copies it first and stops if that fails (copyUnread).
    keepBackup = true;
    try {
      await fs.copyFile(FILE, corruptFile);
      kept = corruptFile;
    } catch {
      keepUnread = true;
    }
  }
  const back = await loadBackup();
  const recovered = back.loaded ? 'backup' : 'defaults';
  console.warn(`Could not read ${FILE} (${err.code ?? 'damaged file'}). ${recovered === 'backup' ? 'Loaded the last backup.' : 'No usable backup was found, so Plenum starts fresh.'}`);
  healthState = { recovered, corruptFile: kept, at: Date.now(), home: HOME };
  // Only when the damaged file was kept: the loaded state is saved again, so a restart does not start from nothing.
  if (kept) await persist();
}

// The state file is missing. A fresh start is right only when there is no backup either. When a backup exists, it is loaded
// and the page is told, because the file was deleted or moved while Plenum was not running. A backup that is there but cannot be
// used is told too, so the fresh start is not silent.
async function missing() {
  const back = await loadBackup();
  if (back.loaded) {
    console.warn(`Could not find ${FILE}. Loaded the last backup.`);
    healthState = { recovered: 'backup', corruptFile: null, missing: true, at: Date.now(), home: HOME };
    return;
  }
  if (!back.present) return;
  console.warn(`Could not find ${FILE}, and its backup could not be used. Plenum starts fresh.`);
  healthState = { recovered: 'defaults', corruptFile: back.kept, missing: true, at: Date.now(), home: HOME };
}

// The state file could not be read even after the retries, so it is not known to be damaged. Nothing is renamed or deleted.
// The backup is loaded when it reads. keepBackup stops the next save from copying the unread file over the backup.
async function unreadable(err) {
  keepBackup = true;
  keepUnread = true;
  known = undefined;
  const back = await loadBackup();
  const recovered = back.loaded ? 'backup-readonly' : 'defaults';
  console.warn(`Could not read ${FILE} (${err.code ?? 'unknown error'}). ${recovered === 'backup-readonly' ? 'Loaded the last backup.' : 'No usable backup was found, so Plenum starts fresh.'}`);
  healthState = { recovered, corruptFile: null, unread: true, at: Date.now(), home: HOME };
}

// Loads the backup into state when it reads and holds a valid state. Otherwise state is the defaults. A backup that reads but is
// damaged is kept aside (keepBackupAside), so the next save cannot replace it. Returns { loaded, present, kept }: present says whether
// a backup file exists, kept is the path of the damaged backup's copy or null.
async function loadBackup() {
  let text;
  try {
    text = await fs.readFile(BAK, 'utf8');
  } catch (err) {
    state = defaults();
    return { loaded: false, present: err.code !== 'ENOENT', kept: null };
  }
  try {
    state = asState(text);
    return { loaded: true, present: true, kept: null };
  } catch {
    state = defaults();
    return { loaded: false, present: true, kept: await keepBackupAside() };
  }
}

// Moves a damaged backup aside as state.json.bak.corrupt-<time>. When the move fails it is copied instead. When neither works, the
// backup stays where it is and keepBackup stops the next save from copying over it. Returns the kept path or null.
async function keepBackupAside() {
  const kept = `${BAK}.corrupt-${stamp()}`;
  try {
    await fs.rename(BAK, kept);
    return kept;
  } catch {
    // The copy below is the fallback.
  }
  try {
    await fs.copyFile(BAK, kept);
    return kept;
  } catch {
    keepBackup = true;
    return null;
  }
}

// A chat entry must be null (no chat yet) or a list of objects. Any other value would fail every send, compact and clear on its
// project, so the value is kept in a file beside the state file and the entry starts empty. Nothing is deleted. When the value cannot
// be kept, the entry is left as it is.
// target is the state to check: the loaded one, or the state of a dated copy before a restore uses it (restoreBackup). That one is
// not saved or told to the page here, because the restore does both once it has gone through. Resolves to the path of the file the
// old values were kept in, or null when nothing was set aside.
async function setAsideBadChats(target = state) {
  const bad = Object.entries(target.chats ?? {}).filter(([, list]) => list !== null && !(Array.isArray(list) && list.every(isObject)));
  if (bad.length === 0) return null;
  const kept = path.join(HOME, `state.json.damaged-chats-${stamp()}.json`);
  try {
    await fs.writeFile(kept, JSON.stringify(Object.fromEntries(bad), null, 2), { flag: 'wx' });
  } catch (err) {
    console.error(`Could not keep the damaged chats (${err.code ?? 'unknown error'}), so they are left as they are.`);
    return null;
  }
  for (const [id] of bad) target.chats[id] = [];
  console.warn(`A chat in ${target === state ? FILE : 'the restored copy'} was not a list of messages. It was kept in ${kept}, and the chat starts empty.`);
  if (target !== state) return kept;
  healthState ??= { recovered: 'chats', corruptFile: kept, at: Date.now(), home: HOME };
  // Saved once, so the reset survives a restart.
  await persist();
  return kept;
}

// A save writes its temp file under a name that holds the process id, then renames it into place. A process killed between the
// two leaves that file behind. The temp files of processes that are no longer running are removed. A running process's temp
// file is kept, so a second Plenum on the same folder is not touched. The saved prompts and pipelines are written the same way
// (lib/atomic-write.mjs, where the name also holds a counter), so their temp files are removed here too.
const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

async function removeStaleTemps() {
  for (const name of await fs.readdir(HOME).catch(() => [])) {
    const match = /^(?:state|prompts|pipelines)\.json\.(\d+)(?:\.\d+)?\.tmp$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid !== process.pid && !alive(pid)) await fs.rm(path.join(HOME, name), { force: true }).catch(() => {});
  }
}

// What load() did about a damaged, unreadable or missing state file, or null when the file was read normally.
export function health() {
  return healthState;
}

export function ackHealth() {
  healthState = null;
}

// The message of the last save that failed, or null once a save has worked. The page shows it, so a change that the file does
// not hold is not hidden from the user.
export const saveFailure = () => saveFailureMessage;

export const get = () => state;

export function transcript(projectId) {
  return (state.chats[projectId] ??= []);
}

// Adds a message and returns the stored row, so a caller can finish it later (finishMessage) or take it out (removeMessage).
export function addMessage(projectId, message) {
  const list = transcript(projectId);
  const row = { ...message, ts: Date.now() };
  list.push(row);
  if (list.length > MAX_MESSAGES) list.splice(0, list.length - MAX_MESSAGES);
  return row;
}

// A reply that streams is a draft row in the transcript (B-29). When it ends, the same row takes the finished reply's fields, so the
// transcript gets one row for the reply, not two. A row that is no longer in the transcript is added again instead.
export function finishMessage(projectId, row, fields) {
  const list = transcript(projectId);
  if (!list.includes(row)) return addMessage(projectId, fields);
  for (const key of Object.keys(row)) delete row[key];
  Object.assign(row, fields, { ts: Date.now() });
  return row;
}

// Takes a draft row out of the transcript, for a reply that ends with nothing to keep. A row that is not there is left alone.
export function removeMessage(projectId, row) {
  const list = transcript(projectId);
  const at = list.indexOf(row);
  if (at !== -1) list.splice(at, 1);
  return at !== -1;
}

// A reply still drafted when the state is read was cut off by a crash or a kill, since no run is live at start (B-29): the draft is marked
// interrupted, and so is a question that has no reply after it (a compact or an auto-fix row is not a question). The page says so.
function markInterrupted() {
  for (const list of Object.values(state.chats ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      if (row?.draft === true) {
        delete row.draft;
        row.interrupted = true;
      }
    }
    const last = list.at(-1);
    if (last && last.role === 'user' && !last.compact && !last.auto && !last.interrupted && ['chat', 'council', 'build'].includes(last.kind)) {
      last.interrupted = true;
    }
  }
}

// The saved file is copied to the backup before it is replaced, so one good copy is always kept. A backup that is read-only (the
// copy carries that attribute over from a read-only state file) is made writable first, so the copy can replace it. A copy that
// fails is reported and the save goes on. A missing state file has nothing to copy, so that is not reported.
// diskValid() says whether the text on disk holds a valid state (writeState works it out once, and only when it is asked). Resolves
// to whether the backup now holds that text.
async function backUp(disk, diskValid) {
  if (keepBackup) return false;
  // A state file on disk that does not hold a valid state is not copied over the backup, which keeps the last good save.
  if (typeof disk === 'string' && !diskValid()) return false;
  // The last save wrote the text the backup already holds, so there is nothing new to copy.
  if (typeof disk === 'string' && disk === known && bakHoldsKnown) return true;
  await fs.chmod(BAK, 0o600).catch(() => {});
  let copied = typeof disk === 'string';
  await fs.copyFile(FILE, BAK).catch(err => {
    copied = false;
    if (err.code !== 'ENOENT') console.warn(`Could not copy ${FILE} to the backup (${err.code ?? 'unknown error'}). The backup is older than the last save.`);
  });
  return copied;
}

// ---------- Dated copies ----------
// The backup above is the save before the last one, so it is seconds old and cannot bring back chats that a mistake or a fault removed
// minutes ago (store-4). Dated copies can. The contract, which lib/routes/store-health.mjs and the page rely on:
//   <HOME>/backups/state-<yyyymmdd-hhmm>.json          at most one an hour, made by a save that persist() asked for
//   <HOME>/backups/state-<yyyymmdd-hhmm>-update.json   before the first save of a build other than the one that saved last
//   <HOME>/backups/state-<yyyymmdd-hhmm>-restore.json  the state as it was just before a restore, so a restore can be undone
//   (a name that is taken gets -2, -3 and so on; the time in a name is local time)
//   <HOME>/backups/index.json                          what each copy holds, so the list need not read the copies (see copyIndex)
//   backups()            -> [{ name, time, bytes, kind, chats, messages }] newest first; kind is 'hourly', 'update' or 'restore';
//                           chats and messages are how many the copy holds, or null when the copy cannot be read as a state
//   restoreBackup(name, { prepare })
//                        -> { name, kept, fresh }; kept is the name of the copy that holds the state from before the restore, or
//                           null; fresh is false when nothing had changed since the last restore, so that restore's copy is
//                           named again and no new one is made. prepare(next) may bring the copy's state up to date before it is used.
// A copy is the text of the state file as the save found it (it is not read a second time), and only a text that holds a valid
// state is copied. A copy that fails (a full disk, a locked file, a folder that cannot be made) is skipped and tried again later:
// it never fails the save and is never waited for with retries. Kept: the newest 24 hourly copies, then the newest copy of each of
// 7 earlier days, the newest 3 "update" copies, every "restore" copy younger than 7 days and the newest 3 older ones, and the newest
// copy that is more than twice the size of every newer one (the state from before a large loss). The whole folder stays under a byte
// limit, oldest first, but the two newest copies always stay, and so does the first "restore" copy of each series of restores (the
// state a person had before trying copies one after another), until it is 7 days old.
const COPY_NAME = /^state-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(?:-(update|restore))?(?:-(\d{1,3}))?\.json$/;
// The build that saved last, as one line of text. It is beside the copies, not in the state file, so the state's shape is unchanged.
const BUILD_MARK = path.join(BACKUPS, 'last-build.txt');
// tuneBackups changes these, for tests. build is a function that returns the build's id, or null to read lib/build-info.mjs.
const copyTune = {
  now: () => Date.now(),
  everyMs: 3_600_000,
  hourly: 24,
  daily: 7,
  special: 3,
  // Every -restore copy younger than this is kept, whatever their number. Restores that follow each other by less than seriesGapMs
  // are one series, and the first copy of a series is the one the byte limit never removes.
  restoreKeepMs: 7 * 86_400_000,
  seriesGapMs: 3_600_000,
  maxBytes: 200 * 1024 * 1024,
  retryMs: 600_000,
  build: null,
};
// The time of the newest copy, null when there is none, undefined until the folder has been read.
let lastCopyAt;
// Whether the build mark has been compared with this build in this process.
let buildSeen = false;
// After a copy that failed, no copy is tried before this time.
let copyRetryAt = 0;
// What went wrong with the last copy, in plain words, or null. backupProblem() gives it to the page.
let copyProblem = null;
// True while a restore runs, so two restores never cross.
let restoring = false;
// The last restore of this process: { text, kept }. text is the state file exactly as that restore left it and kept is the name of
// the -restore copy it answered. While the file still holds that text, another restore has nothing new to keep (see restoreBackup).
// A save that writes any other text forgets it (writeState).
let lastRestore = null;
// What each copy holds, by name: Map(name -> { bytes, mtime, chats, messages }), kept in backups/index.json so the list does not
// read every copy (40 copies of 5 MB) each time it is shown. undefined until the file has been read. An entry counts only while
// the copy still has that size and that time; any other copy is read and counted when the list is next asked for (backups()).
const COPY_INDEX = path.join(BACKUPS, 'index.json');
let copyIndex;

const two = n => String(n).padStart(2, '0');
const copyStamp = ms => {
  const d = new Date(ms);
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
};

// What a file name in the backups folder says, or null when it is not the name of a copy.
function copyInfo(name) {
  const m = COPY_NAME.exec(name);
  if (!m) return null;
  const time = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  if (!Number.isFinite(time)) return null;
  return { name, time, day: m[1] + m[2] + m[3], kind: m[6] ?? 'hourly', n: Number(m[7] ?? 1) };
}

// The copies in the folder, newest first, with their sizes. A folder that is missing or cannot be read holds none.
async function listCopies() {
  const found = [];
  for (const name of await fs.readdir(BACKUPS).catch(() => [])) {
    const info = copyInfo(name);
    if (!info) continue;
    const stat = await fs.stat(path.join(BACKUPS, name)).catch(() => null);
    if (stat?.isFile()) found.push({ ...info, bytes: stat.size, mtime: stat.mtimeMs });
  }
  return found.sort((a, b) => b.time - a.time || b.n - a.n || b.mtime - a.mtime);
}

// The index of what the copies hold, read once. A missing or damaged index is an empty one: the copies are counted again.
async function readIndex() {
  if (copyIndex) return copyIndex;
  const index = new Map();
  try {
    const parsed = JSON.parse(await fs.readFile(COPY_INDEX, 'utf8'));
    for (const [name, e] of Object.entries(isObject(parsed?.copies) ? parsed.copies : {})) {
      if (!COPY_NAME.test(name) || !isObject(e) || !Number.isFinite(e.bytes) || !Number.isFinite(e.mtime)) continue;
      const whole = Number.isInteger(e.chats) && Number.isInteger(e.messages);
      index.set(name, { bytes: e.bytes, mtime: e.mtime, chats: whole ? e.chats : null, messages: whole ? e.messages : null });
    }
  } catch {
    // No index yet, or one that cannot be read.
  }
  // Another call may have read it meanwhile; the first one read stays.
  copyIndex ??= index;
  return copyIndex;
}

// Writes the index. It never throws: an index that cannot be written only means the copies are counted again later.
async function writeIndex() {
  if (!copyIndex) return;
  try {
    await writeFileAtomic(COPY_INDEX, JSON.stringify({ version: 1, copies: Object.fromEntries(copyIndex) }), { waits: [] });
  } catch {
    // Left for the next time.
  }
}

// Notes what a copy that was just written holds. Never throws.
async function noteCopy(name, counts) {
  try {
    const stat = await fs.stat(path.join(BACKUPS, name));
    const index = await readIndex();
    index.set(name, { bytes: stat.size, mtime: Math.round(stat.mtimeMs), chats: counts.chats, messages: counts.messages });
    await writeIndex();
  } catch {
    // The list counts this copy when it is next shown.
  }
}

// Reads one copy and counts what it holds. A copy that cannot be read, or that does not hold a state, has no numbers.
async function countCopy(name) {
  try {
    return countsOf(asState(await fs.readFile(path.join(BACKUPS, name), 'utf8')));
  } catch {
    return { chats: null, messages: null };
  }
}

// Writes one copy under a name that is free and returns the name. The text goes to a temp file that is renamed (one try: a copy is
// never waited for), so a copy is whole or absent. counts is what the text holds when the caller knows it without parsing the text.
async function writeCopy(text, kind, counts = null) {
  await fs.mkdir(BACKUPS, { recursive: true });
  const base = `state-${copyStamp(copyTune.now())}${kind === 'hourly' ? '' : `-${kind}`}`;
  for (let n = 1; n <= 999; n += 1) {
    const name = n === 1 ? `${base}.json` : `${base}-${n}.json`;
    const file = path.join(BACKUPS, name);
    const taken = await fs.stat(file).then(() => true, err => err.code !== 'ENOENT');
    if (taken) continue;
    await writeFileAtomic(file, text, { waits: [] });
    await fs.chmod(file, 0o600).catch(() => {});
    if (counts) await noteCopy(name, counts);
    return name;
  }
  throw Object.assign(new Error('no free name for the dated copy'), { code: 'EEXIST' });
}

// This build as one line ("0.6.0+20261113.0412", or the version alone for a development copy), or null when it cannot be told.
// lib/build-info.mjs is read only here and only when asked, so a copy of Plenum without that file saves as before.
async function buildId() {
  try {
    if (typeof copyTune.build === 'function') return copyTune.build() || null;
    const { buildInfo } = await import('./build-info.mjs');
    const info = buildInfo();
    const id = [info?.version, info?.build].filter(part => typeof part === 'string' && part).join('+');
    return id || null;
  } catch {
    return null;
  }
}

// The build's id when it differs from the build that saved last (or none is recorded), else null. Asked until it has an answer.
async function newBuild() {
  if (buildSeen) return null;
  const id = await buildId();
  const last = id === null ? null : await fs.readFile(BUILD_MARK, 'utf8').then(text => text.trim(), () => null);
  if (id === null || last === id) {
    buildSeen = true;
    return null;
  }
  return id;
}

async function markBuild(id) {
  await fs.mkdir(BACKUPS, { recursive: true });
  await writeFileAtomic(BUILD_MARK, id, { waits: [] });
  buildSeen = true;
}

// Whether an hour has passed since the newest copy. The folder is read once; after that the time is kept in memory. A newest copy
// that is far in the future (the clock was set back) does not stop the copies.
async function hourPassed(now) {
  if (lastCopyAt === undefined) lastCopyAt = (await listCopies())[0]?.time ?? null;
  return lastCopyAt === null || now - lastCopyAt >= copyTune.everyMs || lastCopyAt - now > copyTune.everyMs;
}

// Removes the copies that are no longer kept (see the contract above), and the temp files a killed process left in the folder.
async function pruneCopies() {
  const all = await listCopies();
  const keep = new Set();
  const plain = all.filter(c => c.kind === 'hourly');
  for (const c of plain.slice(0, copyTune.hourly)) keep.add(c.name);
  const days = new Set();
  for (const c of plain.slice(copyTune.hourly)) {
    if (days.has(c.day)) continue;
    if (days.size >= copyTune.daily) break;
    days.add(c.day);
    keep.add(c.name);
  }
  for (const kind of ['update', 'restore']) {
    for (const c of all.filter(x => x.kind === kind).slice(0, copyTune.special)) keep.add(c.name);
  }
  // A -restore copy is the only file that holds what the person had before a restore, and the way to find a lost chat is to restore
  // one copy after another. So these are not counted out: every one younger than a week stays, and the first of each series of
  // restores (the state from before the person began) is never removed by the byte limit below either.
  const now = copyTune.now();
  const firsts = new Set();
  let earlier = null;
  for (const c of all.filter(x => x.kind === 'restore').reverse()) {
    if (now - c.time < copyTune.restoreKeepMs) {
      keep.add(c.name);
      if (earlier === null || c.time - earlier.time > copyTune.seriesGapMs) firsts.add(c.name);
    }
    earlier = c;
  }
  // The newest copy that is more than twice as large as every newer one: the state from before a large loss stays until a larger
  // state is saved again.
  let largestNewer = 0;
  for (const [i, c] of all.entries()) {
    if (i > 0 && c.bytes > 2 * largestNewer) {
      keep.add(c.name);
      break;
    }
    largestNewer = Math.max(largestNewer, c.bytes);
  }
  const left = [];
  const gone = [];
  for (const c of all) {
    if (keep.has(c.name)) left.push(c);
    else if (await fs.rm(path.join(BACKUPS, c.name), { force: true }).then(() => true, () => false)) gone.push(c.name);
  }
  // The byte limit: the oldest kept copy goes first, but never one of the two newest and never the first -restore copy of a series.
  // A copy that cannot be removed ends the pass; the next one tries again.
  let total = left.reduce((sum, c) => sum + c.bytes, 0);
  while (total > copyTune.maxBytes) {
    let at = left.length - 1;
    while (at >= 2 && firsts.has(left[at].name)) at -= 1;
    if (at < 2) break;
    const [oldest] = left.splice(at, 1);
    const removed = await fs.rm(path.join(BACKUPS, oldest.name), { force: true }).then(() => true, () => false);
    if (!removed) break;
    gone.push(oldest.name);
    total -= oldest.bytes;
  }
  // What the index says about a copy that is gone goes with it.
  if (copyIndex && gone.filter(name => copyIndex.delete(name)).length > 0) await writeIndex();
  for (const name of await fs.readdir(BACKUPS).catch(() => [])) {
    const match = /\.(\d+)\.\d+\.tmp$/.exec(name);
    if (match && Number(match[1]) !== process.pid && !alive(Number(match[1]))) await fs.rm(path.join(BACKUPS, name), { force: true }).catch(() => {});
  }
}

// The dated copy of one save, when one is due: the text the save found on disk (the state before this save). It never throws and
// never fails the save. A failure is logged once, kept for the page (backupProblem) and tried again after ten minutes.
async function datedCopy(disk, diskValid) {
  try {
    const now = copyTune.now();
    if (now < copyRetryAt) return;
    const build = await newBuild();
    if (typeof disk !== 'string' || !diskValid()) {
      // Nothing that can be copied (a first start, or a file that does not hold a state). A first start records the build all the same.
      if (build !== null && disk === null) await markBuild(build);
      return;
    }
    if (build === null && !(await hourPassed(now))) return;
    await writeCopy(disk, build === null ? 'hourly' : 'update', disk === known ? knownCounts : null);
    lastCopyAt = now;
    if (build !== null) await markBuild(build);
    await pruneCopies();
    copyProblem = null;
    copyRetryAt = 0;
  } catch (err) {
    copyRetryAt = copyTune.now() + copyTune.retryMs;
    const first = copyProblem === null;
    copyProblem = err?.code === 'ENOSPC'
      ? 'The last dated copy could not be made because the disk is full. Saving goes on, and Plenum tries the copy again later.'
      : `The last dated copy could not be made (${err?.code ?? 'unknown error'}). Saving goes on, and Plenum tries the copy again later.`;
    if (first) console.warn(`Could not keep a dated copy of ${FILE} in ${BACKUPS} (${err?.code ?? err?.message ?? 'unknown error'}). The save itself is not affected.`);
  }
}

// The dated copies, newest first: [{ name, time, bytes, kind, chats, messages }]. time is in milliseconds, read from the name.
// chats and messages come from the index; a copy the index does not know (one from an earlier build, one put there by hand, one
// that was changed) is read and counted here, once, and a copy that does not hold a state has null for both.
export async function backups() {
  const all = await listCopies();
  const index = await readIndex();
  let changed = false;
  const out = [];
  for (const { name, time, bytes, kind, mtime } of all) {
    let entry = index.get(name);
    if (!entry || entry.bytes !== bytes || entry.mtime !== Math.round(mtime)) {
      entry = { bytes, mtime: Math.round(mtime), ...(await countCopy(name)) };
      index.set(name, entry);
      changed = true;
    }
    out.push({ name, time, bytes, kind, chats: entry.chats, messages: entry.messages });
  }
  const names = new Set(all.map(c => c.name));
  for (const name of [...index.keys()]) {
    if (!names.has(name)) changed = index.delete(name) || changed;
  }
  if (changed) await writeIndex();
  return out;
}

// Where the copies are, and what went wrong with the last one (a sentence, or null).
export const backupsFolder = () => BACKUPS;
export const backupProblem = () => copyProblem;

// Changes the limits of the dated copies (the keys of copyTune) and forgets what was read from the folder. For tests.
export function tuneBackups(values = {}) {
  for (const key of Object.keys(copyTune)) {
    if (values[key] !== undefined) copyTune[key] = values[key];
  }
  lastCopyAt = undefined;
  buildSeen = false;
  copyRetryAt = 0;
  copyIndex = undefined;
}

// Puts a dated copy in the place of the state. The copy must hold a valid state, and nothing is changed when it does not. The state
// as it is now is saved and kept as a -restore copy first, so the restore can be undone; when that copy cannot be made, nothing is
// restored. The restored state goes through the same checks as a state read at start and is saved by the usual queue, so the check
// for another Plenum sees this process's own write. The caller makes sure no reply is running (lib/routes/store-health.mjs).
//
// Two things the review of 13 Nov 2026 found, and how they are closed:
// - A person looks for a lost chat by restoring copies one after another. When nothing was changed since the last restore, the file
//   holds exactly what that restore wrote, which is itself a copy in the list, so no new -restore copy is made and the earlier one
//   is answered again (fresh: false). A series of trial restores so leaves ONE -restore copy: the state from before the series.
//   (pruneCopies also keeps every -restore copy for a week, so a series with changes in between loses nothing either.)
// - A change saved while the restore was writing its copy went into the old state and into no file. Now the state is swapped only
//   when no save was asked for since the text of the -restore copy was taken; otherwise the copy is made again, and after three
//   rounds the restore is refused, because something is still writing.
//
// prepare(next) is called with the copy's state before it is used, and may change it (the route gives a copy from before threads
// its Main threads there). It is awaited; what it throws is ignored.
// Resolves to { name, kept, fresh }. Throws an error with a sentence for the person and a status.
export async function restoreBackup(name, { prepare } = {}) {
  const refuse = (message, status) => Object.assign(new Error(message), { status });
  const busy = () => refuse('The chats or settings are still changing (a reply or a task may be running). Wait for it to end, and then restore. Nothing was changed.', 409);
  if (typeof name !== 'string' || !COPY_NAME.test(name)) throw refuse('That is not the name of a saved copy.', 400);
  if (restoring) throw refuse('A restore is already running. Wait for it to end.', 409);
  restoring = true;
  try {
    let text;
    try {
      text = await fs.readFile(path.join(BACKUPS, name), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') throw refuse('That copy is no longer there. Nothing was changed.', 404);
      throw refuse(`That copy could not be read (${err.code ?? 'unknown error'}). Nothing was changed.`, 500);
    }
    let next;
    try {
      next = asState(text);
    } catch {
      throw refuse('That copy does not hold a usable state, so nothing was changed.', 422);
    }
    // Everything that needs the disk or another module is done on the copy's state before the swap, so that nothing is awaited
    // between the swap and the save that follows it: a chat that is not a list is set aside as at a start, then the caller's part.
    const aside = await setAsideBadChats(next);
    if (typeof prepare === 'function') {
      try {
        await prepare(next);
      } catch {
        // The copy's state is used as it is.
      }
    }
    let kept = null;
    let fresh = false;
    for (let round = 1; ; round += 1) {
      // The file is brought up to date first, so the copy made next holds everything that is on screen now.
      const unsaved = await persist();
      if (unsaved !== null) throw refuse(`${unsaved} Nothing was restored.`, 500);
      // A save was asked for after that write took its text, so the file is behind again.
      if (saved !== changes) {
        if (round >= 3) throw busy();
        continue;
      }
      const seen = changes;
      let made = null;
      kept = null;
      if (typeof known === 'string') {
        const earlier = lastRestore !== null && lastRestore.text === known ? lastRestore.kept : null;
        if (earlier !== null && (await fs.stat(path.join(BACKUPS, earlier)).then(stat => stat.isFile(), () => false))) {
          kept = earlier;
        } else {
          try {
            made = await writeCopy(known, 'restore', knownCounts);
          } catch (err) {
            throw refuse(`The chats and settings as they are now could not be copied first (${err.code ?? 'unknown error'}), so nothing was restored.`, 500);
          }
          kept = made;
        }
      }
      // Nothing is awaited between this check and the swap, so no change can fall between the copy and the restored state.
      if (changes === seen) {
        fresh = made !== null;
        break;
      }
      // The copy is already older than the state. It is taken away again, and the next round makes a new one.
      if (made !== null) {
        await fs.rm(path.join(BACKUPS, made), { force: true }).catch(() => {});
        copyIndex?.delete(made);
      }
      if (round >= 3) throw busy();
    }
    state = next;
    markInterrupted();
    if (aside !== null) healthState ??= { recovered: 'chats', corruptFile: aside, at: Date.now(), home: HOME };
    const before = changes;
    const failure = await persist();
    // Remembered only when nobody else asked for a save meanwhile, so the text is the restored state and nothing more.
    lastRestore = failure === null && kept !== null && changes === before + 1 && typeof known === 'string' ? { text: known, kept } : null;
    await pruneCopies().catch(() => {});
    if (failure !== null) throw refuse(`${failure} The restored chats and settings are shown but are lost on restart until a save works.`, 500);
    return { name, kept, fresh };
  } finally {
    restoring = false;
  }
}

// The state file could not be read at start, so it is copied aside before the first save replaces it. A missing file needs no copy.
// Any other failure stops the save, so the unread file is never replaced without a copy.
async function copyUnread() {
  const unreadCopy = `${FILE}.unread-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    await fs.copyFile(FILE, unreadCopy);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  keepUnread = false;
}

// The state file as it is on disk now: its text, null when there is no file, or undefined when it cannot be read.
async function diskText() {
  try {
    return await fs.readFile(FILE, 'utf8');
  } catch (err) {
    return err.code === 'ENOENT' ? null : undefined;
  }
}

// What the person is told when a save failed. A lock (EPERM, EBUSY, EACCES) has already been tried again for about 3 seconds by then.
// Every text here is true only because startWrite schedules the re-save (scheduleRetry) after such a failure.
function saveFailureText(err) {
  if (isLockError(err)) {
    return 'Plenum could not save its state file: another program has it open (often a sync or antivirus tool), or the folder cannot be written. Plenum tries again by itself.';
  }
  if (err?.code === 'ENOSPC') return 'Plenum could not save its state file because the disk is full. Free some space. Plenum tries again by itself.';
  return `Plenum could not save its state file (${err?.code ?? 'unknown error'}). Plenum tries again by itself.`;
}

// One save: the backup, then the state written to a temp file, flushed to the disk and renamed over the state file; a rename onto
// a locked file is tried again for about 3 seconds (lib/atomic-write.mjs). Never rejects. Resolves to null when the save worked,
// or to the failure message. A failed save removes its temp file. onText is called at the moment the text is taken from the state.
// full is false for a draft save, which never makes a dated copy (see "Dated copies").
async function writeState(onText = () => {}, full = true) {
  conflict = false;
  let backed = false;
  try {
    await fs.mkdir(HOME, { recursive: true });
    const disk = await diskText();
    // Another Plenum on the same folder saved since this process last read or wrote the file. Replacing it would drop that save, so
    // this one is refused and the change stays on screen until the window is restarted. A file that is gone is not a conflict: it
    // was removed while Plenum ran, and this save writes it again.
    if (known !== undefined && typeof disk === 'string' && disk !== known) {
      conflict = true;
      saveFailureMessage = 'Another Plenum changed the state file in this folder, so this window\'s changes were not saved. Close the other Plenum and restart this one.';
      console.error('Could not save state: the state file was changed by another Plenum.');
      publishState('save-failed');
      return saveFailureMessage;
    }
    // Whether the text on disk holds a valid state. The text this process read at start or wrote itself is known to (store-3): it is
    // not parsed again, which on a large state is the longest block of a save. Any other text is parsed, once.
    let valid;
    const diskValid = () => (valid ??= (disk === known && knownValid) || validText(disk));
    backed = await backUp(disk, diskValid);
    if (full) await datedCopy(disk, diskValid);
    if (keepUnread) await copyUnread();
    onText();
    const text = JSON.stringify(state, null, 2);
    const counts = countsOf(state);
    // Writes run one at a time, so the temp file keeps its one name per process (removeStaleTemps knows it).
    await writeFileAtomic(FILE, text, { tmp: `${FILE}.${process.pid}.tmp`, waits: tuned.renameWaits });
    bakHoldsKnown = backed && text === disk;
    // The file no longer holds what the last restore wrote, so the next restore has something new to keep.
    if (lastRestore !== null && lastRestore.text !== text) lastRestore = null;
    known = text;
    knownCounts = counts;
    knownValid = true;
    keepBackup = false;
    saveFailureMessage = null;
    return null;
  } catch (err) {
    // The file was not replaced. Whether the backup holds it is no longer certain when the copy ran, so the next save copies again.
    bakHoldsKnown = false;
    saveFailureMessage = saveFailureText(err);
    console.error('Could not save state:', err?.message ?? err);
    publishState('save-failed');
    return saveFailureMessage;
  }
}

// ---------- When a save runs ----------
// A save writes the whole state, so the saves are kept few. At most one write runs, and at most one more waits. A caller's promise
// resolves only from a write that took its text after the call, so a save that reports success always holds the caller's change:
// a call joins the running write while that write has not taken its text yet, and shares the one waiting write otherwise. Fifty
// calls in a row are one or two writes. A failed write leaves the state unsaved (changes differs from saved), so the next write
// carries the change again, and a timer saves again by itself when nothing else does.

// Asks for a save and returns the promise of the write that covers it. now is false for a draft save, which may wait.
function request(now) {
  changes += 1;
  if (running?.open) return running.promise;
  return waitForNext(now, now);
}

function waitForNext(now, full = false) {
  if (!pending) {
    let resolve;
    const promise = new Promise(done => {
      resolve = done;
    });
    pending = { promise, resolve, now: false, full: false, timer: null };
  }
  if (now) pending.now = true;
  if (full) pending.full = true;
  const { promise } = pending;
  pump();
  return promise;
}

// Starts the waiting write when no write runs and it is due. A draft save is due once the quiet gap after the last write is over;
// its timer is not unref'd, because the write is owed and the wait is short.
function pump() {
  if (running || !pending) return;
  const wait = pending.now ? 0 : lastWriteEnd + tuned.quietGapMs - Date.now();
  if (wait <= 0) {
    startWrite();
    return;
  }
  pending.timer ??= setTimeout(() => {
    if (pending) {
      pending.timer = null;
      pending.now = true;
    }
    pump();
  }, wait);
}

function startWrite() {
  const job = pending;
  pending = null;
  clearTimeout(job.timer);
  const mine = { promise: job.promise, open: true, covers: changes };
  running = mine;
  const failedBefore = saveFailureMessage !== null;
  const taken = () => {
    mine.open = false;
    mine.covers = changes;
  };
  // writeState never rejects; the catch keeps that true for the callers even if it ever did.
  writeState(taken, job.full)
    .catch(err => {
      saveFailureMessage = saveFailureText(err);
      return saveFailureMessage;
    })
    .then(failure => {
      running = null;
      lastWriteEnd = Date.now();
      if (failure === null) {
        saved = mine.covers;
        cancelRetry();
        // The page shows the failure until it is told a save worked.
        if (failedBefore) publishState('save-worked');
      } else if (conflict) {
        cancelRetry();
      } else {
        scheduleRetry();
      }
      job.resolve(failure);
      pump();
    });
}

// After a save that failed for a reason of the disk (not the refusal for another Plenum), the state is saved again by itself. One
// timer at a time; it does not keep the process alive, and it tells no window by itself (a failure or a recovery does, as always).
function scheduleRetry() {
  if (retryTimer) return;
  const wait = tuned.retryMs[Math.min(retryStep, tuned.retryMs.length - 1)];
  retryStep += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (changes !== saved) waitForNext(true);
  }, wait);
  retryTimer.unref?.();
}

function cancelRetry() {
  clearTimeout(retryTimer);
  retryTimer = null;
  retryStep = 0;
}

// Changes the waits of the scheduler (the keys of `tuned`). For tests, which cannot wait 10 seconds for a re-save.
export function tuneSaves(values = {}) {
  for (const key of Object.keys(tuned)) {
    if (values[key] !== undefined) tuned[key] = values[key];
  }
}

// Saves the state: a temp file renamed into place, one write at a time (see "When a save runs"). Every window is told the state
// changed (lib/events.mjs); calls close together become one event. The promise never rejects. It resolves to null when the save
// worked, or to the failure message. Callers that must know whether the change reached the file use saveOrFail().
export function persist() {
  publishState('persist');
  return request(true);
}

// The same save, but without telling the windows, and it may wait up to the quiet gap (2 seconds after the last write) so the
// drafts of several replies share one write. A reply's draft is saved this way while it streams: the stream already shows the
// reply, so a redraw would only repeat it. It never rejects; a failed save is kept in saveFailure as usual.
export function persistQuiet() {
  return request(false);
}

// Brings the file up to date before Plenum closes or restarts: a waiting draft save starts now, a running write is waited for, and
// a change whose save failed is written again. Resolves to null when the file holds the state, or to a message when the save failed
// or took longer than the limit (2 seconds). It never rejects, and with nothing to save it writes nothing.
export function flush(limitMs = tuned.flushLimitMs) {
  let job;
  if (pending || (!running && changes !== saved)) job = waitForNext(true);
  else if (running) job = running.promise;
  else return Promise.resolve(null);
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve('Plenum could not finish saving its state file in time.'), limitMs);
    job.then(result => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

// Saves, and throws when the save failed, so a route answers with an error instead of a success that the file does not back up.
// The error has status 500, because the server maps an error without a status to 400.
export async function saveOrFail() {
  const failure = await persist();
  if (failure === null) return;
  throw Object.assign(new Error(`${failure} The change is shown but is lost on restart until a save works.`), { status: 500 });
}
