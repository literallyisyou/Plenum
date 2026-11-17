// The team's log (wave 3, DELEGATION-DESIGN.md section 5.4): one JSON line for each finished delegated task, in team-log.jsonl in
// Plenum's data folder. It answers "which model did what, how long, how much", and nothing else.
//
// THE CONTRACT (build/v06/ultra-w3-team pins it):
//   createTeamLog({ dir, now, publish, maxBytes, keep }) -> an instance; the default instance's functions are exported under the same names.
//   append(entry)                         -> a promise of the line that was written
//   recent({ project, limit, before })    -> a promise of [line], newest first (50 by default, 200 at most; before is a time in ms)
//   usage({ days, project })              -> a promise of { days, byProvider: [{ provider, label, count, ok, failed, minutes, input, output,
//                                            dollars }], byKind: [{ kind, count, ok }] }
//   The line: { v: 1, at, project, job, work, agent, title, lead, worker, provider, program, picked, moved: [{ from, why }], ok, state,
//               cls, ms, steps, changed, usage: { billing, input, output, dollars }, auto?, effort? }
//     auto: true and effort (low, medium, high, xhigh, max or '': at most 8 characters) only when Auto chose the model (wave 6).
//     program is '' for an ordinary task and the program's id for a hand-off to a program; provider is 'hub' for one through the hub.
//   A finished task publishes { type: 'team', reason: 'log' }, at most once a second.
//
// RULES THIS MODULE KEEPS: a line holds titles, models, times and counts, and never instructions, answers or file contents: append copies
// the named fields only, so nothing else a caller passes can reach the file. The file is appended to, one write at a time, and moved to
// team-log.1.jsonl when it reaches 4 MB (the one before that is replaced). The last 300 lines are kept in memory. Nothing is read or
// written until the first call. usage() reads the two files once; after that it sums from memory, where the few fields it adds up are
// kept for every line of the two files and follow each write and each move (the page asks for the sums after every finished task, and
// reading up to 8 MB each time would hold the server up).
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import * as events from './events.mjs';
import { HOME } from './store.mjs';

export const VERSION = 1;
export const MAX_BYTES = 4 * 1024 * 1024;
export const KEEP = 300;
const PUBLISH_GAP_MS = 1000;
const DAY_MS = 24 * 60 * 60_000;
const STATES = ['done', 'not finished', 'stopped', 'refused'];
const EFFORT_WORDS = ['low', 'medium', 'high', 'xhigh', 'max'];
// The names the page shows for where the work ran. A provider that is not here shows its id.
export const PROVIDER_LABELS = Object.freeze({
  anthropic: 'Claude', codex: 'Codex', gemini: 'Gemini', muse: 'Muse Code', cursor: 'Cursor', grok: 'Grok Build', antigravity: 'Antigravity',
  xai: 'xAI', openai: 'OpenAI API', deepseek: 'DeepSeek', mistral: 'Mistral', googleai: 'Google AI', openrouter: 'OpenRouter', echo: 'Test', hub: 'Plenum Hub',
});

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '');
const count = v => (Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
const amount = v => (Number.isFinite(v) && v >= 0 ? v : null);

// The line for one finished task: the named fields only, each cut to a short length.
export function lineOf(entry, now = Date.now()) {
  const e = isObject(entry) ? entry : {};
  const u = isObject(e.usage) ? e.usage : {};
  const worker = text(e.worker, 200);
  return {
    v: VERSION,
    at: Number.isFinite(e.at) && e.at > 0 ? e.at : now,
    project: text(e.project, 80),
    job: text(e.job, 40),
    work: text(e.work, 24),
    agent: text(e.agent, 40),
    title: text(e.title, 120),
    lead: text(e.lead, 200),
    worker,
    provider: text(e.provider, 40) || (worker.includes(':') ? worker.slice(0, worker.indexOf(':')) : ''),
    program: text(e.program, 80),
    picked: e.picked === true,
    moved: (Array.isArray(e.moved) ? e.moved : []).filter(isObject).slice(0, 4).map(m => ({ from: text(m.from, 200), why: text(m.why, 40) })),
    ok: e.ok === true,
    state: STATES.includes(e.state) ? e.state : e.ok === true ? 'done' : 'not finished',
    cls: text(e.cls, 24),
    ms: count(e.ms),
    steps: count(e.steps),
    changed: count(Array.isArray(e.changed) ? e.changed.length : e.changed),
    usage: {
      billing: u.billing === 'plan' || u.billing === 'api' ? u.billing : null,
      input: count(u.input),
      output: count(u.output),
      dollars: amount(u.dollars),
    },
    // Auto routing (wave 6): set only for a task whose model Auto chose, so a line of a task without Auto is as it was.
    ...(e.auto === true ? { auto: true, effort: EFFORT_WORDS.includes(e.effort) ? e.effort : '' } : {}),
  };
}

function parseLines(raw) {
  const out = [];
  for (const row of raw.split('\n')) {
    if (!row.trim()) continue;
    try {
      const line = JSON.parse(row);
      if (isObject(line) && Number.isFinite(line.at)) out.push(line);
    } catch {
      // A line cut off by a crash is passed over.
    }
  }
  return out;
}

export function createTeamLog({ dir = HOME, now = () => Date.now(), publish = ev => events.publish(ev), maxBytes = MAX_BYTES, keep = KEEP } = {}) {
  const file = path.join(dir, 'team-log.jsonl');
  const older = path.join(dir, 'team-log.1.jsonl');
  let memory = null; // the last `keep` lines, oldest first
  let size = null; // the file's size in bytes, once known
  let queue = Promise.resolve();
  let lastPublish = 0;
  let owed = null;
  let sums = null; // { older: [row], current: [row] }: what usage() adds up, for every line of the two files, once they were read

  const readAll = async name => {
    try {
      return parseLines(await fsp.readFile(name, 'utf8'));
    } catch {
      return [];
    }
  };

  // The fields usage() needs of a line, and nothing else of it.
  const rowOf = line => ({
    at: line.at,
    project: typeof line.project === 'string' ? line.project : '',
    provider: text(line.provider, 40) || 'unknown',
    work: text(line.work, 24) || 'other',
    ok: line.ok === true,
    ms: count(line.ms),
    input: count(line.usage?.input),
    output: count(line.usage?.output),
    dollars: Number.isFinite(line.usage?.dollars) ? line.usage.dollars : null,
  });

  // The rows of one file, and whether they can be kept: a file that is not there is an empty one; a file that could not be read just
  // now is read again by the next call, so one bad moment does not empty the sums for the rest of the run.
  const rowsOf = async name => {
    try {
      return { rows: parseLines(await fsp.readFile(name, 'utf8')).map(rowOf), sure: true };
    } catch (err) {
      return { rows: [], sure: err?.code === 'ENOENT' };
    }
  };

  // Runs between two writes (the callers queue it), so no line is counted twice or missed.
  async function summed() {
    if (sums) return sums;
    const [a, b] = [await rowsOf(older), await rowsOf(file)];
    const both = { older: a.rows, current: b.rows };
    if (a.sure && b.sure) sums = both;
    return both;
  }

  async function loaded() {
    if (memory) return memory;
    const current = await readAll(file);
    const lines = current.length >= keep ? current : [...(await readAll(older)), ...current];
    memory = lines.slice(-keep);
    return memory;
  }

  function tell() {
    const send = () => {
      lastPublish = now();
      try {
        publish({ type: 'team', reason: 'log' });
      } catch {
        // The log is written whether or not a window hears of it.
      }
    };
    const wait = PUBLISH_GAP_MS - (now() - lastPublish);
    if (wait <= 0) return send();
    if (owed) return undefined;
    owed = setTimeout(() => { owed = null; send(); }, wait);
    owed.unref?.();
    return undefined;
  }

  async function write(line) {
    await loaded();
    await fsp.mkdir(dir, { recursive: true });
    if (size === null) size = await fsp.stat(file).then(s => s.size, () => 0);
    const row = `${JSON.stringify(line)}\n`;
    const bytes = Buffer.byteLength(row);
    if (size > 0 && size + bytes > maxBytes) {
      // The full file becomes team-log.1.jsonl (the one before it is replaced) and a new one starts.
      const removed = await fsp.rm(older, { force: true }).then(() => true, () => false);
      if (removed && sums) sums.older = [];
      await fsp.rename(file, older).then(() => {
        size = 0;
        if (sums) {
          sums.older = sums.current;
          sums.current = [];
        }
      }, () => {});
    }
    try {
      await fsp.appendFile(file, row);
    } catch (err) {
      // Whether any of the line reached the file is not known: the sums are read from the files again at the next call.
      sums = null;
      throw err;
    }
    sums?.current.push(rowOf(line));
    size += bytes;
    memory.push(line);
    if (memory.length > keep) memory.splice(0, memory.length - keep);
    tell();
    return line;
  }

  // One write at a time; a write that failed does not hold up the next one.
  function append(entry) {
    const line = lineOf(entry, now());
    const run = queue.then(() => write(line));
    queue = run.catch(() => {});
    return run;
  }

  async function recent({ project, limit, before } = {}) {
    await queue;
    const lines = await loaded();
    const max = Number.isInteger(limit) && limit >= 1 ? Math.min(limit, 200) : 50;
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < max; i--) {
      const line = lines[i];
      if (project && line.project !== project) continue;
      if (Number.isFinite(before) && !(line.at < before)) continue;
      out.push(line);
    }
    return out;
  }

  // The delegated work of the last `days` days, for each place it ran and each kind of work. It covers every line of the two files, so
  // more than the lines kept for recent(); the files are read by the first call only (summed).
  async function usage({ days, project, labelOf } = {}) {
    const read = queue.then(summed);
    queue = read.catch(() => {});
    const { older: before, current } = await read;
    const span = Number.isFinite(days) && days >= 1 ? Math.min(Math.floor(days), 90) : 7;
    const since = now() - span * DAY_MS;
    const providers = new Map();
    const kinds = new Map();
    for (const line of [...before, ...current]) {
      if (!(line.at >= since) || (project && line.project !== project)) continue;
      const id = line.provider;
      let p = providers.get(id);
      if (!p) {
        let label = PROVIDER_LABELS[id] ?? id;
        try {
          label = (typeof labelOf === 'function' && labelOf(id)) || label;
        } catch {
          // The built-in name stays.
        }
        p = { provider: id, label, count: 0, ok: 0, failed: 0, minutes: 0, input: 0, output: 0, dollars: null, ms: 0 };
        providers.set(id, p);
      }
      p.count += 1;
      if (line.ok === true) p.ok += 1;
      else p.failed += 1;
      p.ms += line.ms;
      p.input += line.input;
      p.output += line.output;
      if (line.dollars !== null) p.dollars = (p.dollars ?? 0) + line.dollars;
      const kind = line.work;
      const k = kinds.get(kind) ?? { kind, count: 0, ok: 0 };
      k.count += 1;
      if (line.ok === true) k.ok += 1;
      kinds.set(kind, k);
    }
    const byProvider = [...providers.values()].map(({ ms, ...p }) => ({ ...p, minutes: Math.round(ms / 6000) / 10, dollars: p.dollars === null ? null : Math.round(p.dollars * 10000) / 10000 }));
    return { days: span, byProvider, byKind: [...kinds.values()] };
  }

  return { append, recent, usage, file };
}

// ---------- the default instance ----------

let instance = null;
const log = () => (instance ??= createTeamLog());

export const append = entry => log().append(entry);
export const recent = query => log().recent(query);
export const usage = query => log().usage(query);
