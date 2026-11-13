// ext-services. Settings > General > Background services: the one place that says what runs, why not, and has one button to put each
// thing right. It is also where setting up is finished (the hub's first setup, the first business). Under the rows: the two switches,
// Start with Windows and Bring Plenum Hub up when Plenum starts. Adds itself through window.MuseUI (app.js). Layout and colour are in
// ext-services.css (tokens only).
//
// The server (lib/routes/services.mjs, lib/hub-starter.mjs) owns every fact; this page shows them and changes them only through the routes.
// THE CONTRACT THIS PAGE READS (BUSINESS-DESIGN.md section 7):
//  - GET /api/services -> { services: [{ id, label, state: running|starting|stopped|needs-you|off|unknown, why, action: { id, label } |
//    null }], autostart: { supported, on, reason }, hubAtStart: { on, follows }, checking }. From the server's memory: it never waits for
//    the hub's starter. An action whose id starts with "open-" is this page's own (open-accounts, open-hub, open-businesses): it opens
//    that part of Plenum. Every other action is sent to POST /api/services/action { id } (hub-start, hub-setup, hub-check).
//  - POST /api/services/autostart { on }, POST /api/services/hub-at-start { on }, POST /api/services/action { id }: each answers as GET.
//    A refusal shows the server's own sentence and the page stays as the server has it.
//  - Event 'services' (a reading changed, a switch was set elsewhere): read again, only while the section is on the page.
//  - While the section is on the page it asks again every 5 seconds while something is starting or being checked, and every 30 seconds
//    otherwise. Each GET also tells the server that the section is on screen. Nothing is asked before the section is drawn, and nothing
//    after it left the page.
// With the route missing (404) the section says so in one line. A field that is missing is unknown, never an error. Text reaches the page
// through textContent only. This page names no notice id.
(function () {
  const MuseUI = window.MuseUI;
  if (!MuseUI || !MuseUI.settings || typeof MuseUI.settings.register !== 'function') return;

  const FAST_MS = 5000;
  const SLOW_MS = 30000;
  const SAVED_MS = 2500;
  // The sentences of BUSINESS-DESIGN.md section 7.
  const TEXT = {
    intro: 'What Plenum runs in the background, and what it needs from you. Plenum itself opens no window for these.',
    autostart: 'Plenum starts in the tray when you sign in to Windows and shows no window until you open it. To keep Plenum running when you close its window, keep "Keep in tray on close" on, under Desktop.',
    autostartInstalled: 'Start with Windows works in the installed app.',
    autostartNext: 'Start with Windows comes with the next build.',
    hubAtStart: 'Plenum starts the hub and its helper in the background, with no window, while Docker is already running.',
    follows: 'It follows Connect agents until you change it here.',
    notMine: 'Plenum does not change whether the hub\'s helper starts with Windows, hands-off mode, or Docker\'s own settings. It never stops the hub.',
    // The same two sentences for a hub that runs without Docker (engine local), and for one whose way of running is not known (no reading
    // yet, or a value this Plenum does not know): Docker is named only for a hub that runs in Docker.
    hubAtStartLocal: 'Plenum starts the hub and its helper in the background, with no window.',
    notMineLocal: 'Plenum does not change whether the hub\'s helper starts with Windows or hands-off mode. It never stops the hub.',
    hubAtStartAny: 'Plenum starts the hub and its helper in the background, with no window. If the hub runs in Docker, it waits until Docker is already running.',
    notMineAny: 'Plenum does not change whether the hub\'s helper starts with Windows or hands-off mode, or Docker\'s own settings if the hub runs in Docker. It never stops the hub.',
    missing: 'This build of Plenum has no Background services yet.',
    noAnswer: 'Plenum did not answer. Try again.',
    loading: 'Reading what runs...',
  };
  const STATE_WORD = { running: 'Running', starting: 'Starting', stopped: 'Not running', 'needs-you': 'Needs you', off: 'Off', unknown: 'Not known yet' };

  // ---------- helpers (text only) ----------

  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = v => (typeof v === 'string' ? v : '');
  const list = v => (Array.isArray(v) ? v : []);

  // ---------- state ----------

  let data = null;          // the last answer of the routes
  let phase = 'idle';       // idle | loading | ready | missing | error
  let busy = '';            // the control whose change is on its way: an action id, 'autostart' or 'hub-at-start'
  let view = null;          // the parts of the section on the page
  let pollTimer = null;
  let eventTimer = null;
  let wantFocus = '';       // the control to give the focus back to after the next draw
  const said = new Map();   // key -> { text, bad }
  const sayTimers = new Map();

  const onPage = () => Boolean(view && view.root.isConnected);
  const rows = () => list(data?.services).filter(s => isObj(s) && str(s.id));

  // ---------- requests ----------

  async function ask(path, body) {
    const res = await MuseUI.request(path, body === undefined ? {} : { method: 'POST', body });
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(str(answer?.error));
      err.status = res.status;
      throw err;
    }
    return answer;
  }
  const whyNot = err => {
    const text = str(err?.message);
    return !text || /^Request failed \(\d+\)$/.test(text) || err instanceof TypeError ? TEXT.noAnswer : text;
  };

  function schedule() {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (!onPage() || phase === 'missing') return;
    const fast = data?.checking === true || rows().some(s => s.state === 'starting');
    pollTimer = setTimeout(() => { if (onPage() && document.visibilityState !== 'hidden') load(); else schedule(); }, fast ? FAST_MS : SLOW_MS);
  }

  let loading = false;
  let again = false;
  async function load() {
    if (loading || busy) { again = true; return; }
    loading = true;
    if (!data) { phase = 'loading'; paint(); }
    try {
      const answer = await ask('/api/services');
      if (!isObj(answer)) throw new Error('');
      // A change that was sent while this read was on its way answers with newer facts: this one is dropped.
      if (!busy) { data = answer; phase = 'ready'; }
    } catch (err) {
      if (err?.status === 404) { phase = 'missing'; data = null; } else if (!data) phase = 'error';
    }
    loading = false;
    paint();
    schedule();
    if (again) { again = false; if (onPage()) load(); }
  }

  function onEvent() {
    if (!onPage() || phase === 'missing') return;
    clearTimeout(eventTimer);
    eventTimer = setTimeout(() => { if (onPage()) load(); }, 250);
  }

  // ---------- status lines ----------

  function say(key, text, bad, clearAfter) {
    clearTimeout(sayTimers.get(key));
    if (text) said.set(key, { text, bad: bad === true });
    else said.delete(key);
    if (clearAfter) sayTimers.set(key, setTimeout(() => { said.delete(key); drawSaid(); }, SAVED_MS));
    drawSaid();
  }
  function drawSaid() {
    if (!onPage()) return;
    for (const line of view.root.querySelectorAll('[data-say]')) {
      const now = said.get(line.dataset.say);
      const text = now?.text ?? '';
      if (line.textContent !== text) line.textContent = text;
      line.classList.toggle('svc-bad', now?.bad === true);
    }
  }
  const sayLine = key => {
    const n = make('span', 'svc-save');
    n.setAttribute('role', 'status');
    n.dataset.say = key;
    return n;
  };

  // ---------- changes ----------

  // One change at a time. The page shows the server's answer, and the server's own sentence when it refuses.
  async function change(key, path, body, done) {
    if (busy) return;
    busy = key;
    wantFocus = key;
    say(key, '');
    paint();
    try {
      const answer = await ask(path, body);
      if (isObj(answer)) { data = answer; phase = 'ready'; }
      if (done) say(key, done, false, true);
    } catch (err) {
      say(key, whyNot(err), true);
    }
    busy = '';
    paint();
    schedule();
  }

  // The page's own actions: they open another part of Plenum.
  function openPart(id) {
    if (id === 'open-accounts') return void MuseUI.openSettings?.('accounts');
    if (id === 'open-hub') return void MuseUI.openSettings?.('hub');
    if (id === 'open-businesses') {
      // The Businesses pane (public/ext-business.js registers it as 'business'). The Settings page lies over the panes, so it closes first.
      const pane = MuseUI.pane;
      const known = typeof pane?.list === 'function' ? list(pane.list()) : [];
      if (known.includes('business') && typeof pane.open === 'function') {
        document.getElementById('settingsClose')?.click();
        return void pane.open('business');
      }
      say('row-business', 'The Businesses pane is not part of this build yet.', false, true);
    }
    return undefined;
  }

  function press(service) {
    const id = str(service.action?.id);
    if (!id) return;
    if (id.startsWith('open-')) return openPart(id);
    return change(`row-${service.id}`, '/api/services/action', { id });
  }

  // ---------- the section ----------

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
    const root = make('div', 'svc-root');
    const intro = make('p', 'svc-intro', TEXT.intro);
    const line = make('p', 'svc-line');
    line.setAttribute('role', 'status');
    const retry = make('button', 'ghost small svc-retry', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => load());
    const main = make('div', 'svc-main');

    const listEl = make('ul', 'svc-list');
    listEl.setAttribute('aria-label', 'Background services');

    const switches = make('div', 'svc-switches');
    const auto = switchRow('Start with Windows', TEXT.autostart, 'autostart');
    auto.input.addEventListener('change', () => change('autostart', '/api/services/autostart', { on: auto.input.checked }, 'Saved'));
    const atStart = switchRow('Bring Plenum Hub up when Plenum starts', TEXT.hubAtStart, 'hub-at-start');
    atStart.input.addEventListener('change', () => change('hub-at-start', '/api/services/hub-at-start', { on: atStart.input.checked }, 'Saved'));
    switches.append(auto.row, sayLine('autostart'), atStart.row, sayLine('hub-at-start'));

    const foot = make('p', 'svc-foot', TEXT.notMine);
    main.append(listEl, switches, foot);
    root.append(intro, line, retry, main);
    body.append(root);
    view = { root, line, retry, main, listEl, auto, atStart, foot, drawn: '' };
  }

  function serviceRow(service) {
    const state = Object.hasOwn(STATE_WORD, service.state) ? service.state : 'unknown';
    const li = make('li', 'svc-row');
    li.dataset.state = state;
    li.dataset.row = `row-${service.id}`;
    li.tabIndex = -1;
    const dot = make('span', 'svc-dot');
    dot.dataset.state = state;
    dot.setAttribute('aria-hidden', 'true');
    const text = make('div', 'svc-text');
    const top = make('div', 'svc-top');
    top.append(make('span', 'svc-name', str(service.label) || service.id), make('span', 'svc-word', service.id === 'sign-ins' && state === 'running' ? 'Ready' : STATE_WORD[state]));
    text.append(top, make('p', 'svc-why', str(service.why)));
    li.append(dot, text);
    const action = isObj(service.action) && str(service.action.id) && str(service.action.label) ? service.action : null;
    const key = `row-${service.id}`;
    if (state === 'starting' || busy === key) {
      const mark = make('span', 'spinner svc-progress');
      mark.setAttribute('aria-hidden', 'true');
      li.append(mark);
    }
    if (action) {
      const button = make('button', 'ghost small svc-action', action.label);
      button.type = 'button';
      button.dataset.fk = key;
      button.disabled = Boolean(busy);
      button.setAttribute('aria-label', `${action.label}: ${str(service.label) || service.id}`);
      button.addEventListener('click', () => press(service));
      li.append(button);
    }
    const save = sayLine(key);
    save.classList.add('svc-row-save');
    li.append(save);
    return li;
  }

  function paint() {
    if (!onPage()) return;
    const v = view;
    const ready = phase === 'ready' || Boolean(data);
    v.root.setAttribute('aria-busy', String(Boolean(busy) || phase === 'loading'));
    v.main.hidden = !ready;
    v.retry.hidden = phase !== 'error';
    v.line.textContent = phase === 'missing' ? TEXT.missing : phase === 'error' ? TEXT.noAnswer : phase === 'loading' && !data ? TEXT.loading : '';
    v.line.hidden = !v.line.textContent;
    if (!ready) return;

    // The rows are drawn again only when something in them changed, and the focus stays on the control it was on.
    const drawn = JSON.stringify([rows(), busy]);
    if (drawn !== v.drawn) {
      const held = v.listEl.contains(document.activeElement) ? str(document.activeElement.dataset.fk) || str(document.activeElement.dataset.row) : '';
      v.drawn = drawn;
      v.listEl.replaceChildren(...rows().map(serviceRow));
      if (held && !wantFocus) wantFocus = held;
    }

    const a = isObj(data.autostart) ? data.autostart : {};
    const supported = a.supported === true;
    v.auto.input.checked = supported && a.on === true;
    v.auto.input.disabled = !supported || Boolean(busy);
    v.auto.small.textContent = supported ? TEXT.autostart : a.reason === 'next-build' ? TEXT.autostartNext : TEXT.autostartInstalled;

    const h = isObj(data.hubAtStart) ? data.hubAtStart : {};
    const engine = str(data.hubEngine);
    const atStartText = engine === 'docker' ? TEXT.hubAtStart : engine === 'local' ? TEXT.hubAtStartLocal : TEXT.hubAtStartAny;
    v.atStart.input.checked = h.on === true;
    v.atStart.input.disabled = Boolean(busy);
    v.atStart.small.textContent = h.follows === true ? `${atStartText} ${TEXT.follows}` : atStartText;
    v.foot.textContent = engine === 'docker' ? TEXT.notMine : engine === 'local' ? TEXT.notMineLocal : TEXT.notMineAny;

    drawSaid();
    if (wantFocus && !busy) {
      // The control the person used, or its row when the control is gone (a button that became a progress mark).
      const target = [...v.root.querySelectorAll('[data-fk]')].find(n => n.dataset.fk === wantFocus && !n.disabled)
        ?? [...v.root.querySelectorAll('[data-row]')].find(n => n.dataset.row === wantFocus);
      wantFocus = '';
      if (target && (document.activeElement === document.body || !document.activeElement || !document.activeElement.isConnected)) target.focus({ preventScroll: true });
    }
  }

  // ---------- Settings section ----------

  // Drawing reads the server's memory (GET /api/services starts nothing by itself that shows). Nothing is read before the section is drawn.
  function render(body) {
    for (const t of sayTimers.values()) clearTimeout(t);
    sayTimers.clear();
    said.clear();
    body.textContent = '';
    build(body);
    paint();
    load();
  }

  (async function start() {
    await (MuseUI.ready ?? Promise.resolve());
    MuseUI.settings.register({ id: 'services', scope: 'app', group: 'general', title: 'Background services', order: 80, render });
    MuseUI.events?.on?.('services', onEvent);
    MuseUI.events?.on?.('hub', onEvent);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && onPage()) load(); });
  })();
})();
