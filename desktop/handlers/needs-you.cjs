'use strict';
// "<Business>: 2 things need you" (14 Nov 2026). The server's state carries the last notice that a business left new items on the
// owner's list (needsYou: { seq, business, name, count, at } or null; lib/needs-you.mjs, set by lib/setup.mjs after a setup step). A new
// one becomes a desktop notification when the window is not focused. The notification names the business and a count only: never a
// title, a prompt, a reply or a path. A click shows the window. It follows the setting of the approval alerts (the same kind of alert:
// something waits for the person), and the first state after a start only sets what "new" means.
let lastSeq = null;
// Kept in a variable so the notification is not collected before a click on it can be handled.
let note = null;

const oneLine = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

// The text of the notification for a notice, or '' when it is not one.
function textOf(n) {
  if (!n || typeof n !== 'object' || !Number.isInteger(n.count) || n.count < 1) return '';
  const name = oneLine(n.name, 60) || 'A business';
  return `${name}: ${n.count === 1 ? '1 thing needs you' : `${Math.min(n.count, 999)} things need you`}`;
}

function onState(shell, st) {
  const n = st && typeof st === 'object' ? st.needsYou : null;
  const seq = n && Number.isInteger(n.seq) ? n.seq : 0;
  if (lastSeq === null) {
    lastSeq = seq;
    return;
  }
  if (seq === lastSeq) return;
  const isNew = seq > lastSeq;
  lastSeq = seq;
  if (!isNew) return;
  const body = textOf(n);
  if (!body) return;
  const { approvalAlerts } = shell.settings();
  const win = shell.win();
  if (approvalAlerts === false || (win && win.isFocused())) return;
  if (!shell.Notification.isSupported()) return;
  note = new shell.Notification({ title: 'Plenum', body });
  note.on('click', () => shell.showWindow());
  note.show();
}

module.exports = {
  name: 'needs-you',
  textOf,
  // For the tests: forgets what was seen.
  reset: () => { lastSeq = null; note = null; },
  hooks: { state: onState },
};
