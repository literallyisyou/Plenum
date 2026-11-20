// ext-brief-notify. Settings > General > Morning and evening brief (wave 8): the switch (off until the owner turns it on), the two times,
// which businesses, when the next brief comes, what happened to the last one, and "Send one now". Adds itself through window.MuseUI
// (app.js). Layout and colour are in ext-brief-notify.css (tokens only).
//
// The server (lib/brief-notify.mjs, lib/routes/brief-notify.mjs) owns every fact and every sentence about a brief; this page shows them
// and changes the settings only through the routes.
// THE CONTRACT THIS PAGE READS:
//  - GET /api/brief-notify -> { settings: { on, morning: { on, at }, evening: { on, at }, businesses: null | [id] }, nextText,
//    last: { text } | null, quiet: { on, from, to }, saving, why? }.
//  - POST /api/brief-notify/settings { on?, morning?, evening?, businesses? } answers as the GET; a 400 carries one sentence in `error`.
//  - POST /api/brief-notify/now {} -> { sent, text }.
//  - GET /api/business -> { businesses: [{ id, name, status }] } for the list of businesses (left out when it cannot be read).
// Text reaches the page through textContent only. No key, token, status number or raw error text is shown: a failure is one sentence,
// the server's own for a value it refused, else a fixed one.
(function () {
  const MuseUI = window.MuseUI;
  if (!MuseUI) return;

  const SAVED_MS = 2500;
  const SLOTS = [['morning', 'Morning brief'], ['evening', 'Evening brief']];
  const TEXT = {
    intro: 'One notification in the morning and one in the evening. For each business it says what was done, what is next, what waits for you and any plan or limit warning. A brief with nothing to say is not sent.',
    on: 'Send the brief',
    onNote: 'Off until you turn it on. It comes to this computer and to your paired phones, and a tap opens Businesses.',
    loadFailed: 'The brief settings could not be loaded. Try again.',
    saveFailed: 'That could not be saved. Try again.',
    nowFailed: 'The brief could not be sent. Try again.',
    saved: 'Saved',
    all: 'Every business',
    allNote: 'Also the ones you add later.',
    noBusiness: 'There is no business yet. The brief starts with your first one.',
    listFailed: 'The list of businesses could not be read, so none can be picked. Try again.',
    noPick: 'There is no business to pick yet, so the brief stays on every business.',
    rules: 'A muted business is left out. If this computer was asleep or Plenum was not running at the time, the brief comes when it is back, unless that is more than 3 hours later. On a phone it follows the switch for approvals and "Only when I am away".',
  };

  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = v => (typeof v === 'string' ? v : '');
  const list = v => (Array.isArray(v) ? v : []);

  let data = null;        // the last answer of GET /api/brief-notify
  let failed = false;
  let businesses = null;  // [{ id, name }] or null when the list could not be read
  let view = null;
  const said = new Map();
  const sayTimers = new Map();
  const onPage = () => Boolean(view && view.root.isConnected);

  // -> { ok, answer }: answer is the parsed body either way (a refused value carries the server's sentence in `error`).
  async function call(path, body) {
    const res = await MuseUI.request(path, body === undefined ? {} : { method: 'POST', body });
    const answer = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, answer };
  }

  let loading = null;
  function load() {
    if (loading) return loading;
    loading = (async () => {
      try {
        const { ok, answer } = await call('/api/brief-notify');
        if (!ok || !isObj(answer) || !isObj(answer.settings)) throw new Error('shape');
        data = answer;
        failed = false;
      } catch {
        failed = true;
      }
      loading = null;
      paint();
      return !failed;
    })();
    return loading;
  }

  async function readBusinesses() {
    try {
      const { ok, answer } = await call('/api/business');
      if (!ok) throw new Error('request');
      businesses = list(answer?.businesses).filter(b => isObj(b) && str(b.id) && b.status !== 'closed').map(b => ({ id: b.id, name: str(b.name) || b.id }));
    } catch {
      businesses = null;
    }
    paint();
  }

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
      node.classList.toggle('bn-bad', now?.bad === true);
    }
  }
  const sayLine = key => {
    const n = make('span', 'bn-say');
    n.setAttribute('role', 'status');
    n.dataset.say = key;
    return n;
  };

  async function save(body) {
    try {
      const { ok, status, answer } = await call('/api/brief-notify/settings', body);
      if (ok && isObj(answer?.settings)) {
        data = answer;
        say('save', TEXT.saved);
      } else {
        // A value the server refused comes with its own sentence; anything else is one fixed sentence.
        say('save', status === 400 && str(answer?.error) ? str(answer.error).slice(0, 200) : TEXT.saveFailed, true);
      }
    } catch {
      say('save', TEXT.saveFailed, true);
    }
    paint();
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

  function build(body) {
    const root = make('div', 'bn-root');
    const intro = make('p', 'bn-note', TEXT.intro);
    const line = make('p', 'bn-line');
    line.setAttribute('role', 'status');
    const retry = make('button', 'ghost small bn-retry', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => { load(); readBusinesses(); });

    const on = switchRow(TEXT.on, TEXT.onNote, 'brief-on');
    on.input.addEventListener('change', () => save({ on: on.input.checked }));

    const slots = {};
    const slotBox = make('div', 'bn-slots');
    for (const [name, title] of SLOTS) {
      const row = make('div', 'bn-slot');
      const sw = switchRow(title, '', `brief-${name}-on`);
      const time = make('input', 'bn-time');
      time.type = 'time';
      time.dataset.fk = `brief-${name}-at`;
      time.setAttribute('aria-label', `${title}: time`);
      sw.input.addEventListener('change', () => save({ [name]: { on: sw.input.checked } }));
      time.addEventListener('change', () => { if (time.value) save({ [name]: { at: time.value } }); else paint(); });
      row.append(sw.row, time);
      slotBox.append(row);
      slots[name] = { sw, time };
    }

    const next = make('p', 'bn-fact bn-next');
    next.setAttribute('role', 'status');
    const last = make('p', 'bn-fact bn-last');
    const why = make('p', 'bn-fact bn-why');

    const biz = make('fieldset', 'bn-biz');
    biz.append(make('legend', 'bn-h', 'Businesses in the brief'));
    const all = make('label', 'bn-check');
    const allInput = make('input');
    allInput.type = 'checkbox';
    allInput.dataset.fk = 'brief-all';
    all.append(allInput, make('span', null, TEXT.all), make('small', 'bn-small', TEXT.allNote));
    allInput.addEventListener('change', () => {
      // Review, 17 Nov 2026: an empty pick would leave every business out of the brief without a word, so "Every business" stays on
      // while the list is unknown (it is read again for the next try) or there is no business to pick.
      if (!allInput.checked && !list(businesses).length) {
        allInput.checked = true;
        say('save', businesses === null ? TEXT.listFailed : TEXT.noPick, true);
        if (businesses === null) readBusinesses();
        return;
      }
      save({ businesses: allInput.checked ? null : list(businesses).map(b => b.id) });
    });
    const picks = make('div', 'bn-picks');
    const none = make('p', 'bn-note', TEXT.noBusiness);
    biz.append(all, picks, none);

    const rules = make('p', 'bn-note bn-rules');
    const nowRow = make('div', 'bn-now');
    const nowBtn = make('button', 'ghost small bn-now-btn', 'Send one now');
    nowBtn.type = 'button';
    nowBtn.addEventListener('click', async () => {
      say('now', '');
      nowBtn.disabled = true;
      try {
        const { ok, answer } = await call('/api/brief-notify/now', {});
        if (!ok) throw new Error('request');
        say('now', str(answer?.text).slice(0, 200) || TEXT.nowFailed, answer?.sent !== true && !str(answer?.text));
      } catch {
        say('now', TEXT.nowFailed, true);
      }
      nowBtn.disabled = false;
    });
    nowRow.append(nowBtn, sayLine('now'));

    const main = make('div', 'bn-main');
    main.append(on.row, slotBox, sayLine('save'), next, last, why, biz, rules, nowRow);
    root.append(intro, line, retry, main);
    body.append(root);
    view = { root, line, retry, main, on, slots, next, last, why, biz, allInput, picks, none, rules };
  }

  // The boxes are rebuilt only when the list of businesses changed; otherwise only their ticks are set, so the box a keyboard user just
  // ticked keeps the focus (review, 17 Nov 2026: every save and every read rebuilt the list and dropped the focus to the page).
  let picksSig = '';
  function paintPicks(chosen) {
    const v = view;
    const known = list(businesses);
    v.none.hidden = known.length > 0 || businesses === null;
    v.picks.hidden = chosen === null || !known.length;
    if (v.picks.hidden) { v.picks.replaceChildren(); picksSig = ''; return; }
    const sig = JSON.stringify(known.map(b => [b.id, b.name]));
    const boxes = [...v.picks.querySelectorAll('input')];
    if (sig === picksSig && boxes.length === known.length) {
      for (const input of boxes) input.checked = chosen.includes(input.dataset.business);
      return;
    }
    const focused = v.picks.contains(document.activeElement) ? str(document.activeElement?.dataset?.business) : '';
    picksSig = sig;
    v.picks.replaceChildren(...known.map(b => {
      const row = make('label', 'bn-check');
      const input = make('input');
      input.type = 'checkbox';
      input.dataset.business = b.id;
      input.checked = chosen.includes(b.id);
      input.addEventListener('change', () => {
        const ids = [...v.picks.querySelectorAll('input')].filter(n => n.checked).map(n => n.dataset.business);
        save({ businesses: ids });
      });
      row.append(input, make('span', null, b.name));
      return row;
    }));
    if (focused) [...v.picks.querySelectorAll('input')].find(n => n.dataset.business === focused)?.focus();
  }

  function paint() {
    if (!onPage()) return;
    const v = view;
    const ready = Boolean(data);
    v.main.hidden = !ready;
    v.line.textContent = failed && !ready ? TEXT.loadFailed : '';
    v.line.hidden = !v.line.textContent;
    v.retry.hidden = !(failed && !ready);
    if (!ready) return;
    const s = isObj(data.settings) ? data.settings : {};
    const held = n => document.activeElement === n;
    v.on.input.checked = s.on === true;
    for (const [name] of SLOTS) {
      const slot = isObj(s[name]) ? s[name] : {};
      const { sw, time } = v.slots[name];
      sw.input.checked = slot.on === true;
      sw.input.disabled = s.on !== true;
      if (!held(time)) time.value = str(slot.at);
      time.disabled = s.on !== true || slot.on !== true;
    }
    v.next.textContent = str(data.nextText);
    v.next.hidden = !v.next.textContent;
    v.last.textContent = str(data.last?.text);
    v.last.hidden = !v.last.textContent;
    v.why.textContent = data.saving === false ? str(data.why) : '';
    v.why.hidden = !v.why.textContent;
    const chosen = Array.isArray(s.businesses) ? s.businesses.filter(id => typeof id === 'string') : null;
    v.allInput.checked = chosen === null;
    paintPicks(chosen);
    const q = isObj(data.quiet) ? data.quiet : {};
    const quiet = q.on === true && str(q.from) && str(q.to)
      ? `No brief comes during quiet hours (${q.from} to ${q.to}): one whose time falls inside them comes when they end. `
      : '';
    v.rules.textContent = quiet + TEXT.rules;
    drawSaid();
  }

  function render(body) {
    for (const t of sayTimers.values()) clearTimeout(t);
    sayTimers.clear();
    said.clear();
    body.textContent = '';
    build(body);
    paint();
    load();
    readBusinesses();
  }

  (async function start() {
    await (MuseUI.ready ?? Promise.resolve());
    if (MuseUI.settings && typeof MuseUI.settings.register === 'function') {
      MuseUI.settings.register({ id: 'brief-notify', scope: 'app', group: 'general', title: 'Morning and evening brief', order: 76, render });
    }
    // A brief that was just sent changes "the last one" and "the next one": read again when its notice arrives.
    MuseUI.events?.on?.('notice', ev => { if (onPage() && str(ev?.notice?.key).startsWith('brief:')) load(); });
  })();
})();
