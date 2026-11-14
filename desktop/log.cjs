'use strict';
// The desktop shell's log (server.log in the app's user-data folder). No Electron import: the file system and the clock are passed in, so a
// test can fill a disk, refuse a rename or stop the clock (desktop/main.cjs is the only caller).
//  - Every line the shell writes starts with the time (ISO, UTC). What the server prints is written as it comes, with nothing added.
//  - The log has a size cap. At the cap, server.log is renamed to server.log.1 (the one before is replaced) and a new file starts. A rename
//    that fails (a locked file on Windows) is skipped and tried again later; it is never thrown.
//  - A write that fails (a full disk, a locked or removed file) is an 'error' event of the stream. It is caught here: the log stops
//    writing, drops lines (counting them) and opens the file again after RETRY_MS. The shell and the server's output pipes go on.
//  - The user's name in a path is replaced by ~, and a key, a bearer token or the launch token never reaches the file.
// The last lines are also kept in memory (tail), for the "Copy details" button of an error box.

const MAX_BYTES = 5 * 1024 * 1024;
const RETRY_MS = 30_000;
// A stream that holds more than this waiting to be written (a slow or stuck disk) drops new lines instead of growing for ever.
const MAX_QUEUED = 1024 * 1024;
const TAIL_LINES = 40;
const KEY_PATTERNS = [
  /\b(?:sk|xai|gsk|pk|rk)[-_][A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(x-plenum-token["'\s:=]+)[A-Za-z0-9]{12,}/gi,
];
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A function that cleans one piece of text. user: the name in "C:\Users\<name>"; secrets: a function that gives the exact values to
// hide (the launch token). The home folder's own spelling is replaced as a whole as well.
function makeRedactor({ user = '', home = '', secrets = () => [] } = {}) {
  const userRe = user && user.length >= 2 ? new RegExp(`([\\\\/]Users[\\\\/])${escapeRe(user)}(?![A-Za-z0-9_.-])`, 'gi') : null;
  const homeRe = home && home.length > 3 ? new RegExp(escapeRe(home).replace(/\\\\/g, '[\\\\/]'), 'gi') : null;
  return text => {
    let out = String(text);
    if (homeRe) out = out.replace(homeRe, '~');
    if (userRe) out = out.replace(userRe, '$1~');
    let list = [];
    try {
      list = secrets() ?? [];
    } catch {
      list = [];
    }
    for (const secret of list) if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join('[hidden]');
    for (const re of KEY_PATTERNS) out = out.replace(re, (m, lead) => (typeof lead === 'string' ? `${lead}[hidden]` : '[hidden]'));
    return out;
  };
}

function createLog({ fs, clock = Date.now, maxBytes = MAX_BYTES, retryMs = RETRY_MS, redact = text => text } = {}) {
  let file = '';
  let stream = null;
  let bytes = 0;
  // After a failed write or open: nothing is written before this time. After a failed rename: no new try before bytes passes this.
  let retryAt = 0;
  let renameAfter = 0;
  let dropped = 0;
  let lastError = '';
  let closed = false;
  const tail = [];

  const remember = text => {
    for (const piece of text.split(/\r?\n/)) {
      if (!piece) continue;
      tail.push(piece);
      if (tail.length > TAIL_LINES) tail.shift();
    }
  };

  function fail(err) {
    lastError = String(err?.code ?? err?.message ?? err).slice(0, 80);
    retryAt = clock() + retryMs;
    const dead = stream;
    stream = null;
    try {
      dead?.removeAllListeners?.('error');
      dead?.on?.('error', () => {});
      dead?.destroy?.();
    } catch {
      // Already gone.
    }
  }

  function openStream() {
    try {
      fs.mkdirSync(require('node:path').dirname(file), { recursive: true });
      // The file is opened here, at once, and the stream is given the handle: a file that does not exist yet (a stream opens it a moment later)
      // could not be renamed at the cap. A file that cannot be opened (a folder, a full disk) throws here and is dealt with below.
      const s = typeof fs.openSync === 'function' ? fs.createWriteStream(file, { fd: fs.openSync(file, 'a'), flags: 'a' }) : fs.createWriteStream(file, { flags: 'a' });
      s.on('error', err => {
        if (s === stream) fail(err);
      });
      stream = s;
      try {
        bytes = fs.statSync(file).size;
      } catch {
        bytes = 0;
      }
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  }

  // The file is full: it becomes server.log.1 and a new one starts. A failure to do that is skipped (the log goes on growing past the cap
  // until the next try, 1 MB later).
  function rotate() {
    const old = `${file}.1`;
    const current = stream;
    try {
      try {
        fs.unlinkSync(old);
      } catch {
        // No older copy.
      }
      fs.renameSync(file, old);
    } catch {
      renameAfter = bytes + 1024 * 1024;
      return;
    }
    stream = null;
    try {
      current?.end?.();
    } catch {
      // Closed already.
    }
    bytes = 0;
    openStream();
  }

  function put(text) {
    if (closed) return;
    if (!stream && clock() >= retryAt) {
      if (openStream() && dropped > 0) {
        const note = `${new Date(clock()).toISOString()} log: ${dropped} lines could not be written (${lastError}) and are lost\n`;
        dropped = 0;
        stream.write(note);
        bytes += Buffer.byteLength(note);
      }
    }
    if (!stream || (stream.writableLength ?? 0) > MAX_QUEUED) {
      dropped += 1;
      return;
    }
    try {
      stream.write(text);
    } catch (err) {
      fail(err);
      dropped += 1;
      return;
    }
    bytes += Buffer.byteLength(text);
    if (bytes > maxBytes && bytes > renameAfter) rotate();
  }

  return {
    // Opens (or reopens) the file. Never throws: a file that cannot be opened is retried when the next line comes.
    open(target) {
      file = target;
      closed = false;
      openStream();
      if (stream && bytes > maxBytes) rotate();
    },
    // One line of the shell's own: the time, then the text.
    line(text) {
      const stamped = `${new Date(clock()).toISOString()} ${redact(text)}`;
      remember(stamped);
      put(`${stamped}\n`);
    },
    // What the server printed: written as it came.
    raw(chunk) {
      const clean = redact(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      remember(clean);
      put(clean);
    },
    // Takes everything a readable (the server's stdout or stderr) gives. A read never waits for the file.
    attach(readable, onText) {
      readable?.on?.('data', chunk => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        this.raw(text);
        onText?.(text);
      });
      readable?.on?.('error', () => {});
    },
    // The last lines, redacted, for a person to copy.
    tail: () => tail.slice(),
    file: () => file,
    // Ends the stream (the app is quitting). Calls done once the file is flushed, or at once when there is nothing open.
    end(done) {
      closed = true;
      const last = stream;
      stream = null;
      if (!last) {
        done?.();
        return;
      }
      try {
        last.on('error', () => {});
        last.end(() => done?.());
      } catch {
        done?.();
      }
    },
  };
}

module.exports = { createLog, makeRedactor, MAX_BYTES, RETRY_MS, TAIL_LINES };
