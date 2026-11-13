import { Worker } from 'node:worker_threads';

// Runs a regular expression that a model (or any other outside text) wrote, off the server's thread. JavaScript's own engine can
// take hours on a short pattern such as ^(a+)+$ and cannot be interrupted, and the server has one thread: while it is busy nothing
// answers, Stop included. So such a pattern never runs here. It runs in a worker thread that is ended when it takes too long or
// when the run is stopped. Only the pattern and the text go to the worker: it gets no file access, an empty environment and none of
// the server's start options, and its code is the text below, so there is no file to find on disk (the update overlay, a packed app).
// Any code that takes a pattern from a model should use this instead of new RegExp(...).test().

// The longest pattern that is accepted.
export const MAX_PATTERN = 500;
// A line longer than this is not tested: one long line (a minified file) is where a slow pattern costs the most.
export const MAX_LINE = 2000;
// How long one text may take before the worker is ended.
export const DEADLINE_MS = 5000;
export const TOO_SLOW_MESSAGE = 'That pattern took too long, so the search was stopped. Use a simpler pattern or a plain-text search.';
export const STOPPED_MESSAGE = 'The search was stopped.';

// Checks a pattern before anything runs: its length, then its syntax. Building a RegExp only parses the pattern, so this is safe on
// the server's thread, and a syntax error keeps the engine's own message. g and y are dropped: they make test() remember a position.
export function checkPattern(pattern, flags = '') {
  const source = String(pattern ?? '');
  if (!source) throw new Error('Give a pattern to search for.');
  if (source.length > MAX_PATTERN) {
    throw new Error(`A regular expression can be at most ${MAX_PATTERN} characters, and this one has ${source.length}. Use a shorter pattern or a plain-text search.`);
  }
  const kept = String(flags ?? '').replace(/[gy]/g, '');
  new RegExp(source, kept);
  return { source, flags: kept };
}

// The worker: it keeps the compiled pattern and, for each text, answers the 0-based numbers of the lines that match (at most
// `limit`) and how many lines were too long to test. A line's trailing \r (a Windows line ending) is not part of the line.
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
let re = null;
parentPort.on('message', m => {
  try {
    if (!re) re = new RegExp(m.source, m.flags);
    const lines = m.text.split('\\n');
    const hits = [];
    let long = 0;
    for (let i = 0; i < lines.length && hits.length < m.limit; i++) {
      const line = lines[i].endsWith('\\r') ? lines[i].slice(0, -1) : lines[i];
      if (line.length > m.maxLine) long += 1;
      else if (re.test(line)) hits.push(i);
    }
    parentPort.postMessage({ id: m.id, hits, long });
  } catch (err) {
    parentPort.postMessage({ id: m.id, error: String(err && err.message || err) });
  }
});
`;

// A matcher for one pattern. lines(text, limit) resolves to { hits, long }: the 0-based numbers of the matching lines (at most
// limit) and the count of lines over maxLine that were skipped. It rejects with TOO_SLOW_MESSAGE when one text takes longer than
// deadlineMs, and with STOPPED_MESSAGE when signal aborts; either way the worker is ended at once, and every later call rejects the
// same way. One text is tested at a time. Call close() when done (a finally block): it ends the worker.
export function regexMatcher(pattern, { flags = '', deadlineMs = DEADLINE_MS, maxLine = MAX_LINE, signal } = {}) {
  const checked = checkPattern(pattern, flags);
  let worker = null;
  let pending = null; // { id, resolve, reject, timer }
  let dead = null; // the error every later call gets
  let seq = 0;

  const settle = (err, value) => {
    const p = pending;
    pending = null;
    if (!p) return;
    clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(value);
  };
  const end = err => {
    if (err && !dead) dead = err;
    const w = worker;
    worker = null;
    if (w) w.terminate().catch(() => {});
    settle(err ?? new Error(STOPPED_MESSAGE));
  };
  const onAbort = () => end(new Error(STOPPED_MESSAGE));
  if (signal) {
    if (signal.aborted) dead = new Error(STOPPED_MESSAGE);
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const start = () => {
    // execArgv and env are given, so the worker takes over neither the server's start options (preloads, loaders) nor its environment.
    const w = new Worker(WORKER_SOURCE, { eval: true, execArgv: [], env: {}, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    w.on('message', m => {
      if (w !== worker || !pending || m?.id !== pending.id) return;
      if (m.error) settle(new Error(m.error));
      else settle(null, { hits: m.hits, long: m.long });
    });
    const broke = () => {
      if (w === worker) end(new Error('The pattern search stopped unexpectedly. Use a simpler pattern or a plain-text search.'));
    };
    w.on('error', broke);
    w.on('exit', broke);
    worker = w;
  };

  return {
    lines(text, limit = Number.MAX_SAFE_INTEGER) {
      if (dead) return Promise.reject(dead);
      if (pending) return Promise.reject(new Error('The matcher tests one text at a time.'));
      return new Promise((resolve, reject) => {
        try {
          if (!worker) start();
          const id = ++seq;
          const timer = setTimeout(() => end(new Error(TOO_SLOW_MESSAGE)), deadlineMs);
          pending = { id, resolve, reject, timer };
          worker.postMessage({ id, text: String(text ?? ''), limit, maxLine, source: checked.source, flags: checked.flags });
        } catch (err) {
          if (pending) clearTimeout(pending.timer);
          pending = null;
          end(err);
          reject(err);
        }
      });
    },
    close() {
      signal?.removeEventListener('abort', onAbort);
      end(new Error(STOPPED_MESSAGE));
    },
  };
}
