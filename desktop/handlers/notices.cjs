'use strict';
// The server's notices as desktop notifications (wave 4, 16 Nov 2026). A notice is something Plenum noticed by itself: a program was
// signed out and its sign-in window is open, a routine did not run, the hub stopped and was started again. Its producers publish it on the
// events channel as { type: 'notice', notice: { key, level, title, text, route, business, project, clear } }, and lib/notify.mjs stamps it
// before it goes out (seq, at, and repeat / quiet / silent). desktop/main.cjs hands it here through the event hook. The rules:
//  - repeat (the same words were shown in the last hours) and quiet (quiet hours, or the business is muted) are not shown now: the page's
//    list and the morning summary have them.
//  - A clear ends the condition: a 'needs-you' or 'problem' notification for its key goes away. An 'fyi' stays until the system puts it
//    away: an fyi is the good news that ends a condition ("Codex is signed in again", "Plenum Hub was started again"), and its producers
//    send the clear right after it (lib/signin-check.mjs noticeSignedIn) or a minute later (lib/hub-starter.mjs thenClear), so closing it
//    on the clear would take the news down the moment it appeared (wave 5 integration, 16 Nov 2026). The page reads a clear the same way:
//    it takes the key off its open list and leaves its toasts alone (public/ext-notify.js).
//  - Nothing is shown while the Plenum window is in front, whatever the level: the page shows the notice itself then (its own toast and
//    the bell), and a Windows notification on top of it would say the same thing twice (wave 5 integration). A notification of the same
//    key that is still up from before is taken down, as it is out of date. With the window not in front: 'fyi' always without sound,
//    'needs-you' and 'problem' without sound when the notice says silent.
//  - The one exception: a test notification (key 'test:<ts>', Settings > Notifications > Send a test notification) shows while the
//    window is in front, with sound. The button is pressed with the window in front, and the test is whether Windows shows Plenum's
//    notifications at all, so showing nothing would tell a person whose notifications are blocked nothing (w7 notify-5).
//  - One notification per key: a newer one for the same key replaces the older.
// The words are the notice's own title (or "Plenum") and text, which the producers write in Plenum's own words (never a model's text, a
// path or a key); they are cut to one line here. A click opens the place the notice names (route): Accounts, Today, Plan use,
// Background services, the chat or Night shift. An old-style notice (a line of text with no notice record) is the page's alone and shows nothing here.
const ROUTES = new Set(['accounts', 'today', 'plan-use', 'services', 'chat', 'night-shift']);
const LEVELS = new Set(['needs-you', 'problem', 'fyi']);
const MAX_KEPT = 20;

const oneLine = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const str = v => (typeof v === 'string' ? v : '');

// The notifications shown, by key: { note, level }, kept so one is not collected before a click on it can be handled, and so a clear
// knows whether it is a condition (needs-you, problem) or news (fyi).
const notes = new Map();

function close(key) {
  const kept = notes.get(key);
  notes.delete(key);
  try {
    kept?.note?.close?.();
  } catch {
    // Already gone.
  }
}

// A clear: the condition of the key ended. Its needs-you or problem notification goes away; an fyi (the news that it ended) stays.
function clearKey(key) {
  const kept = notes.get(key);
  if (kept && kept.level !== 'fyi') close(key);
}

// Where a click on the notification goes: { kind, id? } for shell.showWindow, or undefined for the window as it is.
function routeOf(n) {
  const route = str(n.route);
  if (!ROUTES.has(route)) return undefined;
  if (route === 'today' && str(n.business)) return { kind: 'today', id: n.business };
  if (route === 'chat' && str(n.project)) return { kind: 'chat', id: n.project };
  return { kind: route };
}

function onEvent(shell, ev) {
  if (!ev || ev.type !== 'notice') return;
  const n = ev.notice;
  if (!n || typeof n !== 'object') return;
  const key = oneLine(n.key, 120);
  if (!key) return;
  if (n.clear === true) {
    clearKey(key);
    return;
  }
  if (n.repeat === true || n.quiet === true) return;
  const level = LEVELS.has(n.level) ? n.level : 'fyi';
  const body = oneLine(n.text, 240);
  const title = oneLine(n.title, 60) || 'Plenum';
  if (!body) return;
  const win = shell.win();
  const focused = Boolean(win && typeof win.isFocused === 'function' && win.isFocused());
  const testing = key.startsWith('test:');
  if (focused && !testing) {
    // The page shows it (toast and bell). What this key showed before is out of date now.
    close(key);
    return;
  }
  if (!shell.Notification.isSupported()) return;
  const silent = !testing && (level === 'fyi' || n.silent === true);
  close(key);
  const route = routeOf(n);
  const note = new shell.Notification({ title, body, silent });
  note.on('click', () => shell.showWindow(route));
  note.show();
  notes.set(key, { note, level });
  // Only the newest few are kept; an older one has long been seen or put away by the system.
  while (notes.size > MAX_KEPT) notes.delete(notes.keys().next().value);
}

module.exports = {
  name: 'notices',
  routeOf,
  // For the tests: forgets the notifications shown.
  reset: () => notes.clear(),
  hooks: { event: onEvent },
};
