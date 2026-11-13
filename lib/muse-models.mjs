import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findExecutable } from './proc.mjs';
import { runAcp } from './acp.mjs';

// The models Muse Code offers this account, read live (DECISIONS item 91). Plenum's Muse catalog is a fixed list, and Muse Code
// 1.4.18 stopped offering muse-wonder-full-1.0, so a council seat on it failed with "does not exist or you lack access".
// The list is read the way lib/antigravity.mjs reads Antigravity's: a handshake with `muse acp` that sends no prompt (it costs
// nothing), in an empty scratch folder, at most every 30 minutes, again 2 minutes after a failed read, one read at a time. A failed
// read (an older Muse Code without `muse acp`, not signed in, a timeout) changes nothing and marks nothing: the last good list stays.
// Muse Code 1.4.18 answers session/new with { sessionId, modes, configOptions } and no models field; the configOptions entry with id
// "model" is a select whose options are the models. models.availableModels is read as well, in case a later version sends it.

export const FRESH_MS = 30 * 60_000;
export const RETRY_MS = 2 * 60_000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_MODELS = 40;
const LABEL = 'Muse Code';
const cleanName = s => String(s ?? '').replace(/[\u0000-\u001f\u007f()]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// The CATALOG hook (lib/providers.mjs setMuseModels), set by providers.mjs so this file does not import it back. It gets the list of
// { id, label }, or null when no list is known.
let publish = () => 0;
export function onMuseModels(fn) {
  publish = typeof fn === 'function' ? fn : () => 0;
}

let last = { at: 0, ok: false, count: 0, error: null, models: [] };
let inflight = null;
// The reason of the last failed read that was written to the log, so a read that keeps failing the same way is logged once.
let lastLogged = null;

// "muse-ember-1.0" to "Muse Ember 1.0 (Muse Code)". Muse gives the id as the name, so the label is made from the id; a name that is
// not the id (a later version may send a real one) is used as it is.
export function labelOf(id, name) {
  const given = cleanName(name);
  if (given && given.toLowerCase() !== String(id).toLowerCase()) return `${given} (Muse Code)`;
  const words = String(id).split('-').filter(Boolean).map(w => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w));
  return `${words.join(' ')} (Muse Code)`;
}

// The models in a session/new answer, as { id, label }: models.availableModels (modelId, name) first, else the options of the
// configOptions entry with id "model" (value, name; a group of options is read as its options). Anything else is skipped.
export function toEntries(session) {
  const raw = [];
  const available = session?.models?.availableModels;
  if (Array.isArray(available)) {
    for (const m of available) if (isObject(m)) raw.push({ id: m.modelId ?? m.value ?? m.id, name: m.name });
  }
  if (!raw.length && Array.isArray(session?.configOptions)) {
    const option = session.configOptions.find(o => isObject(o) && o.id === 'model');
    const walk = list => {
      for (const o of Array.isArray(list) ? list : []) {
        if (!isObject(o)) continue;
        if (Array.isArray(o.options)) walk(o.options);
        else raw.push({ id: o.value, name: o.name });
      }
    };
    walk(option?.options);
  }
  const out = [];
  const seen = new Set();
  for (const m of raw) {
    if (typeof m.id !== 'string' || !MODEL_ID.test(m.id) || m.id.toLowerCase() === 'default' || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({ id: m.id, label: labelOf(m.id, m.name) });
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

// Reads the account's models again when the last read is stale (or force is set), with a handshake that sends no prompt, in an empty
// scratch folder. Resolves to the state, never throws. run replaces runAcp in the tests.
export function refreshMuseModels({ force = false, now = Date.now, run = runAcp, log = line => console.error(line) } = {}) {
  if (inflight) return inflight;
  const age = now() - last.at;
  if (!force && last.at && age < (last.ok ? FRESH_MS : RETRY_MS)) return Promise.resolve(museModelsState());
  inflight = (async () => {
    const started = Date.now();
    let scratch = null;
    try {
      if (!(await findExecutable('muse'))) throw new Error('Muse Code is not installed.');
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'plenum-muse-'));
      const { session } = await run({ command: 'muse', args: ['acp'], cwd: scratch, prompt: '', label: LABEL, sessionOnly: true, handshakeMs: 20_000 });
      const entries = toEntries(session);
      // An answer with no model in it is more likely a Muse Code that does not list them than an account with none, so it is a failed
      // read: nothing is marked and the last good list stays.
      if (!entries.length) throw new Error('Muse Code sent no model list.');
      publish(entries);
      last = { at: now(), ok: true, count: entries.length, error: null, models: entries };
      lastLogged = null;
    } catch (err) {
      const lines = String(err?.message ?? err).split('\n');
      const message = lines[0].slice(0, 200);
      last = { at: now(), ok: false, count: last.count, error: message, models: last.models };
      // One line in the server log when a read fails with a new reason, with what Muse Code wrote last; anything that looks like a
      // key or token is hidden.
      if (message !== lastLogged) {
        lastLogged = message;
        const detail = lines.slice(1).join(' ').replace(/[A-Za-z0-9_\-./+=]{24,}/g, '[hidden]').replace(/\s+/g, ' ').trim().slice(0, 300);
        log(`Muse Code's model list could not be read after ${((Date.now() - started) / 1000).toFixed(1)} s: ${message}${detail ? ` (${detail})` : ''}`);
      }
    } finally {
      if (scratch) await removeScratch(scratch);
      inflight = null;
    }
    return museModelsState();
  })();
  return inflight;
}

// Waits for a read for at most waitMs (Accounts' Refresh), so a slow Muse Code cannot hold the answer up.
export async function museModelsWithin(waitMs, opts) {
  const run = refreshMuseModels(opts);
  let timer;
  await Promise.race([run, new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]);
  clearTimeout(timer);
  return museModelsState();
}

export const museModelsState = () => ({ at: last.at, ok: last.ok, count: last.count, error: last.error, reading: !!inflight });

// The last good list, as [{ id, label }] (empty when none was read).
export const museOffered = () => last.models.slice();

// For tests: forget the last read and take the discovered models out of the catalog.
export function resetMuseModels() {
  last = { at: 0, ok: false, count: 0, error: null, models: [] };
  inflight = null;
  lastLogged = null;
  lastForcedAt = 0;
  publish(null);
}

// ---------- a run on a model the account is not offered ----------

// What the CLI says when the model is gone or the account lacks it.
const NOT_OFFERED = /does not exist or you lack access/i;

// The error a chat or council shows when "muse exec" fails because the model is not offered, or null for any other error. label is the
// model's label as the app shows it (labelFor in lib/providers.mjs); labels maps a model id to its label. The offered list comes from the
// last live read, and a new read is started, so the next try knows more. The CLI's own text follows on a new line, shortened.
let lastForcedAt = 0;
export function notOfferedError(err, id, { label, labels = () => null } = {}) {
  const text = String(err?.message ?? err ?? '');
  if (!NOT_OFFERED.test(text)) return null;
  // A new read is forced at most once in 2 minutes, so a loop of failing runs does not start a handshake for each failure.
  if (Date.now() - lastForcedAt >= RETRY_MS) {
    lastForcedAt = Date.now();
    refreshMuseModels({ force: true }).catch(() => {});
  } else {
    refreshMuseModels().catch(() => {});
  }
  const offered = museOffered();
  const list = offered.length ? `It offers: ${offered.map(m => labels(m.id) ?? m.label).join(', ')}.` : 'Open the model menu to see what it offers.';
  const own = text.replace(/^\s*muse exited with code \w+:?\s*/i, '').replace(/[A-Za-z]:[\\/][^\s'"]*|(?:^|\s)\/(?:home|Users|root|var|tmp)\/[^\s'"]*/g, ' [path]').replace(/[A-Za-z0-9_\-./+=]{40,}/g, '[hidden]').replace(/\s+/g, ' ').trim().slice(0, 240);
  const failure = new Error(`Muse Code does not offer ${label}, model id ${id}, to this account any more. ${list} Pick one of those for this chat or seat.${own ? `\n${own}` : ''}`);
  failure.notOffered = true;
  return failure;
}

// Removes a scratch folder. Windows refuses while the agent still has it as its working folder, so a refused removal is tried again for
// a moment; the run has already ended the agent (lib/acp.mjs waits for it).
async function removeScratch(dir) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}
