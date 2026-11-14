// ext-a11y.js: how the page behaves for a keyboard and a screen reader. index.html loads it first, before app.js; ext.js lists it too,
// so the guard below lets only the first copy run. It reads the page and its events and changes no app.js code.
//
//   1. The drawer (#drawer, role=dialog, aria-modal). It is watched, not named after any panel: whatever a panel draws into it works.
//      When it opens, the focus moves into it (to the drawer itself, so its title and role are read; the next Tab is the close button).
//      While it is open Tab and Shift+Tab go round the drawer's controls and then the Stop controls that stay above the dim layer (the
//      drive bar and pill, and any other button named Stop), so Stop stays reachable by keyboard exactly as it was. A dialog on top of the
//      drawer (a native <dialog>, or another aria-modal dialog) keeps its own focus handling. If the content is redrawn and the focused
//      control goes with it, the focus returns to the same control in the new content. When the drawer closes, the focus goes back to the
//      control that opened it, unless the app already moved it somewhere on purpose. Escape is the app's own and is not touched.
//   2. Announcements. #chat is a log that is not live (the transcript is redrawn many times a second while a reply streams, and a live
//      region would read it again and again). The short events are said once each from two regions at the end of the page: #a11yStatus
//      (polite: a reply finished, a run stopped, an approval waits) and #a11yAlert (assertive: a failure). They come from the run events
//      on window 'plenum:event' (only the end of a run, an error and an approval card, never a delta) and from the toasts, whose own box
//      is switched off once its toasts are spoken from these two. Other code can say a sentence with MuseA11y.announce(text, { urgent }).
//   3. A slow start. If the first answer of GET /api/state has not come within 3 seconds, plain words under the title bar say Plenum is
//      still starting; after 30 seconds they say what to do. They go when the answer comes. It is read from the browser's own record of
//      finished requests, so no request is added and nothing in app.js is touched.
(function () {
  if (window.MuseA11y) return;

  const $ = id => document.getElementById(id);
  const STALL_MS = 3000;
  const LONG_MS = 30000;
  const SAME_WORDS_MS = 1500;
  const GAP_MS = 350;

  // ---------- 2. the two live regions ----------
  function region(id, role, live) {
    let node = $(id);
    if (!node) {
      node = document.createElement('div');
      node.id = id;
      node.className = 'a11y-live';
      node.setAttribute('role', role);
      node.setAttribute('aria-live', live);
      node.setAttribute('aria-atomic', 'true');
      document.body.append(node);
    }
    return node;
  }

  const lanes = {
    status: { node: null, queue: [], busy: false },
    alert: { node: null, queue: [], busy: false },
  };
  const log = []; // what was said, newest last, at most 100 (the tests read it)
  const lastSaid = new Map(); // words -> time, so the same words twice within a moment are said once

  function pump(name) {
    const lane = lanes[name];
    if (lane.busy) return;
    const next = lane.queue.shift();
    if (next === undefined) return;
    lane.busy = true;
    lane.node.textContent = '';
    // Emptied first and filled a moment later: the same words said twice in a row are still read the second time.
    setTimeout(() => {
      lane.node.textContent = next;
      log.push({ region: name, text: next, at: Date.now() });
      if (log.length > 100) log.shift();
      setTimeout(() => {
        lane.busy = false;
        pump(name);
      }, GAP_MS);
    }, 60);
  }

  // `event` is true for a sentence that already stands for one event (a run event is checked by its own key): it is not held back for
  // having the same words as an earlier one. A toast or a caller's sentence is held back when the same words were said a moment ago.
  function announce(text, { urgent = false, event = false } = {}) {
    const words = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!words) return false;
    const now = Date.now();
    const before = lastSaid.get(words);
    if (!event && before !== undefined && now - before < SAME_WORDS_MS) return false;
    lastSaid.set(words, now);
    if (lastSaid.size > 60) for (const [key, at] of lastSaid) if (now - at > SAME_WORDS_MS) lastSaid.delete(key);
    const name = urgent ? 'alert' : 'status';
    lanes[name].queue.push(words);
    pump(name);
    return true;
  }

  // ---------- 2a. run events ----------
  const WHAT = {
    chat: 'The reply', review: 'The review', relay: 'The relay', council: 'The council', compare: 'The comparison',
    pipeline: 'The pipeline', build: 'The build', compact: 'The summary of the chat', restore: 'The restore',
  };
  const said = new Set(); // one key per event already said: run id, what happened, and the card's id for an approval
  const failed = new Set(); // runs that already said they failed, so their closing event does not say they finished

  function once(key) {
    if (said.has(key)) return false;
    said.add(key);
    if (said.size > 400) said.delete(said.values().next().value);
    return true;
  }

  function onRunEvent(ev) {
    const inner = ev.event;
    if (!inner || typeof inner !== 'object' || typeof ev.runId !== 'string') return;
    const what = WHAT[ev.kind] ?? 'The run';
    const id = ev.runId;
    switch (inner.type) {
      case 'approval':
        // The card of a request that waits for an answer. A run's other events are not looked at.
        if (once(`${id}|approval|${inner.approvalId ?? ''}`)) announce(`Approval needed. ${what === 'The run' ? 'A run' : what} is waiting for your answer.`, { event: true });
        break;
      case 'error':
        failed.add(id);
        if (failed.size > 400) failed.delete(failed.values().next().value);
        if (once(`${id}|error`)) announce(`${what} failed. Open its chat to see why.`, { urgent: true, event: true });
        break;
      case 'done':
        // A comparison sends one done per column (it has a seat); only the end of a whole run is said.
        if (inner.seat !== undefined) break;
        if (failed.has(id)) break;
        if (!once(`${id}|done`)) break;
        if (inner.timedOut) announce(`${what} ran out of time and stopped.`, { event: true });
        else if (inner.aborted) announce(`${what} was stopped.`, { event: true });
        else announce(`${what} finished.`, { event: true });
        break;
      default:
    }
  }

  window.addEventListener('plenum:event', e => {
    const ev = e.detail;
    if (ev && ev.type === 'run') onRunEvent(ev);
  });

  // ---------- 2b. toasts ----------
  function watchToasts() {
    const box = $('toasts');
    if (!box || typeof MutationObserver === 'undefined') return;
    new MutationObserver(records => {
      for (const rec of records) {
        for (const node of rec.addedNodes) {
          if (!(node instanceof Element) || !node.classList.contains('toast')) continue;
          announce(node.textContent, { urgent: node.classList.contains('bad') });
        }
      }
    }).observe(box, { childList: true });
    // From here a toast is said by the two regions. Off, so that it is not said twice.
    box.setAttribute('aria-live', 'off');
  }

  // ---------- 1. the drawer ----------
  const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable="true"]';

  function usable(node) {
    if (node.disabled || node.hidden || node.inert) return false;
    const index = node.getAttribute('tabindex');
    if (index !== null && Number(index) < 0) return false;
    if (node.tagName === 'INPUT' && node.type === 'hidden') return false;
    if (node.closest('[hidden], [inert]')) return false;
    if (node.getClientRects().length === 0) return false;
    if (getComputedStyle(node).visibility === 'hidden') return false;
    // A radio group is one stop: the chosen one (or the first, when none is chosen).
    if (node.tagName === 'INPUT' && node.type === 'radio' && node.name) {
      const group = [...(node.form ?? node.getRootNode()).querySelectorAll('input[type="radio"]')].filter(r => r.name === node.name && !r.disabled);
      const chosen = group.find(r => r.checked);
      if (chosen ? chosen !== node : group[0] !== node) return false;
    }
    return true;
  }

  const tabbable = root => [...root.querySelectorAll(FOCUSABLE)].filter(usable);

  const drawer = $('drawer');
  if (drawer) watchDrawer(drawer);

  function watchDrawer(box) {
    const opened = () => !box.hidden;
    let wasOpen = opened();
    let opener = null; // the control that had the focus when the drawer opened
    let openerId = '';
    let lastOutside = null; // the control focused last outside the drawer, for a drawer opened from code that moved the focus first
    let inside = null; // the control focused last inside it
    let insideShape = null; // what it looked like, to find it again in redrawn content

    const plain = node => !node || node === document.body || node === document.documentElement;
    const shapeOf = node => ({
      id: node.id || '',
      tag: node.tagName,
      label: (node.getAttribute('aria-label') || node.getAttribute('name') || node.textContent || '').trim().slice(0, 60),
      index: tabbable(box).indexOf(node),
    });

    document.addEventListener('focusin', e => {
      const node = e.target;
      if (!(node instanceof Element)) return;
      if (box.contains(node)) {
        if (node !== box && opened()) {
          inside = node;
          insideShape = shapeOf(node);
        }
      } else if (!opened()) {
        lastOutside = node;
      }
    }, true);

    // The dialogs that sit above the drawer and look after their own focus.
    const dialogAbove = () => Boolean(document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]:not(#drawer)'));

    // The Stop controls (and the drive bar's others) are above the dim layer and stay in the cycle.
    function stopControls() {
      const out = [];
      for (const b of document.querySelectorAll('button')) {
        if (box.contains(b) || b.closest('.settings-page') || !usable(b)) continue;
        const name = (b.getAttribute('aria-label') || b.textContent || '').trim();
        if (/^stop\b/i.test(name) || b.closest('.drivebar, .drive-pill')) out.push(b);
        if (out.length >= 12) break;
      }
      return out;
    }

    function open() {
      const at = document.activeElement;
      opener = !plain(at) && !box.contains(at) ? at : lastOutside;
      openerId = opener?.id ?? '';
      inside = null;
      insideShape = null;
      // A panel that already put the focus on one of its own controls keeps it. Otherwise the drawer takes it.
      if (!box.contains(document.activeElement)) box.focus({ preventScroll: true });
    }

    function close() {
      const at = document.activeElement;
      // The app moved the focus somewhere on purpose (it opened another page, say): leave it there.
      if (!plain(at) && !box.contains(at)) return;
      const candidates = [opener, openerId ? $(openerId) : null, $('input'), $('helpBtn')];
      const target = candidates.find(n => n && n.isConnected && n instanceof HTMLElement && !box.contains(n) && usable(n));
      target?.focus({ preventScroll: true });
      opener = null;
      inside = null;
      insideShape = null;
    }

    // The controls were redrawn and the one that had the focus went with them: the same control in the new content gets it back.
    function keep() {
      if (!opened() || dialogAbove()) return;
      const at = document.activeElement;
      if (box.contains(at) || !plain(at)) return;
      const now = tabbable(box);
      const s = insideShape;
      const same = s && (
        (s.id && now.find(n => n.id === s.id))
        || now.find(n => n.tagName === s.tag && s.label && (n.getAttribute('aria-label') || n.getAttribute('name') || n.textContent || '').trim().slice(0, 60) === s.label)
        || (s.index >= 0 ? now[Math.min(s.index, now.length - 1)] : null)
      );
      (same ?? box).focus({ preventScroll: true });
    }

    new MutationObserver(() => {
      const now = opened();
      if (now === wasOpen) return;
      wasOpen = now;
      if (now) open();
      else close();
    }).observe(box, { attributes: true, attributeFilter: ['hidden'] });

    // The same note, taken a few times a second while the drawer is open, for a window whose focus events do not come (a window that
    // is not in front). It costs nothing while the drawer is shut.
    setInterval(() => {
      const node = document.activeElement;
      if (opened() && node && node !== box && box.contains(node)) {
        inside = node;
        insideShape = shapeOf(node);
      }
    }, 250);

    // One check per frame at most, whatever the content does.
    let frame = 0;
    const later = () => {
      if (frame || !opened()) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        keep();
      });
    };
    new MutationObserver(later).observe(box, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden'] });

    // Tab and Shift+Tab. Run after the panel's own handlers (bubbling), and stand back for a panel that handled the key itself.
    document.addEventListener('keydown', e => {
      if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return;
      if (!opened() || dialogAbove()) return;
      const here = tabbable(box);
      const ring = [...here, ...stopControls()];
      e.preventDefault();
      if (!ring.length) {
        box.focus({ preventScroll: true });
        return;
      }
      const at = document.activeElement;
      const back = e.shiftKey;
      const i = ring.indexOf(at);
      let next;
      if (i >= 0) {
        next = ring[(i + (back ? -1 : 1) + ring.length) % ring.length];
      } else if (at === box || (box.contains(at) && !here.length)) {
        next = back ? ring[ring.length - 1] : ring[0];
      } else if (box.contains(at)) {
        // A control the cycle skips (a radio that is not the chosen one): the next one in the drawer's own order.
        const after = here.filter(n => at.compareDocumentPosition(n) & (back ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING));
        next = back ? after[after.length - 1] : after[0];
        next ??= back ? ring[ring.length - 1] : ring[0];
      } else {
        // The focus is outside the cycle (it was moved there by code, or lost): it comes back in.
        next = back ? ring[ring.length - 1] : ring[0];
      }
      next.focus();
      // A focus moved by script after a script-made focus (the drawer itself) is not drawn as a keyboard focus by the browser, so the ring
      // is asked for here (ext-a11y.css). It goes when the control loses the focus.
      if (!next.matches(':focus-visible')) {
        next.setAttribute('data-kbfocus', '');
        next.addEventListener('blur', () => next.removeAttribute('data-kbfocus'), { once: true });
      }
    });

    // A drawer that is already open when this script runs (it cannot be, but a reload of the script must not leave it without focus).
    if (wasOpen) open();
  }

  // ---------- 3. a slow start ----------
  function watchStart() {
    if (typeof PerformanceObserver === 'undefined' || !window.performance?.getEntriesByType) return;
    const isState = name => {
      try {
        return new URL(name, location.href).pathname === '/api/state';
      } catch {
        return false;
      }
    };
    let card = null;
    let stage = 0;
    let finished = false;
    const timers = [];
    let observer = null;

    const answered = () => performance.getEntriesByType('resource').some(entry => isState(entry.name));

    function finish() {
      if (finished) return;
      finished = true;
      for (const t of timers) clearTimeout(t);
      observer?.disconnect();
      card?.remove();
      card = null;
    }

    const WORDS = [
      ['Plenum is still starting.', 'Its server has not answered yet. This can take a few seconds when the computer is busy. Your projects and chats appear as soon as it does.'],
      ['Plenum is taking longer than it should.', 'Close Plenum and open it again. If it happens every time, the file server.log in Plenum\'s data folder says why.'],
    ];

    function show(level) {
      if (finished || stage >= level) return;
      // The page is asking for the token (plain Node only): nothing is loading, and that card says what to do.
      if (document.querySelector('.token-card')) return;
      if (answered()) return finish();
      stage = level;
      if (!card) {
        card = document.createElement('div');
        card.className = 'a11y-slow';
        card.id = 'a11ySlow';
        const title = document.createElement('div');
        title.className = 'a11y-slow-title';
        const text = document.createElement('div');
        text.className = 'a11y-slow-text';
        card.append(title, text);
        document.body.append(card);
      }
      const [head, rest] = WORDS[level - 1];
      card.children[0].textContent = head;
      card.children[1].textContent = rest;
      announce(`${head} ${rest}`);
    }

    if (answered()) return;
    // The events channel connects only after the state was read (loadAll in app.js), so it ends the wait as well. It is the second way
    // out, for a window whose finished requests are not in the browser's record (the phone's page reads through its own shell).
    window.addEventListener('plenum:connection', e => { if (e.detail?.connected) finish(); });
    try {
      observer = new PerformanceObserver(list => {
        if (list.getEntries().some(entry => isState(entry.name))) finish();
      });
      observer.observe({ type: 'resource', buffered: true });
    } catch {
      return;
    }
    const spent = performance.now();
    timers.push(setTimeout(() => show(1), Math.max(0, STALL_MS - spent)));
    timers.push(setTimeout(() => show(2), Math.max(0, LONG_MS - spent)));
  }

  window.MuseA11y = { announce, log, version: 1 };

  function start() {
    lanes.status.node = region('a11yStatus', 'status', 'polite');
    lanes.alert.node = region('a11yAlert', 'alert', 'assertive');
    watchToasts();
    watchStart();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
