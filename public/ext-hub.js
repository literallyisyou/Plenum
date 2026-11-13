// ext-hub. Settings > Agents > Plenum Hub: whether the hub answers, the switch that lets models use it as their own agents, the switch that
// keeps Ask first on, what waits for the person, the agents Plenum has used, the addresses and Test connection, and a
// "Hub N" chip in the title bar. Adds itself through window.MuseUI (app.js). Layout and colour are in ext-hub.css (shared tokens only).
//
// The server (lib/routes/hub.mjs, lib/hub.mjs) owns every fact; this page shows them and never holds a token.
//  - GET /api/hub/status -> the whole picture, from the server's memory (it never reaches the hub). Read after MuseUI.ready, on 'hello'
//    (a reconnect) and on each 'hub' event.
//  - Event 'hub': { health, waiting, agents, settings, starter, paused } replaces what the page knows. The page never polls the hub.
//  - Nothing of the hub runs until the person turns it on or looks at this section. The Settings page draws every section when it opens,
//    so being drawn is not being looked at: an IntersectionObserver tells when the card is really on screen, which means at least half
//    of it (or a card that fills a good part of the window) for about a second, so scrolling past it reaches nothing. Then, and only
//    then, the page asks for one real check (POST /api/hub/refresh) and tells the server every 20 seconds that the section is still on
//    screen (POST /api/hub/watch { open: true }); when the card leaves the screen it says so ({ open: false }) and the server stops
//    checking. A window that was hidden asks for one check when it is seen again, so the card never shows a stale "Not connected".
//  - POST /api/hub/refresh (Check now), /settings, /test and /revoke. There is no key to enter: the server asks the hub's own starter.
// A field that is missing is unknown, never an error; unknown fields are ignored; numbers pass Number.isFinite. Text reaches the page
// through textContent only. The page holds no key of any kind.
(function () {
  const MuseUI = window.MuseUI;
  if (!MuseUI || !MuseUI.settings || typeof MuseUI.settings.register !== 'function') return;

  const HUB_NAME = 'Plenum Hub';
  const SAVED_MS = 2000;
  const WATCH_MS = 20000;
  // The card counts as looked at after it was at least half visible (or filled this share of the window's height) for this long.
  const DWELL_MS = 1000;
  const HALF = 0.5;
  const WINDOW_SHARE = 0.4;
  const HEALTH_WORD = { up: 'Running', paused: 'Paused', checking: 'Checking', odd: 'Unexpected answer', down: 'Not answering', off: 'Not connected' };
  // 'nohub': the agent's last ask failed for a reason that is the whole hub's (down, not set up); the header says it, the row has no word.
  const AGENT_STATE = { ok: 'Ready', paused: 'Paused', killed: 'Stopped', failed: 'No hub tools', nohub: '' };
  // What the starter counts for the person: its own words ("Questions waiting for you", "Calls waiting for an OK"), each with its page.
  const ROWS = [
    ['forYou', 'Questions waiting for you', 'inbox'],
    ['approvals', 'Calls waiting for your OK', 'approvals'],
  ];
  // ---------- helpers (text only) ----------

  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (className, label, onClick) => {
    const b = make('button', className, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = v => (typeof v === 'string' ? v : '');
  const count = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
  let idSeq = 0;
  const uid = base => `${base}-${++idSeq}`;

  // 'just now', '5 min ago', '3 h ago', '12 Oct'. Anything that is not a time gives 'not yet'.
  function ago(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return 'not yet';
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    const d = new Date(ms);
    if (!Number.isFinite(d.getTime())) return 'not yet';
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }

  // ---------- state ----------

  let st = null;              // the latest status, or null before the first answer
  let loading = false;
  let loadError = '';
  let view = null;            // the card's parts for the section on screen
  let refreshing = false;
  let onScreen = false;       // the card is really on screen (not only drawn)
  let watchTimer = null;
  let dwellTimer = null;
  let observer = null;
  let chipHandle = null;
  let chipCount = -1;
  const timers = new Map();

  const settings = () => (isObj(st?.settings) ? st.settings : {});
  const health = () => (isObj(st?.health) ? st.health : {});
  // Counts can be shown whenever the server sends them (null means unknown or the hub is down).
  const countsUsable = () => isObj(st?.waiting);
  const privateUrl = () => str(settings().privateUrl) || str(st?.defaults?.privateUrl);

  // A link is used only when it is plain http on this computer. The server has already checked the address; this is the second look.
  const LOCAL_LINK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?(\/[^\s]*)?$/i;
  const safeHref = url => (typeof url === 'string' && LOCAL_LINK.test(url) ? url : null);
  const linkOf = key => safeHref(st?.links?.[key]);

  function link(text, href, label) {
    const a = make('a', 'hub-link', text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    if (label) a.setAttribute('aria-label', label);
    return a;
  }

  // ---------- loading ----------

  function take(data) {
    if (!isObj(data)) return;
    st = data;
    loadError = '';
    paint();
  }

  async function load() {
    if (loading) return;
    loading = true;
    loadError = '';
    paint();
    try {
      take(await MuseUI.api('/api/hub/status'));
    } catch (err) {
      if (!st) loadError = str(err?.message) || 'Plenum could not read the state of Plenum Hub.';
    } finally {
      loading = false;
      paint();
    }
  }

  // Event 'hub': replace what the page knows, field by field.
  function onEvent(ev) {
    if (!isObj(ev)) return;
    if (!st) { load(); return; }
    const next = { ...st };
    for (const key of ['health', 'agents', 'settings', 'starter', 'paused']) if (key in ev) next[key] = key === 'settings' ? { ...st.settings, ...ev[key] } : ev[key];
    if ('waiting' in ev) next.waiting = ev.waiting;
    st = next;
    paint();
  }

  async function refresh(manual) {
    if (refreshing) return;
    refreshing = true;
    if (view) {
      view.checkBtn.disabled = true;
      view.checkLine.classList.remove('hub-bad');
      view.checkLine.textContent = manual ? 'Checking Plenum Hub…' : '';
    }
    paint();
    try {
      take(await MuseUI.api('/api/hub/refresh', {}));
      if (view) view.checkLine.textContent = '';
    } catch (err) {
      if (view) {
        view.checkLine.textContent = manual ? (str(err?.message) || 'The check did not finish.') : '';
        view.checkLine.classList.toggle('hub-bad', manual === true);
      }
    } finally {
      refreshing = false;
      if (view) view.checkBtn.disabled = false;
      paint();
    }
  }

  // ---------- on screen or not ----------

  // The card came on screen or left it. On screen: one real check now, and a short message every 20 seconds so the server keeps checking.
  // Gone: the server is told at once, and it stops by itself anyway when the messages stop.
  function setOnScreen(yes) {
    if (yes === onScreen) return;
    onScreen = yes;
    clearInterval(watchTimer);
    watchTimer = null;
    if (yes) {
      refresh(false);
      watchTimer = setInterval(beat, WATCH_MS);
      paint();
    } else {
      MuseUI.api('/api/hub/watch', { open: false }).then(take, () => {});
    }
  }
  function beat() {
    if (!view || !view.root.isConnected) { setOnScreen(false); return; }
    // A window nobody can see is not looking at the section: the server's lease runs out by itself.
    if (document.visibilityState === 'hidden') return;
    MuseUI.api('/api/hub/watch', { open: true }).catch(() => {});
  }
  // Half of the card is visible, or the card fills a good part of the window (a card taller than the window can never be half visible).
  function seen(entry) {
    if (entry?.isIntersecting !== true) return false;
    const ratio = typeof entry.intersectionRatio === 'number' ? entry.intersectionRatio : 0;
    if (ratio >= HALF) return true;
    const shown = Number(entry.intersectionRect?.height) || 0;
    const windowHeight = Number(entry.rootBounds?.height) || Number(window.innerHeight) || 0;
    return windowHeight > 0 && shown >= windowHeight * WINDOW_SHARE;
  }
  function observe(root) {
    try { observer?.disconnect(); } catch { /* already gone */ }
    observer = null;
    clearTimeout(dwellTimer);
    dwellTimer = null;
    // Without the observer (it is in every browser Plenum runs in) a drawn card counts as on screen until it is removed.
    if (typeof IntersectionObserver !== 'function') { setOnScreen(true); return; }
    const steps = [];
    for (let i = 0; i <= 20; i++) steps.push(i / 20);
    observer = new IntersectionObserver(entries => {
      const last = entries[entries.length - 1];
      if (!view || last?.target !== view.root) return;
      if (!seen(last)) {
        // Scrolled past, or gone: nothing was asked if it was not looked at for long enough.
        clearTimeout(dwellTimer);
        dwellTimer = null;
        setOnScreen(false);
        return;
      }
      if (onScreen || dwellTimer) return;
      dwellTimer = setTimeout(() => {
        dwellTimer = null;
        if (view && view.root === root && root.isConnected) setOnScreen(true);
      }, DWELL_MS);
    }, { threshold: steps });
    observer.observe(root);
  }
  // The window was hidden (minimised, behind another one) and is seen again while the card is on screen: the server's lease may have run
  // out meanwhile, so ask for one real check now instead of showing "Not connected" until the next 20-second message.
  function onVisible() {
    if (document.visibilityState === 'hidden' || !onScreen) return;
    if (!view || !view.root.isConnected) { setOnScreen(false); return; }
    refresh(false);
  }

  // ---------- the title-bar chip ----------

  function chip() {
    const total = countsUsable() ? count(st.waiting.total) : null;
    const want = total && total > 0 ? total : 0;
    if (want === chipCount) return;
    chipCount = want;
    try { chipHandle?.remove?.(); } catch { /* the slot is already gone */ }
    chipHandle = null;
    if (!want || !MuseUI.slots || typeof MuseUI.slots.add !== 'function' || !MuseUI.ui || typeof MuseUI.ui.chip !== 'function') return;
    const shown = `${want}${st.waiting.capped === true ? '+' : ''}`;
    const node = MuseUI.ui.chip({
      label: `Hub ${shown}`,
      title: `${shown} ${want === 1 && !st.waiting.capped ? 'thing waits' : 'things wait'} for you in ${HUB_NAME}`,
      tone: 'accent',
      onClick: () => { MuseUI.openSettings('hub'); },
    });
    chipHandle = MuseUI.slots.add('titlebar', 'hub', node, 70);
  }

  // ---------- one control's answer line ----------

  function say(line, text, bad, clearAfter) {
    clearTimeout(timers.get(line));
    line.textContent = text;
    line.classList.toggle('hub-bad', bad === true);
    if (clearAfter) timers.set(line, setTimeout(() => { line.textContent = ''; }, SAVED_MS));
  }
  const saveLine = () => {
    const n = make('span', 'hub-save');
    n.setAttribute('role', 'status');
    return n;
  };

  function switchRow(title, note) {
    const row = make('label', 'switch-row');
    const input = make('input');
    input.type = 'checkbox';
    const track = make('span', 'switch-track');
    track.setAttribute('aria-hidden', 'true');
    const text = make('span');
    text.append(title, make('small', null, note));
    row.append(input, track, text);
    return { row, input };
  }

  // ---------- the card ----------

  function build(body) {
    const root = make('div', 'hub-root');

    // Header: health dot with its word, Check now (always there, so "start it, then check again" has a button), Open Plenum Hub.
    const head = make('div', 'hub-head');
    const state = make('span', 'hub-state');
    const dot = make('span', 'hub-dot');
    dot.setAttribute('aria-hidden', 'true');
    const word = make('span', 'hub-word');
    state.append(dot, word);
    const checkBtn = button('ghost small', 'Check now', () => refresh(true));
    const checkLine = make('span', 'hub-save');
    checkLine.setAttribute('role', 'status');
    const open = make('span', 'hub-open');
    head.append(state, checkBtn, checkLine, open);
    const line = make('p', 'hub-line');
    line.setAttribute('role', 'status');
    const starter = make('p', 'hub-line hub-starter');
    starter.setAttribute('role', 'status');
    root.append(head, line, starter);

    // Switches.
    const agents = switchRow('Connect agents to the hub', 'Each model you run gets its own agent on the hub, so it can message other agents and share work.');
    const agentsWhy = make('p', 'hub-why');
    agentsWhy.id = uid('hub-why');
    const agentsSave = saveLine();
    const confirm = switchRow('Ask before a model changes anything on the hub', 'A card asks you before a model sends a message, creates a task or writes a note.');
    const confirmSave = saveLine();
    const noAskSlot = make('div', 'hub-slot');
    const agentsSlot = make('div', 'hub-slot');
    root.append(agentsSlot, agents.row, agentsWhy, agentsSave, confirm.row, confirmSave, noAskSlot);

    // Waiting for you.
    const waitBox = make('section', 'hub-wait');
    waitBox.setAttribute('aria-labelledby', uid('hub-waith'));
    const waitHead = make('h5', 'hub-sub', 'Waiting for you');
    waitHead.id = waitBox.getAttribute('aria-labelledby');
    const big = make('div', 'hub-big');
    const bigNum = make('span', 'hub-num');
    const bigText = make('span', 'hub-numtext');
    big.append(bigNum, bigText);
    const bigNote = make('p', 'hub-note');
    const rows = make('ul', 'hub-rows');
    waitBox.append(waitHead, big, bigNote, rows);
    root.append(waitBox);

    // The agents of the person's models: the ones Plenum has used, and any that has a problem of its own.
    const usedBox = make('section', 'hub-used');
    usedBox.setAttribute('aria-labelledby', uid('hub-usedh'));
    const usedHead = make('h5', 'hub-sub', 'Agents of your models');
    usedHead.id = usedBox.getAttribute('aria-labelledby');
    const usedList = make('ul', 'hub-agents');
    const usedNote = make('p', 'hub-note', 'Plenum gives each model its own agent on the hub, named after the model, the same name the hub’s own starter uses, so the two share one agent.');
    const disconnect = button('ghost small', 'Disconnect Plenum from all agents', () => disconnectAll());
    const disconnectLine = saveLine();
    usedBox.append(usedHead, usedList, usedNote, disconnect, disconnectLine);
    root.append(usedBox);

    // Addresses.
    const addr = make('details', 'hub-addr');
    addr.append(make('summary', null, 'Addresses'));
    const pubField = addressField('Agents address', 'publicUrl');
    const privField = addressField('Admin address', 'privateUrl');
    const starterField = addressField('Hub starter folder', 'starterFolder');
    const about = make('p', 'hub-note', 'This is the Tabletalk Hub program running on this computer. Plenum calls it Plenum Hub.');
    const addrActions = make('div', 'hub-inline');
    const reset = button('ghost small', 'Reset', () => resetAddresses());
    const test = button('ghost small', 'Test connection', () => testConnection());
    addrActions.append(reset, test);
    const addrLine = saveLine();
    const steps = make('ul', 'hub-steps');
    steps.setAttribute('role', 'status');
    addr.append(pubField.box, privField.box, starterField.box, addrActions, addrLine, steps, about);
    addr.addEventListener('keydown', e => {
      if (e.key === 'Escape' && addr.open) { addr.open = false; addr.querySelector('summary')?.focus(); e.stopPropagation(); }
    });
    root.append(addr);

    const foot = make('p', 'hub-foot');
    root.append(foot);
    body.append(root);

    // Until the first paint nothing is claimed: no waiting list, no agents, and the word says what is happening.
    word.textContent = 'Checking';
    dot.dataset.state = 'checking';
    checkBtn.hidden = true;
    waitBox.hidden = true;
    usedBox.hidden = true;

    view = {
      root, state, dot, word, open, line, starter, agents, agentsWhy, agentsSave, agentsSlot, confirm, confirmSave, noAskSlot,
      waitBox, big, bigNum, bigText, bigNote, rows, checkBtn, checkLine,
      usedBox, usedList, disconnect, disconnectLine, addr, pubField, privField, starterField, reset, test, addrLine, steps, foot,
      noticed: false,
    };

    agents.input.addEventListener('change', () => changeSwitch({ agents: agents.input.checked }, agents.input, agentsSave));
    confirm.input.addEventListener('change', () => {
      const never = !confirm.input.checked;
      changeSwitch({ confirm: never ? 'never' : 'writes' }, confirm.input, confirmSave, () => {
        if (never && typeof MuseUI.notice === 'function') MuseUI.notice('hub-no-ask', { after: confirm.row });
      });
    });
  }

  function addressField(label, key) {
    const box = make('div', 'hub-field');
    const id = uid('hub-addr');
    const lab = make('label', 'hub-label', label);
    lab.htmlFor = id;
    const input = make('input', 'hub-input');
    input.id = id;
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    input.addEventListener('change', () => saveAddress(key, input));
    box.append(lab, input);
    return { box, input, key };
  }

  // ---------- drawing ----------

  // Fades the part that changed in 150 ms (opacity only; the stylesheet stops it for reduced motion).
  function fade(node) {
    node.classList.remove('hub-fade');
    void node.offsetWidth;
    node.classList.add('hub-fade');
  }

  let lastShape = '';

  function paint() {
    chip();
    if (!view || !view.root.isConnected) return;
    const v = view;
    const h = health();
    // The first check after the card came on screen shows as Checking, not as the state from before anything was checked.
    const hs = st ? (refreshing && (str(h.state) || 'off') === 'off' ? 'checking' : (str(h.state) || 'off')) : 'checking';
    // A hub that answers but is paused by its owner is "Paused", not "Running".
    const shown = hs === 'up' && isObj(st.paused) ? 'paused' : hs;
    const word = !st ? (loadError ? 'Unknown' : 'Checking') : (HEALTH_WORD[shown] || 'Unknown');
    v.dot.dataset.state = st ? shown : 'checking';
    if (v.word.textContent !== word) { v.word.textContent = word; fade(v.state); }

    // The one line under the header: loading, a load error, or the hub's own sentence while it is not running.
    let line = '';
    let bad = false;
    if (!st) {
      line = loadError || 'Checking Plenum Hub…';
      bad = Boolean(loadError);
    } else if (hs !== 'up') {
      line = hs === 'checking' ? 'Checking Plenum Hub…' : (str(h.message) || (hs === 'off' ? 'Plenum is not connected to the hub and sends nothing to it.' : ''));
      // A hub that is down or not the hub is said calmly: the dot carries the colour, the sentence says what to do. Only a failure of
      // Plenum's own (the status could not be read) is drawn as an error.
      bad = false;
    } else if (isObj(st.paused)) {
      line = str(st.paused.message) || 'Everything on the hub is paused.';
    }
    v.line.textContent = line;
    v.line.classList.toggle('hub-bad', bad);
    v.line.hidden = !line;

    // The hub's starter (a local program that hands out agent keys): a calm sentence while it is missing, not set up or not answering.
    // What is wrong with one agent only (no key, a name that belongs to another computer, paused) is said on that agent's row below.
    const sd = isObj(st?.starter) ? st.starter : {};
    const starterText = sd.state && !['ready', 'unchecked', 'checking', 'reserved', 'nokey', 'paused'].includes(sd.state) ? str(sd.message) : '';
    v.starter.textContent = starterText;
    v.starter.hidden = !starterText;
    // The starter is not set up, not found or too old: no agent can get its key, so no row says "Ready".
    const starterOut = ['notsetup', 'missing', 'older'].includes(sd.state);

    // Open Plenum Hub.
    const home = linkOf('home');
    v.open.replaceChildren();
    if (home) v.open.append(link('Open Plenum Hub', home));
    v.open.hidden = !home;

    const ready = Boolean(st);
    const s = settings();

    // Switches.
    const why = '';
    const agentsOn = s.agents === true;
    v.agents.input.checked = agentsOn;
    v.agents.input.disabled = !ready;
    v.checkBtn.hidden = !ready;
    v.agents.input.removeAttribute('aria-describedby');
    v.agentsWhy.hidden = true;
    v.confirm.input.checked = s.confirm !== 'never';
    v.confirm.input.disabled = !ready;
    // The notice above the switch is drawn when the card is really on screen. A strip shows once per launch, and the Settings page draws
    // every section each time it opens, so a strip drawn with the card would be used up where nobody saw it.
    if (!v.noticed && ready && onScreen && typeof MuseUI.notice === 'function') {
      v.noticed = true;
      MuseUI.notice('hub-agents', { before: v.agents.row });
    }

    // Waiting for you: what the person has to do (messages for you and approvals for you). The secondary line says how many calls wait in all.
    const w = isObj(st?.waiting) ? st.waiting : null;
    const total = count(w?.total);
    const showWait = ready && countsUsable();
    v.waitBox.hidden = !showWait;
    if (showWait) {
      const plus = w.capped === true ? '+' : '';
      v.bigNum.textContent = total === null ? '—' : `${total}${plus}`;
      v.bigText.textContent = total === 0 && !w.partial ? 'Nothing is waiting for you.' : total === null ? 'Plenum does not know the number right now.' : w.partial ? 'or more need your answer' : total === 1 ? 'thing needs your answer' : 'things need your answer';
      v.bigNote.textContent = str(w.note);
      v.bigNote.hidden = !v.bigNote.textContent;
      v.rows.hidden = !(total > 0) || !ROWS.some(([key]) => count(w[key]) !== null);
      const shownRows = ROWS.filter(([key]) => count(w[key]) !== null);
      const shape = JSON.stringify([w, st.links && Object.keys(st.links)]);
      if (shape !== lastShape || !v.rows.childElementCount) {
        lastShape = shape;
        const items = [];
        for (const [key, label, to] of shownRows) {
          const n = count(w[key]);
          const li = make('li', 'hub-row');
          li.append(make('span', 'hub-rowname', label), make('span', 'hub-rowcount', n === null ? '—' : `${n}${plus}`));
          const href = linkOf(to);
          if (href) li.append(link('Open', href, `Open ${label} in ${HUB_NAME}`));
          items.push(li);
        }
        v.rows.replaceChildren(...items);
        fade(v.big);
      }
    }

    // Agents used.
    const list = Array.isArray(st?.agents) ? st.agents.filter(isObj) : [];
    v.usedBox.hidden = !ready;
    v.usedList.replaceChildren(...list.map(a => {
      const li = make('li', 'hub-agent');
      const main = make('span', 'hub-agent-main');
      main.append(make('span', 'hub-agent-name', str(a.name) || 'agent'));
      if (str(a.model)) main.append(make('span', 'hub-agent-model', str(a.model)));
      const meta = make('span', 'hub-agent-meta');
      // "Ready" is said only while the hub answers and its starter can hand out keys; the header says what is wrong otherwise.
      const word = a.state === 'ok' ? (hs === 'up' && !isObj(st.paused) && !starterOut ? AGENT_STATE.ok : '') : a.state === 'nohub' ? '' : (AGENT_STATE[a.state] || 'Unknown');
      const state = make('span', 'hub-agent-state', word);
      state.dataset.state = str(a.state);
      const when = ago(a.lastUsedAt);
      meta.append(make('span', null, when === 'not yet' ? 'not used yet' : `used ${when}`));
      if (word) meta.append(state);
      li.append(main, meta);
      if (str(a.note)) {
        const note = make('span', 'hub-agent-note', str(a.note));
        li.append(note);
      }
      return li;
    }));
    if (!list.length) v.usedList.append(make('li', 'hub-empty', 'No model has used the hub yet.'));
    v.disconnect.hidden = !(list.length || agentsOn);

    // Addresses.
    if (ready) {
      for (const f of [v.pubField, v.privField, v.starterField]) {
        f.box.hidden = f.key === 'starterFolder' && !('starterFolder' in s) && !('starterFolder' in (st.defaults ?? {}));
        if (document.activeElement !== f.input) f.input.value = str(s[f.key]) || str(st.defaults?.[f.key]);
        f.input.placeholder = str(st.defaults?.[f.key]);
      }
    }
    v.addr.hidden = !ready;

    // The footer: what the hub cannot serve yet, from the server's own list.
    const not = Array.isArray(st?.notCovered) ? st.notCovered.filter(x => typeof x === 'string' && x) : [];
    v.foot.textContent = not.length ? `${not.join(' and ')} cannot use the hub yet.` : '';
    v.foot.hidden = !not.length;
  }

  // ---------- actions ----------

  async function changeSwitch(patch, input, save, afterOn) {
    const before = !input.checked;
    input.disabled = true;
    say(save, '');
    try {
      take(await MuseUI.api('/api/hub/settings', patch));
      say(save, 'Saved', false, true);
      if (afterOn) afterOn();
    } catch (err) {
      input.checked = before;
      say(save, str(err?.message) || 'The change was not saved.', true);
    } finally {
      input.disabled = false;
      paint();
    }
  }

  async function disconnectAll() {
    if (!view) return;
    const ok = await MuseUI.confirm({
      title: 'Disconnect Plenum from all agents?',
      body: 'Plenum forgets every agent key it holds and turns "Connect agents to the hub" off. The agents and their keys stay on your hub; Plenum cannot remove them there.',
      action: 'Disconnect',
      tone: 'danger',
    });
    if (!ok || !view) return;
    view.disconnect.disabled = true;
    say(view.disconnectLine, '');
    try {
      const got = await MuseUI.api('/api/hub/revoke', {});
      if (isObj(got?.status)) take(got.status);
      const n = count(got?.revoked);
      say(view.disconnectLine, n === null || n === 0 ? 'Disconnected.' : `Disconnected. Plenum forgot ${n} ${n === 1 ? 'key' : 'keys'}.`, false, true);
    } catch (err) {
      say(view.disconnectLine, str(err?.message) || 'Plenum could not disconnect.', true);
    } finally {
      if (view) view.disconnect.disabled = false;
      paint();
    }
  }

  async function saveAddress(key, input) {
    say(view.addrLine, '');
    const before = str(settings()[key]);
    const value = input.value.trim();
    if (value === before) return;
    try {
      take(await MuseUI.api('/api/hub/settings', { [key]: value === str(st?.defaults?.[key]) ? '' : value }));
      say(view.addrLine, 'Saved', false, true);
    } catch (err) {
      input.value = before || str(st?.defaults?.[key]);
      say(view.addrLine, str(err?.message) || 'The address was not saved.', true);
    }
  }

  async function resetAddresses() {
    say(view.addrLine, '');
    view.reset.disabled = true;
    try {
      const patch = { publicUrl: '', privateUrl: '' };
      if ('starterFolder' in settings()) patch.starterFolder = '';
      take(await MuseUI.api('/api/hub/settings', patch));
      say(view.addrLine, 'Back to the default addresses.', false, true);
    } catch (err) {
      say(view.addrLine, str(err?.message) || 'The addresses were not reset.', true);
    } finally {
      if (view) view.reset.disabled = false;
      paint();
    }
  }

  async function testConnection() {
    const v = view;
    v.test.disabled = true;
    v.steps.replaceChildren(make('li', 'hub-step', 'Testing…'));
    try {
      const got = await MuseUI.api('/api/hub/test', {});
      const steps = Array.isArray(got?.steps) ? got.steps.filter(isObj) : [];
      v.steps.replaceChildren(...steps.map(x => {
        const li = make('li', 'hub-step');
        li.dataset.ok = x.ok === true ? 'yes' : 'no';
        li.append(make('span', 'hub-step-mark', x.ok === true ? 'OK' : 'Failed'), make('span', 'hub-step-text', str(x.text)));
        return li;
      }));
      if (!steps.length) v.steps.replaceChildren(make('li', 'hub-step', 'The test returned nothing.'));
    } catch (err) {
      v.steps.replaceChildren(make('li', 'hub-step hub-bad', str(err?.message) || 'The test did not run.'));
    } finally {
      v.test.disabled = false;
    }
  }

  // ---------- Settings section ----------

  // Drawing the card reaches nothing: the status is read from the server's memory. The hub is checked only once the card is on screen.
  function render(body) {
    body.textContent = '';
    build(body);
    paint();
    // The card is not in the page yet while it is built, so that first paint may have drawn nothing: paint again once it is there.
    setTimeout(paint, 0);
    if (!st) load();
    observe(view.root);
  }

  // ---------- start ----------

  (async function start() {
    await (MuseUI.ready ?? Promise.resolve());
    MuseUI.settings.register({ id: 'hub', scope: 'app', group: 'agents', title: HUB_NAME, order: 40, render });
    MuseUI.events.on('hub', onEvent);
    // A reconnect may be a server that started again and knows nothing of this page: say again that the section is on screen.
    MuseUI.events.on('hello', () => { load(); if (onScreen) refresh(false); });
    if (typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', onVisible);
    load();
  })();
})();
