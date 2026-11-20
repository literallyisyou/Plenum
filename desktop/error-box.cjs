'use strict';
// The one helper behind the shell's question boxes (Try again / Open log / Quit, Reload / Quit, Wait / Reload / Quit). Each gets a
// "Copy details" button just before the last one (the last button is always Quit). Copy details puts the box's words, the build, the
// time and the last lines of the log on the clipboard, then asks the same question again, so a person can paste it into a message
// without hunting for the log. No Electron import: dialogs, the clipboard, the log's tail and the clock are passed in, so a test shows
// no box. A box that cannot be shown falls back to the plain error box and counts as the last button.

const COPY_LABEL = 'Copy details';

// The text Copy details puts on the clipboard. redact hides the user's name in paths.
function detailsText({ title, message, detail, build, now, tail = [], redact = t => t }) {
  const lines = [`${title}: ${message}`];
  if (detail) lines.push('', String(detail));
  lines.push('', `${build || 'Plenum'}`, `Time: ${now}`);
  if (tail.length) lines.push('', 'Last lines of the log:', ...tail);
  return redact(lines.join('\n'));
}

// log(line) writes to the app's log. describe() gives the build line. Returns choose(options), which resolves with the index of the
// button chosen among options.buttons (Copy details is not one of them).
// options.signal (an AbortSignal, optional; shell-9): the app closes the box when what it asks about has settled by itself (a server that
// answered after all). It goes to showMessageBox, which then closes the box as if it was cancelled (Electron's options.signal), and
// choose resolves with cancelId. A signal that has already aborted shows no box. The caller reads signal.aborted to tell it from a choice.
function createChooser({ dialogs, clipboard, log = () => {}, describe = () => '', tail = () => [], redact, clock = Date.now }) {
  return async function choose({ title = 'Plenum', message, detail, buttons, defaultId = 0, cancelId = buttons.length - 1, type = 'warning', copy = true, signal = null }) {
    log(`dialog: ${message} [${buttons.join(' / ')}] ${String(detail ?? '').split(/\r?\n/)[0].slice(0, 300)}`.trimEnd());
    const canCopy = copy && typeof clipboard?.writeText === 'function';
    // The shown buttons: Copy details before the last one. A shown index at or after copyAt is one more than the caller's.
    const copyAt = buttons.length - 1;
    const shown = canCopy ? [...buttons.slice(0, copyAt), COPY_LABEL, buttons[copyAt]] : buttons;
    const toShown = i => (canCopy && i >= copyAt ? i + 1 : i);
    const closedByApp = () => {
      if (signal?.aborted !== true) return false;
      log('dialog: closed by the app, it is no longer needed');
      return true;
    };
    for (;;) {
      if (closedByApp()) return cancelId;
      let n;
      try {
        const dlg = typeof dialogs() === 'object' ? dialogs() : null;
        if (!dlg || typeof dlg.showMessageBox !== 'function') throw new Error('no message box');
        const options = { type, title, message, detail, buttons: shown, defaultId: toShown(defaultId), cancelId: toShown(cancelId), noLink: true };
        if (signal) options.signal = signal;
        const result = await dlg.showMessageBox(options);
        if (closedByApp()) return cancelId;
        n = Number(result?.response);
      } catch {
        if (closedByApp()) return cancelId;
        try {
          dialogs().showErrorBox(title, `${message}\n\n${detail ?? ''}`);
        } catch {
          // Nothing can be shown; the log has the message.
        }
        return cancelId;
      }
      if (!Number.isInteger(n) || n < 0 || n >= shown.length) return cancelId;
      if (canCopy && n === copyAt) {
        try {
          clipboard.writeText(detailsText({ title, message, detail, build: describe(), now: new Date(clock()).toISOString(), tail: tail(), redact }));
          log('dialog: the details were copied');
        } catch {
          log('dialog: the details could not be copied');
        }
        continue;
      }
      return canCopy && n > copyAt ? n - 1 : n;
    }
  };
}

module.exports = { createChooser, detailsText, COPY_LABEL };
