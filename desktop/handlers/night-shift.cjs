'use strict';
// Night shift keeps the PC awake while jobs wait (wave 6, 16 Nov 2026; the contract is the Night shift brief). The server asks once a
// minute over the shell channel: { type: 'night-shift-awake', on, until } and gets { ok, awake, idleSec } back.
//  - on: true  holds one 'prevent-app-suspension' blocker (its own id, apart from the alerts' blocker in alerts.cjs) if none is held, and
//    renews a 3-minute lease. The hold ends at `until` (the end of the hours; a number of ms, or a date text), and never more than
//    12 hours from now. A server that crashes leaves the PC awake for at most the lease.
//  - The blocker is released when: on is false, the lease runs out, `until` is reached, the server exits, or the app quits.
//  - While it is held the tray shows "Night shift is keeping this PC awake" (a click shows the window); otherwise the item is removed.
//  - idleSec is how long the person has been away from this PC, from the system's idle time; null when the desktop cannot tell. The
//    server needs it to know whether the owner is at the PC.
// Nothing here logs, stores or sends the owner's text; a message carries no key.
const LEASE_MS = 3 * 60 * 1000;
const MAX_HOLD_MS = 12 * 60 * 60 * 1000;
const TRAY_LABEL = 'Night shift is keeping this PC awake';

// `until` as a time in ms, or null when it is not a usable time.
function untilMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

// A handler with its own state: the blocker id, the lease timer and the end time. Tests make one each; the module exports one.
function createHandler() {
  let blockerId = null;
  let timer = null;
  let endsAt = 0;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  function setTray(shell, on) {
    try {
      shell.tray?.setItem?.('night-shift', on ? { label: TRAY_LABEL, click: () => shell.showWindow() } : null);
    } catch {
      // The tray is a courtesy; the hold does not depend on it.
    }
  }

  function release(shell) {
    clearTimer();
    endsAt = 0;
    if (blockerId === null) return;
    const id = blockerId;
    blockerId = null;
    try {
      shell.powerSaveBlocker.stop(id);
    } catch {
      // Already stopped.
    }
    setTray(shell, false);
  }

  // Sets the timer for the nearer of the lease end and the end time; when it fires the hold is let go.
  function arm(shell, leaseEnd) {
    clearTimer();
    const wait = Math.max(0, Math.min(leaseEnd, endsAt) - Date.now());
    timer = setTimeout(() => release(shell), wait);
    timer.unref?.();
  }

  function hold(shell, until) {
    const now = Date.now();
    const asked = untilMs(until);
    const end = Math.min(asked === null ? now + MAX_HOLD_MS : asked, now + MAX_HOLD_MS);
    if (end <= now) {
      release(shell);
      return;
    }
    if (blockerId === null) {
      blockerId = shell.powerSaveBlocker.start('prevent-app-suspension');
      setTray(shell, true);
    }
    endsAt = end;
    arm(shell, now + LEASE_MS);
  }

  function idleSecOf(shell) {
    try {
      const n = shell.powerMonitor?.getSystemIdleTime?.();
      return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
    } catch {
      return null;
    }
  }

  async function awakeMessage(message, shell) {
    if (message && message.on === true) hold(shell, message.until);
    else release(shell);
    return { ok: true, awake: blockerId !== null, idleSec: idleSecOf(shell) };
  }

  function presenceMessage(_message, shell) {
    let state = 'unknown';
    try {
      state = shell.powerMonitor?.getSystemIdleState?.(1) ?? 'unknown';
    } catch {
      // An unavailable reading cannot authorize unattended work.
    }
    return { ok: true, idleSec: idleSecOf(shell), state };
  }

  return {
    name: 'night-shift',
    // Whether the blocker is held now (for the tests).
    held: () => blockerId !== null,
    messages: { 'night-shift-awake': awakeMessage, 'night-shift-presence': presenceMessage },
    hooks: {
      serverExited: shell => release(shell),
      beforeQuit: shell => release(shell),
    },
  };
}

module.exports = { ...createHandler(), createHandler, LEASE_MS, MAX_HOLD_MS, TRAY_LABEL };
