// ext-open-route: a desktop notification was clicked, and the page opens the place it is about (wave 4, 16 Nov 2026). The desktop app
// (desktop/main.cjs openInPage) brings the window to the front and tells this page { op: 'open', kind, id }: it posts that message to the
// page's own window and also leaves it in window.__plenumPendingOpen, which this file takes when it loads after the message (the window
// was made again, or the page was still loading its panels). Each message has a number (n), so one is never opened twice.
// The places, with the page's own calls (the same ones public/ext-phone.js uses for a tapped phone notification):
//   waiting  <project>   the project's waiting card in the chat when it is the project on screen, else the Agents board
//   chat     <project>   that project's chat (its row in the sidebar, as a click on it)
//   today    <business>  the Businesses pane (Today)
//   plan-use             the Plan use pop-up (the alerts strip's button when an alert waits, else the ring's pop-up)
//   accounts             Settings > Accounts
//   services             Settings > Background services
// An unknown kind does nothing. Every message also goes out as window event 'plenum:open' with detail { kind, id }, so a panel can take
// a place it owns further (the Businesses pane can pick the business). Nothing here asks the server for anything or changes a setting.
// Wave 5 (integration): a paired browser in the computer layout (data-surface "wide") has no phone layer, and public/ext-phone.js is the
// phone's only taker of the shell's routes. So on a shell page that is not the desktop app and not the phone layout, this file takes them:
// plenumShell.onRoute (else the 'plenum:route' event) and plenumShell.takeRoute() once at start, as ext-phone does. A tapped notification
// (#waiting=<approval>, #handover=<approval>, #chat=<project>, #today[=<business>], #accounts, #services, #settings=limit, #home) opens the
// same places as above. The shell already reads the address and its hashchange (mobile/shell/app.js), so this file reads the address only
// when the shell had no route for it at start.
(function () {
  'use strict';
  const MU = window.MuseUI;
  if (!MU) return;

  const KINDS = new Set(['waiting', 'chat', 'today', 'plan-use', 'accounts', 'services']);
  const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
  // A message older than this is from another moment (a page that was loaded much later) and is not opened.
  const FRESH_MS = 60_000;
  let lastN = 0;

  const q = sel => document.querySelector(sel);
  const call = (fn, ...args) => {
    try {
      if (typeof fn === 'function') return fn(...args);
    } catch {
      // The place could not be opened; the window is in front anyway.
    }
    return undefined;
  };

  // Calls fn until it answers true (the project list and the panels may not be drawn yet when the window opens from a notification).
  // giveUp runs once when every try answered false.
  function soon(fn, tries = 15, every = 200, giveUp = null) {
    const attempt = left => {
      if (fn()) return;
      if (left <= 0) {
        if (giveUp) call(giveUp);
        return;
      }
      setTimeout(() => attempt(left - 1), every);
    };
    attempt(tries);
  }

  // Settings covers the chat; it is closed with its own Close button before a chat or a card is shown.
  function leaveSettings() {
    if (document.getElementById('app')?.hasAttribute('data-settings-open')) q('#settingsClose')?.click();
  }

  const activeProject = () => MU.state?.activeProject ?? '';
  const knownProject = id => Array.isArray(MU.state?.projects) && MU.state.projects.some(p => p && p.id === id);

  // Shows that project's chat: a click on its row in the sidebar, which is how the person switches. Answers true when it is on screen.
  function showProject(id) {
    if (!id) return true;
    if (!knownProject(id)) return false;
    if (activeProject() === id) return true;
    const row = q(`.proj-item[data-focus-key="project:${CSS.escape(id)}"]`);
    if (!row) return false;
    row.click();
    return true;
  }

  function goChat(id) {
    leaveSettings();
    soon(() => showProject(id));
  }

  // The card of the project on screen is scrolled to and takes the focus. A card of another project is on the Agents board, which shows
  // the cards of every project (the project on screen does not change, as on the phone).
  function goWaiting(id) {
    leaveSettings();
    if (id && knownProject(id) && activeProject() !== id) {
      call(MU.openAgentsLive);
      return;
    }
    soon(() => {
      const stream = call(MU.stream) ?? document;
      const card = [...stream.querySelectorAll('.approval[data-approval-id]')].find(c => !c.dataset.answeredHere && c.isConnected);
      if (!card) return false;
      focusCard(card);
      return true;
    }, 10);
  }

  function focusCard(card) {
    card.scrollIntoView({ block: 'center' });
    card.tabIndex = card.tabIndex >= 0 ? card.tabIndex : -1;
    card.focus({ preventScroll: true });
  }

  // The Plan use pop-up: through the alerts strip's button while an alert waits (it opens the pop-up also for a model without a ring), else
  // the ring's pop-up. The alerts may not be read yet, so this looks for a moment first. A pop-up that is open already stays open.
  function goPlanUse(tries = 8) {
    const pop = q('.ext-quota-pop');
    if (pop && !pop.hidden) return;
    const strip = q('.pw-strip [data-fk="strip|open"]');
    if (strip) {
      strip.click();
      return;
    }
    const plan = MU.planWatch;
    if (plan && typeof plan.settled === 'function' && !plan.settled() && tries > 0) {
      setTimeout(() => goPlanUse(tries - 1), 250);
      return;
    }
    call(MU.openPlanUse, null);
  }

  function open(kind, id) {
    if (kind === 'chat') goChat(id);
    else if (kind === 'waiting') goWaiting(id);
    else if (kind === 'today') call(MU.openBusinesses);
    else if (kind === 'plan-use') goPlanUse();
    else if (kind === 'accounts') call(MU.openAccountsAt);
    else if (kind === 'services') call(MU.openSettings, 'services');
  }

  function take(data) {
    if (!data || typeof data !== 'object' || data.op !== 'open' || !KINDS.has(data.kind)) return;
    const n = Number(data.n);
    if (Number.isFinite(n) && n > 0) {
      if (n <= lastN) return;
      lastN = n;
    }
    if (Number.isFinite(data.at) && Math.abs(Date.now() - data.at) > FRESH_MS) return;
    // The copy left for a late page is the same message: it is not opened again.
    const left = window.__plenumPendingOpen;
    if (left && (left === data || Number(left.n) <= lastN)) window.__plenumPendingOpen = null;
    const id = typeof data.id === 'string' && ID.test(data.id) ? data.id : '';
    try {
      window.dispatchEvent(new CustomEvent('plenum:open', { detail: { kind: data.kind, id } }));
    } catch {
      // A listener's error does not stop the opening.
    }
    open(data.kind, id);
  }

  // Only this window's own messages count: not a frame inside the page (an artifact, a preview), not another origin.
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    take(event.data);
  });
  // The desktop also left the message here, for a page whose panels loaded after it was posted.
  const waiting = window.__plenumPendingOpen;
  if (waiting) take(waiting);

  // ---------- wave 5: the shell's routes on a paired browser in the computer layout ----------

  const shell = window.plenumShell && typeof window.plenumShell === 'object' ? window.plenumShell : null;
  // The phone layout has its own taker (public/ext-phone.js), and the desktop app has no shell routes. data-surface "wide" is set only
  // by the shell's boot.js, so it counts even where window.plenumShell is not the shell's own object (a page whose window already had
  // one, as the test harness's window has): there the routes come as the 'plenum:route' event, which boot.js always sends.
  const surface = document.documentElement?.dataset?.surface;
  if (surface === 'phone') return;
  if (surface !== 'wide' && (!shell || shell.desktop === true)) return;
  const shellRoutes = shell && shell.desktop !== true ? shell : null;

  // The ids the shell's links carry (mobile/shell/push.js): letters, digits, dots, dashes and underscores.
  const ROUTE_ID = /^[A-Za-z0-9_.-]{1,80}$/;
  const routeId = v => (typeof v === 'string' && ROUTE_ID.test(v) ? v : '');

  // The approval as the Agents board knows it ({ approvalId, projectId, ... }), or null.
  function boardItem(id) {
    if (!id) return null;
    try {
      const view = typeof MU.board?.view === 'function' ? MU.board.view() : null;
      const list = view && Array.isArray(view.approvals) ? view.approvals : [];
      return list.find(c => c && String(c.approvalId ?? '') === id) ?? null;
    } catch {
      return null;
    }
  }

  // A route names the approval itself (#waiting=<approval id>). Its card is scrolled to when it is in the chat on screen. A card of
  // another project is on the Agents board, as for a desktop notification. A card that is nowhere any more opens the board and says so.
  function goApproval(id) {
    leaveSettings();
    const item = boardItem(id);
    if (item && item.projectId && item.projectId !== activeProject()) {
      call(MU.openAgentsLive);
      return;
    }
    soon(() => {
      const stream = call(MU.stream) ?? document;
      const cards = [...stream.querySelectorAll('.approval[data-approval-id]')].filter(c => c.isConnected && !c.dataset.answeredHere);
      const card = id ? cards.find(c => c.dataset.approvalId === id) : cards[0];
      if (!card) return false;
      focusCard(card);
      return true;
    }, 10, 200, () => {
      call(MU.openAgentsLive);
      if (id && !boardItem(id)) call(MU.toast, 'That approval is no longer waiting.');
    });
  }

  // A model asked the person to do a step: its "Your turn" card in the chat on screen, else the Agents board, where the waiting run is.
  function goHandover() {
    leaveSettings();
    soon(() => {
      const stream = call(MU.stream) ?? document;
      const card = [...stream.querySelectorAll('.approval.typeit')].find(c => c.isConnected);
      if (!card) return false;
      focusCard(card);
      return true;
    }, 10, 200, () => call(MU.openAgentsLive));
  }

  // A limit stopped something: the plan watch's alert while one waits (its Plan use button), else the spend limit's chip, else Settings.
  // The same order as the phone (public/ext-phone.js goLimit).
  function goLimit(tries = 8) {
    leaveSettings();
    const strip = q('.pw-strip [data-fk="strip|open"]');
    if (strip) {
      strip.click();
      return;
    }
    const plan = MU.planWatch;
    if (plan && typeof plan.settled === 'function' && !plan.settled() && tries > 0) {
      setTimeout(() => goLimit(tries - 1), 250);
      return;
    }
    const chip = q('.ext-budget-chip');
    if (chip && !chip.hidden) {
      chip.click();
      return;
    }
    call(MU.openSettings, '');
  }

  // The places that a desktop notification opens too: they go out as 'plenum:open' first (the Businesses pane picks the business).
  function place(kind, id) {
    try {
      window.dispatchEvent(new CustomEvent('plenum:open', { detail: { kind, id } }));
    } catch {
      // A listener's error does not stop the opening.
    }
    open(kind, id);
  }

  function route(link) {
    if (!link || typeof link !== 'object') return;
    const kind = link.kind;
    if (kind === 'waiting') goApproval(routeId(link.id));
    else if (kind === 'handover') goHandover();
    else if (kind === 'chat') place('chat', routeId(link.project));
    else if (kind === 'settings' && link.section === 'limit') goLimit();
    else if (kind === 'today') place('today', routeId(link.id) || routeId(link.business));
    else if (kind === 'accounts' || kind === 'services' || kind === 'plan-use') place(kind, '');
    // Home is the project list, which the computer layout always shows in its sidebar.
    else if (kind === 'home') leaveSettings();
  }

  // #today, #today=<business>, #accounts, #services left in the address when the shell had no route at start. Taken off once followed.
  function placeOfHash(hash) {
    const text = String(hash || '').replace(/^#/, '');
    if (text === 'today' || text === 'accounts' || text === 'services') return { kind: text };
    const m = /^today=([A-Za-z0-9_.-]{1,80})$/.exec(text);
    return m ? { kind: 'today', id: m[1] } : null;
  }

  if (typeof shellRoutes?.onRoute === 'function') shellRoutes.onRoute(link => route(link));
  else window.addEventListener('plenum:route', e => route(e.detail));
  let first = null;
  try {
    first = typeof shellRoutes?.takeRoute === 'function' ? shellRoutes.takeRoute() : null;
  } catch {
    first = null;
  }
  if (first) route(first);
  else {
    const link = placeOfHash(location.hash);
    if (link) {
      try {
        history.replaceState(history.state, '', location.pathname + location.search);
      } catch {
        // The address stays; the place is still opened once.
      }
      route(link);
    }
  }
})();
