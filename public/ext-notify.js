// ext-notify. Notifications in the page (wave 4, n3): live notices as toasts, a bell in the title bar with a count of what needs you, a sheet
// 'Notifications' (Needs you, Recent), a calm 'While you were away' strip, and Settings > General > Notifications. Adds itself through
// window.MuseUI (app.js). Layout and colour are in ext-notify.css (tokens only).
//
// The server (lib/notify.mjs, lib/routes/notify.mjs) owns every fact; this page shows them and changes them only through the routes.
// THE CONTRACT THIS PAGE READS:
//  - GET /api/notify -> { settings: { quiet: { on, from, to }, mutes: { <business>: untilMs }, summary: { on, at } }, recent: [notice + { clearedAt }]
//    (newest first), open: [notice] (newest first), seenAt, unseen, quietNow, saving }.
//  - POST /api/notify/settings { quiet?, summary? } answers as the GET. POST /api/notify/mute { business, minutes | 'day' } (0 ends a mute).
//    POST /api/notify/test {}. POST /api/notify/seen {}. POST /api/notify/clear { key } (Dismiss on a Needs you row: the hub takes the
//    key off its open list and publishes the clear; a way out for a row that went stale, for example one kept across a restart).
//  - Event 'notice': { type: 'notice', notice: { key, level, title, text, route, business, project, seq, at, repeat, quiet, silent, clear } }.
//    A notice that is a repeat, is held back as quiet, or is a clear, is not shown as a toast. A clear takes the key off the open list.
//    A notice without stamps is shown the way notices always were. Event 'hello' (a reconnect): the list is read again.
// Going to a place (route 'accounts' | 'today' | 'plan-use' | 'services' | 'chat' | 'night-shift'): the page's own message { op: 'open', kind, id } that
// public/ext-open-route.js takes (it also sends window event 'plenum:open'). Where that file is not part of the page, the panel opens the
// place itself with the calls it has and sends 'plenum:open' on its own. A place that cannot be opened does nothing and never throws.
// Text reaches the page through textContent only. No key, token, status number or raw error text is shown: every failure is one fixed sentence.
(function () {
  const MuseUI = window.MuseUI;
  if (!MuseUI) return;

  const AWAY_AFTER_MS = 30 * 60 * 1000;
  const PRESENT_EVERY_MS = 60 * 1000;
  const SAVED_MS = 2500;
  const RECENT_SHOWN = 20;
  const RECENT_KEPT = 50;
  const LONG_TOAST_MS = 14000;
  const LEVELS = ['needs-you', 'problem', 'fyi'];
  const WORRY = ['needs-you', 'problem'];
  const TEXT = {
    loadFailed: 'Notifications could not be loaded. Try again.',
    saveFailed: 'That could not be saved. Try again.',
    // The server put the change in force but could not write it down (a locked file, or the hub works in memory).
    unwritten: 'This could not be written to disk. It holds until Plenum restarts.',
    sameTimes: 'Pick two different times for quiet hours.',
    muteFailed: 'That could not be changed. Try again.',
    dismissFailed: 'That could not be dismissed. Try again.',
    testFailed: 'The test notification could not be sent. Try again.',
    testSent: 'A test notification is on its way.',
    saved: 'Saved',
    nothingNeeds: 'Nothing needs you right now.',
    nothingYet: 'Nothing yet.',
    quietNote: 'During quiet hours only things that need you come through, without sound. The rest waits for the morning summary.',
    intro: 'What Plenum tells you, and when. Plenum keeps the last few days here.',
  };
  const GO = {
    accounts: 'Open Accounts',
    today: 'Open Businesses',
    'plan-use': 'See plan use',
    services: 'Open Background services',
    chat: 'Open the chat',
    'night-shift': 'Open Night shift',
  };

  // ---------- helpers (text only) ----------

  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const special = key => /^(test|summary):/.test(key);
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = v => (typeof v === 'string' ? v : '');
  const list = v => (Array.isArray(v) ? v : []);
  const levelOf = v => (LEVELS.includes(v) ? v : 'fyi');
  const worry = n => WORRY.includes(levelOf(n?.level));
  const sentence = n => {
    const title = str(n?.title).trim();
    const text = str(n?.text).trim();
    return title && text ? `${title}: ${text}` : title || text;
  };
  function when(at) {
    if (!Number.isFinite(at) || at <= 0) return '';
    const d = new Date(at);
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  }
  const plural = (n, one, many) => (n === 1 ? one : many);

  // ---------- state ----------

  let data = null;            // the last answer of GET /api/notify
  let failed = false;         // the last read did not work
  const open = new Map();     // key -> notice that needs the person (needs-you or problem)
  let recent = [];            // newest first
  let businesses = null;      // [{ id, name }] for the mute picker, or null when not known
  let bell = null;
  let badge = null;
  let sheet = null;
  let opener = null;
  let strip = null;
  let hiddenAt = 0;
  let unwatched = false;      // the page has not been in front since it started (a window started with Windows, in the tray)
  let sheetNote = '';         // a failure sentence on the open sheet (a Dismiss that did not work), gone when it opens again
  let pendingTime = null;     // { field, value }: a quiet-hours time not sent because it equals the other one (see saveTime)
  let view = null;            // the Settings section on the page
  const said = new Map();
  const sayTimers = new Map();

  const onPage = () => Boolean(view && view.root.isConnected);
  // The owner is watching only when the page is visible AND its window has the focus. A window created hidden (started with Windows,
  // kept in the tray) reports visibilityState 'visible' in Electron, so visibility alone counted a window nobody saw as watched.
  const watching = () => document.visibilityState === 'visible' && (typeof document.hasFocus === 'function' ? document.hasFocus() : true);

  // ---------- requests ----------

  async function ask(path, body) {
    const res = await MuseUI.request(path, body === undefined ? {} : { method: 'POST', body });
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('request');
    return answer;
  }

  function take(answer) {
    data = answer;
    open.clear();
    for (const n of list(answer.open)) if (isObj(n) && str(n.key) && worry(n) && !special(n.key)) open.set(n.key, n);
    recent = list(answer.recent).filter(isObj).slice(0, RECENT_KEPT);
  }

  let loading = null;
  function load() {
    if (loading) return loading;
    loading = (async () => {
      try {
        const answer = await ask('/api/notify');
        if (!isObj(answer)) throw new Error('shape');
        take(answer);
        failed = false;
      } catch {
        failed = true;
      }
      loading = null;
      paintAll();
      return !failed;
    })();
    return loading;
  }

  // ---------- live notices ----------

  function onNotice(ev) {
    const n = isObj(ev?.notice) ? ev.notice : null;
    const key = str(n?.key);
    if (!n || !key) return;
    if (n.clear === true) {
      open.delete(key);
      paintAll();
      return;
    }
    const level = levelOf(n.level);
    const text = sentence(n);
    // Test and summary notices are never in the server's open list, and are never cleared: keep them out of the bell.
    if (worry(n) && !special(key)) open.set(key, { ...n, level });
    else open.delete(key);
    if (n.repeat !== true && text) {
      recent.unshift({ ...n, level });
      if (recent.length > RECENT_KEPT) recent.length = RECENT_KEPT;
    }
    paintAll();
    if (n.repeat === true || n.quiet === true || !text) return;
    // toast(text, kind, ms): a problem stays longer; app.js's own timing and close button do the rest.
    if (level === 'fyi') MuseUI.toast?.(text, 'ok');
    else MuseUI.toast?.(text, 'bad', LONG_TOAST_MS);
    // The owner watched it arrive: move the seen mark, so it is not counted as news when he comes back.
    if (watching()) markPresent();
  }

  // ---------- going to a place ----------

  function go(n) {
    const kind = str(n?.route);
    if (!GO[kind]) return;
    const id = kind === 'today' ? str(n.business) : kind === 'chat' ? str(n.project) : '';
    closeSheet(false);
    try {
      if (document.querySelector('script[src*="ext-open-route"]')) {
        // The same message the desktop leaves for a clicked notification. No number: the desktop's own numbering is not disturbed.
        window.postMessage({ op: 'open', kind, id, at: Date.now() }, location.origin);
        return;
      }
      // Without that file the panel opens what it can itself, and tells the other panels.
      try {
        window.dispatchEvent(new CustomEvent('plenum:open', { detail: { kind, id } }));
      } catch {
        // A listener's error does not stop the opening.
      }
      if (kind === 'accounts') MuseUI.openAccountsAt?.();
      else if (kind === 'services') MuseUI.openSettings?.('services');
      else if (kind === 'today') MuseUI.openBusinesses?.();
      else if (kind === 'plan-use') MuseUI.openPlanUse?.(null);
      else if (kind === 'night-shift' && MuseUI.pane?.list?.().includes('night-shift')) MuseUI.pane.open('night-shift');
    } catch {
      // The place could not be opened.
    }
  }

  // ---------- the bell ----------

  function makeBell() {
    const b = make('button', 'ntf-bell');
    b.type = 'button';
    b.setAttribute('aria-haspopup', 'dialog');
    b.setAttribute('aria-expanded', 'false');
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'ic ntf-bell-ic');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M6 9a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9Zm4 9.5a2 2 0 0 0 4 0');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.7');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    badge = make('span', 'ntf-badge');
    badge.setAttribute('aria-hidden', 'true');
    b.append(svg, badge);
    b.addEventListener('click', () => (sheet && !sheet.dlg.hidden ? closeSheet(true) : openSheet(b)));
    return b;
  }

  // The bell keeps its place when nothing needs you (it is only not seen), so the title bar does not move when it appears.
  function paintBell() {
    if (!bell) return;
    const n = open.size;
    bell.dataset.idle = n === 0 ? 'true' : 'false';
    bell.disabled = n === 0 && !(sheet && !sheet.dlg.hidden);
    bell.setAttribute('aria-hidden', n === 0 ? 'true' : 'false');
    badge.textContent = n > 99 ? '99+' : n ? String(n) : '';
    const label = n === 0 ? 'Notifications' : `Notifications: ${n} ${plural(n, 'thing needs', 'things need')} you`;
    bell.title = label;
    bell.setAttribute('aria-label', label);
  }

  // ---------- the sheet ----------

  const focusables = root => [...root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(n => !n.disabled && !n.hidden && n.getClientRects().length);

  function ensureSheet() {
    if (sheet) return sheet;
    const scrim = make('div', 'ntf-scrim');
    scrim.hidden = true;
    const dlg = make('dialog', 'ntf-sheet');
    dlg.hidden = true;
    // The sheet can hold the focus itself when the row that had it is gone (not reachable with Tab).
    dlg.tabIndex = -1;
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-labelledby', 'ntfSheetTitle');
    const head = make('div', 'ntf-sheet-head');
    const title = make('h2', 'ntf-sheet-title', 'Notifications');
    title.id = 'ntfSheetTitle';
    const close = make('button', 'ghost small ntf-close', 'Close');
    close.type = 'button';
    close.addEventListener('click', () => closeSheet(true));
    head.append(title, close);
    const line = make('p', 'ntf-line');
    line.setAttribute('role', 'status');
    const retry = make('button', 'ghost small ntf-retry', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => load());
    const needsHead = make('h3', 'ntf-h', 'Needs you');
    const needs = make('ul', 'ntf-list ntf-needs');
    needs.setAttribute('aria-label', 'Needs you');
    const recentHead = make('h3', 'ntf-h', 'Recent');
    const recentEl = make('ul', 'ntf-list ntf-recent');
    recentEl.setAttribute('aria-label', 'Recent');
    const settings = make('button', 'ghost small ntf-settings', 'Notification settings');
    settings.type = 'button';
    settings.addEventListener('click', () => { closeSheet(false); MuseUI.openSettings?.('notifications'); });
    dlg.append(head, line, retry, needsHead, needs, recentHead, recentEl, settings);
    scrim.addEventListener('click', () => closeSheet(true));
    dlg.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeSheet(true);
      } else if (e.key === 'Tab') {
        const items = focusables(dlg);
        if (!items.length) { e.preventDefault(); return; }
        const first = items[0];
        const last = items[items.length - 1];
        const at = document.activeElement;
        if (e.shiftKey && (at === first || !dlg.contains(at))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (at === last || !dlg.contains(at))) { e.preventDefault(); first.focus(); }
      }
    });
    document.addEventListener('focusin', e => {
      if (!dlg.hidden && e.target && !dlg.contains(e.target) && !document.querySelector('dialog.risk-dialog[open], dialog.confirm-dialog[open]')) {
        (focusables(dlg)[0] ?? dlg).focus();
      }
    });
    (document.body ?? document.documentElement).append(scrim, dlg);
    sheet = { scrim, dlg, line, retry, needs, recentEl, needsHead, recentHead };
    return sheet;
  }

  function needRow(n) {
    const li = make('li', 'ntf-item');
    li.dataset.level = levelOf(n.level);
    li.dataset.key = str(n.key);
    const text = make('div', 'ntf-text');
    text.append(make('span', 'ntf-title', str(n.title) || 'Plenum'), make('span', 'ntf-sub', str(n.text)));
    li.append(text);
    const name = str(n.title) || 'this notice';
    const label = GO[str(n.route)];
    if (label) {
      const b = make('button', 'ghost small ntf-go', label);
      b.type = 'button';
      b.setAttribute('aria-label', `${label}: ${name}`);
      b.addEventListener('click', () => go(n));
      li.append(b);
    }
    // Dismiss: a row whose producer will not clear it (it was kept across a restart, or its routine was deleted) can still be taken down.
    const x = make('button', 'ghost small ntf-dismiss', 'Dismiss');
    x.type = 'button';
    x.setAttribute('aria-label', `Dismiss: ${name}`);
    x.addEventListener('click', () => dismiss(str(n.key)));
    li.append(x);
    return li;
  }

  async function dismiss(key) {
    if (!key) return;
    try {
      await ask('/api/notify/clear', { key });
      open.delete(key);
      sheetNote = '';
    } catch {
      sheetNote = TEXT.dismissFailed;
    }
    paintAll();
  }
  function recentRow(n) {
    const li = make('li', 'ntf-item ntf-past');
    li.dataset.level = levelOf(n.level);
    li.append(make('time', 'ntf-when', when(Number(n.at))), make('span', 'ntf-sentence', sentence(n)));
    return li;
  }

  function paintSheet() {
    if (!sheet || sheet.dlg.hidden) return;
    const s = sheet;
    s.line.textContent = failed ? TEXT.loadFailed : sheetNote;
    s.line.hidden = !s.line.textContent;
    s.line.classList.toggle('ntf-bad', !failed && Boolean(sheetNote));
    s.retry.hidden = !failed;
    // The rows are drawn new: a focused row button would be destroyed and the focus would fall to the page, where the sheet's Escape
    // and Tab handling no longer reach. Remember which row and which button had it, and give it back after drawing.
    const had = document.activeElement;
    const rows = [...s.needs.children];
    const row = had && had !== s.needs && s.needs.contains(had) ? rows.find(li => li.contains(had)) : null;
    const which = row ? (had.classList?.contains('ntf-dismiss') ? 'ntf-dismiss' : 'ntf-go') : '';
    const index = row ? rows.indexOf(row) : -1;
    const needs = [...open.values()];
    s.needs.replaceChildren(...(needs.length ? needs.map(needRow) : [make('li', 'ntf-empty', TEXT.nothingNeeds)]));
    const past = recent.filter(n => sentence(n)).slice(0, RECENT_SHOWN);
    s.recentEl.replaceChildren(...(past.length ? past.map(recentRow) : [make('li', 'ntf-empty', TEXT.nothingYet)]));
    if (!row) return;
    const now = [...s.needs.children].filter(li => li.dataset?.key);
    // The same row when it is still there, else the row that took its place (the next one, or the last), else the sheet itself.
    const same = now.find(li => li.dataset.key === row.dataset.key) ?? now[Math.min(index, now.length - 1)] ?? null;
    const target = same ? same.querySelector(`.${which}`) ?? same.querySelector('.ntf-dismiss') : null;
    (target ?? s.dlg).focus();
  }

  function openSheet(from) {
    const s = ensureSheet();
    opener = from ?? null;
    sheetNote = '';
    s.scrim.hidden = false;
    s.dlg.hidden = false;
    if (typeof s.dlg.show === 'function') s.dlg.show();
    else s.dlg.setAttribute('open', '');
    bell?.setAttribute('aria-expanded', 'true');
    paintSheet();
    paintBell();
    (focusables(s.dlg)[0] ?? s.dlg).focus();
    // The list is read again each time the sheet opens, so it never shows what was true an hour ago.
    load();
  }

  function closeSheet(returnFocus) {
    if (!sheet || sheet.dlg.hidden) return;
    sheet.scrim.hidden = true;
    sheet.dlg.hidden = true;
    if (typeof sheet.dlg.close === 'function') sheet.dlg.close();
    else sheet.dlg.removeAttribute('open');
    bell?.setAttribute('aria-expanded', 'false');
    paintBell();
    if (!returnFocus) return;
    const back = opener && opener.isConnected && !opener.disabled ? opener : bell && !bell.disabled ? bell : null;
    if (back) {
      back.focus?.();
      return;
    }
    // Neither the opener nor the bell can take it (the last thing was cleared, so the bell is out of reach; or the sheet was opened from
    // the away strip): the message box takes it, so the focus is not left nowhere.
    const box = document.getElementById('input');
    if (box && !box.disabled) box.focus?.({ preventScroll: true });
  }

  // ---------- While you were away ----------

  // While the page is in front, the seen mark follows the owner, at most once a minute (a later notice waits for the rest of the minute).
  let lastSeenPost = 0;
  let presentTimer = null;
  function markPresent() {
    const wait = lastSeenPost + PRESENT_EVERY_MS - Date.now();
    if (wait <= 0) { postSeen(); return; }
    if (presentTimer) return;
    presentTimer = setTimeout(() => {
      presentTimer = null;
      if (watching()) postSeen();
    }, wait);
  }

  function postSeen() {
    lastSeenPost = Date.now();
    ask('/api/notify/seen', {}).then(answer => { if (data && Number.isFinite(answer?.seenAt)) data.seenAt = answer.seenAt; }).catch(() => {});
  }

  // The one sentence, made from the notices newer than seenAt that are not cleared. Test and summary notices are not counted.
  function awayText(d, since) {
    const seenAt = Math.max(Number(d?.seenAt) || 0, Number(since) || 0);
    const items = new Map();
    for (const n of list(d?.recent)) {
      if (!isObj(n) || !str(n.key) || n.clearedAt || !(Number(n.at) > seenAt) || special(n.key)) continue;
      if (!items.has(n.key)) items.set(n.key, n);
    }
    let routines = 0; let needs = 0; let problems = 0; let updates = 0;
    for (const n of items.values()) {
      const level = levelOf(n.level);
      if (str(n.key).startsWith('routine:') && level !== 'fyi') routines += 1;
      else if (level === 'needs-you') needs += 1;
      else if (level === 'problem') problems += 1;
      else updates += 1;
    }
    const parts = [];
    if (routines) parts.push(`${routines} ${plural(routines, 'routine did', 'routines did')} not run`);
    if (problems) parts.push(`${problems} ${plural(problems, 'problem', 'problems')}`);
    if (updates) parts.push(`${updates} ${plural(updates, 'update', 'updates')}`);
    if (needs) parts.push(`${needs} ${plural(needs, 'thing needs', 'things need')} you`);
    return parts.length ? `While you were away: ${parts.join(', ')}.` : '';
  }

  function dismissStrip() {
    if (!strip) return;
    strip.remove();
    strip = null;
  }

  function showAway(since) {
    if (!data || failed) return;
    if (!(Number(data.seenAt) > 0)) {
      // The first time this page meets the hub: there is no "away" yet. Start the clock quietly.
      postSeen();
      return;
    }
    if (strip && strip.isConnected) return;
    const text = awayText(data, since);
    if (!text) return;
    const host = document.getElementById('chat');
    if (!host?.parentNode) return;
    const bar = make('div', 'ntf-away');
    bar.setAttribute('role', 'status');
    const words = make('span', 'ntf-away-text', text);
    const show = make('button', 'ghost small ntf-away-show', 'Show');
    show.type = 'button';
    show.addEventListener('click', () => { dismissStrip(); postSeen(); openSheet(null); });
    const x = make('button', 'ghost small ntf-away-close', 'Close');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close this note');
    x.addEventListener('click', () => { dismissStrip(); postSeen(); });
    bar.append(words, show, x);
    host.parentNode.insertBefore(bar, host);
    strip = bar;
    postSeen();
  }

  async function checkAway(since) {
    if (strip && strip.isConnected) return;
    if (await load()) showAway(since);
  }

  // ---------- Settings > Notifications ----------

  function say(key, text, bad) {
    clearTimeout(sayTimers.get(key));
    if (text) said.set(key, { text, bad: bad === true });
    else said.delete(key);
    if (text && !bad) sayTimers.set(key, setTimeout(() => { said.delete(key); drawSaid(); }, SAVED_MS));
    drawSaid();
  }
  function drawSaid() {
    if (!onPage()) return;
    for (const node of view.root.querySelectorAll('[data-say]')) {
      const now = said.get(node.dataset.say);
      const text = now?.text ?? '';
      if (node.textContent !== text) node.textContent = text;
      node.classList.toggle('ntf-bad', now?.bad === true);
    }
  }
  const sayLine = key => {
    const n = make('span', 'ntf-save');
    n.setAttribute('role', 'status');
    n.dataset.say = key;
    return n;
  };

  // A change that failed may still be in force: the server puts it in force before it writes notify.json, and answers 500 when the write
  // fails (or always, while the hub works in memory). So after a failure the settings are read again and shown as the server has them,
  // and the sentence says which it was.
  async function save(key, body) {
    try {
      const answer = await ask('/api/notify/settings', body);
      if (isObj(answer?.settings)) take(answer);
      say(key, TEXT.saved);
    } catch {
      const read = await load();
      const s = isObj(data?.settings) ? data.settings : {};
      const inForce = read && Object.entries(body).every(([part, vals]) => Object.entries(vals).every(([name, v]) => isObj(s[part]) && s[part][name] === v));
      say(key, inForce ? TEXT.unwritten : TEXT.saveFailed, true);
    }
    paintAll();
  }

  async function muteCall(business, minutes) {
    try {
      await ask('/api/notify/mute', { business, minutes });
      say('mute', TEXT.saved);
      await load();
    } catch {
      const read = await load();
      const until = Number((isObj(data?.settings?.mutes) ? data.settings.mutes : {})[business]) || 0;
      const inForce = read && (minutes === 0 ? !(until > Date.now()) : until > Date.now());
      say('mute', inForce ? TEXT.unwritten : TEXT.muteFailed, true);
    }
  }

  // Quiet hours from and to the same time never hold, so the page does not send them; it says so. The time that was not sent stays in
  // its box, and the next change of the other box sends both together: a swap (23:00-07:00 to 07:00-23:00) takes two steps, where
  // refusing each step alone would leave no way to it.
  function saveTime(field, value) {
    const q = isObj(data?.settings?.quiet) ? data.settings.quiet : {};
    const otherField = field === 'from' ? 'to' : 'from';
    const waiting = pendingTime?.field === otherField ? pendingTime.value : null;
    if (value === (waiting ?? q[otherField])) {
      pendingTime = { field, value };
      say('quiet', TEXT.sameTimes, true);
      paintSettings();
      return;
    }
    pendingTime = null;
    save('quiet', { quiet: waiting ? { [field]: value, [otherField]: waiting } : { [field]: value } });
  }

  async function readBusinesses() {
    try {
      const answer = await ask('/api/business');
      businesses = list(answer?.businesses).filter(b => isObj(b) && str(b.id)).map(b => ({ id: b.id, name: str(b.name) || b.id }));
    } catch {
      businesses = null;
    }
    paintSettings();
  }

  function switchRow(title, note, key) {
    const row = make('label', 'switch-row');
    const input = make('input');
    input.type = 'checkbox';
    input.dataset.fk = key;
    const track = make('span', 'switch-track');
    track.setAttribute('aria-hidden', 'true');
    const text = make('span');
    const small = make('small', null, note);
    text.append(title, small);
    row.append(input, track, text);
    return { row, input, small };
  }
  function timeField(label, key) {
    const wrap = make('label', 'ntf-time');
    const input = make('input');
    input.type = 'time';
    input.dataset.fk = key;
    input.setAttribute('aria-label', label);
    wrap.append(make('span', 'ntf-time-label', label), input);
    return { wrap, input };
  }

  function build(body) {
    const root = make('div', 'ntf-root');
    const intro = make('p', 'ntf-intro', TEXT.intro);
    const line = make('p', 'ntf-line');
    line.setAttribute('role', 'status');
    const retry = make('button', 'ghost small ntf-retry', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => load());

    const levels = make('dl', 'ntf-levels');
    for (const [name, note] of [
      ['Needs you', 'Always shown, even in quiet hours. Only a muted business holds it back.'],
      ['Problems', 'Shown right away. In quiet hours they wait for the morning summary.'],
      ['Updates', 'Small news. In quiet hours they wait for the morning summary.'],
    ]) levels.append(make('dt', 'ntf-level', name), make('dd', 'ntf-level-note', note));

    const quiet = switchRow('Quiet hours', TEXT.quietNote, 'quiet-on');
    const from = timeField('From', 'quiet-from');
    const to = timeField('To', 'quiet-to');
    const times = make('div', 'ntf-times');
    times.append(from.wrap, to.wrap);
    quiet.input.addEventListener('change', () => { pendingTime = null; save('quiet', { quiet: { on: quiet.input.checked } }); });
    from.input.addEventListener('change', () => { if (from.input.value) saveTime('from', from.input.value); else paintSettings(); });
    to.input.addEventListener('change', () => { if (to.input.value) saveTime('to', to.input.value); else paintSettings(); });
    for (const box of [from.input, to.input]) box.addEventListener('blur', () => paintSettings());

    const summary = switchRow('Morning summary', 'One note with what waited, at the time you pick.', 'summary-on');
    const at = timeField('At', 'summary-at');
    summary.input.addEventListener('change', () => save('summary', { summary: { on: summary.input.checked } }));
    at.input.addEventListener('change', () => { if (at.input.value) save('summary', { summary: { at: at.input.value } }); else paintSettings(); });

    const muteBox = make('div', 'ntf-mute');
    muteBox.append(make('h3', 'ntf-h', 'Mute a business'));
    const muteNote = make('p', 'ntf-note', 'A muted business sends nothing until the time you pick. What needs you still shows on the bell.');
    const pick = make('div', 'ntf-mute-pick');
    const who = make('select');
    who.dataset.fk = 'mute-who';
    who.setAttribute('aria-label', 'Business to mute');
    const howLong = make('select');
    howLong.dataset.fk = 'mute-for';
    howLong.setAttribute('aria-label', 'For how long');
    for (const [value, label] of [['60', 'For 1 hour'], ['240', 'For 4 hours'], ['day', 'Until tomorrow']]) {
      const o = make('option', null, label);
      o.value = value;
      howLong.append(o);
    }
    const muteBtn = make('button', 'ghost small ntf-mute-btn', 'Mute');
    muteBtn.type = 'button';
    muteBtn.addEventListener('click', () => {
      if (!who.value) return;
      muteCall(who.value, howLong.value === 'day' ? 'day' : Number(howLong.value));
    });
    pick.append(who, howLong, muteBtn);
    const mutes = make('ul', 'ntf-list ntf-mutes');
    mutes.setAttribute('aria-label', 'Muted businesses');
    muteBox.append(muteNote, pick, sayLine('mute'), mutes);

    const test = make('div', 'ntf-test');
    const testBtn = make('button', 'ghost small ntf-test-btn', 'Send a test notification');
    testBtn.type = 'button';
    testBtn.addEventListener('click', async () => {
      say('test', '');
      try {
        await ask('/api/notify/test', {});
        say('test', TEXT.testSent);
      } catch {
        say('test', TEXT.testFailed, true);
      }
    });
    const recentBtn = make('button', 'ghost small ntf-recent-btn', 'Show recent notifications');
    recentBtn.type = 'button';
    recentBtn.addEventListener('click', () => openSheet(recentBtn));
    test.append(testBtn, recentBtn, sayLine('test'));

    const main = make('div', 'ntf-main');
    main.append(levels, quiet.row, times, sayLine('quiet'), summary.row, at.wrap, sayLine('summary'), muteBox, test);
    root.append(intro, line, retry, main);
    body.append(root);
    view = { root, line, retry, main, quiet, from, to, summary, at, who, howLong, muteBox, muteNote, pick, mutes };
  }

  function nameOf(id) {
    return businesses?.find(b => b.id === id)?.name || id;
  }

  function paintSettings() {
    if (!onPage()) return;
    const v = view;
    const ready = Boolean(data);
    v.main.hidden = !ready;
    v.line.textContent = failed && !ready ? TEXT.loadFailed : '';
    v.line.hidden = !v.line.textContent;
    v.retry.hidden = !(failed && !ready);
    if (!ready) return;
    const s = isObj(data.settings) ? data.settings : {};
    const q = isObj(s.quiet) ? s.quiet : {};
    const m = isObj(s.summary) ? s.summary : {};
    const held = n => document.activeElement === n;
    v.quiet.input.checked = q.on === true;
    // A time that was not sent (it equals the other one) stays in its box, next to the sentence, until the other box is changed.
    const shown = field => (pendingTime?.field === field ? pendingTime.value : str(q[field]));
    if (!held(v.from.input)) v.from.input.value = shown('from');
    if (!held(v.to.input)) v.to.input.value = shown('to');
    v.from.input.disabled = v.to.input.disabled = q.on !== true;
    v.summary.input.checked = m.on === true;
    if (!held(v.at.input)) v.at.input.value = str(m.at);
    v.at.input.disabled = m.on !== true;

    const now = Date.now();
    const active = Object.entries(isObj(s.mutes) ? s.mutes : {}).filter(([, until]) => Number(until) > now);
    // The picker only when the business list could be read and has someone to pick.
    const canPick = Boolean(businesses && businesses.length);
    v.pick.hidden = !canPick;
    v.muteNote.hidden = !canPick && !active.length;
    v.muteBox.hidden = !canPick && !active.length;
    if (canPick) {
      const had = v.who.value;
      v.who.replaceChildren(...businesses.map(b => { const o = make('option', null, b.name); o.value = b.id; return o; }));
      if (had && businesses.some(b => b.id === had)) v.who.value = had;
    }
    v.mutes.replaceChildren(...active.map(([id, until]) => {
      const li = make('li', 'ntf-item');
      const text = make('div', 'ntf-text');
      text.append(make('span', 'ntf-title', nameOf(id)), make('span', 'ntf-sub', `Muted until ${when(Number(until))}`));
      const b = make('button', 'ghost small ntf-go', 'Unmute');
      b.type = 'button';
      b.setAttribute('aria-label', `Unmute ${nameOf(id)}`);
      b.addEventListener('click', () => muteCall(id, 0));
      li.append(text, b);
      return li;
    }));
    drawSaid();
  }

  function render(body) {
    for (const t of sayTimers.values()) clearTimeout(t);
    sayTimers.clear();
    said.clear();
    pendingTime = null;
    body.textContent = '';
    build(body);
    paintSettings();
    load();
    readBusinesses();
  }

  function paintAll() {
    paintBell();
    paintSheet();
    paintSettings();
  }

  // ---------- start ----------

  (async function start() {
    await (MuseUI.ready ?? Promise.resolve());
    try {
      bell = makeBell();
      MuseUI.slots?.add?.('titlebar', 'notify', bell, 90);
      paintBell();
    } catch {
      bell = null;
    }
    if (MuseUI.settings && typeof MuseUI.settings.register === 'function') {
      MuseUI.settings.register({ id: 'notifications', scope: 'app', group: 'general', title: 'Notifications', order: 75, render });
    }
    MuseUI.events?.on?.('notice', onNotice);
    MuseUI.events?.on?.('hello', () => { load(); });
    // He is back: the page became visible, its window got the focus (shown from the tray, or clicked), or he pressed a key or the
    // pointer in it (a person is there, even when the system has not said the window is in front). After a start nobody watched, the
    // first return is "away" however long it took, and the news is counted from the server's seen mark only.
    const cameBack = byHand => {
      if (!hiddenAt || (!byHand && !watching())) return;
      const since = hiddenAt;
      const never = unwatched;
      hiddenAt = 0;
      unwatched = false;
      if (never) checkAway(0);
      else if (Date.now() - since > AWAY_AFTER_MS) checkAway(since);
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        if (!hiddenAt) {
          hiddenAt = Date.now();
          // What came while he was looking is seen: only what comes after this moment can be news when he is back.
          clearTimeout(presentTimer);
          presentTimer = null;
          postSeen();
        }
        return;
      }
      cameBack(false);
    });
    window.addEventListener?.('focus', () => cameBack(false));
    for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, () => { if (hiddenAt) cameBack(true); }, true);
    // A page that starts where nobody sees it (a window created hidden, in the tray) draws no strip and marks nothing seen: it waits
    // until he is first there.
    const watchedAtStart = watching();
    if (!watchedAtStart) {
      hiddenAt = Date.now();
      unwatched = true;
    }
    await load();
    if (watchedAtStart) showAway();
  })();
})();
