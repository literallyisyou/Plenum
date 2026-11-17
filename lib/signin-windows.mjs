// The sign-in windows that are open and not known to be finished, by program: { at, by: 'plenum' | 'person', stamp }. One list for
// the whole server, so a second run does not open a second window. The rules are in lib/signin-check.mjs (DECISIONS item 154), which
// reads and writes this list. It stands alone, with no import, so that a program's own status check (lib/claude-cli.mjs,
// lib/accounts.mjs, lib/cursor.mjs, lib/antigravity.mjs) can say "signed in" here without importing the gate that imports it.
//   at     when the window opened
//   by     'plenum' (a council opened it) or 'person' (Sign in in Accounts)
//   stamp  what the program's sign-in files looked like when the window opened: only for a program with no sign-in check of its
//          own, null until it is read
export const signInWindows = new Map();

// Who wants to know that a program was seen signed in (wave 4: the sign-in notices of lib/signin-check.mjs, and other packages).
// Each listener is called with the program id ('anthropic', 'codex', 'gemini', ...); one that throws is skipped.
const signedInListeners = new Set();

// Adds a listener; returns the function that removes it again.
export function onSignedIn(fn) {
  if (typeof fn !== 'function') return () => {};
  signedInListeners.add(fn);
  return () => {
    signedInListeners.delete(fn);
  };
}

// The program's own check just said "signed in" (or a turn of it just ran): a window that was open for it is finished. Without this
// a window that was finished after the council stopped waiting for it would count as open for hours, and the next sign-out would
// get no window. Every listener is told.
export function noteSignedIn(provider) {
  signInWindows.delete(provider);
  for (const fn of [...signedInListeners]) {
    try {
      const out = fn(provider);
      // A listener that returns a promise that fails is skipped too.
      if (out && typeof out.catch === 'function') out.catch(() => {});
    } catch {
      // A broken listener must not stop the check that called this.
    }
  }
}
