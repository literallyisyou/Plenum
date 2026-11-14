// ext-programs. Settings > Agents > Programs: the programs a lead can hand a task to. Each program shows whether it can run now (a dot
// and the reason in words), the line that says what it is best at (a text field; the lead reads it), the model it runs on now with a
// menu to set one, a switch, arrows to reorder and the fixed sentence of what is switched on for it. Below them: agents the person
// added from Plenum Hub, with Remove, and a small form to add one. Adds itself through window.MuseUI (app.js). Layout and colour are in
// ext-programs.css (tokens only).
//
// The server (lib/routes/programs.mjs, lib/programs.mjs) owns every fact; this page shows them and changes them only through the routes.
// THE CONTRACT THIS PAGE READS (DELEGATION-DESIGN.md sections 15.3, 15.4 and 15.9):
//  - GET /api/programs -> { v, programs: [{ id, label, via: 'local' | 'hub', provider | agent, on, best, model, waitMin, builtIn, state,
//    why, abilities, bestDefault, modelNow: { ref, label, why } | null }], limits: { hubAtOnce }, hub: { connected, state, wake },
//    claudeTools: 'own' | 'type', newer?, damaged? }. From the server's memory; it starts nothing. state is ready, unknown, off,
//    not-installed, sign-in, limit, other-route, hub-off, hub-down, hub-agent-missing, hub-agent-paused or hub-agent-killed, and why is one
//    whole sentence. An agent on the hub also has hubNote: one sentence about being started ('' until the hub has been asked).
//  - POST /api/programs/check {} -> the same answer plus check: { ok, why?, say? }: the server asks the hub's own list of agents (name,
//    status, presence.wakeable). Sent when the section is drawn and when "Check agents" is pressed, never by a timer.
//  - POST /api/programs { programs, limits } -> the same answer. EVERY change on this page is one such request with the whole record
//    (each entry goes back as it came). "Saved" is said only after the answer; a refusal (400) shows the server's own sentence and
//    the page stays as the server has it.
//  - GET /api/agents (an existing route) -> catalog [{ ref, label }]: the models a program's menu offers (those of its own provider).
//  - Events 'programs' (saved elsewhere), 'providers' (a sign-in or a model list changed) and 'hub' (the hub's state changed): read
//    again, only while the section is on the page.
// Nothing is asked before the section is drawn. With the routes missing (404) the section says so in one line. A field that is missing
// is unknown, never an error. Text reaches the page through textContent only. This page names no notice id.
(function () {
  const MuseUI = window.MuseUI;
  if (!MuseUI || !MuseUI.settings || typeof MuseUI.settings.register !== 'function') return;

  const SAVED_MS = 2500;
  const BEST_MAX = 120;
  const LABEL_MAX = 40;
  const MAX_ENTRIES = 24;
  // The sentences of DELEGATION-DESIGN.md section 15.9 and 15.4.
  const TEXT = {
    top: 'A lead can hand a task to one of these programs. The task then runs inside that program, with the abilities listed under it, inside the approval mode and folders of the chat that asked. In a folder on Ask first, Codex, Gemini CLI and Muse Code start only after your yes on a card in Businesses, because they cannot ask before each step. An agent on Plenum Hub gets the agent type\'s rules written into its task, but Plenum cannot enforce them on another computer. These lines are a start. Write what you find each program best at: the lead reads them.',
    addIntro: 'Add an agent from Plenum Hub: its name on the hub (for example grok-bot), what to call it, what it is best at, and how long Plenum waits for its answer.',
    hubFacts: 'An agent that the hub\'s helper starts on this PC works with the hub\'s tools only: no shell, no files on this PC, no web, and none of your own connectors, rules or memory. It runs in its own work folder for 10 minutes at most. It can read and answer messages, work on tasks, and write notes and files that live on the hub. An agent that is open in its own program, or on another computer, can do whatever that program allows there; the hub cannot tell. Plenum writes the agent type\'s rules (read only, no commands, its folders) into the task, but it cannot enforce them on an agent, least of all on another computer. For work in a folder, pick the program itself. An agent on another computer answers only while its own program is running there.',
    hubStop: 'Stopping a hand-off cancels its task on the hub at once. A run that the hub\'s helper had already started ends by itself within 10 minutes at the latest, and what it already did stays done. To stop an agent at once, pause it in Plenum Hub.',
    checkAgents: 'Check agents',
    checking: 'Asking the hub which agents exist…',
    shareHead: 'Results in the business room',
    shareNote: 'A business\'s room on Plenum Hub is received by every agent that is a member of it, on other computers too (and any agent on the hub can read a room that is not private). Switched on for a business, Plenum posts there a short result line after a task that ran on this PC (the title, the answer and the changed files), and it puts the title and instructions of a task handed to an agent on Plenum Hub into that room. Switched off, none of that goes to the room: such a task goes to the agent alone. It is off until you switch it on for a business.',
    noShare: 'No business has a hub room yet.',
    coderCommands: 'A Coder cannot run commands unless you allow it (Settings > Agents > Coder > Run commands). With it on, Claude Code runs the tests itself, and each command is checked and shown to you in Ask first.',
    skills: 'Skills kept in your Claude folder give their instructions. Reading their other files there can be refused, because Plenum guards sign-in folders. Skills in the project folder work in full.',
    missing: 'This build of Plenum has no Programs page yet.',
    newer: 'These programs were saved by a newer version of Plenum. They are shown here and cannot be changed until Plenum is updated.',
    damaged: 'The saved programs could not be read, so the built-in ones are shown. Saving keeps a copy of the old file as programs.damaged.json.',
    noHubAgents: 'No agent from Plenum Hub yet.',
  };
  const STATE_WORD = {
    ready: 'Ready', unknown: 'Not checked yet', off: 'Switched off', 'not-installed': 'Not installed', 'sign-in': 'Needs sign-in',
    limit: 'At its plan limit', 'other-route': 'Claude uses your API key', 'hub-off': 'Hub not connected', 'hub-down': 'Hub not answering',
    'hub-agent-missing': 'Not found on the hub', 'hub-agent-paused': 'Paused on the hub', 'hub-agent-killed': 'Stopped on the hub',
  };
  // What the person can do about a state. A state whose word says it all gets the next step only.
  const NEXT = {
    'not-installed': 'Install it from Accounts.',
    'sign-in': 'Sign in under Accounts.',
    'other-route': 'Set Claude to the Claude Code sign-in in Accounts.',
    'hub-off': 'Turn on Connect agents under Plenum Hub.',
    'hub-down': 'Start it in Settings > Background services.',
    'hub-agent-missing': 'Check its name, or add the agent in Plenum Hub.',
    'hub-agent-paused': 'Resume it in Plenum Hub.',
    'hub-agent-killed': 'Use another agent, or add a new one in Plenum Hub.',
  };
  // The states whose sentence from the server says more than the word beside the dot.
  const SAYS_MORE = new Set(['limit', 'other-route', 'hub-agent-missing', 'hub-agent-paused', 'hub-agent-killed']);

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
  let idSeq = 0;
  const uid = base => `${base}-${++idSeq}`;
  function icon(name, cls) {
    if (typeof MuseUI.icon === 'function') return MuseUI.icon(name, cls);
    return make('span', cls);
  }

  // ---------- state ----------

  let data = null;            // the last answer of GET or POST /api/programs
  let catalog = null;         // [{ ref, label }] from GET /api/agents; null while not known
  let phase = 'idle';         // idle | loading | ready | missing | error
  let errorText = '';
  let busy = false;           // a change is on its way to the server
  let again = false;          // an event came while a request was running
  let changes = 0;            // how many changes the server has answered; a read that started before one of them is thrown away
  let checking = false;       // the hub's list of agents is being asked
  let checkSay = '';          // what the last look at the hub's agents could not do, in words
  let view = null;            // the parts of the section on the page
  let wantFocus = null;       // focus keys to try after the next draw, in order
  const said = new Map();     // what each status line says now: key -> { text, bad }
  const timers = new Map();

  const entries = () => list(data?.programs).filter(p => isObj(p) && str(p.id));
  const locals = () => entries().filter(p => p.via !== 'hub');
  const hubAgents = () => entries().filter(p => p.via === 'hub');
  const locked = () => data?.newer === true;
  const onPage = () => Boolean(view && view.root.isConnected);
  // A focus key names a control across draws: the program and what the control does.
  const fk = (id, what) => `${id}|${what}`;

  // ---------- requests ----------

  // A request that keeps the status of a refusal, so a missing route (404) can be told from a failure.
  async function get(path) {
    const res = await MuseUI.request(path);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(str(body?.error));
      err.status = res.status;
      throw err;
    }
    return body;
  }

  // The sentence for a change that did not go through: the server's own when it sent one.
  function whyNot(err) {
    const text = str(err?.message);
    if (!text || /^Request failed \(\d+\)$/.test(text) || err instanceof TypeError) return 'The change was not saved. Plenum did not answer; try again.';
    return text;
  }

  function takeCatalog(got) {
    const found = list(got?.catalog).filter(c => isObj(c) && str(c.ref));
    if (found.length) catalog = found.map(c => ({ ref: c.ref, label: str(c.label) || c.ref, offered: c.offered !== false }));
  }

  async function load() {
    if (phase === 'loading' || busy) { again = true; return; }
    const first = !data;
    const at = changes;
    phase = 'loading';
    if (first) paint();
    try {
      const [p, a] = await Promise.all([get('/api/programs'), catalog ? null : get('/api/agents').catch(() => null)]);
      if (!isObj(p) || !Array.isArray(p.programs)) throw new Error('');
      if (a) takeCatalog(a);
      phase = 'ready';
      errorText = '';
      // A change was saved while this read was on its way, so its answer is older than the page: read once more.
      if (at === changes) data = p;
      else again = true;
    } catch (err) {
      if (err?.status === 404) {
        phase = 'missing';
        data = null;
      } else if (data) {
        // A later read that fails leaves what the page knows; the next event reads again.
        phase = 'ready';
      } else {
        phase = 'error';
        errorText = err?.status ? str(err.message) : 'Its server did not answer.';
      }
    }
    paint();
    if (again) { again = false; if (onPage()) load(); }
  }

  // Asks the server to look at the hub's own list of agents (status, online, whether its helper can start each one) and reads the programs again.
  // Done when the section is drawn and when the button is pressed, never by a timer.
  async function checkAgents() {
    if (checking || !onPage() || phase === 'missing' || !data || data.hub?.connected !== true || !hubAgents().length) return;
    checking = true;
    checkSay = TEXT.checking;
    drawCheck();
    const at = changes;
    let fresh = null;
    try {
      const got = await MuseUI.api('/api/programs/check', {});
      checkSay = isObj(got?.check) && got.check.ok === false ? str(got.check.say) : '';
      if (isObj(got) && Array.isArray(got.programs)) fresh = got;
    } catch {
      checkSay = 'Plenum did not answer, so it could not ask which agents exist.';
    }
    checking = false;
    // The answer is the programs as the server has them now; it is shown unless a change was saved while it was on its way (then the page
    // reads again, so that nothing older is drawn over it).
    if (fresh && at === changes && !busy) data = fresh;
    else if (fresh) again = true;
    paint();
    if (again && !busy) { again = false; if (onPage()) load(); }
  }
  function drawCheck() {
    if (!onPage()) return;
    view.hubCheck.textContent = checkSay;
    view.hubCheck.hidden = !checkSay;
    view.checkBtn.disabled = checking;
  }

  // Events: read again, but only while the section is on the page. Several events in a row become one read.
  let eventTimer = null;
  function onEvent() {
    if (!onPage() || phase === 'missing') return;
    clearTimeout(eventTimer);
    eventTimer = setTimeout(() => { if (onPage()) load(); }, 250);
  }

  // ---------- status lines ----------

  function say(key, text, bad, clearAfter) {
    clearTimeout(timers.get(key));
    if (text) said.set(key, { text, bad: bad === true });
    else said.delete(key);
    if (clearAfter) timers.set(key, setTimeout(() => { said.delete(key); drawSaid(); }, SAVED_MS));
    drawSaid();
  }
  function drawSaid() {
    if (!onPage()) return;
    for (const line of view.root.querySelectorAll('[data-say]')) {
      const now = said.get(line.dataset.say);
      const text = now?.text ?? '';
      if (line.textContent !== text) line.textContent = text;
      line.classList.toggle('prog-bad', now?.bad === true);
    }
  }
  const sayLine = key => {
    const n = make('span', 'prog-save');
    n.setAttribute('role', 'status');
    n.dataset.say = key;
    return n;
  };

  // ---------- changes ----------

  // One change: the whole record with `change` applied goes to the server, and the page shows what the server answers.
  // Changes go one at a time, in the order they were made: one that is made while another is on its way waits for that one's answer
  // and is then applied to what the server answered, so no change is dropped and none is built on an old record.
  let queue = Promise.resolve();
  function save(key, change, opts) {
    const run = queue.then(() => saveNow(key, change, opts));
    queue = run.catch(() => {});
    return run;
  }
  async function saveNow(key, change, { focus, after } = {}) {
    if (!data || locked()) return false;
    const next = { programs: entries().map(p => ({ ...p })), limits: { ...(isObj(data.limits) ? data.limits : {}) }, shareRooms: Array.isArray(data.shareRooms) ? data.shareRooms.filter(x => typeof x === 'string') : [], updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : 0 };
    if (change(next) === false) return false;
    busy = true;
    wantFocus = focus ?? null;
    view?.root.setAttribute('aria-busy', 'true');
    say(key, 'Saving…');
    let ok = false;
    try {
      const got = await MuseUI.api('/api/programs', next);
      if (isObj(got) && Array.isArray(got.programs)) data = got;
      changes += 1;
      ok = true;
    } catch (err) {
      say(key, whyNot(err), true);
      // Another window changed the record first: this page reads it again, so the next change is made on what is there now.
      if (err?.status === 409 && !locked()) again = true;
      // Nothing changed, so focus stays on the control that was used and what was typed stays in its field.
      wantFocus = null;
    }
    busy = false;
    view?.root.removeAttribute('aria-busy');
    paint(!ok);
    if (ok) {
      say(key, 'Saved', false, true);
      if (after) after();
    }
    // An event that came while the change was on its way is read now.
    if (again) { again = false; if (onPage()) load(); }
    return ok;
  }

  // Changes one program of the record that is about to be sent; false (nothing is sent) when the program is no longer in it.
  const edit = (id, fn) => rec => {
    const p = rec.programs.find(x => x.id === id);
    if (!p) return false;
    fn(p);
    return true;
  };

  function move(entry, by) {
    const up = by < 0;
    // An arrow moves a program among its own kind; the two kinds keep their places in the record.
    const group = (entry.via === 'hub' ? hubAgents() : locals()).map(p => p.id);
    const at = group.indexOf(entry.id);
    const other = group[at + by];
    if (!other) return;
    save(`row:${entry.id}`, rec => {
      const a = rec.programs.findIndex(p => p.id === entry.id);
      const b = rec.programs.findIndex(p => p.id === other);
      if (a < 0 || b < 0) return false;
      [rec.programs[a], rec.programs[b]] = [rec.programs[b], rec.programs[a]];
      return true;
    }, { focus: [fk(entry.id, up ? 'up' : 'down'), fk(entry.id, up ? 'down' : 'up')] });
  }

  async function setOn(entry, input) {
    const want = input.checked;
    const ok = await save(`row:${entry.id}`, edit(entry.id, p => { p.on = want; }), { focus: [fk(entry.id, 'on')] });
    if (!ok) input.checked = !want;
  }

  // What each field last sent. Leaving a field sends what it holds only when that differs from what it sent last, so a line that
  // Enter already sent, or that the server refused, is not sent a second time by the field losing focus. Enter always sends.
  const sent = new WeakMap();
  function setBest(entry, input, byEnter) {
    const text = input.value.trim();
    if (text === str(entry.best)) return;
    if (!byEnter && sent.get(input) === text) return;
    sent.set(input, text);
    // No focus is named: the person may have gone on to the next control (Tab), and focus stays where they are.
    save(`row:${entry.id}`, edit(entry.id, p => { p.best = text; }));
  }

  function resetBest(entry) {
    save(`row:${entry.id}`, edit(entry.id, p => { p.best = str(entry.bestDefault); }), { focus: [fk(entry.id, 'best')] });
  }

  function setModel(entry, ref) {
    save(`row:${entry.id}`, edit(entry.id, p => { p.model = ref; }), { focus: [fk(entry.id, 'model')] });
  }

  function setWait(entry, input, byEnter) {
    const n = Number(input.value);
    if (n === entry.waitMin) return;
    if (!byEnter && sent.get(input) === n) return;
    sent.set(input, n);
    save(`row:${entry.id}`, edit(entry.id, p => { p.waitMin = n; }));
  }

  function remove(entry) {
    const ids = hubAgents().map(p => p.id);
    const at = ids.indexOf(entry.id);
    const neighbour = ids[at + 1] ?? ids[at - 1];
    save('hub', rec => {
      rec.programs = rec.programs.filter(p => p.id !== entry.id);
      return true;
    }, { focus: [neighbour ? fk(neighbour, 'remove') : '', fk('new', 'name')] });
  }

  function add() {
    const v = view;
    const agent = v.newName.value.trim().toLowerCase();
    if (!agent) { say('hub', 'Give the agent\'s name on the hub.', true); v.newName.focus(); return; }
    const minutes = Number(v.newWait.value);
    save('hub', rec => {
      rec.programs.push({ id: `hub:${agent}`, agent, label: v.newLabel.value.trim(), best: v.newBest.value.trim(), waitMin: minutes, on: true });
      return true;
    }, {
      focus: [fk('new', 'name')],
      after: () => { v.newName.value = ''; v.newLabel.value = ''; v.newBest.value = ''; v.newWait.value = '10'; },
    });
  }

  // One business and its switch: Plenum posts a program's result to its hub room only while the switch is on.
  function shareRow(b, checked) {
    const li = make('li', 'prog-item prog-share-row');
    const name = `${str(b.name) || str(b.id)}, room ${str(b.hubRoom)}`;
    const sw = make('label', 'switch-row prog-switch');
    const input = make('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.dataset.fk = fk(`share:${str(b.id)}`, 'on');
    input.setAttribute('aria-label', `Post results in the hub room of ${name}`);
    input.addEventListener('change', async () => {
      const want = input.checked;
      const ok = await save(`share:${str(b.id)}`, rec => {
        const set = new Set(rec.shareRooms);
        if (want) set.add(str(b.id)); else set.delete(str(b.id));
        rec.shareRooms = [...set];
      }, { focus: [fk(`share:${str(b.id)}`, 'on')] });
      if (!ok) input.checked = !want;
    });
    const track = make('span', 'switch-track');
    track.setAttribute('aria-hidden', 'true');
    sw.append(input, track);
    li.append(make('span', 'prog-name', name), sw, sayLine(`share:${str(b.id)}`));
    return li;
  }

  // ---------- the section ----------

  function section(title, cls) {
    const box = make('section', `prog-sec ${cls}`);
    const head = make('h5', 'prog-sub', title);
    head.id = uid('prog-h');
    box.setAttribute('aria-labelledby', head.id);
    box.append(head);
    return box;
  }

  function field(labelText, input, cls) {
    const wrap = make('label', `prog-field ${cls ?? ''}`.trim());
    wrap.append(make('span', 'prog-flabel', labelText), input);
    return wrap;
  }

  function textInput(max, placeholder) {
    const input = make('input', 'prog-input');
    input.type = 'text';
    input.maxLength = max;
    input.autocomplete = 'off';
    input.spellcheck = true;
    if (placeholder) input.placeholder = placeholder;
    return input;
  }

  // The line a program is best at: one line of text that may be long, so it is a text area that grows to show all of it. A line
  // break cannot be typed or pasted into it; Enter is for the caller (save, or add).
  function lineInput(placeholder) {
    const input = make('textarea', 'prog-input prog-text');
    input.rows = 1;
    input.maxLength = BEST_MAX;
    input.autocomplete = 'off';
    input.spellcheck = true;
    if (placeholder) input.placeholder = placeholder;
    input.addEventListener('input', () => {
      const flat = input.value.replace(/\s*[\r\n]+\s*/g, ' ');
      if (flat !== input.value) input.value = flat;
    });
    return input;
  }

  function build(body) {
    const root = make('div', 'prog-root');
    const line = make('p', 'prog-line');
    line.setAttribute('role', 'status');
    const retry = make('button', 'ghost small prog-retry', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => load());
    const main = make('div', 'prog-main');

    const top = make('p', 'prog-note', TEXT.top);
    const alerts = make('div', 'prog-alerts');
    alerts.setAttribute('role', 'status');

    const localList = make('ol', 'prog-list');
    localList.setAttribute('aria-label', 'Programs on this PC, in your order');

    // Agents the person added from Plenum Hub.
    const hubSec = section('Agents on Plenum Hub', 'prog-hub');
    const hubState = make('p', 'prog-note');
    const hubCheck = make('p', 'prog-note');
    hubCheck.setAttribute('role', 'status');
    hubCheck.hidden = true;
    const checkBtn = make('button', 'ghost small prog-check', TEXT.checkAgents);
    checkBtn.type = 'button';
    checkBtn.dataset.fk = fk('hub', 'check');
    checkBtn.addEventListener('click', () => checkAgents());
    const hubList = make('ol', 'prog-list');
    hubList.setAttribute('aria-labelledby', hubSec.querySelector('h5').id);
    const hubEmpty = make('p', 'prog-empty', TEXT.noHubAgents);

    const form = make('form', 'prog-add');
    form.noValidate = true;
    const newName = textInput(32);
    newName.classList.add('prog-mono');
    newName.dataset.fk = fk('new', 'name');
    newName.autocapitalize = 'off';
    newName.spellcheck = false;
    const newLabel = textInput(LABEL_MAX);
    const newBest = lineInput();
    newBest.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); form.requestSubmit(); } });
    const newWait = make('input', 'prog-input prog-num');
    newWait.type = 'number';
    newWait.min = '1';
    newWait.max = '60';
    newWait.step = '1';
    newWait.value = '10';
    const addBtn = make('button', 'ghost small', 'Add agent');
    addBtn.type = 'submit';
    addBtn.dataset.fk = fk('new', 'add');
    const fields = make('div', 'prog-add-fields');
    fields.append(
      field('Name on the hub', newName, 'prog-f-name'),
      field('What to call it', newLabel, 'prog-f-label'),
      field('Minutes to wait', newWait, 'prog-f-wait'),
      field('What it is best at', newBest, 'prog-f-best'),
    );
    const addRow = make('div', 'prog-actions');
    addRow.append(addBtn, sayLine('hub'));
    form.append(make('p', 'prog-note', TEXT.addIntro), fields, addRow);
    form.addEventListener('submit', e => { e.preventDefault(); add(); });
    const full = make('p', 'prog-note', `Plenum keeps ${MAX_ENTRIES} programs at most. Remove an agent to add another.`);

    hubSec.append(hubState, hubCheck, checkBtn, hubList, hubEmpty, form, full, make('p', 'prog-note', TEXT.hubFacts), make('p', 'prog-note', TEXT.hubStop));
    // The owner's switch per business for posting a program's result to its hub room (off by default).
    const shareSec = section(TEXT.shareHead, 'prog-share');
    const shareList = make('ul', 'prog-list');
    shareList.setAttribute('aria-labelledby', shareSec.querySelector('h5').id);
    const shareEmpty = make('p', 'prog-empty', TEXT.noShare);
    shareSec.append(make('p', 'prog-note', TEXT.shareNote), shareList, shareEmpty);
    main.append(top, alerts, localList, hubSec, shareSec);
    root.append(line, retry, main);
    // Rows that waited for a field to be left are drawn once it is.
    root.addEventListener('focusout', () => {
      if (view?.late) setTimeout(() => { if (onPage() && view.late) paint(); }, 0);
    });
    body.append(root);
    view = { root, line, retry, main, alerts, localList, hubSec, shareSec, shareList, shareEmpty, hubState, hubCheck, checkBtn, hubList, hubEmpty, form, full, newName, newLabel, newBest, newWait, addBtn, shape: '' };
  }

  // ---------- drawing ----------

  function paint(keepRows) {
    if (!onPage()) return;
    const v = view;
    // The focus keys a change asked for wait until that change is drawn. A draw that comes while the change is on its way (an older
    // read that ends, a check) keeps the focus where it is and leaves the keys for the draw that follows the answer.
    const held = (busy ? null : wantFocus) ?? (v.root.contains(document.activeElement) && document.activeElement.dataset?.fk ? [document.activeElement.dataset.fk] : null);
    if (!busy) wantFocus = null;

    const ready = Boolean(data);
    let line = '';
    if (phase === 'missing') line = TEXT.missing;
    else if (phase === 'error') line = `Plenum could not read your programs. ${errorText}`.trim();
    else if (!ready) line = 'Reading your programs…';
    v.line.textContent = line;
    v.line.hidden = !line;
    v.line.classList.toggle('prog-bad', phase === 'error');
    v.retry.hidden = phase !== 'error';
    v.main.hidden = !ready;
    if (!ready) return;

    // The rows are built again only when what they show changed: an event that brings the same answer leaves the page alone, so an
    // open menu stays open and what is being typed stays. A change that was refused leaves the rows as they are, too.
    const shape = JSON.stringify([data, catalog]);
    // Nor are they built again under a line the person is typing: the rows wait until the field is left or its line is saved.
    v.late = shape !== v.shape && keepRows !== true && typingIn();
    if (shape !== v.shape && keepRows !== true && !v.late) {
      v.shape = shape;
      const alertRows = [locked() ? TEXT.newer : '', data.damaged === true ? TEXT.damaged : ''].filter(Boolean).map(t => make('p', 'prog-alert', t));
      v.alerts.replaceChildren(...alertRows);
      v.alerts.hidden = !alertRows.length;
      const own = locals();
      v.localList.replaceChildren(...own.map((p, i) => rowEl(p, i, own.length)));
      const agents = hubAgents();
      v.hubList.replaceChildren(...agents.map((p, i) => rowEl(p, i, agents.length)));
      v.hubList.hidden = !agents.length;
      v.hubEmpty.hidden = agents.length > 0;
      v.checkBtn.hidden = !(isObj(data.hub) && data.hub.connected === true && agents.length > 0);
      const hub = isObj(data.hub) ? data.hub : {};
      v.hubState.textContent = hub.connected === true
        ? (hub.wake === 'older' ? 'Plenum is connected to Plenum Hub. This hub\'s starter is an older one, so Plenum cannot wake an agent: it waits two minutes for an agent that is open in its own program.' : 'Plenum is connected to Plenum Hub.')
        : 'Plenum is not connected to Plenum Hub. Turn on Connect agents under Plenum Hub to hand tasks to these agents.';
      const biz = list(data.businesses).filter(b => isObj(b) && str(b.id));
      const on = new Set(list(data.shareRooms));
      v.shareList.replaceChildren(...biz.map(b => shareRow(b, on.has(str(b.id)))));
      v.shareEmpty.hidden = biz.length > 0;
      v.shareSec.hidden = false;
      const room = entries().length < MAX_ENTRIES;
      v.form.hidden = locked() || !room;
      v.full.hidden = locked() || room;
    }
    drawSaid();
    drawCheck();

    // Focus goes back to the control that was used, or to the next best one, so the keyboard keeps its place after a change.
    if (held) {
      for (const key of held) {
        if (!key) continue;
        const node = [...v.root.querySelectorAll('[data-fk]')].find(n => n.dataset.fk === key);
        if (node && !node.disabled && node.getClientRects().length) {
          if (document.activeElement !== node) {
            node.focus({ preventScroll: true });
            // A line that was just saved keeps the caret at its end.
            if (node.tagName === 'TEXTAREA') node.setSelectionRange(node.value.length, node.value.length);
          }
          break;
        }
      }
    }
  }

  // True while focus is in a row's text field that holds something the server has not been sent.
  function typingIn() {
    const a = document.activeElement;
    if (!a || !view?.root.contains(a) || typeof a.matches !== 'function' || !a.matches('.prog-list .prog-input')) return false;
    if (a.value === a.dataset.was) return false;
    return sent.get(a) !== (a.type === 'number' ? Number(a.value) : a.value.trim());
  }

  function stateText(entry, state) {
    const why = str(entry.why).trim();
    const next = NEXT[state] ?? '';
    return [SAYS_MORE.has(state) ? why : '', next].filter(Boolean).join(' ');
  }

  function rowEl(entry, i, count) {
    const hub = entry.via === 'hub';
    const label = str(entry.label) || entry.id;
    const state = STATE_WORD[str(entry.state)] ? str(entry.state) : 'unknown';
    const off = locked();
    const li = make('li', 'prog-row');
    li.dataset.program = entry.id;
    li.dataset.state = state;

    // The head: the dot, the name, the state in words; the arrows and the switch.
    const head = make('div', 'prog-head');
    const dot = make('span', 'prog-dot');
    dot.setAttribute('aria-hidden', 'true');
    const title = make('div', 'prog-title');
    const name = make('span', 'prog-name', label);
    name.id = uid('prog-n');
    title.append(name);
    if (hub) title.append(make('span', 'prog-id', str(entry.agent) || entry.id));
    const st = make('span', 'prog-state');
    st.append(dot, make('span', 'prog-word', STATE_WORD[state]));
    title.append(st);

    const acts = make('div', 'prog-acts');
    const arrow = (what, text, disabled, run) => {
      const b = make('button', `icon-btn prog-act prog-act-${what}`);
      b.type = 'button';
      b.dataset.fk = fk(entry.id, what);
      b.disabled = disabled || off;
      b.append(icon('arrow-up'));
      b.setAttribute('aria-label', text);
      b.title = text;
      b.addEventListener('click', run);
      return b;
    };
    acts.append(
      arrow('up', `Move ${label} up`, i === 0, () => move(entry, -1)),
      arrow('down', `Move ${label} down`, i === count - 1, () => move(entry, 1)),
    );
    const sw = make('label', 'switch-row prog-switch');
    const input = make('input');
    input.type = 'checkbox';
    input.checked = entry.on !== false;
    input.disabled = off;
    input.dataset.fk = fk(entry.id, 'on');
    input.setAttribute('aria-label', `Hand tasks to ${label}`);
    input.addEventListener('change', () => setOn(entry, input));
    const track = make('span', 'switch-track');
    track.setAttribute('aria-hidden', 'true');
    sw.append(input, track);
    acts.append(sw);
    head.append(title, acts);
    li.append(head);

    const more = stateText(entry, state);
    if (more) li.append(make('p', 'prog-why', more));
    // What the hub's own list says about being started (the server words it; it is empty until the hub has been asked).
    if (hub && str(entry.hubNote)) li.append(make('p', 'prog-why', entry.hubNote));

    // What it is best at: the line the lead reads.
    const best = lineInput(hub ? 'What this agent is best at' : '');
    best.value = str(entry.best);
    best.dataset.was = best.value;
    best.disabled = off;
    best.dataset.fk = fk(entry.id, 'best');
    best.addEventListener('change', () => setBest(entry, best));
    best.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); setBest(entry, best, true); } });
    const bestField = field('Best at', best, 'prog-best');
    const count120 = make('span', 'prog-count');
    const showCount = () => { count120.textContent = best.value.length > BEST_MAX - 20 ? `${best.value.length} of ${BEST_MAX}` : ''; };
    best.addEventListener('input', showCount);
    showCount();
    const bestRow = make('div', 'prog-bestrow');
    bestRow.append(bestField);
    if (!hub && str(entry.bestDefault) && str(entry.best) !== str(entry.bestDefault)) {
      const reset = make('button', 'prog-quiet', 'Reset');
      reset.type = 'button';
      reset.disabled = off;
      reset.dataset.fk = fk(entry.id, 'reset');
      reset.setAttribute('aria-label', `Reset what ${label} is best at`);
      reset.addEventListener('click', () => resetBest(entry));
      bestRow.append(reset);
    }
    li.append(bestRow, count120);

    if (hub) {
      // How long Plenum waits for the agent's answer, and Remove.
      const wait = make('input', 'prog-input prog-num');
      wait.type = 'number';
      wait.min = '1';
      wait.max = '60';
      wait.step = '1';
      wait.value = String(Number.isInteger(entry.waitMin) ? entry.waitMin : 10);
      wait.dataset.was = wait.value;
      wait.disabled = off;
      wait.dataset.fk = fk(entry.id, 'wait');
      wait.addEventListener('change', () => setWait(entry, wait));
      wait.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); setWait(entry, wait, true); } });
      const rm = make('button', 'prog-quiet', 'Remove');
      rm.type = 'button';
      rm.disabled = off;
      rm.dataset.fk = fk(entry.id, 'remove');
      rm.setAttribute('aria-label', `Remove ${label}`);
      rm.addEventListener('click', () => remove(entry));
      const row = make('div', 'prog-modelrow');
      row.append(field('Minutes to wait', wait, 'prog-wait'), rm);
      li.append(row);
    } else {
      // The model it runs on now, and why; a menu to set one.
      const now = isObj(entry.modelNow) ? entry.modelNow : null;
      // A program that cannot run now (switched off, not installed, needs sign-in) does not "run on" anything: the line says what it would use.
      const canRun = state === 'ready' || state === 'unknown';
      const row = make('div', 'prog-modelrow');
      const runs = make('p', 'prog-runs', now ? `${canRun ? 'Runs on' : 'Would run on'} ${str(now.label) || str(now.ref)}, ${str(now.why)}.` : 'Plenum knows no model of this program right now.');
      const select = make('select', 'prog-select');
      select.dataset.fk = fk(entry.id, 'model');
      select.disabled = off;
      select.setAttribute('aria-label', `Model for ${label}`);
      select.append(new Option('Automatic', ''));
      const prefix = `${str(entry.provider)}:`;
      const own = list(catalog).filter(c => c.ref.startsWith(prefix));
      for (const c of own) select.append(new Option(c.offered ? c.label : `${c.label} (not offered now)`, c.ref));
      const chosen = str(entry.model);
      if (chosen && !own.some(c => c.ref === chosen)) select.append(new Option(chosen, chosen));
      select.value = chosen;
      select.addEventListener('change', () => setModel(entry, select.value));
      row.append(runs, select);
      li.append(row);
    }

    if (str(entry.abilities)) li.append(make('p', 'prog-abil', entry.abilities));
    if (entry.id === 'claude-code') {
      li.append(make('p', 'prog-abil', TEXT.coderCommands));
      // With the agent type's tools only (today's build), the server's own sentence above already says that none of the person's
      // skills, servers or settings are loaded: it is not said a second time.
      if (data.claudeTools === 'own') li.append(make('p', 'prog-abil', TEXT.skills));
    }
    li.append(sayLine(`row:${entry.id}`));
    return li;
  }

  // ---------- Settings section ----------

  // Drawing reads the server's memory (GET /api/programs starts nothing). Nothing is read before the section is drawn.
  function render(body) {
    // What a status line said the last time the page was open is not said again.
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    said.clear();
    body.textContent = '';
    build(body);
    paint();
    checkSay = '';
    load().then(() => checkAgents());
  }

  (async function start() {
    await (MuseUI.ready ?? Promise.resolve());
    MuseUI.settings.register({ id: 'programs', scope: 'app', group: 'agents', title: 'Programs', order: 35, render });
    MuseUI.events.on('programs', onEvent);
    MuseUI.events.on('providers', onEvent);
    MuseUI.events.on('hub', onEvent);
  })();
})();
