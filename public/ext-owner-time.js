// The owner-time meter on the Businesses pane, and the marks it is counted from (wave 8; lib/owner-time.mjs holds the count and the
// rule, lib/routes/owner-time.mjs the routes). Two parts, both in this one file:
//   THE BLOCK  A small part at the top of the Businesses pane (public/ext-business.js draws the pane; this file only places its own
//              element inside it, between the pane's head and its tabs' content): your minutes this week against your weekly limit,
//              each business this week and last week, the line that says the leads now hold what can wait (from 80%) or that you are
//              over the time you set (from 100%), what the estimate counts and what it does not, and the weekly limit itself.
//   THE MARKS  What this page saw you do for a business, sent to POST /api/owner-time/mark: an item of your list that came up in front
//              of you ('open'), a move, a scroll or a key on it ('active'), a button pressed on it or in a business's Setup ('press'),
//              and typing in the chat of a folder ('type'; the server counts it only when the folder belongs to a business).
//              The server keeps the clock: the page sends no times and no durations.
// THE CONTRACT THIS PAGE READS (owned by lib/routes/owner-time.mjs; the page uses nothing else of the meter):
//   GET  /api/owner-time                 { estimate, label, counts, doesNotCount, capMinutes, percent, state: 'ok' | 'hold' | 'over', line,
//                                        thisWeek: { ms, minutes, businesses: [{ id, name, ms, minutes, answers }], other: { ms } },
//                                        lastWeek: the same }
//   POST /api/owner-time/mark            { what, item? | business? + kind? | project? }; the answer is not read
//   POST /api/owner-time/cap             { minutes } -> the summary; 400 with one sentence, shown as it is
//   Events: { type: 'owner-time' } (the state or the limit changed), and the pane's own ({ type: 'decisions' }, { type: 'business' }).
// The meter never stands in the way: a mark that fails is dropped without a word, no button waits for it, and this file adds no
// listener that prevents or stops an event. Every text is set through textContent; there is no inline style. Layout and colour are in
// ext-owner-time.css (tokens only). A route that is missing (an older server) leaves the block out; the pane is as it was.
(() => {
  'use strict';
  const MU = window.MuseUI;
  if (!MU?.request) return;

  const TEXT = {
    title: 'Your time this week',
    estimate: 'Estimate',
    what: 'What this counts, and your weekly limit',
    not: 'It does not count:',
    business: 'Business',
    thisWeek: 'This week',
    lastWeek: 'Last week',
    all: 'All businesses',
    other: 'Businesses no longer in Plenum',
    cap: 'Weekly limit for all businesses, in minutes',
    capNote: 'Ten hours is 600. From 80% the leads are told to hold what can wait for next week. Nothing is ever blocked.',
    save: 'Save limit',
    saved: 'The weekly limit is saved.',
    capBad: 'The weekly limit is a whole number of minutes from 1 to 10,080.',
    failed: 'That did not work. Try again.',
    meter: 'Your minutes this week against your weekly limit',
  };
  const ID = /^b_[a-z0-9]{4,16}$/;
  const NUM = /^\d{1,15}$/;
  // The same thing is marked at most this often; a press goes at once.
  const MARK_MS = 15_000;
  // The numbers are read again at most this often.
  const READ_MS = 5000;

  const isObj = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  const arr = v => (Array.isArray(v) ? v : []);
  const str = v => (typeof v === 'string' ? v : '');
  const num = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  function make(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  // "0 min", "under 1 min", "42 min".
  const mins = ms => (num(ms) === 0 ? '0 min' : num(ms) < 30_000 ? 'under 1 min' : `${Math.round(num(ms) / 60_000)} min`);

  // ---------- the marks ----------

  const sentAt = new Map();
  function send(mark, key) {
    const now = Date.now();
    if (key) {
      if (now - (sentAt.get(key) ?? 0) < MARK_MS) return;
      if (sentAt.size > 300) sentAt.clear();
      sentAt.set(key, now);
    }
    try {
      // The answer is not read, and a refusal (a phone that may only read, an older server) is not said: the meter never interrupts.
      Promise.resolve(MU.request('/api/owner-time/mark', { method: 'POST', body: mark })).catch(() => {});
    } catch {
      // A mark that cannot be sent is dropped.
    }
  }

  const paneRoot = () => document.querySelector('.ext-biz');
  const onScreen = el => Boolean(el && el.isConnected && el.getClientRects().length > 0);
  const here = () => document.visibilityState !== 'hidden' && (typeof document.hasFocus !== 'function' || document.hasFocus());

  // What a place on the page belongs to: { item } (an item of the list), { business, kind } (a business being set up, or the Setup tab
  // of one business with its instructions), { project } (the chat's composer), or null for anything else.
  function contextOf(target) {
    const t = target instanceof Element ? target : null;
    if (!t) return null;
    const pane = t.closest('.ext-biz');
    if (pane) {
      if (t.closest('.ot-box')) return null;
      const item = t.closest('.biz-item');
      if (item && NUM.test(str(item.dataset.n))) return { mark: { item: Number(item.dataset.n) }, key: `i|${item.dataset.n}` };
      if (item && ID.test(str(item.dataset.business))) return { mark: { business: item.dataset.business, kind: 'setup' }, key: `s|${item.dataset.business}` };
      const tab = pane.querySelector('#biz-tab-setup');
      const sel = str(pane.querySelector('.biz-switcher')?.value);
      if (tab?.getAttribute('aria-selected') === 'true' && ID.test(sel) && t.closest('.biz-panel')) {
        const kind = t.closest('.biz-charter') ? 'charter' : 'setup';
        return { mark: { business: sel, kind }, key: `${kind}|${sel}` };
      }
      return null;
    }
    if (t.id === 'input' && t.closest('#composer')) {
      const project = str(MU.state?.activeProject);
      return project ? { mark: { project }, key: `p|${project}`, chat: true } : null;
    }
    return null;
  }

  // The items of the list that are in front of the person now: each is marked as opened (the server starts its clock when it is not
  // running; an opening takes no time by itself).
  function markOpen() {
    const root = paneRoot();
    if (!onScreen(root) || !here()) return;
    const high = window.innerHeight || document.documentElement.clientHeight || 0;
    let n = 0;
    for (const item of root.querySelectorAll('.biz-item[data-n]')) {
      if (!NUM.test(str(item.dataset.n))) continue;
      const box = item.getBoundingClientRect();
      if (box.bottom <= 0 || box.top >= high) continue;
      send({ what: 'open', item: Number(item.dataset.n) }, `o|${item.dataset.n}`);
      if (++n >= 12) break;
    }
  }

  // Only what a person does is his time. The Businesses pane gives the focus back and puts its scroll back after every redraw (and it is
  // drawn again whenever a lead writes to a record), so a focus or a scroll counts only shortly after a key, a press, a wheel, a touch or
  // a pointer that really moved; a pointer that rests where it was (the page moved under it) and an event the page made itself
  // (isTrusted false: element.click(), a dispatched event) are not his. Without this, an hour away from a window left in front counted.
  const REAL_MS = 1500;
  let realAt = 0;
  let px = NaN;
  let py = NaN;
  function real(e) {
    if (e?.isTrusted === false) return false;
    const now = Date.now();
    if (e.type === 'focusin' || e.type === 'scroll') return now - realAt <= REAL_MS;
    if (e.type === 'pointermove') {
      if (e.clientX === px && e.clientY === py) return false;
      px = e.clientX;
      py = e.clientY;
    }
    realAt = now;
    return true;
  }

  let lastLook = 0;
  function onActive(e) {
    if (!real(e)) return;
    // Moves and scrolls come many times a second: one look a second is enough.
    const now = Date.now();
    if (now - lastLook < 1000) return;
    lastLook = now;
    const c = contextOf(e.target);
    if (c && !c.chat) send({ what: 'active', ...c.mark }, `a|${c.key}`);
    else if (!c && e.type !== 'pointermove') markOpen();
  }
  function onType(e) {
    if (!real(e)) return;
    const c = contextOf(e.target);
    if (!c) return;
    send({ what: c.chat ? 'type' : 'active', ...c.mark }, `${c.chat ? 't' : 'a'}|${c.key}`);
  }
  function onPress(e) {
    if (!real(e)) return;
    const t = e.target instanceof Element ? e.target : null;
    const c = contextOf(t);
    if (!c || c.chat) return;
    // A press on a button is sent at once; a press anywhere else on the thing is activity.
    if (t.closest('button, [role="button"], input[type="checkbox"], select')) send({ what: 'press', ...c.mark });
    else send({ what: 'active', ...c.mark }, `a|${c.key}`);
  }
  // Listeners that only look: passive, in the capture phase, and none of them prevents or stops anything.
  const LOOK = { capture: true, passive: true };
  document.addEventListener('click', onPress, LOOK);
  document.addEventListener('input', onType, LOOK);
  document.addEventListener('pointermove', onActive, LOOK);
  document.addEventListener('wheel', onActive, LOOK);
  document.addEventListener('scroll', onActive, LOOK);
  document.addEventListener('touchmove', onActive, LOOK);
  document.addEventListener('keydown', onActive, LOOK);
  document.addEventListener('focusin', onActive, LOOK);

  // ---------- the block ----------

  let data = null;
  let missing = false;
  let readAt = 0;
  let reading = false;
  let said = { text: '', bad: false };
  let busy = false;
  let box = null;
  let parts = null;
  let capDraft = null;
  // The phone's access, as public/ext-business.js reads it: the shell's connection tier; on the desktop there is none.
  const belowFull = () => {
    try {
      const shell = window.plenumShell;
      const c = shell && typeof shell.connection === 'function' ? shell.connection() : null;
      const tier = String(c?.tier ?? shell?.tier ?? '');
      return tier === 'approve' || tier === 'read';
    } catch { return false; }
  };

  function buildBox() {
    box = make('section', 'ot-box');
    const title = make('h3', 'ot-title', TEXT.title);
    title.id = 'ot-title';
    box.setAttribute('aria-labelledby', title.id);
    const head = make('div', 'ot-head');
    head.append(title, make('span', 'ot-est', TEXT.estimate));
    const total = make('p', 'ot-total');
    const meter = make('progress', 'ot-meter');
    meter.setAttribute('aria-label', TEXT.meter);
    const line = make('p', 'ot-line');
    line.setAttribute('role', 'status');
    const table = make('table', 'ot-table');
    const thead = make('thead');
    const hr = make('tr');
    for (const [text, cls] of [[TEXT.business, 'ot-name'], [TEXT.thisWeek, 'ot-n'], [TEXT.lastWeek, 'ot-n']]) {
      const th = make('th', cls, text);
      th.scope = 'col';
      hr.append(th);
    }
    thead.append(hr);
    const tbody = make('tbody');
    table.append(thead, tbody);

    const what = make('details', 'ot-what');
    what.append(make('summary', 'ot-what-head', TEXT.what));
    const label = make('p', 'ot-note');
    const counts = make('ul', 'ot-list');
    const notHead = make('p', 'ot-note', TEXT.not);
    const not = make('ul', 'ot-list');
    const cap = make('div', 'ot-cap');
    const capLabel = make('label', 'ot-cap-label', TEXT.cap);
    const input = make('input', 'ot-cap-input');
    input.type = 'number';
    input.min = '1';
    input.max = '10080';
    input.step = '1';
    input.id = 'ot-cap';
    input.inputMode = 'numeric';
    capLabel.htmlFor = input.id;
    const capNote = make('p', 'ot-note', TEXT.capNote);
    capNote.id = 'ot-cap-note';
    input.setAttribute('aria-describedby', capNote.id);
    input.addEventListener('input', () => { capDraft = input.value; });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); saveCap(); } });
    const save = make('button', 'ghost small', TEXT.save);
    save.type = 'button';
    save.addEventListener('click', saveCap);
    const row = make('div', 'ot-cap-row');
    row.append(input, save);
    cap.append(capLabel, row, capNote);
    what.append(label, counts, notHead, not, cap);

    const say = make('p', 'ot-say');
    say.setAttribute('role', 'status');
    say.setAttribute('aria-live', 'polite');
    box.append(head, total, meter, line, table, what, say);
    parts = { total, meter, line, tbody, label, counts, not, input, save, say };
  }

  function rowEl(name, now, before, cls) {
    const tr = make('tr', cls);
    const th = make('th', 'ot-name', name);
    th.scope = 'row';
    tr.append(th, make('td', 'ot-n', mins(now)), make('td', 'ot-n', mins(before)));
    return tr;
  }

  function draw() {
    if (!box || !parts) return;
    const d = data;
    box.hidden = !isObj(d);
    if (!isObj(d)) return;
    const now = isObj(d.thisWeek) ? d.thisWeek : {};
    const before = isObj(d.lastWeek) ? d.lastWeek : {};
    const cap = num(d.capMinutes) || 600;
    const used = Math.round(num(now.ms) / 60_000);
    parts.total.textContent = `About ${used} of ${cap} minutes (${Math.floor(num(d.percent))}%). Last week: about ${Math.round(num(before.ms) / 60_000)}.`;
    parts.meter.max = cap;
    parts.meter.value = Math.min(cap, num(now.ms) / 60_000);
    box.dataset.state = d.state === 'over' ? 'over' : d.state === 'hold' ? 'hold' : 'ok';
    parts.line.textContent = str(d.line);
    parts.line.hidden = !str(d.line);

    const last = new Map(arr(before.businesses).filter(isObj).map(b => [str(b.id), num(b.ms)]));
    const rows = [];
    const seen = new Set();
    for (const b of arr(now.businesses).filter(isObj)) {
      seen.add(str(b.id));
      rows.push(rowEl(str(b.name) || 'A business', num(b.ms), last.get(str(b.id)) ?? 0));
    }
    for (const b of arr(before.businesses).filter(isObj)) if (!seen.has(str(b.id)) && num(b.ms)) rows.push(rowEl(str(b.name) || 'A business', 0, num(b.ms)));
    if (num(now.other?.ms) || num(before.other?.ms)) rows.push(rowEl(TEXT.other, num(now.other?.ms), num(before.other?.ms)));
    rows.push(rowEl(TEXT.all, num(now.ms), num(before.ms), 'ot-all'));
    parts.tbody.replaceChildren(...rows);

    parts.label.textContent = str(d.label);
    parts.counts.replaceChildren(...arr(d.counts).map(s => make('li', '', str(s))));
    parts.not.replaceChildren(...arr(d.doesNotCount).map(s => make('li', '', str(s))));
    // The field keeps what is being typed in it.
    if (document.activeElement !== parts.input) parts.input.value = capDraft ?? String(cap);
    // A paired phone below Full (Approve and watch, Read only) reads the meter and cannot change the limit: the Bridge refuses that POST
    // (lib/remote/tiers.mjs), so the page does not offer it, as the rest of the Businesses pane does (public/ext-business.js belowFull).
    const locked = busy || belowFull();
    parts.input.disabled = locked;
    parts.save.disabled = locked;
    parts.say.textContent = said.text;
    parts.say.classList.toggle('ot-bad', said.bad);
  }

  // Puts the block into the Businesses pane when the pane is there: at the end of the pane, after its panel, where a redraw of the pane
  // leaves it alone. It is a record of his week, so it comes below what waits for him: a program that waits to start stays the first
  // thing on Today, above the list of decisions (merge of item 196 onto wave 7, 18 Nov 2026; fix-biz H1).
  function place() {
    const root = paneRoot();
    if (!root || missing) return false;
    if (!box) buildBox();
    if (box.parentElement !== root) {
      root.append(box);
      draw();
    }
    return true;
  }

  async function read(force) {
    if (missing || reading || (!force && Date.now() - readAt < READ_MS)) return;
    reading = true;
    readAt = Date.now();
    try {
      const res = await MU.request('/api/owner-time');
      if (res.status === 404) missing = true;
      else if (res.ok) {
        const body = await res.json().catch(() => null);
        if (isObj(body)) data = body;
      }
    } catch {
      // The numbers that are shown stay; the next event reads again.
    } finally {
      reading = false;
    }
    if (missing) { box?.remove(); return; }
    draw();
  }

  async function saveCap() {
    if (busy || !parts || belowFull()) return;
    const minutes = Number(parts.input.value);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) {
      said = { text: TEXT.capBad, bad: true };
      draw();
      parts.input.focus();
      return;
    }
    busy = true;
    said = { text: '', bad: false };
    draw();
    try {
      const res = await MU.request('/api/owner-time/cap', { method: 'POST', body: { minutes } });
      const body = await res.json().catch(() => null);
      if (res.ok && isObj(body)) {
        data = body;
        capDraft = null;
        said = { text: TEXT.saved, bad: false };
      } else said = { text: str(body?.error) || TEXT.failed, bad: true };
    } catch {
      said = { text: TEXT.failed, bad: true };
    }
    busy = false;
    draw();
  }

  function show() {
    if (!place()) return;
    read(false);
    markOpen();
  }

  window.addEventListener('plenum:pane', () => setTimeout(show, 0));
  window.addEventListener('plenum:event', e => {
    const type = e.detail?.type;
    if (type === 'owner-time') { if (place()) read(true); }
    else if (type === 'decisions' || type === 'business') setTimeout(show, 200);
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') show(); });

  // For other panels and for the tests: the block's element, a fresh read, and what a place on the page belongs to.
  MU.ownerTime = { node: () => box, refresh: () => { place(); return read(true); }, contextOf: target => contextOf(target)?.mark ?? null };
  show();
})();
