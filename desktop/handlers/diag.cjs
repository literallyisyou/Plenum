'use strict';
// The server's Help and Diagnostics asks (lib/routes/diag.mjs).
//  - 'diag-log' -> { type: 'diag-log-result', id, lines } : the last lines of server.log (the shell's own lines and the server's
//    output), at most LINES lines from the last READ_BYTES bytes. The file is written through the shell's redactor (desktop/log.cjs), and the
//    server cleans the lines again before they reach a report. { lines: [] } when there is no log yet.
//  - 'open-log-folder' -> { ok } : shows server.log in the file manager. Nothing is opened but the folder.
// No message carries a path or text to the shell, and the answer to 'open-log-folder' holds no path.
const fs = require('node:fs');

const READ_BYTES = 96 * 1024;
const LINES = 1500;

function tailOf(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - READ_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split(/\r?\n/);
    // A read that starts inside a line leaves half a line first.
    if (start > 0) lines.shift();
    return lines.slice(-LINES);
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed.
      }
    }
  }
}

module.exports = {
  name: 'diag',
  READ_BYTES,
  LINES,
  tailOf,
  messages: {
    'diag-log': async (message, shell) => {
      const file = shell.logFile;
      return { lines: typeof file === 'string' && file ? tailOf(file) : [] };
    },
    'open-log-folder': async (message, shell) => {
      const file = shell.logFile;
      if (typeof file !== 'string' || !file) return { ok: false };
      try {
        shell.shell.showItemInFolder(file);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
  },
};
