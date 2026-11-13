// One way to replace a file Plenum owns (the state file, the saved prompts, the saved pipelines): the text goes to a temp file,
// is flushed to the disk, and the temp file is renamed over the target. A reader or a crash sees the old file or the new one,
// never half of one. On Windows a sync client, antivirus or the indexer can hold the target for a moment, and the rename then
// fails with EPERM, EBUSY or EACCES. That is tried again for a few seconds before it counts as a failure.
import { promises as fs } from 'node:fs';

// The waits between the tries of one rename, in milliseconds: 8 tries in about 3 seconds.
export const RENAME_WAITS = Object.freeze([50, 100, 200, 400, 800, 800, 800]);
const LOCK_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
// A file system that cannot flush (some network and virtual drives) is not a failed save: the write itself worked.
const NO_SYNC_CODES = new Set(['EINVAL', 'ENOTSUP', 'ENOSYS', 'EOPNOTSUPP']);

// Whether an error is the short lock another program takes on a file, which is worth waiting for.
export const isLockError = err => LOCK_CODES.has(err?.code);

let seq = 0;

// Renames, trying again after each wait while the error is a lock. Any other error, and a lock that outlasts the waits, is thrown.
export async function renameRetry(from, to, waits = RENAME_WAITS) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fs.rename(from, to);
    } catch (err) {
      if (attempt >= waits.length || !isLockError(err)) throw err;
      await new Promise(resolve => setTimeout(resolve, waits[attempt]));
    }
  }
}

// Replaces `file` with `text`. The temp file has a name of its own (the process id and a counter), so two calls never share one;
// a caller that already writes one at a time may name it (`tmp`). When anything fails the temp file is removed, the target is left
// as it was, and the error is thrown.
export async function writeFileAtomic(file, text, { tmp = `${file}.${process.pid}.${++seq}.tmp`, waits = RENAME_WAITS } = {}) {
  try {
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(text);
      await handle.sync().catch(err => {
        if (!NO_SYNC_CODES.has(err?.code)) throw err;
      });
    } finally {
      await handle.close();
    }
    await renameRetry(tmp, file, waits);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
