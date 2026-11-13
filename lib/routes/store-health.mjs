// Store health: GET /api/store/health says whether Plenum loaded its backup, or started fresh, because the saved state file was
// damaged when it started. POST /api/store/health/ack clears that notice for this run. The recovery itself is in lib/store.mjs;
// these routes only report it. The server checks X-Muse-Console on every POST before this handler runs.
//
// The dated copies of the state file (lib/store.mjs, "Dated copies"), for Settings > General > Backups (public/ext-store-health.js):
//   GET  /api/store/backups  -> { backups: [{ name, time, bytes, kind, chats, messages }], folder, problem }
//        newest first; time is in milliseconds; kind is 'hourly', 'update' or 'restore'; chats and messages say how many the copy
//        holds (null when the copy cannot be read as a state), so nobody has to restore a copy to see what is in it; folder is
//        where the copies are; problem is a sentence about the last copy that could not be made, or null. The text of a copy is
//        never sent.
//   POST /api/store/restore  { name, confirm: true } -> { ok: true, name, kept, fresh, state }
//        name must be one of the names the list gives (a path is refused). kept is the name of the copy that holds the chats and
//        settings as they were before, so the restore can be undone. fresh is false when nothing had changed since the last
//        restore: no new copy was needed then, and kept names the copy that restore made. state is the public state afterwards.
//        400: no confirm, or not the name of a copy. 404: the copy is gone. 409: a reply or a task is running, something is still
//        saving, or a restore is. 422: the copy does not hold a usable state. 500: the state could not be saved. The message is a
//        sentence for the person.

export const routes = [
  { method: 'GET', path: '/api/store/health', handler: healthRoute },
  { method: 'POST', path: '/api/store/health/ack', handler: ackRoute },
  { method: 'GET', path: '/api/store/backups', handler: backupsRoute },
  { method: 'POST', path: '/api/store/restore', handler: restoreRoute },
];

// { health: null } when the state file was read normally, or the recovery that happened at start.
async function healthRoute({ res, json, store }) {
  return json(res, 200, { health: store.health() });
}

async function ackRoute({ res, json, store }) {
  store.ackHealth();
  return json(res, 200, { ok: true });
}

async function backupsRoute({ res, json, store }) {
  return json(res, 200, { backups: await store.backups(), folder: store.backupsFolder(), problem: store.backupProblem() });
}

const refuse = (status, message) => Object.assign(new Error(message), { status });

// A restore replaces every chat and setting, so it waits until nothing runs: a reply that is still being written would be cut from
// its chat, and its end would be saved into the restored state. running is the server's map of live runs. exclusive is its map of
// project-wide operations (a checkpoint restore, a rewind, a merge); the server does not hand it to route modules yet, so it is
// checked only when it is there.
async function restoreRoute({ req, res, json, readBody, store, running, exclusive, publicState }) {
  const body = await readBody(req);
  const name = body && typeof body === 'object' ? body.name : undefined;
  if (!body || typeof body !== 'object' || body.confirm !== true) throw refuse(400, 'Confirm the restore first.');
  if (typeof name !== 'string') throw refuse(400, 'Choose a saved copy to restore.');
  if ((running && running.size > 0) || (exclusive && exclusive.size > 0)) {
    throw refuse(409, 'A reply or a task is running. Wait for it to end, or stop it, and then restore.');
  }
  const done = await store.restoreBackup(name, { prepare: next => addThreads(store, next) });
  return json(res, 200, { ok: true, name: done.name, kept: done.kept, fresh: done.fresh !== false, state: typeof publicState === 'function' ? publicState() : null });
}

// A copy from before threads existed gets its Main threads, as a state file read at start does (lib/threads.mjs). A copy made by
// this build already has them, and this does nothing. The store calls it with the copy's state before that state is used, so the
// migration works on a stand-in for the store: it changes that state only, saves nothing (the restore saves) and makes no file.
// At a start the migration first copies the state file to state.json.pre-threads-<date>; here the restore has already kept the
// state as a dated copy, and one more full copy for every restore of an old copy would only fill the folder.
async function addThreads(store, next) {
  try {
    const { migrateThreads, threadsOff } = await import('../threads.mjs');
    // Threads are off for this run (their own backup failed at start): the copy is used as it is, and the next start migrates it.
    if (typeof threadsOff === 'function' && threadsOff()) return;
    await migrateThreads({ get: () => next, persist: async () => null, HOME: store.HOME }, { copy: async () => {} });
  } catch {
    // Without lib/threads.mjs the restored state is used as it is.
  }
}
