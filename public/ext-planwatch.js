// Plan watch, the page's part (DECISIONS item 153). The server watches every signed-in subscription's plan use, projects each window
// to its reset, and raises one alert when a window will run short or is used up (lib/plan-watch.mjs, lib/routes/plan-watch.mjs).
// This file reads what the server says and places it: the body of the Plan use pop-up (public/ext-quota.js draws the pop-up and
// asks this file for the parts), the one line for each business in the Businesses pane (public/ext-business.js asks businessLine),
// and the alerts strip above the message box. It never makes a sentence about a plan, a pace or a business: `say`, `text` and
// `note` are finished sentences from the server, set with textContent as they are. The words made here are only labels and the
// sentences about this page's own controls.
//
// THE CONTRACT THIS PAGE READS (owned by lib/routes/plan-watch.mjs):
//   GET  /api/plan-watch            { v: 1, at, on, why, settings: { on, paidEveryMin, alerts }, checking, nextCheckAt, note,
//                                     subs: [{ provider, label, signedIn, source: free | replies | request | none, checkedAt, note, state,
//                                              windows: [{ id, name, minutes, usedPercent, resetsAt, pace, projected, say }] }],
//                                     businesses: [{ id, name, state, say, providers, next }],
//                                     alerts: [{ id, level: short | out, provider, window, title, text, at, businesses, seen }] }
//                                   403 { terms: true } until the License Agreement is accepted; 404 when the server has no such route
//   POST /api/plan-watch/settings   { on?, paidEveryMin?, alerts? } -> the settings (400 with one sentence)
//   POST /api/plan-watch/check      {} -> the state after one round of free readings (the same shape as GET)
//   POST /api/plan-watch/seen       { id } -> { ok: true }
//   Event { type: 'plan-watch' }: a reading, a state or an alert changed; the state is read again.
// On a 404 the page stays as it was before this feature: MuseUI.planWatch.mode() is 'legacy' and nothing here draws.
// When the state changes this file fires window event 'plenum:plan-watch' (no detail), which the pop-up and the Businesses pane hear.
// Everything is built with createElement and textContent; no inline style and no innerHTML (strict CSP). Colour and size come from
// the tokens in style.css, through ext-planwatch.css and ext-quota.css.
(function () {
  'use strict';
  const MU = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MU || !MU.request) return;

  const POLL_MS = 5 * 60 * 1000;
  const FIRST_READ_MS = 1200;
  const EVENT_WAIT_MS = 150;
  const DAY = 24 * 3600 * 1000;
  const EVERY = [30, 60, 120, 180, 240, 360];
  // Marks for the cards. Anything else gets its first letter and its own id (the class is simply not styled).
  const MARKS = { anthropic: ['C', 'claude'], codex: ['X', 'codex'], muse: ['M', 'muse'], gemini: ['G', 'gemini'], antigravity: ['A', 'antigravity'], cursor: ['Cu', 'cursor'], grok: ['Gr', 'grok'] };
  // What a window's state is called on its card. The words of the sentences come from the server.
  const PILLS = { fine: 'On track', tight: 'Tight', short: 'Will run short', out: 'Used up', unknown: 'Not known' };
  // The same state while it rests on an early estimate only (projected.sure is false for every window in that state): it may, not it will.
  const EARLY_PILLS = { tight: 'May get tight', short: 'May run short' };
  const TONES = { fine: 'green', tight: 'amber', short: 'amber', out: 'red' };
  const HOW = { free: 'with a free check', replies: 'with its last reply', request: 'with one very small request' };
  const TERMS_TEXT = 'Plan use is watched once the License Agreement is accepted.';

  const arr = v => (Array.isArray(v) ? v : []);
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = v => (typeof v === 'string' ? v : '');
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  const make = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // ---------- what the page holds ----------

  // status: idle (not read yet), ok, missing (404), terms (403 with terms: true), error (anything else; the last good data stays).
  const pw = { status: 'idle', data: null };
  let reading = null;
  let again = false;
  let busyCheck = false;
  const saving = new Set();
  const dismissed = new Set(); // alert ids marked seen here, until the server's answer says so too

  const data = () => (pw.status === 'ok' ? pw.data : null);
  // A subscription that is signed out is not listed (the server says so in its sign-in state); one that is not known (null) is.
  const subs = () => arr(data()?.subs).filter(s => isObj(s) && str(s.provider) && s.signedIn !== false);
  const alerts = () => arr(data()?.alerts).filter(a => isObj(a) && str(a.id));
  const settings = () => (isObj(data()?.settings) ? data().settings : {});
  // An alert that no longer holds (`current === false`, the server computes it) is not new news: it leaves the strip and the count. A server
  // that sends no `current` behaves as before.
  const unseen = () => alerts().filter(a => a.seen !== true && a.current !== false && !dismissed.has(a.id));

  function announce() {
    window.dispatchEvent(new CustomEvent('plenum:plan-watch'));
    paintStrip();
  }

  function adopt(next, status = 'ok') {
    const before = JSON.stringify([pw.status, pw.data]);
    pw.status = status;
    if (status === 'ok') {
      pw.data = next;
      for (const id of [...dismissed]) if (!alerts().some(a => a.id === id && a.seen !== true)) dismissed.delete(id);
    }
    if (before !== JSON.stringify([pw.status, pw.data])) announce();
  }

  // ---------- reading ----------

  async function readOnce() {
    let res;
    try {
      res = await MU.request('/api/plan-watch');
    } catch {
      return; // offline or the server is busy: the page keeps what it has
    }
    const body = await res.json().catch(() => null);
    if (res.status === 404) return adopt(null, 'missing');
    if (res.status === 403 && body?.terms === true) return adopt(null, 'terms');
    if (!res.ok || !isObj(body) || !Array.isArray(body.subs)) {
      if (pw.status === 'idle') pw.status = 'error';
      return undefined;
    }
    return adopt(body);
  }

  // Calls that come while a read runs are folded into one more read after it.
  function load() {
    if (reading) {
      again = true;
      return reading;
    }
    reading = (async () => {
      do {
        again = false;
        await readOnce();
      } while (again);
    })().finally(() => { reading = null; });
    return reading;
  }

  let soon = 0;
  const loadSoon = () => {
    clearTimeout(soon);
    soon = setTimeout(load, EVENT_WAIT_MS);
  };

  // ---------- writing ----------

  async function saveSettings(patch, key) {
    if (saving.has(key)) return;
    saving.add(key);
    try {
      const out = await MU.api('/api/plan-watch/settings', patch);
      const next = isObj(out?.settings) ? out.settings : out;
      if (pw.status === 'ok' && isObj(next)) adopt({ ...pw.data, settings: { ...settings(), ...next } });
    } catch (err) {
      MU.toast?.(err?.message || 'The setting could not be saved.', 'bad');
      announce(); // the control goes back to what the server holds
    } finally {
      saving.delete(key);
    }
  }

  async function checkNow() {
    if (busyCheck) return;
    busyCheck = true;
    announce();
    try {
      const out = await MU.api('/api/plan-watch/check', {});
      if (isObj(out) && Array.isArray(out.subs)) {
        adopt(out);
      } else {
        await load();
      }
    } catch (err) {
      MU.toast?.(err?.message || 'Plan use could not be checked.', 'bad');
    } finally {
      busyCheck = false;
      announce();
    }
  }

  async function markSeen(list) {
    for (const a of list) dismissed.add(a.id);
    announce();
    await Promise.all(list.map(a => MU.api('/api/plan-watch/seen', { id: a.id }).catch(() => dismissed.delete(a.id))));
    await load();
    announce();
  }

  // ---------- small words ----------

  // "Sat 3:10 PM" in the PC's own time zone; a date is added when the time is more than six days away.
  function dayTime(ms) {
    const when = new Date(ms);
    const far = Math.abs(ms - Date.now()) > 6 * DAY;
    // en-US like the server's sentences, so the card and the alert read the same on every PC.
    return when.toLocaleString('en-US', far
      ? { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }
      : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }

  function agoText(ms) {
    const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (secs < 60) return 'just now';
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins} ${mins === 1 ? 'minute' : 'minutes'} ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
    const days = Math.round(hours / 24);
    return `${days} days ago`;
  }

  function checkedLine(sub) {
    const at = num(sub.checkedAt);
    if (at === null) return sub.source === 'none' ? '' : 'Not checked yet.';
    if (sub.source === 'request' && Date.now() - at < 90_000) return 'Asked just now, with one very small request.';
    const how = HOW[sub.source];
    return `Checked ${agoText(at)}${how ? `, ${how}` : ''}.`;
  }

  // ---------- the pop-up's parts ----------

  const pillOf = sub => {
    const state = str(sub.state);
    const inState = arr(sub.windows).filter(w => isObj(w) && str(w.projected?.state) === state);
    const early = inState.length > 0 && inState.every(w => w.projected.sure !== true);
    return [(early && EARLY_PILLS[state]) || PILLS[state] || PILLS.unknown, TONES[state] ?? ''];
  };

  function windowRow(sub, w) {
    const row = make('div', 'ext-quota-win');
    const name = str(w.name) || 'Plan window';
    const used = num(w.usedPercent);
    const reset = num(w.resetsAt);
    // A limit whose reset time has passed and that has no newer reading: its number is the one from before the reset, so it is said as
    // that and no bar is drawn (the server's sentence says that Plenum is waiting for a new reading).
    const past = reset !== null && reset <= Date.now();
    const line = make('div', 'ext-quota-win-line');
    line.append(make('span', 'ext-quota-win-name', name), make('span', 'ext-quota-win-pct', used === null ? 'no percentage reported' : past ? `was ${Math.round(used)}% before the reset` : `used ${Math.round(used)}%`));
    row.append(line);
    if (used !== null && !past) {
      const meter = document.createElement('meter');
      meter.setAttribute('min', '0');
      meter.setAttribute('max', '100');
      meter.setAttribute('low', '80');
      meter.setAttribute('high', '95');
      meter.setAttribute('optimum', '0');
      meter.setAttribute('value', String(Math.min(100, Math.max(0, used))));
      meter.setAttribute('aria-label', `${str(sub.label) || sub.provider} ${name}, ${Math.round(used)}% used`);
      row.append(meter);
    }
    row.append(make('p', 'ext-quota-win-reset', reset === null ? 'Reset time not reported' : past ? `Reset ${dayTime(reset)}` : `Resets ${dayTime(reset)}`));
    if (str(w.say)) {
      const say = make('p', 'pw-say', w.say);
      const state = str(w.projected?.state);
      if (state) say.dataset.state = state;
      row.append(say);
    }
    return row;
  }

  // `refresh` is ext-quota.js's own Refresh for the provider (a reading that can send one very small request); it is given back as
  // a button so the pop-up keeps one way to ask for it. Null when that provider has none.
  function subCard(sub, refresh) {
    const [pill, tone] = pillOf(sub);
    const [mark, key] = MARKS[sub.provider] ?? [(str(sub.label) || sub.provider).slice(0, 1).toUpperCase(), sub.provider];
    const windows = arr(sub.windows).filter(isObj);
    // The line under the name says when and how the newest reading was taken; with no reading it is the old "Plan limits not shown".
    const checked = checkedLine(sub);
    const card = MU.cardShell(mark, key, str(sub.label) || sub.provider, checked || (windows.length ? 'Plan limits' : 'Plan limits not shown'), pill, tone === 'green');
    card.classList.add('pw-sub');
    card.dataset.provider = sub.provider;
    const body = make('div', 'card-body ext-quota-card-body');
    for (const w of windows) body.append(windowRow(sub, w));
    if (str(sub.note)) body.append(make('p', 'ext-quota-note pw-note', sub.note));
    const button = refresh ? refresh(sub.provider) : null;
    if (button) body.append(button);
    card.append(body);
    return card;
  }

  function alertItem(a) {
    const item = make('article', 'pw-alert');
    item.dataset.level = str(a.level);
    item.dataset.seen = a.seen === true || dismissed.has(a.id) ? '1' : '0';
    const holds = a.current !== false;
    item.dataset.current = holds ? '1' : '0';
    const head = make('div', 'pw-alert-head');
    if (item.dataset.seen === '0' && holds) head.append(make('span', 'pw-new', 'New'));
    head.append(make('span', 'pw-alert-title', str(a.title) || 'Plan use'));
    item.append(head);
    if (str(a.text)) item.append(make('p', 'pw-alert-text', a.text));
    const at = num(a.at);
    if (at !== null) item.append(make('p', 'pw-alert-at', `Raised ${agoText(at)}.`));
    if (!holds) item.append(make('p', 'pw-alert-gone', 'This is no longer the case.'));
    if (item.dataset.seen === '0' && holds) {
      const seen = make('button', 'ghost small', 'Seen');
      seen.type = 'button';
      seen.dataset.fk = `alert|${a.id}`;
      seen.setAttribute('aria-label', `Mark seen: ${str(a.title) || 'plan use alert'}`);
      seen.addEventListener('click', () => markSeen([a]));
      item.append(seen);
    }
    return item;
  }

  function alertsSection() {
    const list = alerts().slice(0, 10);
    if (!list.length) return null;
    const box = make('section', 'pw-alerts');
    box.setAttribute('aria-label', 'Plan use alerts');
    box.append(make('h3', 'pw-h', 'Alerts'));
    for (const a of list) box.append(alertItem(a));
    return box;
  }

  function checkBar() {
    const d = data();
    const box = make('div', 'pw-check');
    const button = make('button', 'primary small', d.checking === true || busyCheck ? 'Checking…' : 'Check now');
    button.type = 'button';
    button.dataset.fk = 'check';
    button.disabled = d.checking === true || busyCheck;
    button.setAttribute('aria-busy', String(button.disabled));
    button.addEventListener('click', checkNow);
    box.append(button);
    const next = num(d.nextCheckAt);
    if (d.on === true && settings().on !== false && next !== null && next > Date.now()) box.append(make('span', 'ext-quota-note pw-next', `Next automatic check: ${dayTime(next)}.`));
    // What the last Check now did and did not ask (for example that a very small request kept to its budget): the server's sentence.
    if (str(d.note)) box.append(make('p', 'ext-quota-note pw-note', d.note));
    return box;
  }

  function everyOptions(current) {
    const list = [[0, 'Never']];
    const mins = [...new Set([...EVERY, ...(Number.isInteger(current) && current > 0 ? [current] : [])])].sort((a, b) => a - b);
    for (const m of mins) list.push([m, m % 60 === 0 ? (m === 60 ? 'Every hour' : `Every ${m / 60} hours`) : `Every ${m} minutes`]);
    return list;
  }

  function switchRow(label, checked, key, onChange) {
    const row = make('label', 'pw-switch');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = checked;
    box.dataset.fk = key;
    box.addEventListener('change', () => onChange(box.checked));
    row.append(box, make('span', 'pw-switch-text', label));
    return row;
  }

  function settingsSection() {
    const s = settings();
    const d = data();
    const box = make('section', 'pw-settings');
    box.setAttribute('aria-label', 'Plan watch settings');
    box.append(make('h3', 'pw-h', 'Automatic checks'));
    box.append(switchRow('Check plan use by itself', s.on !== false, 'set|on', on => saveSettings({ on }, 'on')));
    // Why the watch is not running (switched off, waiting for the License Agreement, or off for this start): the server's sentence.
    if (d.on === false && str(d.why)) box.append(make('p', 'ext-quota-note pw-why', d.why));
    const label = make('label', 'pw-every');
    label.append(make('span', 'pw-switch-text', 'Checks that send a very small request'));
    const select = document.createElement('select');
    select.dataset.fk = 'set|every';
    select.setAttribute('aria-label', 'How often a check may send a very small request');
    const current = Number.isInteger(s.paidEveryMin) ? s.paidEveryMin : 60;
    for (const [value, text] of everyOptions(current)) {
      const option = make('option', '', text);
      option.value = String(value);
      option.selected = value === current;
      select.append(option);
    }
    select.addEventListener('change', () => saveSettings({ paidEveryMin: Number(select.value) }, 'every'));
    label.append(select);
    box.append(label);
    box.append(make('p', 'ext-quota-note', 'A check of Claude Code or Muse Code sends one very small request to that provider. A reply from either one also brings its plan use. While nothing changes, Plenum asks less often: every 6 hours at most.'));
    box.append(switchRow('Alert me before a plan runs out', s.alerts !== false, 'set|alerts', on => saveSettings({ alerts: on }, 'alerts')));
    return box;
  }

  // The parts of the pop-up in watch mode: the alerts, one card for each subscription, the check, the settings.
  // `refresh(provider)` gives ext-quota.js's Refresh button for that provider, or null.
  function body(refresh) {
    const parts = [];
    const list = alertsSection();
    if (list) parts.push(list);
    const cards = make('div', 'ext-quota-cards');
    const all = subs();
    for (const sub of all) cards.append(subCard(sub, refresh));
    if (!all.length) cards.append(make('p', 'ext-quota-note', 'No subscription is signed in yet.'));
    parts.push(cards, checkBar(), settingsSection());
    return parts;
  }

  // ---------- the line for a business ----------

  function businessLine(id) {
    const b = arr(data()?.businesses).find(x => isObj(x) && x.id === id);
    if (!b || !str(b.say)) return null;
    const state = str(b.state);
    const node = make('p', `biz-line pw-biz${state === 'out' ? ' biz-line-bad' : state === 'short' || state === 'tight' ? ' biz-line-warn' : ''}`, b.say);
    if (state) node.dataset.state = state;
    return node;
  }

  // ---------- the alerts strip ----------

  let strip = null; // { node, handle, key }

  function paintStrip() {
    const list = settings().alerts === false ? [] : unseen();
    const key = list.map(a => a.id).join('|');
    if (!list.length) {
      if (strip) {
        strip.handle.remove();
        strip = null;
      }
      return;
    }
    if (strip && strip.key === key) return;
    // The first unseen alert that still holds leads (the server puts the worst of a round first); the others are counted. The focus is kept
    // when the strip is drawn again with the same button.
    const lead = list[0];
    const held = strip?.node.contains(document.activeElement) ? document.activeElement.dataset.fk : '';
    const node = make('div', 'pw-strip');
    node.setAttribute('role', 'status');
    node.dataset.level = str(lead.level);
    const text = make('div', 'pw-strip-text');
    text.append(make('strong', 'pw-strip-title', str(lead.title) || 'Plan use'));
    if (str(lead.text)) text.append(make('span', 'pw-strip-body', ` ${lead.text}`));
    if (list.length > 1) text.append(make('span', 'pw-strip-more', ` ${list.length - 1} more ${list.length === 2 ? 'alert' : 'alerts'}.`));
    const row = make('div', 'pw-strip-row');
    if (typeof MU.openPlanUse === 'function') {
      const open = make('button', 'ghost small', 'Plan use');
      open.type = 'button';
      open.dataset.fk = 'strip|open';
      open.addEventListener('click', () => MU.openPlanUse(open));
      row.append(open);
    }
    const seen = make('button', 'ghost small', list.length > 1 ? 'All seen' : 'Seen');
    seen.type = 'button';
    seen.dataset.fk = 'strip|seen';
    seen.addEventListener('click', () => markSeen(unseen()));
    row.append(seen);
    node.append(text, row);
    if (strip) strip.handle.remove();
    strip = { node, key, handle: MU.slots.add('bannerSlot', 'ext-planwatch', node, 15) };
    if (held) node.querySelector(`[data-fk="${held}"]`)?.focus();
  }

  // ---------- wiring ----------

  MU.planWatch = {
    // 'watch' when the server answers the plan watch, else 'legacy' (the pop-up is as it was before the feature).
    mode: () => (pw.status === 'ok' ? 'watch' : 'legacy'),
    // A sentence for the pop-up in legacy mode when the reason is the License Agreement.
    notice: () => (pw.status === 'terms' ? make('p', 'ext-quota-note pw-note', TERMS_TEXT) : null),
    body,
    businessLine,
    load,
    unseenCount: () => unseen().length,
    // Whether the first read has an answer (of any kind). Until then nobody can tell whether an alert waits.
    settled: () => pw.status !== 'idle',
  };

  window.addEventListener('plenum:event', event => {
    if (event.detail?.type === 'plan-watch') loadSoon();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') load();
  }, POLL_MS);
  Promise.resolve(MU.ready).then(() => setTimeout(load, FIRST_READ_MS), () => {});
})();
