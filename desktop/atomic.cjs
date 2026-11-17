'use strict';
// One way for the desktop app to replace a file it owns (the saved keys, the updater's bookkeeping): the text goes to a temp file, is
// flushed to the disk, and the temp file is renamed over the target. A reader or a crash sees the old file or the new one, never half
// of one. On Windows a sync client, antivirus or the indexer can hold the target for a moment, and the rename then fails with EPERM,
// EBUSY or EACCES; that is tried again after short waits before it counts as a failure. When anything fails the temp file is removed,
// the target is left as it was, and the error is thrown. This is the CommonJS copy of lib/atomic-write.mjs (the server's), for the
// Electron main process.
//
// The errors are the file system's own (a code and the file names). The text written is never put in an error or a log line, so a
// caller that writes encrypted keys never shows them. fs can be replaced (the tests and the key vault pass their own); only its sync
// calls are used (openSync, writeFileSync with a descriptor, fsyncSync, closeSync, renameSync, rmSync), and the waits between tries of
// the rename are timers in writeFileAtomic and a short blocking sleep in writeFileAtomicSync.
const nodeFs = require('node:fs');

// The waits between the tries of one rename, in milliseconds: 8 tries in about 3 seconds (the same as lib/atomic-write.mjs).
const RENAME_WAITS = Object.freeze([50, 100, 200, 400, 800, 800, 800]);
// The sync version blocks the thread while it waits, so its waits are shorter: 6 tries in about a third of a second.
const SYNC_RENAME_WAITS = Object.freeze([10, 20, 40, 80, 150]);
const LOCK_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
// A file system that cannot flush (some network and virtual drives) is not a failed save: the write itself worked.
const NO_SYNC_CODES = new Set(['EINVAL', 'ENOTSUP', 'ENOSYS', 'EOPNOTSUPP']);

// Whether an error is the short lock another program takes on a file, which is worth waiting for.
const isLockError = err => LOCK_CODES.has(err?.code);

let seq = 0;
const tempName = file => `${file}.${process.pid}.${++seq}.tmp`;

// A sleep that blocks this thread, for the sync version only. Atomics.wait is allowed in Node's main thread.
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // No way to wait: the next try comes at once.
  }
}

// Writes the temp file: open, write, flush, close. The descriptor is closed whatever happens.
function writeTemp(fs, tmp, text, mode) {
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeFileSync(fd, text);
    try {
      fs.fsyncSync(fd);
    } catch (err) {
      if (!NO_SYNC_CODES.has(err?.code)) throw err;
    }
  } finally {
    fs.closeSync(fd);
  }
}

function removeTemp(fs, tmp) {
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    // A temp file that cannot be removed now is left; it has a name of its own and is never read.
  }
}

// Renames, trying again after each wait while the error is a lock. Any other error, and a lock that outlasts the waits, is thrown.
async function renameRetry(from, to, { fs = nodeFs, waits = RENAME_WAITS } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return fs.renameSync(from, to);
    } catch (err) {
      if (attempt >= waits.length || !isLockError(err)) throw err;
      await new Promise(resolve => setTimeout(resolve, waits[attempt]));
    }
  }
}

function renameRetrySync(from, to, { fs = nodeFs, waits = SYNC_RENAME_WAITS } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return fs.renameSync(from, to);
    } catch (err) {
      if (attempt >= waits.length || !isLockError(err)) throw err;
      sleepSync(waits[attempt]);
    }
  }
}

// Replaces `file` with `text`. The temp file has a name of its own (the process id and a counter), so two calls never share one.
// mode is the new file's permission bits (0o600: only the owner can read it).
async function writeFileAtomic(file, text, { fs = nodeFs, mode = 0o666, waits = RENAME_WAITS, tmp = tempName(file) } = {}) {
  try {
    writeTemp(fs, tmp, text, mode);
    await renameRetry(tmp, file, { fs, waits });
  } catch (err) {
    removeTemp(fs, tmp);
    throw err;
  }
}

// The same, for a caller that must finish before it returns (the updater's bookkeeping is read back at once). It waits less.
function writeFileAtomicSync(file, text, { fs = nodeFs, mode = 0o666, waits = SYNC_RENAME_WAITS, tmp = tempName(file) } = {}) {
  try {
    writeTemp(fs, tmp, text, mode);
    renameRetrySync(tmp, file, { fs, waits });
  } catch (err) {
    removeTemp(fs, tmp);
    throw err;
  }
}

module.exports = { RENAME_WAITS, SYNC_RENAME_WAITS, isLockError, renameRetry, renameRetrySync, writeFileAtomic, writeFileAtomicSync };
