// The idle clock of one text-mode council turn (a seat's reply, or the moderator's). A turn that writes nothing for the idle limit is
// stopped on its own, so one wedged model cannot hold a council until the run's 3 hour limit. There is no total limit: a model that
// thinks hard can be silent for minutes, and a turn that keeps writing is never cut.
//   watchTurn({ signal, idleMs, onExpire }) -> { signal, touch(), pause(), resume(), stop(), expired }
// signal is the caller's (the run's Stop). The watch has its own signal, which ends when the caller's does and when the clock runs out;
// `expired` tells the two apart, so a Stop is never reported as a time-out. touch() is called on every delta and every sign of work,
// pause() and resume() hold the clock while the turn waits for the person (an approval card). Call stop() when the turn is over.

export function watchTurn({ signal, idleMs, onExpire } = {}) {
  const own = new AbortController();
  let expired = false;
  let over = false;
  let paused = 0;
  let timer = null;
  const clear = () => {
    clearTimeout(timer);
    timer = null;
  };
  const arm = () => {
    clear();
    if (over || paused > 0 || expired || !(idleMs > 0)) return;
    timer = setTimeout(() => {
      timer = null;
      if (over || paused > 0 || expired || own.signal.aborted) return;
      expired = true;
      own.abort();
      try {
        onExpire?.();
      } catch {
        // A broken listener must not stop the abort.
      }
    }, idleMs);
    timer.unref?.();
  };
  const onParent = () => {
    clear();
    own.abort();
  };
  if (signal?.aborted) own.abort();
  else signal?.addEventListener('abort', onParent, { once: true });
  arm();
  return {
    signal: own.signal,
    get expired() {
      return expired;
    },
    touch() {
      if (!own.signal.aborted) arm();
    },
    pause() {
      if (over || own.signal.aborted) return;
      paused += 1;
      clear();
    },
    resume() {
      if (over || paused === 0) return;
      paused -= 1;
      if (paused === 0 && !own.signal.aborted) arm();
    },
    stop() {
      over = true;
      clear();
      signal?.removeEventListener('abort', onParent);
    },
  };
}

// An approval function that holds the watch's clock while it waits for the person. The wrapper keeps the original's close(), which the
// run uses to end a card. Returns the argument itself when it is not a function.
export function pauseWhile(watch, approve) {
  if (typeof approve !== 'function') return approve;
  const wrapped = async (...args) => {
    watch.pause();
    try {
      return await approve(...args);
    } finally {
      watch.resume();
    }
  };
  if (typeof approve.close === 'function') wrapped.close = (...args) => approve.close(...args);
  return wrapped;
}

// The sentence for a turn the clock stopped, with the idle limit said in the person's units.
export function idleLimitText(idleMs) {
  const seconds = Math.max(1, Math.round(idleMs / 1000));
  if (seconds < 60) return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
  const minutes = Math.round((idleMs / 60_000) * 10) / 10;
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}
