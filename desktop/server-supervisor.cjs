'use strict';
// The policy for a server that ends while the app is open (DECISIONS item 91). It holds no Electron and starts nothing: desktop/main.cjs
// tells it each exit and it answers with what to do, so the rules can be tested with a clock of the test's own.
//  - A server that ends after it had answered is started again, at most 3 times in 5 minutes, after 0.5, 2 and 5 seconds.
//  - Nothing is restarted during a quit, for the restart code 75 (the app restarts for an update by itself), or before the server had
//    ever answered (that is a failed start, and the person decides what happens next).
//  - When the restarts are used up the answer is to give up, and main.cjs offers Try again, Open log and Quit. Try again calls reset().
// The file also holds the one test of the hidden smoke mode, so that its three conditions are written down in one place.

const RESTART_EXIT_CODE = 75;
const LIMIT = 3;
const WINDOW_MS = 5 * 60 * 1000;
const DELAYS_MS = [500, 2000, 5000];

function createSupervisor({ clock = Date.now, limit = LIMIT, windowMs = WINDOW_MS, delays = DELAYS_MS, restartCode = RESTART_EXIT_CODE } = {}) {
  // The times of the restarts that were allowed, oldest first. Only those inside the window count.
  let restarts = [];
  const recent = now => {
    restarts = restarts.filter(at => now - at < windowMs);
    return restarts.length;
  };
  return {
    // One exit: { code, quitting, answered }. answered is whether the server had answered at least once in this app's life.
    // Returns { restart: true, afterMs, attempt } or { restart: false, reason }, where reason is 'quit', 'restart-code', 'not-answered'
    // or 'used-up'. A restart that is allowed is counted at once.
    onExit({ code, quitting = false, answered = false } = {}) {
      if (quitting) return { restart: false, reason: 'quit' };
      if (code === restartCode) return { restart: false, reason: 'restart-code' };
      if (!answered) return { restart: false, reason: 'not-answered' };
      const now = clock();
      const used = recent(now);
      if (used >= limit) return { restart: false, reason: 'used-up' };
      restarts.push(now);
      return { restart: true, afterMs: delays[Math.min(used, delays.length - 1)], attempt: used + 1 };
    },
    // How many restarts are counted now.
    used: () => recent(clock()),
    // Forgets the restarts: the person chose Try again.
    reset() {
      restarts = [];
    },
    limit,
  };
}

// The hidden smoke mode: the whole shell can be started with nothing on screen, for a test. It needs all three of PLENUM_SMOKE=1, a PORT
// that is a real port other than 4317 (the owner's Plenum), and a MUSE_CONSOLE_HOME. Returns { port } or null. Anything less is the
// normal app.
function smokeMode(env) {
  if (!env || env.PLENUM_SMOKE !== '1') return null;
  if (!/^\d{4,5}$/.test(String(env.PORT ?? ''))) return null;
  const port = Number(env.PORT);
  if (port === 4317 || port < 1024 || port > 65535) return null;
  if (typeof env.MUSE_CONSOLE_HOME !== 'string' || !env.MUSE_CONSOLE_HOME.trim()) return null;
  return { port, crashServer: env.PLENUM_SMOKE_CRASH_SERVER === '1' };
}

module.exports = { createSupervisor, smokeMode, RESTART_EXIT_CODE, LIMIT, WINDOW_MS, DELAYS_MS };
