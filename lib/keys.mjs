import { readUserEnv } from './accounts.mjs';
import { API_PROVIDERS, apiProvider } from './api-providers.mjs';
import { setToken } from './auth.mjs';

// API keys for the model providers that bill per token (xAI, OpenAI, DeepSeek, Mistral, Google AI, OpenRouter) and the Anthropic API key.
// The list comes from lib/api-providers.mjs, so a provider added there is stored, listed and tested here with no other change.
// Where a key lives depends on how Plenum was started:
//  - The desktop app runs this server as a utility process. Its main process keeps the keys encrypted with the operating
//    system (desktop/keyvault.cjs) and sends them here over the channel it opened. They are held in memory only.
//  - Started with plain Node (npm start), there is no channel. Keys come from environment variables only and cannot be saved.
// A key is never logged, never written to the app's state file, never put in an environment and never sent back to the browser.

// The one-off check gives up after this long, so a stalled provider cannot hang the Accounts panel.
const TEST_TIMEOUT_MS = 15_000;
// The same limits the Anthropic key check in server.mjs uses, so every provider is held to one rule.
const MIN_LEN = 20;
const MAX_LEN = 300;
// How long to wait for the desktop app to hand over the saved keys at start, and for it to confirm one save.
const HELLO_TIMEOUT_MS = 5_000;
const SAVE_TIMEOUT_MS = 15_000;

// The Anthropic key is stored like the others but is not one of the providers listed in the Accounts panel.
const ANTHROPIC = { id: 'anthropic', label: 'Anthropic (Claude)', envVar: 'ANTHROPIC_API_KEY' };
// Every key the store accepts, by environment variable name. desktop/keyvault.cjs keeps the same list.
const NAMES = [ANTHROPIC.envVar, ...API_PROVIDERS.map(p => p.envVar)];
const ITEMS = [...API_PROVIDERS.map(p => ({ id: p.id, label: p.label, envVar: p.envVar })), ANTHROPIC];
// What the desktop app can report: keys saved in the operating system's store, kept for this session only (Linux without a
// secret service), or refused. The fourth mode, environment, is the one with no desktop app.
const MODES = ['keychain', 'session', 'unavailable'];

const NOTES = {
  environment: 'Keys are read from environment variables only, because Plenum was started with Node and not as the desktop app. Set the variable of the key (for example ANTHROPIC_API_KEY for Claude or OPENAI_API_KEY for Codex) and restart Plenum, or start Plenum from its installer to save keys here. The desktop app keeps keys in the operating system\'s keychain instead.',
  keychain: 'Keys are saved encrypted by the operating system. Plenum holds them in memory only while it runs.',
  session: 'This computer has no keychain Plenum can use, so keys are kept for this session only and are forgotten when Plenum closes.',
  unavailable: 'Plenum cannot save keys on this computer because the operating system\'s encryption is not available. Keys are never saved as plain text.',
  silent: 'Plenum could not reach its desktop app to load the saved keys, so keys cannot be saved or used. Restart Plenum.',
};
// What a save adds to the message, by where the key went.
const SAVED = {
  keychain: 'It is saved encrypted by the operating system.',
  session: 'It is kept for this session only and is forgotten when Plenum closes.',
};

// Where keys come from now. Everything here is in memory; the only copy on disk is the desktop app's encrypted file.
let port = null;
let storage = { mode: 'environment', note: NOTES.environment };
const memory = new Map(); // key name -> key
// Names of keys that were saved without the provider's check (Save anyway). It holds names only, never a key. It lasts for this run:
// a good Test, a new key that was checked, or removing the key clears the mark.
const unchecked = new Set();
const waiting = new Map(); // save request id -> { resolve, timer }
let nextId = 0;
let onKeys = null;

// Unknown provider ids are a client mistake, so they carry a 400 status for the server to report.
function provider(id) {
  const p = apiProvider(id);
  if (!p) throw Object.assign(new Error('Pick a provider from the list.'), { status: 400 });
  return p;
}

// A value that is only spaces counts as not set.
const clean = v => (typeof v === 'string' ? v.trim() : '');
const looksLikeKey = v => v.length >= MIN_LEN && v.length <= MAX_LEN && !/\s/.test(v);
// A key is plain printable ASCII. Anything else (a curly quote or an ellipsis from a document, an invisible space, a control character)
// cannot be sent as a request header, so such a key can never work and no provider is asked about it.
const sendable = v => /^[\x21-\x7e]+$/.test(v);
// Takes a key out of a message before the message is shown or passed on.
const scrub = (text, ...secrets) => secrets.reduce((t, s) => (s ? t.split(s).join('[key]') : t), String(text));

// The channel to the desktop app, as { post(message), onMessage(handler) }. Electron gives a utility process its parent as
// process.parentPort. A launcher that starts the server with Node's own message channel can ask for it with
// MUSE_CONSOLE_KEY_CHANNEL=ipc. A plain `node server.mjs` has neither, and gets null.
export function parentChannel() {
  const parent = process.parentPort;
  if (parent) return { post: m => parent.postMessage(m), onMessage: fn => parent.on('message', e => fn(e?.data)) };
  if (process.env.MUSE_CONSOLE_KEY_CHANNEL === 'ipc' && typeof process.send === 'function') {
    return { post: m => process.send(m), onMessage: fn => process.on('message', fn) };
  }
  return null;
}

// Reads the desktop app's answer: how keys are stored, and the saved keys themselves.
function applyKeys(msg) {
  const mode = MODES.includes(msg.storage) ? msg.storage : 'unavailable';
  memory.clear();
  unchecked.clear();
  if (mode !== 'unavailable' && msg.keys && typeof msg.keys === 'object') {
    for (const name of NAMES) {
      const value = Object.hasOwn(msg.keys, name) ? clean(msg.keys[name]) : '';
      if (value) memory.set(name, value);
    }
  }
  const note = clean(msg.note).slice(0, 400);
  storage = { mode, note: note || NOTES[mode] };
  // The desktop app also hands over this launch's token in the same message (lib/auth.mjs). A bad value is ignored.
  if (typeof msg.token === 'string') setToken(msg.token, 'desktop');
  onKeys?.();
}

function onMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'keys') return applyKeys(msg);
  // delete-key-result is the answer the desktop app's channel gives when its handler fails for a removal, so it is waited for too.
  if (msg.type === 'save-key-result' || msg.type === 'delete-key-result') {
    const w = waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    clearTimeout(w.timer);
    w.resolve(msg);
  }
}

// Called once at start, before the server listens. With a channel it asks the desktop app for the saved keys and waits for
// them, so the first request already sees them. With null (a plain Node run) keys come from the environment only.
export function connectKeyChannel(channel, { timeoutMs = HELLO_TIMEOUT_MS } = {}) {
  memory.clear();
  unchecked.clear();
  for (const w of waiting.values()) clearTimeout(w.timer);
  waiting.clear();
  port = channel ?? null;
  if (!port) {
    storage = { mode: 'environment', note: NOTES.environment };
    return Promise.resolve(keyStorage());
  }
  storage = { mode: 'unavailable', note: NOTES.silent };
  port.onMessage(onMessage);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      onKeys = null;
      resolve(keyStorage());
    }, timeoutMs);
    onKeys = () => {
      clearTimeout(timer);
      onKeys = null;
      resolve(keyStorage());
    };
    port.post({ type: 'keys-hello' });
  });
}

// How keys are kept right now, in words for the Accounts panel. canSave is false when a save would be refused.
export function keyStorage() {
  return { mode: storage.mode, canSave: storage.mode === 'keychain' || storage.mode === 'session', message: storage.note };
}

// Finds a stored key by its environment variable name, and where it came from. The desktop app never has the key in an
// environment, so with a channel only the memory is read; without one only the environment is.
function lookup(envVar) {
  if (storage.mode === 'environment') {
    const fromEnv = clean(process.env[envVar]);
    return fromEnv ? { key: fromEnv, source: 'environment' } : { key: null, source: null };
  }
  const key = memory.get(envVar);
  return key ? { key, source: storage.mode === 'session' ? 'session only' : 'keychain' } : { key: null, source: null };
}

// False when the saved key was kept without the provider's check and no check has passed since, so the panel can say so.
export function keyChecked(providerId) {
  return !unchecked.has(provider(providerId).envVar);
}

// Called when a Test of the saved key passed: the key is confirmed now.
export function noteChecked(providerId) {
  unchecked.delete(provider(providerId).envVar);
}

// The key kept under one of the stored names ({ key, source }), read on every call so a key saved in the app works at once.
// The Claude adapter uses this for ANTHROPIC_API_KEY.
export async function storedKey(envVar) {
  if (!NAMES.includes(envVar)) throw new Error(`${envVar} is not a key Plenum stores.`);
  return lookup(envVar);
}

// Reports whether a key is set and where it is kept: keychain, session only, environment, or null for none.
// The key itself is never returned.
export async function keyStatus(providerId) {
  const { key, source } = lookup(provider(providerId).envVar);
  return { configured: key !== null, source };
}

// Returns the key for an adapter to send, or null when none is set. Callers must not log it.
export async function keyFor(providerId) {
  return lookup(provider(providerId).envVar).key;
}

// Refuses anything that cannot be a real key before a request is sent with it.
function checkShape(key) {
  if (!looksLikeKey(key)) {
    throw Object.assign(new Error(`That does not look like an API key. Keys are ${MIN_LEN} to ${MAX_LEN} characters with no spaces.`), { status: 400 });
  }
}

// Throws the reason when a key cannot be saved here, so a caller can stop before it sends the key anywhere.
// With the variable name of the key being saved, the plain-Node message names that variable and no other.
export function assertCanSave(envVar) {
  if (keyStorage().canSave) return;
  if (storage.mode === 'environment' && NAMES.includes(envVar)) {
    throw new Error(`Keys are read from environment variables only, because Plenum was started with Node and not as the desktop app. Set ${envVar} and restart Plenum, or start Plenum from its installer to save keys here.`);
  }
  throw new Error(storage.note);
}

// What a request that is never answered, or cannot be sent, says. A save and a removal each have their own words.
const SAVE_FAILED = { late: 'The desktop app did not answer in time, so the key was not saved.', unsent: 'The key could not be handed to the desktop app.' };
const REMOVE_FAILED = { late: 'The desktop app did not answer in time, so the key was not removed.', unsent: 'The removal could not be handed to the desktop app.' };

// Sends the desktop app one request and waits for its answer. Resolves { ok: false, message } if it never comes, with the words in `failed`.
function ask(message, failed = SAVE_FAILED) {
  const id = ++nextId;
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve({ ok: false, message: failed.late });
    }, SAVE_TIMEOUT_MS);
    waiting.set(id, { resolve, timer });
    try {
      port.post({ ...message, id });
    } catch {
      waiting.delete(id);
      clearTimeout(timer);
      resolve({ ok: false, message: failed.unsent });
    }
  });
}

// Hands one key to the desktop app to encrypt and write, then keeps it in memory. Returns a sentence about where it went.
// Throws an Error with a plain message when saving is refused or fails; the message never holds the key.
export async function storeKey(envVar, key) {
  if (!NAMES.includes(envVar)) throw new Error(`${envVar} cannot be saved from here.`);
  assertCanSave(envVar);
  const reply = await ask({ type: 'save-key', name: envVar, key });
  if (!reply.ok) throw new Error(scrub(clean(reply.message) || 'The key could not be saved.', key).slice(0, 300));
  // The desktop app can change its mind about where keys go (for example the secret service went away), and says so here.
  if (MODES.includes(reply.storage)) storage = { mode: reply.storage, note: clean(reply.note) || NOTES[reply.storage] };
  memory.set(envVar, key);
  unchecked.delete(envVar);
  return SAVED[storage.mode] ?? '';
}

// Removes a saved key from the desktop app's store and from memory. Resolves { ok, message } and never throws. The key leaves memory
// only once the desktop app confirms it is gone, so a request that is never answered leaves the key as the app still has it.
// A plain Node run has no store to remove from: its key comes from an environment variable, so that variable is cleared by hand.
// The Anthropic key is not a listed provider, so it is named here and nowhere else (the Claude card removes it through server.mjs).
export async function forgetKey(providerId) {
  const p = providerId === ANTHROPIC.id ? ANTHROPIC : provider(providerId);
  if (storage.mode === 'environment') {
    return { ok: false, message: `The ${p.label} key comes from the ${p.envVar} environment variable, because Plenum was started without the desktop app. Clear that variable and restart Plenum to remove it.` };
  }
  const reply = await ask({ type: 'delete-key', name: p.envVar }, REMOVE_FAILED);
  if (!reply.ok) return { ok: false, message: clean(reply.message).slice(0, 300) || 'The key could not be removed.' };
  // The desktop app can change its mind about where keys go, the same as after a save.
  if (MODES.includes(reply.storage)) storage = { mode: reply.storage, note: clean(reply.note) || NOTES[reply.storage] };
  memory.delete(p.envVar);
  unchecked.delete(p.envVar);
  return { ok: true, message: `The ${p.label} key was removed. Plenum no longer uses it.` };
}

// What a key that cannot be sent says. The key itself is never part of a message.
const BAD_CHARACTER = 'This key has a character that cannot be part of a key, such as a curly quote or an invisible space. Paste it again from the provider.';

// Turns an HTTP status from the check into a plain sentence and a verdict. The provider's own error text is not repeated,
// so nothing from the request can end up in the message. The verdict is only for a result that is not ok:
//  'refused'   the status says the key itself is wrong (401, and any status the provider lists in rejectStatuses), so it is never saved;
//  'unchecked' the check could not tell (no permission to list models, a limit, no credit, a busy provider, no internet), so the key
//              may still be fine and is saved only when the person chooses Save anyway.
function statusMessage(p, status) {
  if (status >= 200 && status < 300) return { ok: true, message: `The ${p.label} key works.` };
  const verdict = (p.rejectStatuses ?? [401]).includes(status) ? 'refused' : 'unchecked';
  if (status === 401 || (status === 400 && verdict === 'refused')) return { ok: false, verdict, message: `${p.label} rejected this key (${status}). Check that you copied the whole key.` };
  // A 403 from a provider that does not list it as a wrong key is often a key limited to some uses (it may not list models), which can still work.
  if (status === 403) return { ok: false, verdict, message: verdict === 'refused' ? `${p.label} refused this key (403). Check the key's permissions in the provider's console.` : `${p.label} refused this key (403) for the check${p.checkPath ? '' : ', which lists models'}. A key limited to some uses can still work; check its permissions in the provider's console.` };
  // A 429 can mean a rate limit or no credit left, and the key itself may still be fine.
  if (status === 429) return { ok: false, verdict, message: `${p.label} is limiting requests or this account has no credit left (429). The key may still be fine; check billing, then try again.` };
  if (status >= 500) return { ok: false, verdict, message: `${p.label} had a server error (${status}). Try again in a few minutes.` };
  return { ok: false, verdict, message: `${p.label} did not accept the check (HTTP ${status}).` };
}

// Sends one cheap request, GET {baseUrl}/models (or the provider's own checkPath), to check a key. Returns { ok, message } and, when
// the key is not accepted, a verdict: 'refused' (the key is wrong, or it has a character no key can have and was never sent) or
// 'unchecked' (the check could not tell: see statusMessage; a redirect, which is never followed, is one of these).
export async function testKey(providerId, key) {
  const p = provider(providerId);
  const value = clean(key);
  if (!value) return { ok: false, verdict: 'refused', message: `No key was given for ${p.label}.` };
  // Refused before any request: the request could not even be built with it, and that is not the network's fault.
  if (!sendable(value)) return { ok: false, verdict: 'refused', message: BAD_CHARACTER };
  let res;
  try {
    res = await fetch(`${p.baseUrl.replace(/\/+$/, '')}${p.checkPath ?? '/models'}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${value}`, accept: 'application/json' },
      // A redirect is refused rather than followed, so the key is never sent on to another host.
      redirect: 'error',
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return { ok: false, verdict: 'unchecked', message: `${p.label} did not answer within ${TEST_TIMEOUT_MS / 1000} seconds. Check the connection and try again.` };
    }
    // A redirect is never followed, so the key is not sent on. It says nothing about the key: the provider's address is fixed, so a
    // redirect comes from something in between (a network sign-in page, a proxy). The person may save the key anyway.
    if (/redirect/i.test(String(err?.cause?.message ?? ''))) {
      return { ok: false, verdict: 'unchecked', message: `${p.label} tried to redirect the check, so it was stopped. The key was not sent on. A network sign-in page or a proxy can cause this; sign in to the network, then try again.` };
    }
    // fetch reports a network failure as a TypeError with a cause. One without a cause was thrown while the request was being built,
    // so nothing was sent: the key cannot be put in a request, and it is refused rather than blamed on the connection.
    if (err?.name === 'TypeError' && err.cause === undefined && !/fetch failed/i.test(String(err.message))) {
      return { ok: false, verdict: 'refused', message: `The check could not be sent with this key, so ${p.label} was not asked. Paste the key again from the provider.` };
    }
    return { ok: false, verdict: 'unchecked', message: `${p.label} could not be reached. Check the internet connection and try again.` };
  }
  // Only the status is needed, so the body is dropped without being read.
  try {
    await res.body?.cancel();
  } catch {
    // Nothing to clean up if the body is already closed.
  }
  return statusMessage(p, res.status);
}

// What an unconfirmed key says about a key that is already saved.
const KEEPS_OLD = ' Your current key stays in place unless you save this one anyway.';
const REPLACED = ' It replaced the key you had saved.';

// Checks a key with the provider and saves it through the desktop app. Throws an Error with a plain message when the key is
// not plausible, keys cannot be saved here, the provider refuses it, or the save fails.
// When the check could not run (testKey verdict 'unchecked') the key is saved only if force is true. Without force the answer is
// { ok: false, saved: false, canSaveAnyway: true, message } and the caller asks the person. With force the key is saved and the answer
// says it is not checked yet ({ ok: true, saved: true, checked: false, message }). The check is sent again first, so a key the provider
// refuses is never saved, and force never skips the shape check or the storage check.
export async function saveKey(providerId, key, { force = false } = {}) {
  const p = provider(providerId);
  const value = typeof key === 'string' ? key.trim() : '';
  checkShape(value);
  // A save that would be refused stops here, before the key is sent to the provider.
  assertCanSave(p.envVar);
  const check = await testKey(p.id, value);
  // A key the provider refuses is never written, so a typo never replaces a working key.
  if (!check.ok && check.verdict !== 'unchecked') throw new Error(check.message);
  const replaces = memory.has(p.envVar) && memory.get(p.envVar) !== value;
  if (!check.ok && force !== true) {
    return { ok: false, saved: false, canSaveAnyway: true, message: `${check.message}${replaces ? KEEPS_OLD : ''}`, storage: storage.mode };
  }
  const where = await storeKey(p.envVar, value);
  if (check.ok) return { ok: true, saved: true, checked: true, message: `${check.message} ${where}`.trim(), storage: storage.mode };
  unchecked.add(p.envVar);
  // The person has just read why the check could not run, so the answer does not repeat it.
  const note = `Saved, not checked yet. Plenum could not confirm this key with ${p.label} just now. Use Test saved key later to check it.`;
  return { ok: true, saved: true, checked: false, message: `${note}${replaces ? REPLACED : ''} ${where}`.trim(), storage: storage.mode };
}

// Keys already in the Windows user environment, which older versions saved there. They are offered for import, never copied
// unless the person asks. Each entry is { id, label, envVar }; the keys themselves are not returned. Only Windows has such
// a place, and only a key not already saved is offered. platform is for tests.
export async function importable({ platform = process.platform } = {}) {
  if (platform !== 'win32' || !keyStorage().canSave) return [];
  const offered = await Promise.all(ITEMS.map(async item => {
    if (memory.has(item.envVar)) return null;
    let value = '';
    try {
      value = clean(await readUserEnv(item.envVar));
    } catch {
      // A value that cannot be read is not offered.
    }
    return looksLikeKey(value) ? item : null;
  }));
  return offered.filter(Boolean);
}

// Copies the chosen keys (by id; all the offered ones when ids is null) into the desktop app's store. The copies in the
// Windows user environment are left alone. Returns one { id, label, imported, message } per key asked for.
// Nothing is offered without the desktop app or off Windows, so the message says why instead of claiming the environment
// was checked. With no ids named, every provider is reported that way, so the caller has a reason to show.
export async function importKeys(ids = null, { platform = process.platform } = {}) {
  const offer = await importable({ platform });
  const reason = !keyStorage().canSave ? `Importing keys needs the Plenum desktop app. ${keyStorage().message}`
    : platform !== 'win32' ? 'Keys are only copied in on Windows.'
      : null;
  const wanted = ids === null ? (reason ? ITEMS.map(o => o.id) : offer.map(o => o.id)) : [...new Set(ids)];
  const results = [];
  for (const id of wanted) {
    const item = offer.find(o => o.id === id);
    if (!item) {
      const known = ITEMS.find(o => o.id === id);
      results.push({ id, label: known?.label ?? String(id).slice(0, 40), imported: false, message: reason ?? 'There is no key for this provider in the Windows user environment to import.' });
      continue;
    }
    try {
      const where = await storeKey(item.envVar, clean(await readUserEnv(item.envVar)));
      // No provider was asked about a copied key (it can be one revoked since), so it shows "not checked yet" until a Test of the
      // saved key passes, as a key kept with Save anyway does (wave 7, signin-8).
      unchecked.add(item.envVar);
      const words = [`The ${item.label} key was copied.`, where, 'It is not checked yet. Use Test saved key.'].filter(Boolean).join(' ');
      results.push({ id, label: item.label, imported: true, message: words });
    } catch (err) {
      results.push({ id, label: item.label, imported: false, message: String(err?.message ?? 'The key could not be copied.') });
    }
  }
  return results;
}
