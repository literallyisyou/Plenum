// ext-board: the Agents board's data and the Running now list in the sidebar (UI-ARCH sections 2, 4 and 11). The board itself is the
// Agents tab of the side pane, drawn by public/ext-agents.js from the store below.
//
// The store holds what lib/activity.mjs holds: every run in progress, the last ended runs and every approval card waiting, in every
// project. It is filled from GET /api/activity and kept current from the 'activity' events on the events channel (plenum:event).
// A snapshot carries the seq of the last change it includes; events that arrived while it was read are applied after it, so nothing
// is lost and nothing is applied twice. A reconnect (the 'hello' event) reads the snapshot again.
//
// Unread: a finished run shows a dot until its chat is opened (or the run ends while its chat is on screen: the project's Main chat or one of its threads). That is kept in
// this window's localStorage ('plenum.board.seen': { [scope]: endedAt }), read and written in try/catch.
//
// Text from the server (project and thread names, models, steps, approval summaries) is set with textContent only.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI || typeof MuseUI.api !== 'function') return;

  const SEEN_KEY = 'plenum.board.seen';
  const SIDE_MAX = 5;
  const RECENT_MAX = 30;
  const TICK_MS = 5000;
  const RETRY_MS = 3000;
  const SWITCH_WAIT_MS = 10000;
  const MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');
  const MOD = MAC ? 'Cmd' : 'Ctrl';

  // The status words of a run (lib/activity.mjs status values).
  const ENDED_WORDS = { done: 'Done', error: 'Error', stopped: 'Stopped', 'cut-off': 'Cut off', 'timed-out': 'Timed out' };

  // ---------- the store ----------

  const runs = new Map();      // scope -> the run in progress
  const recent = [];           // the ended runs, newest first
  const approvals = new Map(); // approval id -> the card waiting
  let seq = 0;                 // the last change applied
  let loaded = false;          // a snapshot has been read at least once
  let gen = 0;                 // which snapshot read is the newest
  let buffer = null;           // the events that arrived while the newest read is on its way
  let seen = readSeen();

  function readSeen() {
    try {
      const value = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
      return Object.fromEntries(Object.entries(value).filter(([, at]) => Number.isFinite(at)));
    } catch {
      return {};
    }
  }

  function writeSeen() {
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    } catch {
      // The marks are kept for this page only.
    }
  }

  const isSeen = run => Number.isFinite(seen[run.scope]) && seen[run.scope] >= (run.endedAt ?? 0);

  // The scope of the chat on screen: the thread's id, or the project's id for Main (the same as activeScope() in app.js).
  const onScreen = () => MuseUI.state.activeThread || MuseUI.state.activeProject || null;

  // Marks the finished runs of a chat as seen. Called when the chat is opened, and when one of its runs ends while it is on screen.
  function markSeen(scope) {
    let changed = false;
    for (const run of recent) {
      if (run.scope !== scope || isSeen(run)) continue;
      seen[scope] = Math.max(seen[scope] ?? 0, run.endedAt ?? 0);
      changed = true;
    }
    if (changed) {
      writeSeen();
      notify();
    }
  }

  function trimRecent() {
    if (recent.length > RECENT_MAX) recent.length = RECENT_MAX;
  }

  // One change in the order the server made it. Each change carries the whole run or card, so applying it twice changes nothing.
  function apply(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (Number.isFinite(ev.seq) && ev.seq > seq) seq = ev.seq;
    switch (ev.op) {
      case 'run-start':
      case 'run-step':
        if (ev.run && typeof ev.run.scope === 'string') runs.set(ev.run.scope, ev.run);
        return;
      case 'run-end':
        if (!ev.run || typeof ev.run.scope !== 'string') return;
        runs.delete(ev.run.scope);
        recent.unshift(ev.run);
        trimRecent();
        // A run that ends while its chat is on screen has been seen.
        // The mark is stored at once, so it is not lost on a reload (markSeen after this finds it seen and writes nothing).
        if (ev.run.scope === onScreen()) {
          seen[ev.run.scope] = Math.max(seen[ev.run.scope] ?? 0, ev.run.endedAt ?? 0);
          writeSeen();
        }
        return;
      case 'approval-add':
        if (ev.card && typeof ev.card.approvalId === 'string') approvals.set(ev.card.approvalId, ev.card);
        return;
      case 'approval-done':
        approvals.delete(String(ev.approvalId));
        return;
      default:
    }
  }

  // Replaces the store with a snapshot.
  function load(snap) {
    runs.clear();
    for (const run of Array.isArray(snap?.runs) ? snap.runs : []) if (run && typeof run.scope === 'string') runs.set(run.scope, run);
    recent.length = 0;
    for (const run of Array.isArray(snap?.recent) ? snap.recent : []) if (run) recent.push(run);
    trimRecent();
    approvals.clear();
    for (const card of Array.isArray(snap?.approvals) ? snap.approvals : []) if (card && typeof card.approvalId === 'string') approvals.set(card.approvalId, card);
    seq = Number.isFinite(snap?.seq) ? snap.seq : 0;
    loaded = true;
  }

  // Reads the snapshot. A read that a newer one has overtaken is dropped. The events that came in while it was on its way and
  // are newer than it are applied after it.
  async function sync() {
    const mine = ++gen;
    const meanwhile = [];
    buffer = meanwhile;
    try {
      const snap = await MuseUI.api('/api/activity');
      if (mine !== gen) return;
      load(snap);
      for (const ev of meanwhile) if ((ev.seq ?? 0) > seq) apply(ev);
      notify();
    } catch {
      // The board keeps what it has. The next reconnect reads it again, and so does the next change while no snapshot has been read yet.
    } finally {
      if (mine === gen) buffer = null;
    }
  }

  // While no snapshot has been read (the first read failed), a change reads it again, at most once every few seconds, so the runs and
  // the cards from before the page opened are listed without waiting for a reconnect.
  let lastRetry = 0;
  function retryFirstRead() {
    if (loaded || buffer || Date.now() - lastRetry < RETRY_MS) return;
    lastRetry = Date.now();
    sync();
  }

  function onActivity(ev) {
    apply(ev);
    if (buffer) buffer.push(ev);
    else retryFirstRead();
    if (ev.op === 'run-end' && ev.run && ev.run.scope === onScreen()) markSeen(ev.run.scope);
    notify();
  }

  // ---------- the rows of the sidebar ----------

  const clock = ms => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  const stepText = run => (run.step ? `${run.step.name} ${run.step.summary}`.trim().slice(0, 60) : '');

  // Waiting cards first (oldest first), then the runs in progress, then the finished runs nobody has opened, newest first.
  // A run that waits on a card is listed once, as waiting.
  function sideRows() {
    const waiting = [...approvals.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    const waitingScopes = new Set(waiting.map(c => c.scope));
    const rows = [];
    for (const c of waiting) {
      rows.push({ key: `w:${c.approvalId}`, scope: c.scope, kind: 'wait', projectId: c.projectId, tone: 'amber', status: 'Waiting for you', projectName: c.projectName, threadName: c.threadName, model: c.modelLabel, step: '', clock: clock(Date.now() - (c.at ?? Date.now())), unseen: false });
    }
    for (const r of [...runs.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) {
      if (waitingScopes.has(r.scope)) continue;
      rows.push({ key: `r:${r.scope}`, scope: r.scope, kind: 'run', projectId: r.projectId, tone: '', status: `Running ${Math.floor(Math.max(0, Date.now() - (r.startedAt ?? Date.now())) / 60000)}m`, projectName: r.projectName, threadName: r.threadName, model: r.modelLabel, step: stepText(r), clock: clock(Date.now() - (r.startedAt ?? Date.now())), unseen: false, via: r.via ?? '' });
    }
    for (const r of recent) {
      if (isSeen(r)) continue;
      rows.push({ key: `d:${r.scope}:${r.endedAt}`, scope: r.scope, kind: 'done', projectId: r.projectId, tone: r.status === 'error' ? 'red' : '', status: ENDED_WORDS[r.status] ?? 'Done', projectName: r.projectName, threadName: r.threadName, model: r.modelLabel, step: stepText(r), clock: clock((r.endedAt ?? 0) - (r.startedAt ?? 0)), unseen: true, via: r.via ?? '' });
    }
    return rows;
  }

  // ---------- the sidebar section ----------

  let side = null;
  let sideHead = null;
  let sideBadge = null;
  let sideCount = null;
  let sideWord = null;
  let sideList = null;
  let sideMore = null;
  let sideSig = '';
  let sideNodes = [];

  const el = (tag, cls = '', text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = String(text);
    return node;
  };

  // The project of a scope the caller did not name one for: the run or card that holds it, else the project the id belongs to (Main's scope is
  // its project's id).
  function projectOfScope(scope) {
    const hit = runs.get(scope) ?? recent.find(r => r.scope === scope) ?? [...approvals.values()].find(c => c.scope === scope);
    if (hit?.projectId) return hit.projectId;
    // A thread's id starts with its project's id (lib/threads.mjs: '<project>-t...').
    return (MuseUI.state.projects ?? []).find(p => scope === p.id || scope.startsWith(`${p.id}-t`))?.id ?? scope;
  }

  // The project switch is the project list's own click, which finishes later (the server answers first), so this waits until the project is the
  // active one. It also ends after a few seconds, so a switch that was refused does not leave it waiting.
  function projectIsActive(projectId) {
    if (MuseUI.state.activeProject === projectId) return Promise.resolve(true);
    return new Promise(resolve => {
      let off = null;
      let poll = null;
      let timer = null;
      const done = ok => {
        clearInterval(poll);
        clearTimeout(timer);
        if (typeof off === 'function') off();
        resolve(ok);
      };
      const check = () => {
        if (MuseUI.state.activeProject === projectId) done(true);
      };
      off = MuseUI.threads?.onRender?.(check);
      poll = setInterval(check, 50);
      timer = setTimeout(() => done(false), SWITCH_WAIT_MS);
    });
  }

  let openTicket = 0;

  // Opens a row's chat: its project (the project list's own button) and then its thread or Main, and marks its runs seen once that chat shows.
  // target is { scope, projectId }, or a bare scope id. A run's scope is its thread's id for a thread and its project's id for Main, so the
  // project is named on its own.
  async function openScope(target) {
    const given = typeof target === 'string' ? { scope: target } : target && typeof target === 'object' ? target : {};
    const scope = typeof given.scope === 'string' ? given.scope : '';
    if (!scope) return;
    const projectId = typeof given.projectId === 'string' && given.projectId ? given.projectId : projectOfScope(scope);
    const ticket = ++openTicket;
    const index = (MuseUI.state.projects ?? []).findIndex(p => p.id === projectId);
    if (index < 0) {
      MuseUI.toast?.('That project is no longer in the list.', 'bad');
      return;
    }
    if (MuseUI.state.activeProject !== projectId) {
      const item = [...document.querySelectorAll('#projects .proj-item')][index];
      // Without the project's own button (the list is not drawn) there is no switch to wait for.
      if (!item) return;
      item.click();
      const switched = await projectIsActive(projectId);
      // A newer click on another row wins; this one stops here.
      if (ticket !== openTicket) return;
      if (!switched) {
        MuseUI.toast?.('The project did not open. Try again.', 'bad');
        return;
      }
    }
    // The project shows the thread it showed last, which need not be the row's: Main is switched to like any other thread (its id is the
    // project's id).
    if (onScreen() !== scope) {
      // Main is always open; a thread may have been closed since its run.
      const known = scope === projectId || !Array.isArray(MuseUI.state.threads) || MuseUI.state.threads.some(t => t && t.id === scope);
      if (!known) {
        MuseUI.toast?.('That thread is closed.', 'bad');
        markSeen(scope);
        return;
      }
      try {
        await MuseUI.threads?.switchTo?.(scope);
      } catch (err) {
        MuseUI.toast?.(err?.message || 'The thread could not be opened.', 'bad');
        return;
      }
      // A run is seen only when its own chat shows. A switch that did not land leaves the dot, and says so unless a newer click took over.
      if (onScreen() !== scope) {
        if (ticket === openTicket) MuseUI.toast?.('The chat did not open. Try again.', 'bad');
        return;
      }
    }
    markSeen(scope);
  }

  function openBoard() {
    if (typeof MuseUI.openAgentsLive === 'function') MuseUI.openAgentsLive();
    return true;
  }

  function rowEl(row) {
    const b = el('button', row.kind === 'wait' ? 'ext-board-row is-wait' : 'ext-board-row');
    b.type = 'button';
    const top = el('span', 'ext-board-row-top');
    const pill = el('span', row.tone ? `pill ext-board-pill ${row.tone}` : 'pill ext-board-pill', row.status);
    top.append(pill);
    if (row.unseen) top.append(el('span', 'ext-board-dot'));
    b.append(top, el('span', 'ext-board-row-name', `${row.projectName || 'Project'} · ${row.threadName || 'Main'}`));
    // A run that a phone acted in says so: via <device> (DECISIONS 68). The name comes from the phone list, never the id.
    const meta = metaOf(row);
    const metaNode = meta ? el('span', 'ext-board-row-meta', meta) : null;
    if (metaNode) b.append(metaNode);
    const via = viaOf(row);
    if (via) b.append(el('span', 'ext-board-row-meta', via));
    b.setAttribute('aria-label', `${row.status}: ${row.projectName || 'Project'} · ${row.threadName || 'Main'}${via ? `, ${via}` : ''}`);
    b.addEventListener('click', () => openScope({ scope: row.scope, projectId: row.projectId }));
    // The parts that change while a run goes, so fillRow can update them in place.
    b.boardParts = { pill, meta: metaNode };
    return b;
  }

  const metaOf = row => [row.model, row.step, row.clock].filter(Boolean).join(' · ');
  const viaOf = row => (row.via ? `via ${MuseUI.phoneName?.(row.via) || 'a phone'}` : '');

  // Updates a drawn row's moving text (its minutes, step and clock) without making a new button, so focus and a click in progress stay.
  function fillRow(b, row) {
    const parts = b?.boardParts;
    if (!parts) return;
    if (parts.pill) parts.pill.textContent = row.status;
    if (parts.meta) parts.meta.textContent = metaOf(row);
    const via = viaOf(row);
    b.setAttribute('aria-label', `${row.status}: ${row.projectName || 'Project'} · ${row.threadName || 'Main'}${via ? `, ${via}` : ''}`);
  }

  function buildSide() {
    const anchor = document.getElementById('projects');
    if (!anchor || side) return;
    side = el('section', 'ext-board-side');
    side.setAttribute('aria-label', 'Running now');
    side.hidden = true;
    // The head is a button that opens the Agents pane. On the icon strip (56 px) it is the only part that shows: the badge's number.
    sideHead = el('button', 'ext-board-side-head');
    sideHead.type = 'button';
    sideHead.title = 'Open the Agents pane';
    sideHead.append(el('span', 'kicker', 'Running now'));
    sideBadge = el('span', 'badge');
    sideBadge.hidden = true;
    sideCount = el('span', 'ext-board-count-num');
    sideWord = el('span', 'ext-board-count-word');
    sideBadge.append(sideCount, sideWord);
    sideHead.append(sideBadge);
    sideHead.addEventListener('click', openBoard);
    sideList = el('div', 'ext-board-side-list');
    sideMore = el('button', 'ghost small ext-board-side-more', `Show all (${MOD}+Shift+B)`);
    sideMore.type = 'button';
    sideMore.addEventListener('click', openBoard);
    side.append(sideHead, sideList, sideMore);
    anchor.after(side);
  }

  function renderSide() {
    if (!side) buildSide();
    if (!side) return;
    const rows = sideRows();
    const waiting = approvals.size;
    const running = runs.size;
    const shown = rows.slice(0, SIDE_MAX);
    // The signature leaves out what moves while a run goes (a running row's minutes, its step and its clock): those are updated in place.
    // Whether a row has a meta line at all is in it, since that changes the row's parts.
    const sig = JSON.stringify([shown.map(r => [r.key, r.kind, r.tone, r.kind === 'run' ? '' : r.status, r.unseen, r.projectName, r.threadName, Boolean(metaOf(r)), r.via, viaOf(r)]), waiting]);
    side.hidden = rows.length === 0;
    // The badge shows the cards waiting (amber) when there are any, else the runs in progress.
    sideBadge.hidden = waiting === 0 && running === 0;
    if (waiting > 0) sideBadge.dataset.tone = 'amber';
    else delete sideBadge.dataset.tone;
    sideCount.textContent = String(waiting > 0 ? waiting : running);
    sideWord.textContent = waiting > 0 ? ' waiting' : ' running';
    sideHead.setAttribute('aria-label', waiting > 0 ? `Running now: ${waiting} waiting for you. Open the Agents pane` : `Running now: ${running} running. Open the Agents pane`);
    sideMore.hidden = rows.length === 0;
    // The list is rebuilt only when rows come, go or change state, so a row that has focus keeps it and a click is not lost to a tick.
    if (sig === sideSig) {
      shown.forEach((r, i) => fillRow(sideNodes[i], r));
      return;
    }
    sideSig = sig;
    sideNodes = shown.map(rowEl);
    sideList.replaceChildren(...sideNodes);
  }

  // Every change: the sidebar is drawn and the board (ext-agents.js) is told. The board reads the store through MuseUI.board.
  function notify() {
    renderSide();
    window.dispatchEvent(new CustomEvent('plenum:board'));
  }

  // ---------- events, keys and the entry points ----------

  window.addEventListener('plenum:event', e => {
    const ev = e.detail;
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'activity') {
      onActivity(ev);
    } else if (ev.type === 'hello') {
      // A (re)connected window reads the whole board again.
      sync();
    } else if (ev.type === 'state') {
      // A chat that is on screen has its finished runs seen.
      if (onScreen()) markSeen(onScreen());
    }
  });

  // Ctrl+Shift+B is handled once, by the shell's key handler in public/app.js: it toggles the Agents pane, and it works from the message
  // box but not from other text fields (B-6). This file only lists the shortcut; a second handler here would re-open the pane that
  // the shell had just hidden.
  window.MuseShortcutRows = window.MuseShortcutRows || [];
  window.MuseShortcutRows.push({ keys: [MOD, 'Shift', 'B'], action: 'Open the Agents board.' });

  // What the Agents pane draws from. view() is a copy, so the pane never changes the store.
  MuseUI.board = {
    view: () => ({
      loaded,
      runs: [...runs.values()].map(r => ({ ...r })).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)),
      recent: recent.map(r => ({ ...r })),
      approvals: [...approvals.values()].map(c => ({ ...c })).sort((a, b) => (a.at ?? 0) - (b.at ?? 0)),
      isSeen: run => isSeen(run),
    }),
    openScope,
    markSeen,
    reload: sync,
  };

  buildSide();
  // A thread that is shown has its finished runs seen, however it came on screen (its tab, the Agents board, another window's change).
  MuseUI.threads?.onRender?.(() => {
    if (onScreen()) markSeen(onScreen());
  });
  // The first read waits for the token (MuseUI.ready); the events channel's hello event reads it again on every connection.
  Promise.resolve(MuseUI.ready).then(() => sync());
  // The clocks and the minutes of the rows move while a run goes; the sidebar is redrawn every few seconds.
  setInterval(() => {
    if (!loaded) retryFirstRead();
    if (document.visibilityState !== 'hidden') renderSide();
  }, TICK_MS);
  document.addEventListener?.('visibilitychange', () => {
    if (document.visibilityState === 'visible') renderSide();
  });
})();
