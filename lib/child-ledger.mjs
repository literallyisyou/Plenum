import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renameRetry, writeFileAtomic } from './atomic-write.mjs';
import { removeScratchDir, SCRATCH_MAX_AGE_MS, isScratchName, sweepScratch } from './scratch.mjs';

// The ledger of the processes Plenum starts (DECISIONS: orphan sweep).
//
// Every CLI Plenum starts goes through startChild (lib/proc.mjs), which writes one line here: the process id, when it was started, its
// program, a few hashed flags of its command line, and the process that started it (the owner: this server). When the child ends, the
// line is removed. If the server or the desktop shell dies without ending its children (a crash, Task Manager), the lines stay, and
// the next start of Plenum (sweepOnce) ends what is still running from them and clears their temp folders.
//
// A sweep ends a process ONLY when every one of these is true, so a process of another program is never ended:
//   1. the line is in this ledger (Plenum started it and wrote it down);
//   2. its owner is gone. The owner counts as ALIVE whenever a live process has the owner's id and was created at or before the line's
//      start time plus 2 seconds (a reused id belongs to a process created later); and whenever anything is in doubt (the clock was
//      stepped, the repeated hour of daylight saving, a time that cannot be read) it is alive and nothing is ended. A second live Plenum
//      keeps its children;
//   3. a process with the child's id is running, was created within a few seconds of the recorded start, has the recorded program name,
//      and its command line holds every recorded flag (compared by hash). Just before the end, that one id is looked at AGAIN and
//      compared again; if anything differs nothing is ended and the line is dropped;
//   4. the line is not the hub's launcher, and is not this process.
// The tree under a confirmed process is ended by walking a fresh table of all processes (a child counts only when it was created after
// its parent, so a reused parent id never adds a stranger) and ending each one by its own id, each only while it still has the
// creation date the table showed (one hidden PowerShell call reads and ends, so no other program can take the id in between).
// `taskkill /t` is never used here.
// All times are UTC milliseconds. The check reads the processes with one hidden PowerShell call (Get-WmiObject Win32_Process; its
// creation date carries the UTC offset, so the repeated hour is not ambiguous) on Windows and `ps` elsewhere. Anything but one JSON
// array as the answer is a failed read, and a failed read ends nothing.
// The ledger holds no environment, no prompt and no key: the command line is kept as hashes of the flags and paths in it.
//
// What a sweep cannot do: a child of a CLI whose own process already ended before the crash has no parent to be found by, and a ledger
// write that raced with a crash within a few milliseconds is missing.
//
// THE SWEEP IS SWITCHED OFF IN THIS BUILD (13 Nov 2026, the coordinator's decision after the second check, ultra/plan/check-sweep2.md).
// Every entry that could end a process or clear a folder at start (sweepOnce, sweepAtStart) does nothing unless the environment has
// PLENUM_SWEEP=1: no PowerShell is started, no table is read, no folder is looked at, and the only thing logged is one line saying so.
// The ledger itself (recording and forgetting children) and Stop stay on. The guards below are built and tested behind the same switch,
// so that it can be switched on in a later build:
//   G1 an id is ended only while it still has the creation date the table showed, checked in the same hidden command that ends it, and
//      never the sweeping process or one of its ancestors (endConfirmed);
//   G2 a scratch folder written since the computer started is kept, up to a week, and only a folder with Plenum's marker file counts
//      as scratch (lib/scratch.mjs);
//   G3 lines older than the last start of the computer are dropped without reading any table: after a restart nothing of ours is alive;
//   N4 two processes writing one ledger take turns through a lock file (mutate), so no line is lost.
// What must be true before it is switched on: the real-crash test (a parent that dies while its children live) has run on a shell that
// lets children outlive their parent; every mkdtemp call of Plenum uses makeScratch (the marker); a third independent check.
//
// Off switches that win over everything (no sweep and no ledger write at all, by every entry): PLENUM_NO_SWEEP=1, PLENUM_SMOKE=1 (the
// shell's hidden start check), and a node:test process that has no home of its own. A test's stand-in spawner never reaches the ledger
// (startChild).

export const LEDGER_NAME = 'children.json';
const MAX_ENTRIES = 500;
const START_TOLERANCE_BEFORE_MS = 5000;
const START_TOLERANCE_AFTER_MS = 2000;
const OWNER_TOLERANCE_MS = 60_000;
const PROBE_PART = 100;
const PROBE_PARALLEL = 3;
const END_PARALLEL = 4;
const TREE_LIMIT = 300;
// The hub's launcher (DECISIONS item 118: Plenum starts `Tabletalk.cmd up`) is the hub's, not a run of Plenum. lib/hub-starter.mjs never
// goes through startChild (a test reads its source to keep it so), so no line is ever written for it. If one were, the program it names
// (the recorded command or program, never a word in an argument, and never the word "hub") is still left alone.
const LAUNCHER = /^(?:tabletalk|hub-starter)/i;
const launcherName = text => LAUNCHER.test(path.win32.basename(String(text ?? '').trim().replace(/^["']+|["']+$/g, '')));

// ---------- where the ledger is ----------

export function ledgerHome(env = process.env) {
  return env.MUSE_CONSOLE_HOME || path.join(os.homedir(), '.muse-console');
}
export const ledgerFile = (home = ledgerHome()) => path.join(home, LEDGER_NAME);

// This process as an owner: its id and the time it started (the uptime gives it to the second).
const OWN_START = Math.round(Date.now() - process.uptime() * 1000);
export const thisOwner = () => ({ pid: process.pid, startedAt: OWN_START });

// Whether the ledger is used at all. Switched off by PLENUM_NO_SWEEP=1 and by PLENUM_SMOKE=1 (the shell's smoke start must not touch
// anything); and a test process (node --test) with no home of its own would write to the owner's real folder, so it does not use it.
export const ledgerOff = (env = process.env) => env.PLENUM_NO_SWEEP === '1' || env.PLENUM_SMOKE === '1';
export function ledgerAllowed(env = process.env) {
  if (ledgerOff(env)) return false;
  if (env.NODE_TEST_CONTEXT && !env.MUSE_CONSOLE_HOME) return false;
  return true;
}

// ---------- what a command line is, without keeping its text ----------

const hash = text => createHash('sha256').update(String(text).toLowerCase()).digest('hex').slice(0, 12);
const unquote = text => String(text).replace(/^["']+|["']+$/g, '');
// Only flags and paths are kept (as hashes): a word that could be a prompt is not, so no text a person typed is ever derived from it.
const FLAG = /^[-/][\w:.=-]{0,40}$/;
const PATHY = /^(?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/])[^\s"]{1,200}$/;
export function imageOf(file, platform = process.platform) {
  const base = (platform === 'win32' ? path.win32 : path.posix).basename(String(file)).toLowerCase();
  return platform === 'win32' && !path.win32.extname(base) ? `${base}.exe` : base;
}
// The program a launch names: its file, and on Windows the shim after cmd.exe /c.
function launchPrograms(file, argv, platform) {
  const list = Array.isArray(argv) ? argv.map(String) : [];
  const out = [String(file ?? '')];
  if (platform === 'win32') list.forEach((arg, i) => { if (/\s/.test(arg) && /^\/c$/i.test(list[i - 1] ?? '')) out.push(arg.trim().split(/\s+/)[0]); });
  return out;
}
export function tokensOf(file, argv = [], platform = process.platform) {
  const out = new Set();
  const take = raw => {
    const t = unquote(raw);
    if (t && (FLAG.test(t) || PATHY.test(t))) out.add(hash(t));
  };
  const list = Array.isArray(argv) ? argv.map(String) : [];
  list.forEach((arg, i) => {
    if (!/\s/.test(arg)) return take(arg);
    // The one argument of cmd.exe /c holds the shim's own path first ("C:\...\claude.cmd" ...): that path identifies the program.
    if (platform === 'win32' && /^\/c$/i.test(list[i - 1] ?? '')) take(arg.trim().split(/\s+/)[0]);
  });
  return [...out].slice(0, 12);
}
// The tokens of a live command line, the way tokensOf made them.
export function liveTokens(commandLine) {
  const out = new Set();
  for (const raw of String(commandLine ?? '').split(/\s+/)) {
    const t = unquote(raw);
    if (t) out.add(hash(t));
  }
  return out;
}

// ---------- the file ----------

// What a read gives: the lines this version understands (entries), the lines it does not (other: a newer version's, kept as they are),
// the other top-level fields (extra), the version number, and damaged: true when the file exists but is not a ledger. A damaged file
// reads as an empty ledger (nothing is ended because of it); the next write keeps it aside first and never overwrites it.
export async function readLedger(file = ledgerFile()) {
  const fresh = { v: 1, entries: [], other: [], extra: {}, damaged: false };
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return fresh;
  }
  if (!text.trim()) return fresh;
  try {
    const data = JSON.parse(text);
    if (data && !Array.isArray(data) && typeof data === 'object' && Array.isArray(data.entries)) {
      const { v, entries, ...extra } = data;
      return { v: Number.isInteger(v) && v >= 1 ? v : 1, entries: entries.filter(validEntry), other: entries.filter(e => !validEntry(e)), extra, damaged: false };
    }
  } catch {
    // Not JSON.
  }
  return { ...fresh, damaged: true };
}
function validEntry(e) {
  return e && Number.isInteger(e.pid) && e.pid > 1 && Number.isFinite(e.spawnedAt) && typeof e.image === 'string'
    && e.owner && Number.isInteger(e.owner.pid) && e.owner.pid > 1 && Number.isFinite(e.owner.startedAt)
    && (e.tokens === undefined || (Array.isArray(e.tokens) && e.tokens.every(t => typeof t === 'string')));
}

// A damaged ledger is renamed to children.json.damaged-<UTC date and time> (a number is added when that name is taken).
async function keepAside(file) {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  for (let n = 0; n < 50; n += 1) {
    const name = `${file}.damaged-${stamp}${n ? `-${n}` : ''}`;
    try {
      await fs.access(name);
    } catch {
      await renameRetry(file, name);
      return true;
    }
  }
  return false;
}

// N4: two processes that write one ledger (the installed app and a development copy on one home) take turns through a lock file beside
// it (children.json.lock, made with the exclusive flag, removed at once after the write). Read, change and write all happen inside the
// lock, so no line is lost. A lock left by a process that died is taken over after LOCK_STALE_MS; if the lock cannot be had within
// LOCK_WAIT_MS, or the folder will not let one be made, the write goes ahead without it (a line that is lost is a child that is not swept,
// never a child ended by mistake). The wait is never longer than that.
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 15_000;
async function withLock(file, body) {
  const lock = `${file}.lock`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const giveUp = Date.now() + LOCK_WAIT_MS;
  let held = false;
  while (!held) {
    try {
      const handle = await fs.open(lock, 'wx');
      await handle.writeFile(String(process.pid)).catch(() => {});
      await handle.close().catch(() => {});
      held = true;
    } catch (err) {
      // EEXIST: another has it. EPERM and EBUSY: Windows while a lock that was just removed is still closing. Anything else: no lock.
      if (!['EEXIST', 'EPERM', 'EBUSY'].includes(err?.code)) break;
      try {
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lock).catch(() => {});
          continue;
        }
      } catch {
        if (Date.now() > giveUp) break;
        continue;
      }
      if (Date.now() > giveUp) break;
      await new Promise(r => setTimeout(r, 10 + Math.random() * 30));
    }
  }
  try {
    return await body();
  } finally {
    if (held) await fs.unlink(lock).catch(() => {});
  }
}

// Changes to the file go one after another in this process (and, through the lock, one after another across processes). A write that
// fails is never an error for a run.
let chain = Promise.resolve();
function mutate(file, change) {
  const next = chain.then(() => withLock(file, async () => {
    let ledger = await readLedger(file);
    if (ledger.damaged) {
      // Never written over: its text stays under a dated name. If it cannot be set aside, nothing is written.
      if (!await keepAside(file)) return;
      ledger = await readLedger(file);
    }
    if (change(ledger) === false) return;
    const out = { ...ledger.extra, v: ledger.v, entries: [...ledger.other.slice(-MAX_ENTRIES), ...ledger.entries.slice(-MAX_ENTRIES)] };
    await writeFileAtomic(file, `${JSON.stringify(out)}\n`);
  })).catch(() => {});
  chain = next;
  return next;
}
// Resolves when every change so far has been written (a test, and the end of the process, wait for it).
export const ledgerSettled = () => chain;

// ---------- writing lines ----------

// Writes the line of a child that was just started. launch is { file, argv }. Returns the entry, or null when nothing is recorded
// (the hub's launcher, a child with no pid, or a ledger that is switched off). Never throws.
export function recordChild(child, { command, file, argv, cwd, platform = process.platform, home, env = process.env, now = Date.now(), owner = thisOwner(), tmp = os.tmpdir() } = {}) {
  try {
    if (!ledgerAllowed(env) || !Number.isInteger(child?.pid) || child.pid <= 1) return null;
    if (launcherName(command) || launchPrograms(file, argv, platform).some(launcherName)) return null;
    const entry = { pid: child.pid, spawnedAt: now, image: imageOf(file, platform), command: String(command ?? '').slice(0, 40), tokens: tokensOf(file, argv, platform), owner };
    if (typeof cwd === 'string' && isScratchName(path.basename(cwd)) && path.resolve(path.dirname(cwd)).toLowerCase() === path.resolve(tmp).toLowerCase()) entry.scratch = path.resolve(cwd);
    mutate(ledgerFile(home ?? ledgerHome(env)), l => { l.entries.push(entry); });
    return entry;
  } catch {
    return null;
  }
}

// Takes the line of a child out (it ended).
export function forgetChild(pid, { home, env = process.env, spawnedAt } = {}) {
  try {
    if (!ledgerAllowed(env) || !Number.isInteger(pid)) return Promise.resolve();
    return mutate(ledgerFile(home ?? ledgerHome(env)), l => {
      const before = l.entries.length;
      l.entries = l.entries.filter(e => !(e.pid === pid && (spawnedAt === undefined || e.spawnedAt === spawnedAt) && e.owner.pid === process.pid));
      return l.entries.length !== before;
    });
  } catch {
    return Promise.resolve();
  }
}

// ---------- looking at live processes ----------

// The creation date WMI gives is text like 20261113143914.031124-420: local time and the offset from UTC in minutes. That is turned
// into UTC milliseconds from the text itself, so the repeated hour of daylight saving is not ambiguous. createdAlt is the reading of
// the same local time by this machine's own time zone rules; when the two differ (WMI states the offset of today for an older process,
// or the hour is repeated) both are kept and a comparison accepts either. null when the text cannot be read.
export function parseDmtf(text) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const ms = Math.floor(Number(m[7]) / 1000);
  const local = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  if (!Number.isFinite(local)) return null;
  const createdMs = local - (m[8] === '-' ? -1 : 1) * Number(m[9]) * 60_000;
  const alt = new Date(y, mo - 1, d, h, mi, s, ms).getTime();
  return { createdMs, createdAlt: Number.isFinite(alt) && alt !== createdMs ? alt : undefined };
}
const timesOf = p => [p?.createdMs, p?.createdAlt].filter(Number.isFinite);

// One JSON array, in UTF-8, whatever the code page of the console is (a path with a letter like e-diaeresis must arrive whole).
function powershellScript(filter) {
  const where = filter ? ` -Filter '${filter}'` : '';
  return `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; $r=@(Get-WmiObject Win32_Process${where} | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; name=$_.Name; cmd=$_.CommandLine; cd=$_.CreationDate } }); ConvertTo-Json -InputObject $r -Compress`;
}
function runPowershell(script, { run, timeoutMs, maxBuffer }) {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const exe = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    try {
      run(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: timeoutMs, maxBuffer, encoding: 'utf8' }, (err, stdout) => {
        if (err) return reject(err);
        // Anything but one JSON array (a banner before it, text after it, nothing at all) is a failed read, never a throw.
        try {
          resolve(parseProbe(stdout));
        } catch (e) {
          reject(e);
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

// Reads { pid -> { name, commandLine, createdMs, createdAlt?, ppid } } for the ids. A process that is not running is not in the map.
// Throws (rejects) when the read cannot be done (the caller then ends nothing). windowsProbe takes any number of ids, in one call.
export function windowsProbe(pids, { run = execFile, timeoutMs = 20_000 } = {}) {
  const ids = [...new Set(pids)].filter(p => Number.isInteger(p) && p > 1);
  if (!ids.length) return Promise.resolve(new Map());
  return runPowershell(powershellScript(ids.map(p => `ProcessId=${p}`).join(' OR ')), { run, timeoutMs, maxBuffer: 4 * 1024 * 1024 });
}
// Every process, for walking a tree.
export function windowsTable({ run = execFile, timeoutMs = 30_000 } = {}) {
  return runPowershell(powershellScript(''), { run, timeoutMs, maxBuffer: 64 * 1024 * 1024 });
}
export function parseProbe(text) {
  const out = new Map();
  const body = String(text ?? '').trim();
  if (!body) throw new Error('The process read gave no answer.');
  const data = JSON.parse(body);
  if (!Array.isArray(data)) throw new Error('The process read gave an answer of an unexpected form.');
  for (const p of data) {
    if (!Number.isInteger(p?.pid)) continue;
    let createdMs = null;
    let createdAlt;
    if (Number.isFinite(p.created)) createdMs = p.created;
    else if (typeof p.cd === 'string') {
      const t = parseDmtf(p.cd);
      if (t) ({ createdMs, createdAlt } = t);
    }
    out.set(p.pid, { name: String(p.name ?? '').toLowerCase(), commandLine: String(p.cmd ?? ''), createdMs, createdAlt, ppid: Number.isInteger(p.ppid) ? p.ppid : null, cd: typeof p.cd === 'string' ? p.cd : null });
  }
  return out;
}
export function posixProbe(pids, { run = execFile, timeoutMs = 10_000 } = {}) {
  const ids = [...new Set(pids)].filter(p => Number.isInteger(p) && p > 1);
  if (!ids.length) return Promise.resolve(new Map());
  return new Promise((resolve, reject) => {
    // lstart is the start time in the C locale, one line per process; the command line comes second so it can hold spaces.
    run('ps', ['-o', 'pid=,lstart=,args=', '-p', ids.join(',')], { timeout: timeoutMs, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout) => {
      // ps exits 1 when none of the ids exists: that is an answer, an empty one.
      if (err && !(err.code === 1 && !String(stdout).trim())) return reject(err);
      const out = new Map();
      for (const line of String(stdout).split('\n')) {
        const m = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]{8}\s+\d{4})\s+(.*)$/.exec(line);
        if (!m) continue;
        const createdMs = Date.parse(m[2]);
        if (Number.isFinite(createdMs)) out.set(Number(m[1]), { name: path.posix.basename(m[3].split(/\s+/)[0]).toLowerCase(), commandLine: m[3], createdMs });
      }
      resolve(out);
    });
  });
}
// A ledger can name many ids; one command line holds only so many, so the ids are read in parts (a few at the same time). Any part that
// fails fails the whole read.
export async function probeInParts(probe, pids, { part = PROBE_PART, parallel = PROBE_PARALLEL } = {}) {
  const ids = [...new Set(pids)].filter(p => Number.isInteger(p) && p > 1);
  const parts = [];
  for (let i = 0; i < ids.length; i += part) parts.push(ids.slice(i, i + part));
  const out = new Map();
  await pool(parts, parallel, async ids1 => { for (const [k, v] of await probe(ids1)) out.set(k, v); });
  return out;
}
export const defaultProbe = (pids, platform = process.platform) => probeInParts(ids => (platform === 'win32' ? windowsProbe(ids) : posixProbe(ids)), pids);

async function pool(items, limit, worker) {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await worker(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

// ---------- ending a confirmed process ----------

// The ids below `root` in a table (a Map of pid -> row, or an array of rows): a row is a child of a process when its parent id is that
// process's id AND it was created at the same time or after it (a process whose parent died and whose parent id was reused is older
// than the new holder of that id, so it is not taken). A row with no readable time is never taken. Deepest first, root last.
export function treeBelow(table, root, { skip = [process.pid], limit = TREE_LIMIT } = {}) {
  const rows = table instanceof Map ? [...table.entries()].map(([pid, r]) => ({ ...r, pid })) : table;
  const byParent = new Map();
  for (const r of rows) {
    if (!Number.isInteger(r.ppid)) continue;
    if (!byParent.has(r.ppid)) byParent.set(r.ppid, []);
    byParent.get(r.ppid).push(r);
  }
  const top = rows.find(r => r.pid === root);
  const order = [];
  const seen = new Set([root]);
  const walk = (row, depth) => {
    for (const c of byParent.get(row.pid) ?? []) {
      if (seen.has(c.pid) || skip.includes(c.pid) || c.pid <= 4 || order.length >= limit) continue;
      if (!Number.isFinite(c.createdMs) || !Number.isFinite(row.createdMs) || c.createdMs < row.createdMs) continue;
      seen.add(c.pid);
      order.push({ pid: c.pid, depth });
      walk(c, depth + 1);
    }
  };
  if (top) walk(top, 1);
  return [...order.sort((a, b) => b.depth - a.depth).map(x => x.pid), root];
}

// The sweeper's own id and the ids of the processes above it (its parent, that one's parent, ...), read from the table.
export function ancestorsOf(rows, selfPid) {
  const mine = [selfPid];
  for (let at = rows.find(r => r.pid === selfPid), n = 0; at && n < 64 && Number.isInteger(at.ppid) && !mine.includes(at.ppid); at = rows.find(r => r.pid === at.ppid), n += 1) mine.push(at.ppid);
  return mine;
}

// The PowerShell text that ends the tree (G1). ids: leaves first, the root last; every one needs a creation date in the table's own text
// (a row with no date, or a root with no date, gives null: nothing is ended). The text reads the processes of the tree again, and only
// for an id whose creation date is still the one the table showed does it call Terminate; the root is compared first, and when it has
// changed nothing at all is ended. It answers "ended:<ids>,<-ids that changed> seen:<ids still running>".
const DATE_TEXT = /^[\d.+-]{20,30}$/;
export function endScript(rows, ids, rootPid) {
  const want = ids.map(id => rows.find(r => r.pid === id)).filter(r => r && DATE_TEXT.test(r.cd ?? ''));
  if (!want.some(r => r.pid === rootPid)) return null;
  return `$ErrorActionPreference='Stop'; $want=@{ ${want.map(r => `${r.pid}='${r.cd}'`).join('; ')} }; $order=@(${want.map(r => r.pid).join(',')}); $done=@(); $all=@{}; foreach ($p in @(Get-WmiObject Win32_Process -Filter '${want.map(r => `ProcessId=${r.pid}`).join(' OR ')}')) { $all[[int]$p.ProcessId]=$p }; $root=$all[${rootPid}]; if ($root -and $want[${rootPid}] -ne $root.CreationDate) { $done+=-${rootPid} } else { foreach ($id in $order) { $p=$all[$id]; if (-not $p) { continue }; if ($want[$id] -eq $p.CreationDate) { try { if (($p.Terminate()).ReturnValue -eq 0) { $done+=$id } } catch { } } else { $done+=-$id } } }; 'ended:' + ($done -join ',') + ' seen:' + (@($all.Keys) -join ',')`;
}

// Ends the process the line describes and what it started. It reads a fresh table of all processes, compares the root with the line
// once more, and only then ends each process of the tree by its own id (no `taskkill /t`, which walks parent links without creation
// times, and never by a bare id: see endScript). Resolves true (ended, or already gone), false (the end did not work), or 'changed' (the process is not the one the line
// describes any more: nothing was ended). Never rejects.
export async function endConfirmed(entry, { platform = process.platform, table = windowsTable, run = execFile, signal = (p, s) => process.kill(p, s), selfPid = process.pid, probe } = {}) {
  try {
    if (!Number.isInteger(entry?.pid) || entry.pid <= 1 || entry.pid === selfPid) return false;
    if (platform === 'win32') {
      const rows = [...(await table()).entries()].map(([pid, r]) => ({ ...r, pid }));
      const root = rows.find(r => r.pid === entry.pid);
      const verdict = matchProcess(entry, root);
      if (verdict === 'unsure') return false;
      if (verdict !== 'same') return 'changed';
      // Never this process or a process above it (N5): a root that is one of the sweeper's own ancestors is left alone, and so is what
      // hangs below such an ancestor.
      const mine = ancestorsOf(rows, selfPid);
      if (mine.includes(entry.pid)) return false;
      const ids = treeBelow(rows, entry.pid, { skip: mine });
      // G1: each id is ended only while it still has the creation date the table showed. An id that Windows gave to another program in
      // the seconds since the table was read has another date and is left alone. One hidden PowerShell call reads and ends them.
      const script = endScript(rows, ids, entry.pid);
      if (!script) return false;
      const sys = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
      const exe = path.win32.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const out = await new Promise(resolve => {
        run(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 20_000, encoding: 'utf8' }, (err, stdout) => resolve(err ? null : String(stdout)));
      });
      const m = /ended:([-\d,]*) seen:([\d,]*)/.exec(out ?? '');
      if (!m) return false;
      const done = m[1].split(',').filter(Boolean).map(Number);
      // The root: another program holds its id now (-id): nothing was ended. Ended now, or gone by itself: done. Still there: not done.
      if (done.includes(-entry.pid)) return 'changed';
      return done.includes(entry.pid) || !m[2].split(',').map(Number).includes(entry.pid);
    }
    const again = await (probe ?? (ids => posixProbe(ids)))([entry.pid]);
    const verdict = matchProcess(entry, again.get(entry.pid));
    if (verdict === 'unsure') return false;
    if (verdict !== 'same') return 'changed';
    try {
      signal(-entry.pid, 'SIGTERM');
    } catch {
      signal(entry.pid, 'SIGTERM');
    }
    return true;
  } catch {
    return false;
  }
}

// ---------- the decisions ----------

// Whether the process that owned a line is still running. When in doubt: alive.
// A live process with the owner's id is the owner when it was created at or before the line's start time plus 2 s (a process that
// reuses the id was created after the child was started), or at or before the child's own creation time plus 2 s, or within a minute
// of the owner's recorded start; a time that cannot be read counts as alive. This process is alive, and is the owner when it started
// no later than the line. All of it in UTC milliseconds.
export function ownerAlive(owner, live, entry, { selfPid = process.pid, selfStart = OWN_START } = {}) {
  const limit = entry.spawnedAt + START_TOLERANCE_AFTER_MS;
  if (owner.pid === selfPid) return selfStart <= limit || Math.abs(owner.startedAt - selfStart) <= OWNER_TOLERANCE_MS;
  const p = live.get(owner.pid);
  if (!p) return false;
  const times = timesOf(p);
  if (!times.length) return true;
  const childTimes = timesOf(live.get(entry.pid));
  return times.some(t => t <= limit || Math.abs(t - owner.startedAt) <= OWNER_TOLERANCE_MS || childTimes.some(c => t <= c + START_TOLERANCE_AFTER_MS));
}

// How a live process p compares with a line:
//   'absent'    no such process;
//   'different' another program, or created at another time (a reused id): not the process of the line;
//   'unsure'    the name and start time fit but the flags do not (or the time or command line cannot be read): the line is kept, nothing ended;
//   'same'      the program, the start time and every recorded flag fit.
export function matchProcess(entry, p) {
  if (!p) return 'absent';
  if (p.name !== entry.image) return 'different';
  const times = timesOf(p);
  if (!times.length) return 'unsure';
  if (!times.some(t => t >= entry.spawnedAt - START_TOLERANCE_BEFORE_MS && t <= entry.spawnedAt + START_TOLERANCE_AFTER_MS)) return 'different';
  const have = liveTokens(p.commandLine);
  return (entry.tokens ?? []).every(t => have.has(t)) ? 'same' : 'unsure';
}
export const isSameProcess = (entry, p) => matchProcess(entry, p) === 'same';

// ---------- the sweep ----------

// Whether a sweep may run. An explicit ledger (options.home or options.file: the tests of this module) is used in a test process; the
// switches PLENUM_NO_SWEEP and PLENUM_SMOKE turn every entry off.
function sweepAllowed(options = {}) {
  const env = options.env ?? process.env;
  if (ledgerOff(env)) return false;
  return !!(options.file || options.home) || ledgerAllowed(env);
}
// The build's own switch: the sweep (ending programs, clearing folders) runs only with PLENUM_SWEEP=1 in the environment.
export const sweepSwitchedOn = (env = process.env) => env.PLENUM_SWEEP === '1';
export const SWEEP_OFF_NOTE = 'The clean-up of programs left by an earlier run is switched off in this build.';
const OFF = () => ({ ended: [], gone: 0, kept: 0, cleaned: [], off: true });
// The answer of an entry that does nothing. When only this build's switch is the reason (not PLENUM_NO_SWEEP, PLENUM_SMOKE or a test
// process), one line says so, at most once per start; nothing else is read, run or written.
let offNoted = false;
function switchedOff(options) {
  if (!offNoted && sweepAllowed(options)) {
    offNoted = true;
    console.log(`[plenum] ${SWEEP_OFF_NOTE}`);
  }
  return Promise.resolve(OFF());
}

const running = new Map();
// Ends what an earlier Plenum left running, and clears its temp folders. Never rejects. Returns
//   { ended: [{ pid, command }], gone: n, kept: n, cleaned: [folder names], error?: text }
// A second call for the same ledger while one is running gets that one's answer.
// options (all for the tests): home, file, env, platform, probe(pids) -> Map, end(pid, { entry }) -> Promise<true|false|'changed'>,
// table() -> Map, run (PowerShell), tmp, now, selfPid, selfStart, maxAgeMs, bootMs (when the computer started; lines older than a minute
// before it are dropped), uptimeMs (how long it has been running, for the scratch folders).
export function sweepAtStart(options = {}) {
  if (!sweepAllowed(options)) return Promise.resolve(OFF());
  if (!sweepSwitchedOn(options.env ?? process.env)) return switchedOff(options);
  const file = options.file ?? ledgerFile(options.home ?? ledgerHome(options.env ?? process.env));
  const key = path.resolve(file).toLowerCase();
  if (running.has(key)) return running.get(key);
  const p = sweepNow(options, file).finally(() => running.delete(key));
  running.set(key, p);
  return p;
}

async function sweepNow(options, file) {
  const result = { ended: [], gone: 0, kept: 0, cleaned: [] };
  try {
    const { platform = process.platform, tmp = os.tmpdir(), selfPid = process.pid, selfStart = OWN_START } = options;
    const ledger = await readLedger(file);
    const handled = [];
    const keepScratch = new Set();
    const hold = e => { if (e.scratch) keepScratch.add(path.resolve(e.scratch).toLowerCase()); };
    // G3: a line older than the last start of the computer (less a minute) cannot be running: after a restart nothing of ours is alive.
    // It is dropped here, with no table read and no end; its scratch folder goes with it (removeScratchDir, below).
    const now = options.now ?? Date.now();
    const upMs = options.uptimeMs ?? os.uptime() * 1000;
    const boot = options.bootMs ?? now - upMs - 60_000;
    const before = ledger.entries.filter(e => e.spawnedAt < boot);
    for (const e of before) {
      result.gone += 1;
      handled.push(e);
    }
    ledger.entries = ledger.entries.filter(e => e.spawnedAt >= boot);
    if (ledger.entries.length) {
      const probe = options.probe ?? (pids => defaultProbe(pids, platform));
      const end = options.end ?? ((pid, ctx) => endConfirmed(ctx.entry, { platform, table: options.table, run: options.run, selfPid, probe: options.probe }));
      let live = null;
      try {
        live = await probeInParts(probe, ledger.entries.flatMap(e => [e.pid, e.owner.pid]));
      } catch (err) {
        // The live processes could not be read, so nothing can be told from anything: nothing is ended and the ledger stays.
        result.error = `Could not read the running processes: ${String(err?.message ?? err).split('\n')[0].slice(0, 160)}`;
      }
      const orphans = [];
      for (const e of live ? ledger.entries : []) {
        if (ownerAlive(e.owner, live, e, { selfPid, selfStart })) {
          result.kept += 1;
          hold(e);
          continue;
        }
        const verdict = e.pid === selfPid || launcherName(e.command) || launcherName(e.image) ? 'different' : matchProcess(e, live.get(e.pid));
        if (verdict === 'same') orphans.push(e);
        else if (verdict === 'unsure') {
          result.kept += 1;
          hold(e);
        } else {
          result.gone += 1;
          handled.push(e);
        }
      }
      // Each orphan is looked at once more, alone, right before it is ended; a few are ended at the same time.
      await pool(orphans, END_PARALLEL, async e => {
        let again;
        try {
          again = await probe([e.pid]);
        } catch {
          result.kept += 1;
          hold(e);
          return;
        }
        const verdict = matchProcess(e, again.get(e.pid));
        if (verdict === 'unsure') {
          result.kept += 1;
          hold(e);
          return;
        }
        if (verdict !== 'same') {
          result.gone += 1;
          handled.push(e);
          return;
        }
        let ok = false;
        try {
          ok = await end(e.pid, { entry: e });
        } catch {
          ok = false;
        }
        if (ok === true) {
          result.ended.push({ pid: e.pid, command: e.command });
          handled.push(e);
        } else if (ok === 'changed') {
          result.gone += 1;
          handled.push(e);
        } else {
          // It is ours and should end, but the end did not work: the line stays for the next start.
          result.kept += 1;
          hold(e);
        }
      });
    }
    for (const e of handled) if (e.scratch) await removeScratchDir(e.scratch, tmp);
    if (handled.length) {
      const id = e => `${e.pid}/${e.spawnedAt}/${e.owner.pid}/${e.owner.startedAt}`;
      await mutate(file, l => {
        const gone = new Set(handled.map(id));
        const before = l.entries.length;
        l.entries = l.entries.filter(e => !gone.has(id(e)));
        return l.entries.length !== before;
      });
    }
    // With the live processes unread, which folders a running Plenum still uses is not known, so none is cleared.
    if (!result.error) result.cleaned = await sweepScratch({ tmp, now, keep: keepScratch, maxAgeMs: options.maxAgeMs ?? SCRATCH_MAX_AGE_MS, upMs });
  } catch (err) {
    result.error ??= String(err?.message ?? err).split('\n')[0].slice(0, 160);
  }
  return result;
}

// What the person is told: plain words, or '' when nothing was left over.
export function sweepNotice(result) {
  const n = result?.ended?.length ?? 0;
  if (!n) return '';
  return n === 1 ? 'Plenum ended 1 program that an earlier run had left running.' : `Plenum ended ${n} programs that an earlier run had left running.`;
}

// THE entry: once per process, in the background, never rejecting and never waited for. server.mjs calls it after listen(), the timer in
// lib/proc.mjs calls it, and startChild calls it before the first child is written; all three get the same promise, so one start makes
// one sweep. Off (nothing read, nothing started, nothing written) unless PLENUM_SWEEP=1 (this build), and with PLENUM_NO_SWEEP=1,
// PLENUM_SMOKE=1 and in a test process with no home of its own, whatever PLENUM_SWEEP says.
let first = null;
export function sweepOnce(options = {}) {
  if (first) return first;
  if (!sweepAllowed(options)) return Promise.resolve(OFF());
  if (!sweepSwitchedOn(options.env ?? process.env)) return switchedOff(options);
  first = new Promise(resolve => setImmediate(resolve)).then(() => sweepAtStart(options)).then(result => {
    const note = sweepNotice(result);
    if (note) console.log(`[plenum] ${note}`);
    return result;
  });
  return first;
}
export const resetSweepOnceForTests = () => { first = null; offNoted = false; };
