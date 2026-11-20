// Model-initiated shared-desktop tools on Windows respect the owner’s Night shift window.
import { AWAY_S } from '../pacer.mjs';

const WAIT = 'Unattended computer use waits for Night shift hours and at least ten minutes without input on the unlocked PC.';
const YIELD = 'Unattended computer use yielded to activity on the PC. It can start again on a later eligible run.';

export function createUnattendedDesktop({ bridge, windowEnd, presence, now = Date.now, signal }) {
  let started = false;
  let yielded = false;
  let ownInput = false;
  let observedIdle = null;
  let stop;

  const inWindow = () => {
    const end = windowEnd();
    return !signal?.aborted && Number.isFinite(end) && end > now();
  };
  const sample = async () => {
    try {
      const result = await presence();
      if (result?.ok !== true || !['active', 'idle'].includes(result.state) || !Number.isFinite(result.idleSec) || result.idleSec < 0) return null;
      return { seconds: result.idleSec, at: now() };
    } catch {
      return null;
    }
  };
  const reset = (current, previous) => previous !== null &&
    current.seconds + 1 < previous.seconds + (current.at - previous.at) / 1000;
  const input = async () => {
    const result = await bridge.userInput();
    if (result?.available === false || typeof result?.mouse !== 'boolean' || typeof result?.keys !== 'boolean') throw new Error(WAIT);
    if (result.mouse || result.keys) {
      yielded = true;
      stop?.(YIELD);
    }
    return result;
  };
  const check = async ({ browser = false } = {}) => {
    if (yielded && !browser) return YIELD;
    if (!inWindow()) return WAIT;
    const current = await sample();
    if (!current || !inWindow()) return WAIT;
    if (browser || !ownInput) {
      if (current.seconds < AWAY_S) return WAIT;
    } else if (reset(current, observedIdle)) {
      yielded = true;
      return YIELD;
    }
    if (!browser) observedIdle = current;
    return null;
  };
  const begin = async () => {
    const held = await check();
    if (held) return held;
    try { await input(); } catch { return WAIT; }
    if (yielded) return YIELD;
    started = true;
    return null;
  };
  const shared = { ...bridge, userInput: input };
  const refused = message => {
    if (started) stop?.(message);
    return { ok: false, reason: 'unattended', message };
  };
  for (const method of ['input', 'focus', 'capture', 'zoom', 'overlay']) {
    shared[method] = async (...args) => {
      if (method === 'overlay' && args[0]?.show !== true) return bridge.overlay(...args);
      const blocked = started ? await check() : WAIT;
      if (blocked) return refused(blocked);
      try { await input(); } catch { return refused(WAIT); }
      if (yielded || !inWindow()) return refused(yielded ? YIELD : WAIT);
      const result = await bridge[method](...args);
      if (method === 'input' || method === 'focus') {
        // Windows counts injections as input. Establish a new baseline immediately after an injection, and still check the native
        // keyboard/pointer detector before the next call and for any later OS-idle reset between actions.
        ownInput = true;
        observedIdle = await sample();
        if (!observedIdle) return refused(WAIT);
      }
      return result;
    };
  }
  return { begin, bridge: shared, browserCheck: () => check({ browser: true }), onBlocked: callback => { stop = callback; } };
}
