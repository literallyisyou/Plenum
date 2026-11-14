// Composer drafts: the text a person has typed and not sent is kept on this PC, per project and thread, and put back when that chat is
// shown again (after a reload, a new build or a restart). Loaded by ext.js; it adds itself through window.MuseUI and edits no other file.
//
// What is kept: only the text of the message box (#input). Never a picture or file, never a follow-up that is waiting in the queue
// (the queue stays in memory, as before), never text that starts with "/" (a command), and never text that holds the launch token or
// something shaped like a key. It lives in this browser's localStorage under one key, and it is never sent to the server, so no
// route and no log ever sees it.
// A draft belongs to a scope id (MuseUI.threads.scope(): the thread on screen, or the project id for its Main thread). The chat of one
// scope never shows the draft of another.
// Rules that keep a person's words safe:
//   - A draft is put back only into an EMPTY box, only when its chat is shown. Text typed since is never replaced.
//   - Text the box already holds when the thread changes stays in the box. It is saved under the thread it was typed in, and only an
//     untouched, saved draft in an unfocused box is swapped for the new thread's own draft (nothing is lost: it is saved).
//   - A saved draft is never overwritten by text this page did not read from it or write to it (another window, or a draft that was
//     never shown): the newer text stays in the box, and the saved one stays saved.
//   - Sending clears the box, and that clears the draft. A send the server refuses puts the text back into the box (app.js), and it is
//     saved again from there.
// Every storage access is in try/catch. With storage blocked the page keeps the drafts in memory for as long as it lives.
// Drafts older than 30 days, drafts of projects or threads that no longer exist, and the oldest drafts beyond about 1 MB are dropped.
(function () {
  const MU = window.MuseUI;
  if (!MU || !MU.threads || typeof MU.threads.scope !== 'function') return;
  const input = document.getElementById('input');
  if (!input) return;

  const KEY = 'plenum-drafts-v1';
  const DEBOUNCE_MS = 300;
  const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  const MAX_ONE = 400_000;   // characters of one draft; a bigger paste is not kept
  const MAX_ALL = 1_000_000; // characters of all drafts together
  // The launch token (64 hex digits) and the shapes of the keys the providers hand out. Text that holds one is never written down.
  const SECRET = /\b[a-f0-9]{64}\b|\b(?:sk|xai|gsk|pk|rk)-[A-Za-z0-9_-]{16,}|\bAIza[0-9A-Za-z_-]{30,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bBearer\s+[A-Za-z0-9._~+/=-]{20,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./;

  // ---------- storage ----------

  let memory = {};
  function readAll() {
    try {
      const raw = window.localStorage.getItem(KEY);
      if (!raw) return {};
      const data = JSON.parse(raw);
      const map = data && data.v === 1 && data.d && typeof data.d === 'object' ? data.d : {};
      const clean = {};
      for (const [scope, d] of Object.entries(map)) {
        if (d && typeof d.t === 'string' && d.t && Number.isFinite(d.at) && Date.now() - d.at <= MAX_AGE_MS) clean[scope] = { t: d.t, at: d.at };
      }
      return clean;
    } catch {
      return { ...memory };
    }
  }
  function writeAll(map) {
    memory = { ...map };
    try {
      if (Object.keys(map).length) window.localStorage.setItem(KEY, JSON.stringify({ v: 1, d: map }));
      else window.localStorage.removeItem(KEY);
    } catch {
      // Storage is blocked or full: the drafts stay in memory for this page.
    }
  }
  // Drops what is too old, then the oldest drafts (never `keep`) until the rest fits.
  function trim(map, keep) {
    const now = Date.now();
    for (const [scope, d] of Object.entries(map)) if (now - d.at > MAX_AGE_MS) delete map[scope];
    let total = Object.values(map).reduce((n, d) => n + d.t.length, 0);
    const oldest = Object.entries(map).filter(([scope]) => scope !== keep).sort((a, b) => a[1].at - b[1].at);
    while (total > MAX_ALL && oldest.length) {
      const [scope, d] = oldest.shift();
      total -= d.t.length;
      delete map[scope];
    }
    return map;
  }
  const savable = text => text.trim() !== '' && text.length <= MAX_ONE && !text.startsWith('/') && !SECRET.test(text);

  // What this page last read from or wrote to each scope's draft. A stored draft that differs from it was changed elsewhere.
  const known = new Map();

  // Saves the draft of a scope. Returns false when it did not (nothing to keep, or a different saved draft is in the way).
  function put(scope, text) {
    const map = readAll();
    const had = map[scope]?.t;
    if (!savable(text)) {
      // The text is empty or not kept: a draft this page owns goes, a different one stays.
      if (had !== undefined && (had === known.get(scope) || had === text)) {
        delete map[scope];
        writeAll(map);
      }
      known.delete(scope);
      return false;
    }
    if (had !== undefined && had !== text && had !== known.get(scope)) return false;
    map[scope] = { t: text, at: Date.now() };
    known.set(scope, text);
    writeAll(trim(map, scope));
    return true;
  }
  // Takes a draft away. With `onlyIf` it goes only when it still holds that text (or the text this page knows).
  function drop(scope, onlyIf) {
    const map = readAll();
    const had = map[scope]?.t;
    if (had === undefined) return;
    if (onlyIf !== undefined && had !== onlyIf && had !== known.get(scope)) return;
    delete map[scope];
    known.delete(scope);
    writeAll(map);
  }

  // ---------- the box ----------

  let shown = null;     // the scope on screen, as this file last saw it
  let owner = null;     // the scope whose draft the text in the box is (null when the box is empty or the text is not kept)
  let lastText = '';    // the last non-empty text the box held
  let pending = null;   // { scope, text, timer }: a save waiting for the debounce
  let quiet = false;    // true while this file sets the box itself
  let editedAt = 0;     // when the box last changed by a person's typing or by the page's code (a restore does not count)
  const TYPING_MS = 5000;

  function flush() {
    if (!pending) return;
    clearTimeout(pending.timer);
    const { scope, text } = pending;
    pending = null;
    try {
      put(scope, text);
    } catch {
      // A failed save must never reach the person's typing.
    }
  }
  function later(scope, text) {
    if (pending) clearTimeout(pending.timer);
    pending = { scope, text, timer: setTimeout(flush, DEBOUNCE_MS) };
  }

  // The note above the box that says a draft was put back, with the way to throw it away.
  let noteHandle = null;
  function clearNote() {
    noteHandle?.remove();
    noteHandle = null;
  }
  function showNote(scope, text) {
    clearNote();
    if (!MU.slots || typeof MU.slots.add !== 'function') return;
    const node = document.createElement('div');
    node.className = 'ext-draft-note';
    node.setAttribute('role', 'status');
    const words = document.createElement('span');
    words.className = 'edn-text';
    words.textContent = 'Your unsent message from this chat is back in the box.';
    const discard = document.createElement('button');
    discard.type = 'button';
    discard.className = 'ghost small edn-discard';
    discard.textContent = 'Discard';
    discard.addEventListener('click', () => {
      flush();
      // Only the restored text goes. If it was edited, the edit is the person's and stays.
      if (input.value === text) setBox('');
      drop(scope);
      owner = null;
      clearNote();
      input.focus();
    });
    node.append(words, discard);
    noteHandle = MU.slots.add('bannerSlot', 'drafts', node, 20);
  }

  const setNative = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  // Sets the box without this file treating it as typing, and lets the page resize it.
  function setBox(text) {
    quiet = true;
    try {
      setNative.set.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } finally {
      quiet = false;
    }
  }

  // Puts the draft of `scope` into the box, only when the box is empty.
  function restore(scope) {
    if (input.value !== '') return;
    const d = readAll()[scope];
    if (!d || !savable(d.t)) return;
    setBox(d.t);
    owner = scope;
    lastText = d.t;
    known.set(scope, d.t);
    showNote(scope, d.t);
  }

  // Drops the drafts of projects and threads that no longer exist. Only once the page knows its projects, and only for the project on
  // screen is its thread list consulted (the others' threads are not known to the page).
  function prune() {
    const st = MU.state;
    if (!st || !Array.isArray(st.projects) || !st.projects.length || !st.activeProject) return;
    const ids = st.projects.map(p => p.id).filter(id => typeof id === 'string');
    const threads = new Set([...(st.threads ?? []), ...(st.closedThreads ?? [])].map(t => t?.id));
    const map = readAll();
    let changed = false;
    for (const scope of Object.keys(map)) {
      const project = ids.find(id => scope === id || scope.startsWith(`${id}-t`));
      const gone = !project || (project === st.activeProject && scope !== project && threads.size > 0 && !threads.has(scope));
      if (gone) {
        delete map[scope];
        changed = true;
      }
    }
    if (changed) writeAll(map);
  }

  // Notices a change of thread (or the first thread the page shows) and acts on it. Called before anything else reads `shown`.
  function sync(viaEdit = false) {
    const now = MU.threads.scope() || null;
    if (!now || now === shown) return;
    const before = shown;
    shown = now;
    clearNote();
    if (before === null) {
      // The first chat the page shows. Text typed before this point is not replaced.
      if (input.value === '') {
        if (!viaEdit) restore(now);
      } else if (input.value.trim()) {
        owner = now;
        lastText = input.value;
        later(now, input.value);
      }
      prune();
      return;
    }
    flush();
    prune();
    // The box is being changed by the person or the page right now: that is not a view of the new thread, so nothing is swapped.
    if (viaEdit) return;
    const text = input.value;
    if (text === '') {
      owner = null;
      restore(now);
      return;
    }
    // The box holds text. It stays, unless it is exactly a saved draft that nobody is typing in: that goes back to its own thread.
    const saved = readAll()[owner ?? before]?.t;
    if (document.activeElement !== input && Date.now() - editedAt > TYPING_MS && owner === before && saved === text) {
      setBox('');
      owner = null;
      restore(now);
    }
  }

  // The box changed: the person typed, or the page set it.
  function changed(text) {
    sync(true);
    if (!shown) return;
    editedAt = Date.now();
    if (text.trim() === '') {
      // Emptied by a send, by a command or by deleting. The draft that was the box goes with it.
      if (pending) {
        clearTimeout(pending.timer);
        pending = null;
      }
      clearNote();
      if (owner) drop(owner, lastText);
      if (shown !== owner && readAll()[shown]?.t === lastText) drop(shown);
      owner = null;
      lastText = '';
      return;
    }
    clearNote();
    const previous = lastText;
    lastText = text;
    if (owner && owner !== shown) {
      // Text carried over from another thread. If this thread has a different draft of its own, the text stays that other thread's.
      const mine = readAll()[shown]?.t;
      if (mine === undefined || mine === text) {
        drop(owner, previous);
        owner = shown;
      }
    } else if (!owner) {
      owner = shown;
    }
    later(owner, text);
  }

  input.addEventListener('input', () => {
    if (quiet) return;
    try {
      changed(input.value);
    } catch {
      // Keeping a draft is an extra; it never gets in the way of typing.
    }
  });
  // The page sets the box in code (clearing it on send, putting a refused question back, an edit of a queued message, a suggestion).
  // That sets no input event, so the setter is wrapped on this one element.
  Object.defineProperty(input, 'value', {
    configurable: true,
    get() { return setNative.get.call(this); },
    set(v) {
      setNative.set.call(this, v);
      if (quiet) return;
      try {
        changed(setNative.get.call(this));
      } catch {
        // see above
      }
    },
  });

  // A message sent to a thread that is not on screen (a queued follow-up, the split view) took that thread's own text with it only
  // when the draft is that very text.
  window.addEventListener('plenum:thread-sent', e => {
    try {
      const d = e.detail;
      if (!d || typeof d.scope !== 'string' || typeof d.text !== 'string') return;
      const had = readAll()[d.scope]?.t;
      if (had !== undefined && had.trim() === d.text.trim()) drop(d.scope);
    } catch {
      // see above
    }
  });

  // The thread changes, the shell redraws: look at the scope each time.
  MU.threads.onRender?.(() => {
    try {
      sync();
    } catch {
      // see above
    }
  });
  // A draft waiting for the debounce is written when the page goes away.
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

  try {
    sync();
  } catch {
    // The page is not ready to say which chat it shows; the first redraw says it.
  }
})();
