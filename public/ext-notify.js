// ext-notify. Notifications in the page (wave 4, n3): live notices as toasts, a bell in the title bar with a count of what needs you, a sheet
// 'Notifications' (Needs you, Recent), a calm 'While you were away' strip, and Settings > General > Notifications. Adds itself through
// window.MuseUI (app.js). Layout and colour are in ext-notify.css (tokens only).
//
// The server (lib/notify.mjs, lib/routes/notify.mjs) owns every fact; this page shows them and changes them only through the routes.
// THE CONTRACT THIS PAGE READS:
//  - GET /api/notify -> { settings: { quiet: { on, from, to }, mutes: { <business>: untilMs }, summary: { on, at } }, recent: [notice + { clearedAt }]
//    (newest first), open: [notice] (newest first), seenAt, unseen, quietNow, saving }.
//  - POST /api/notify/settings { quiet?, summary? } answers as the GET. POST /api/notify/mute { business, minutes | 'day' } (0 ends a mute).
//    POST /api/notify/test {}. POST /api/notify/seen {}.
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
    muteFailed: 'That could not be changed. Try again.',
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
  let view = null;            // the Settings section on the page
  const said = new Map();
  const sayTimers = new Map();

  const onPage = () => Boolean(view && view.root.isConnected);

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
    if (document.visibilityState === 'visible') markPresent();
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
    const text = make('div', 'ntf-text');
    text.append(make('span', 'ntf-title', str(n.title) || 'Plenum'), make('span', 'ntf-sub', str(n.text)));
    li.append(text);
    const label = GO[str(n.route)];
    if (label) {
      const b = make('button', 'ghost small ntf-go', label);
      b.type = 'button';
      b.setAttribute('aria-label', `${label}: ${str(n.title) || 'this notice'}`);
      b.addEventListener('click', () => go(n));
      li.append(b);
    }
    return li;
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
    s.line.textContent = failed ? TEXT.loadFailed : '';
    s.line.hidden = !failed;
    s.retry.hidden = !failed;
    const needs = [...open.values()];
    s.needs.replaceChildren(...(needs.length ? needs.map(needRow) : [make('li', 'ntf-empty', TEXT.nothingNeeds)]));
    const past = recent.filter(n => sentence(n)).slice(0, RECENT_SHOWN);
    s.recentEl.replaceChildren(...(past.length ? past.map(recentRow) : [make('li', 'ntf-empty', TEXT.nothingYet)]));
  }

  function openSheet(from) {
    const s = ensureSheet();
    opener = from ?? null;
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
    back?.focus?.();
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
      if (document.visibilityState === 'visible') postSeen();
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

  async function save(key, body) {
    try {
      const answer = await ask('/api/notify/settings', body);
      if (isObj(answer?.settings)) take(answer);
      say(key, TEXT.saved);
    } catch {
      say(key, TEXT.saveFailed, true);
    }
    paintAll();
  }

  async function muteCall(business, minutes) {
    try {
      await ask('/api/notify/mute', { business, minutes });
      say('mute', TEXT.saved);
      await load();
    } catch {
      say('mute', TEXT.muteFailed, true);
    }
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
    quiet.input.addEventListener('change', () => save('quiet', { quiet: { on: quiet.input.checked } }));
    from.input.addEventListener('change', () => { if (from.input.value) save('quiet', { quiet: { from: from.input.value } }); else paintSettings(); });
    to.input.addEventListener('change', () => { if (to.input.value) save('quiet', { quiet: { to: to.input.value } }); else paintSettings(); });

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
    if (!held(v.from.input)) v.from.input.value = str(q.from);
    if (!held(v.to.input)) v.to.input.value = str(q.to);
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
      const since = hiddenAt;
      const away = since && Date.now() - since > AWAY_AFTER_MS;
      hiddenAt = 0;
      if (away) checkAway(since);
    });
    await load();
    showAway();
  })();
})();
