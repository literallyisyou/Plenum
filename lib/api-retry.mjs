import { waitWords } from './api-errors.mjs';

// Retry for the requests Plenum makes to a model API (used by lib/openai-compat.mjs). A brief rate limit, an overloaded server or a dropped
// connection passes by itself, so the request is made again, but only while that is safe: only before any of the reply has been
// shown or parsed. Once text or a tool call has come out, a second request would repeat text and could run a tool twice, so the
// failure is raised instead and the person sends again.
//   - At most 4 requests for one reply (MAX_TRIES), so 3 retries.
//   - The wait is about 1, 2, 4 seconds with jitter (never over 30), and is raised to what the provider asked for (Retry-After, the
//     wait its message names, or a short x-ratelimit-reset on a 429) when that is longer. A wait the provider asks for that is over 60
//     seconds (a daily quota) is not waited out: the failure is raised at once with the provider's words.
//   - A stop (the abort signal) ends the wait and the retries at once, quietly.
//   - 400, 401, 402, 403, 404, 413, 422, an account with no credit, and a refused redirect are never retried (the caller marks only
//     the errors that may pass as retryable; see lib/api-errors.mjs classify and isBriefNetworkError).

export const MAX_TRIES = 4;
export const BASE_MS = 1000;
export const CAP_MS = 30_000;
export const LONGEST_WAIT_MS = 60_000;

// The statuses worth another request.
const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
export const retryableStatus = status => RETRY_STATUS.has(status);

// How long to wait before the next request. `made` is how many requests have been made so far (1 after the first failed). `waitMs` is
// what the provider asked for (or null). Returns { ms, tooLong }: tooLong when the provider's own wait is over LONGEST_WAIT_MS.
export function retryDelay(made, { waitMs = null, random = Math.random } = {}) {
  if (waitMs != null && waitMs > LONGEST_WAIT_MS) return { ms: waitMs, tooLong: true };
  const top = Math.min(CAP_MS, BASE_MS * 2 ** Math.max(0, made - 1));
  const own = Math.round(top / 2 + (random() * top) / 2);
  return { ms: waitMs != null && waitMs > own ? waitMs : own, tooLong: false };
}

// Waits ms milliseconds. Resolves true when the time has passed and false when the signal stopped it first. Never rejects.
export function sleepAbortable(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, Math.max(0, ms));
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// What the person is told while Plenum waits: "OpenAI API is busy. Trying again in 8 seconds (try 2 of 4)."
function noticeText(label, kind, ms, next, tries) {
  const why = { 'rate-limit': 'is busy', overloaded: 'is overloaded', network: 'could not be reached', timeout: 'took too long' }[kind] ?? 'had a problem';
  return `${label} ${why}. Trying again in ${waitWords(ms / 1000).replace(/^about /, '')} (try ${next} of ${tries}).`;
}

// Runs a request with retries. `attempt(n)` is an async generator function (n counts from 1): it yields what the caller should see and returns the result. When
// an attempt fails in a way that may pass, and nothing was yielded or parsed yet, it throws an Error with err.retry = { kind, waitMs,
// rebuild(tries) } (rebuild gives the final message, which says how many times Plenum tried). Any other error is thrown as it is.
// Options: signal; label; notice(event) (shown to the person); onWait() (called while waiting, so an idle clock does not run out);
// sleep(ms, signal) and random() (tests); tries.
// When the signal stops it, the result is { text: '', calls: [], aborted: true }, the same quiet stop streamRound gives.
export async function* withRetry(attempt, { signal, label = 'The provider', notice, onWait, sleep = sleepAbortable, random = Math.random, tries = MAX_TRIES } = {}) {
  for (let n = 1; ; n++) {
    try {
      return yield* attempt(n);
    } catch (err) {
      const info = err?.retry;
      if (!info || signal?.aborted) {
        if (signal?.aborted && info) return { text: '', calls: [], aborted: true };
        throw err;
      }
      const { ms, tooLong } = retryDelay(n, { waitMs: info.waitMs ?? null, random });
      if (n >= tries || tooLong) {
        if (n > 1 && typeof info.rebuild === 'function') err.message = info.rebuild(n);
        delete err.retry;
        throw err;
      }
      try {
        notice?.({ type: 'notice', kind: 'api-retry', text: noticeText(label, info.kind, ms, n + 1, tries) });
      } catch {
        // A broken listener must not stop the retry.
      }
      // The wait goes in slices, so a listener that tracks activity hears from it during a long wait.
      for (let left = ms; left > 0;) {
        const slice = Math.min(left, 5000);
        try {
          onWait?.();
        } catch {
          // Ignored, as for any activity listener.
        }
        if (!(await sleep(slice, signal))) return { text: '', calls: [], aborted: true };
        left -= slice;
      }
    }
  }
}
