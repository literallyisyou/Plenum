'use strict';
// "A plan will run short" (14 Nov 2026, DECISIONS item 153). The server's plan watch (lib/plan-watch.mjs) raises one alert when a window
// of a subscription's plan use will be used up before it resets, and one when it is used up. The server's state carries the newest alert
// made since the server started (planAlert: { seq, id, level, title, text, at } or null, the way needsYou is carried). A new one becomes a
// desktop notification when the Plenum window is not in front; when it is in front the page's alerts strip already shows it. The words are
// the server's own (alert.text, made once for the page, the notification and the phone): they name the businesses and what happens to
// each, and never carry a prompt, a reply or a path. A click shows the window. It is never a dialog and never stops a run.
// The owner's switch is the plan watch's own (Alerts in the Plan use pop-up): with it off the server makes no alert, so none arrives here.
// New means a different alert id that was raised later than the one last seen, not a larger seq: seq counts from 1 again after the server
// restarts, and the first state after this shell starts only sets what "new" means.
const LEVELS = new Set(['short', 'out']);
let lastId = null;
let lastAt = 0;
let started = false;
// Kept in a variable so the notification is not collected before a click on it can be handled.
let note = null;

const oneLine = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

// The text of the notification for an alert: its own sentence, else its title, as one clean line. '' when it is not an alert.
function textOf(a) {
  if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !a.id || !LEVELS.has(a.level)) return '';
  return oneLine(a.text, 300) || oneLine(a.title, 300);
}

function onState(shell, st) {
  const a = st && typeof st === 'object' ? st.planAlert : null;
  const valid = Boolean(textOf(a));
  const id = valid ? a.id : null;
  const at = valid && Number.isFinite(a.at) ? a.at : 0;
  if (!started) {
    started = true;
    lastId = id;
    lastAt = at;
    return;
  }
  if (!valid || id === lastId || at < lastAt) return;
  lastId = id;
  lastAt = at;
  const win = shell.win();
  if (win && win.isFocused()) return;
  if (!shell.Notification.isSupported()) return;
  note = new shell.Notification({ title: oneLine(a.title, 100) || 'Plenum plan use', body: textOf(a) });
  note.on('click', () => shell.showWindow());
  note.show();
}

module.exports = {
  name: 'plan-watch',
  textOf,
  // For the tests: forgets what was seen.
  reset: () => { lastId = null; lastAt = 0; started = false; note = null; },
  hooks: { state: onState },
};
