// Suggested Night shift jobs (wave 6, ns4). A model's run ends with a NEXT line ("what comes next"); the business record keeps it
// (lib/business.mjs lastRuns). This file shows those lines to the owner as suggestions, and remembers the ones he dismissed.
//
// THE RULE: a suggestion is only a line of text on the page. Nothing here adds, queues or starts a job. A suggestion becomes a job only
// when the owner taps "Use as job" (the page fills its form with the exact text) and then presses "Add job" (lib/jobs.mjs add, which
// the routes guard with the token). This file never calls lib/jobs.mjs and has no way to.
//
//   suggestions()          -> [{ business, name, text, sha256, at, lead }]   newest first; text is the model's NEXT line exactly as the record
//                             holds it (the record already cut it to one line of at most 300 characters); sha256 is of that text; lead is
//                             the run's lead reference ("codex:gpt-5"), '' when the record has none; name is the business's name.
//   dismiss({ business, sha256 }) -> { ok: true }; the pair is remembered in job-suggestions.json and the suggestion stays gone.
//   The file: job-suggestions.json in store.HOME: { v: 1, dismissed: [{ business, sha256, at }] }, at most 500 (the oldest go first).
//     Written whole through writeFileAtomic, one write after another; no file is an empty list; a read error other than "no file" is tried
//     4 times and, if it still fails, nothing is cached and nothing is written; text that is not JSON is kept as job-suggestions.json.damaged
//     (a stamped name if that exists); a file with v above 1 is shown (its dismissals still hide) and never changed.
//   createSuggestions(deps) -> an instance; the default instance's functions are exported below. deps: dir, now, read, write, business
//     (a module, null, or a function giving one or a promise of one: { list, lastRuns }).
import fs, { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomic } from './atomic-write.mjs';
import { CODE_ROOT, moduleUrl } from './overlay.mjs';
import * as store from './store.mjs';

export const VERSION = 1;
export const KEEP = 500;
export const RUNS_LOOKED_AT = 10;
export const MAX_SUGGESTIONS = 30;
export const NEWER = 'Suggested jobs were saved by a newer Plenum. This version shows them and does not change them.';
const SHA_RE = /^[a-f0-9]{64}$/;
// A NEXT line that says there is nothing to do is not a suggestion.
const NOTHING = /^(none|nothing|n\/a|na|no|nil|-|—|no further (work|steps?|action)s?( needed| required)?|nothing (further|more|left)( to do)?|all done|done)[\s.!]*$/i;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (status, message) => Object.assign(new Error(message), { status });
export const sha256Of = text => createHash('sha256').update(String(text), 'utf8').digest('hex');
const pause = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait: the next try follows at once */ } };
const asGetter = v => (typeof v === 'function' && !v.list ? v : () => v);

function lazy(rel) {
  let p = null;
  return () => (p ??= import(moduleUrl(rel, CODE_ROOT)).then(m => m, () => null));
}

export function createSuggestions(deps = {}) {
  const d = {
    dir: deps.dir ?? store.HOME,
    now: deps.now ?? (() => Date.now()),
    read: deps.read ?? (f => fs.readFileSync(f, 'utf8')),
    write: deps.write ?? writeFileAtomic,
    business: deps.business === undefined ? lazy('lib/business.mjs') : asGetter(deps.business),
  };
  const file = path.join(d.dir, 'job-suggestions.json');
  let rec = null;
  let unreadable = '';
  let unreadableAt = 0;
  let writing = Promise.resolve();

  function saveDamaged(text) {
    try {
      let target = `${file}.damaged`;
      if (fs.existsSync(target)) target = `${file}.damaged-${d.now()}`;
      const tmpName = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmpName, text);
      fs.renameSync(tmpName, target);
    } catch { /* the damaged text is a courtesy */ }
  }
  function migrate(raw) {
    const v = isObject(raw) && Number.isInteger(raw.v) ? raw.v : VERSION;
    const list = isObject(raw) && Array.isArray(raw.dismissed) ? raw.dismissed : [];
    const dismissed = list
      .filter(e => isObject(e) && typeof e.business === 'string' && e.business && SHA_RE.test(String(e.sha256)))
      .map(e => ({ business: e.business.slice(0, 80), sha256: e.sha256, at: Number.isFinite(e.at) ? e.at : 0 }))
      .slice(-KEEP);
    return { v, dismissed };
  }
  function load() {
    if (rec) return rec;
    if (unreadable && d.now() - unreadableAt < 5000) return migrate(null);
    let text = null;
    let code = '';
    for (let tries = 0; tries < 4; tries += 1) {
      try {
        text = d.read(file);
        code = '';
        break;
      } catch (err) {
        if (err?.code === 'ENOENT') { code = ''; break; }
        code = String(err?.code ?? 'EIO').slice(0, 20);
        if (tries < 3) pause(50);
      }
    }
    if (code) {
      unreadable = code;
      unreadableAt = d.now();
      return migrate(null);
    }
    unreadable = '';
    let raw = null;
    if (text !== null) {
      try {
        raw = JSON.parse(text);
      } catch {
        if (text.trim()) saveDamaged(text);
      }
    }
    rec = migrate(raw);
    return rec;
  }
  const isNewer = () => load().v > VERSION;
  function persist() {
    if (isNewer()) return Promise.reject(fail(409, NEWER));
    if (unreadable && !rec) return Promise.reject(fail(409, 'Suggested jobs could not be read just now, so nothing was changed. Try again in a minute.'));
    const text = `${JSON.stringify(load(), null, 2)}\n`;
    const job = writing.then(async () => {
      await fsp.mkdir(d.dir, { recursive: true });
      await d.write(file, text);
    });
    writing = job.catch(() => {});
    return job;
  }

  const modOf = async () => {
    try {
      const m = await d.business();
      return m && typeof m.list === 'function' && typeof m.lastRuns === 'function' ? m : null;
    } catch {
      return null;
    }
  };

  async function suggestions() {
    const m = await modOf();
    if (!m) return [];
    let businesses = [];
    try { businesses = m.list() || []; } catch { return []; }
    const gone = new Set(load().dismissed.map(e => `${e.business}|${e.sha256}`));
    const out = [];
    for (const b of businesses) {
      if (!isObject(b) || typeof b.id !== 'string' || !b.id) continue;
      let runs = [];
      try { runs = m.lastRuns(b.id, RUNS_LOOKED_AT) || []; } catch { runs = []; }
      const seen = new Set();
      for (const run of runs) {
        const text = typeof run?.next === 'string' ? run.next.replace(/\s+/g, ' ').trim() : '';
        if (!text || NOTHING.test(text)) continue;
        const sha = sha256Of(text);
        if (seen.has(sha) || gone.has(`${b.id}|${sha}`)) continue;
        seen.add(sha);
        out.push({
          business: b.id,
          name: typeof b.name === 'string' ? b.name : '',
          text,
          sha256: sha,
          at: Number.isFinite(run.at) ? run.at : 0,
          lead: typeof run.lead === 'string' ? run.lead : '',
        });
      }
    }
    out.sort((a, b) => b.at - a.at);
    return out.slice(0, MAX_SUGGESTIONS);
  }

  async function dismiss(input) {
    if (!isObject(input)) throw fail(400, 'Send an object that names the suggestion.');
    const business = typeof input.business === 'string' ? input.business.trim().slice(0, 80) : '';
    const sha = typeof input.sha256 === 'string' ? input.sha256.trim().toLowerCase() : '';
    if (!business) throw fail(400, 'Say which business the suggestion is from.');
    if (!SHA_RE.test(sha)) throw fail(400, 'That is not a suggestion Plenum knows.');
    load();
    if (unreadable && !rec) throw fail(409, 'Suggested jobs could not be read just now, so nothing was changed. Try again in a minute.');
    if (isNewer()) throw fail(409, NEWER);
    const r = load();
    if (!r.dismissed.some(e => e.business === business && e.sha256 === sha)) {
      r.dismissed.push({ business, sha256: sha, at: d.now() });
      if (r.dismissed.length > KEEP) r.dismissed.splice(0, r.dismissed.length - KEEP);
      await persist();
    }
    return { ok: true };
  }

  return { suggestions, dismiss, file, isNewer: () => isNewer(), VERSION };
}

let main = null;
const one = () => (main ??= createSuggestions());
export const suggestions = () => one().suggestions();
export const dismiss = input => one().dismiss(input);
export const newer = () => one().isNewer();
