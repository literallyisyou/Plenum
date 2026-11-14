// The Businesses pane (wave 3; BUSINESS-DESIGN.md section 8). One side pane with a button in the title bar that carries the number of
// items waiting for the person. A switcher (all businesses, or one), Pause all, and three tabs:
//   Today     a program that waits for your yes before it starts (one card each, with the task text), the list of what waits (one tap
//             each: there is no answer-all), then each business's brief in a few lines, then the hub's counts
//   Routines  each routine with its switch, next run, last result, Run now, Stop and Keep (which shows the new playbook first); a
//             follow-up run that is going on, with its Stop; the line that says routines are held after a Stop, with Resume routines; a
//             small editor; the two lines a person reads before a routine is switched on (may the Routines thread write here, and what
//             the folder's approval mode means unattended)
//   Setup     name, purpose, status, leads, limits beside current plan use, the hub room, what is not yet kept apart, Close
// With no business yet, Today is "Start your first business".
//
// THE CONTRACT THIS PAGE READS (owned by lib/routes/business.mjs, decisions.mjs and routines.mjs; the page uses nothing else of theirs):
//   GET  /api/business                         { v, paused, atOnce, businesses: [record + { waiting, nextRun, lastRun }], templates: [{ id, label, about }],
//                                              newer?, damaged? }
//   POST /api/business                         { name, purpose, project, template?, leads? } -> { business, created: [files], skipped: [text], routines: [name] }
//   POST /api/business/update                  { id, ...fields }            400 with one sentence
//   POST /api/business/status                  { id, status }               active | paused | closed
//   POST /api/business/pause-all               { paused }
//   GET  /api/business/one?id=                 the record, the files' state ({ charter, state, plan: { items: [{ mark, text }] }, playbooks: [name] }), today's numbers.
//                                              charter carries changed, unknown, confirmedAt; every file may carry refused (+ why) or unreadable
//   GET  /api/business/charter?id=             { name, state, text, cut, sha256, changed, unknown, confirmedAt, why }: BUSINESS.md as it is shown
//                                              here before "I made this change"; the text and the sha256 come from one read
//   POST /api/business/charter-seen            { id, seen }  seen is that sha256: the confirmation is tied to the text that was shown. 409 with
//                                              one sentence (shown as it is) when the file is another text now; the text is then read again
//   GET  /api/business/brief?range=day|week&id=   BUSINESS-DESIGN.md section 5.4
//   GET  /api/decisions?state=&business=&limit=   { waiting, items, hints, notes: { options, type } }. Every item carries options (the
//                                              server's own refusal is always the last one), refuse (that refusal: the ONLY answer this page
//                                              treats as a no; it never reads a no from an option's words), payNote, and onlyRefuse + draftNote
//                                              when only the refusal can answer it (its draft was lost, or a send or publish has none)
//   POST /api/decisions/answer                 { n, choice, note?, seen? }  seen is the sha256 GET /draft gave: every answer but the refusal
//                                              to an item with a draft sends it. 409 with one sentence, shown as it is (the draft changed, it was
//                                              not opened, the item no longer waits); the list and the draft are then read again
//   POST /api/decisions/withdraw               { n }
//   GET  /api/decisions/draft?n=               { name, text, cut, sha256 }  404 with one sentence when the file is gone
//   GET  /api/programs/starts                  { starts: [{ id, program, label, model, folder, scope, title, text, type, lead, routine, sha256,
//                                              askedAt, until }], waitMin, why }: hand-offs to a program that cannot ask before it acts
//                                              (Codex, Gemini CLI, Muse Code), in a folder on Ask first. Each waits for a yes here.
//   POST /api/programs/starts/answer           { id, allow, seen }  seen is the sha256 of the card as it was drawn: a yes is tied to the
//                                              text on screen. 404 and 409 answer one sentence, shown as it is; the cards are read again
//   GET  /api/routines/playbook?id=            { file, text, length, cut, sha256, changed }: the playbook as a run would get it, shown
//                                              before Keep. POST /api/routines/keep takes { id, seen } with that sha256 (409: read again)
//   POST /api/routines/resume                  {}  ends the hold after a Stop (scheduler.hold: { at, until }; scheduler.why says it)
//   GET  /api/routines?project=                { routines: [routine + { folder }], running: [id], followUps: [{ key, name, business, project,
//                                              since, lead }] (POST /api/routines/stop takes a follow-up's key as id),
//                                              scheduler: { on, lastTick, paused, why, hold?, note? },
//                                              folders: { <project id>: { project, thread, canWrite, approvals } }, newer }. A folder says
//                                              whether the Routines thread may write there and the folder's approval mode; every folder of a
//                                              business is sent, also one with no routine yet (a list of folders is read as well). When none
//                                              is sent, the folder is asked for with project=, and then the page's own state answers for the
//                                              open folder.
//   POST /api/routines                         create (no id: the whole record) or change (id: ONLY the fields sent change). The switch sends
//                                              { id, on } and nothing else, and the editor sends only what was changed in it: a prompt that
//                                              is sent counts as the owner saving the playbook, which accepts a changed one without Keep.
//                                              /delete, /run, /stop, /keep take { id }. /stop answers { ok } or { ok, happened } (one sentence,
//                                              shown as it is). A run's line carries why also when it finished (plan use not known)
//   POST /api/threads/multiwriter              { project, on }              the existing switch "More than one thread may write"
//   Events: { type: 'business' }, { type: 'decisions', waiting }, { type: 'routine' }, { type: 'program-start', action, waiting }.
// A route that is missing (404) is answered with one calm line in its own part; the rest of the pane still works.
// Every text is set through textContent; there is no inline style and no notice id of its own (the registered ones are drawn through the
// guarded call MuseUI.notice?.(id, ...)). Layout and colour are in ext-business.css (tokens only).
//
// To add to this pane later: a tab is one entry in TABS with its painter; a new kind of item is one entry in TYPES; a new line of the
// brief is one function in BRIEF_LINES. A feature of its own is a new pair public/ext-<name>.js and .css, which the loader finds.
(() => {
  'use strict';
  const MU = window.MuseUI;
  if (!MU?.pane?.register) return;

  const TAB = 'business';
  const TITLE = 'Businesses';
  const ALL = 'all';

  const TEXT = {
    approved: 'A yes tells the model it may go ahead. The step it then takes shows its own card only in a folder on Ask first, and only from a model or program that asks Plenum before it acts. Codex, Gemini CLI and Muse Code do not ask.',
    startHead: 'A program waits to start',
    startText: 'The task text that is sent',
    startNoText: '(The task has no text.)',
    nothingWaits: 'Nothing waits for you.',
    noBusiness: 'A business is a folder with your instructions, a plan and playbooks. Models work in it on a schedule and ask you before anything leaves this PC.',
    missing: {
      biz: 'Businesses are not in this build of Plenum yet.',
      dec: 'The list of what waits for you is not in this build of Plenum yet.',
      brief: 'The brief is not in this build of Plenum yet.',
      rt: 'Routines are not in this build of Plenum yet.',
    },
    what: { biz: 'Your businesses', dec: 'The list of what waits for you', brief: 'The brief', rt: 'The routines' },
    pausedAll: 'Everything is paused. No routine starts until you press Resume all.',
    noStart: 'It does not start by itself for now.',
    readOnly: 'The Routines thread is read-only in this folder, so a routine can only read and report. Turn on More than one thread may write.',
    mayWrite: 'The Routines thread may write in this folder.',
    writeUnknown: 'Plenum cannot tell from here whether the Routines thread may write in this folder. Open the folder and look under Threads.',
    ask: 'Ask first: each change waits five minutes for you, then is skipped. A Codex or Gemini coder still edits inside its scope without a card (Coders that cannot ask).',
    auto: 'Auto-approve: this routine\'s models change files and run commands without asking, including ones that reach the internet. What they are told to leave to you is an instruction, not a lock.',
    all: 'Approve all: this routine\'s models change files and run commands without asking, and the cards of the browser pane and of computer use are answered for them too (unless you took those out under Approve all in Settings), so they can also click, type and post on web pages. What they are told to leave to you is an instruction, not a lock.',
    apart: 'Not yet kept apart: sign-ins and the browser profile are shared by all your businesses.',
    held: 'Its playbook changed since you saved it, so it waits. Read the new text here, then keep it to run with it.',
    bookWait: 'Reading the playbook…',
    bookCut: (shown, all) => `A run gets the first ${shown.toLocaleString('en-US')} of its ${all.toLocaleString('en-US')} characters and is told to read the rest in the file. Keep accepts the whole file as it is now.`,
    bookSame: 'This is the text you saved. Nothing changed.',
    followUp: 'Acting on your answers',
    readFirst: 'Read the draft first. It is open below; then answer.',
    draftWait: 'The draft is still being read. Answer when it shows.',
    charterUnknown: 'Plenum has no record of the text you last confirmed. Read it, then confirm it.',
    charterSame: 'This is the text you confirmed.',
    charterRead: 'Read BUSINESS.md here before you confirm it: the confirmation is tied to the text you were shown.',
    clipRefused: 'The clipboard refused. The text is selected below: press Ctrl+C.',
    newer: 'The routines were saved by a newer Plenum. This version shows them and does not change them. Update Plenum to change them.',
    bizNewer: 'Your businesses were saved by a newer Plenum. This version shows them and does not change them. Update Plenum to change them.',
    undrawn: 'This part could not be drawn. Close the pane and open it again. If it happens again, open the log.',
    bizDamaged: 'The file that holds your businesses could not be read, so none is in force. A copy of it is kept when you next save.',
  };

  // The kinds of item (BUSINESS-DESIGN.md section 4.1). Sending, publishing, spending, an account and deleting are steps outside the PC.
  const TYPES = {
    question: { label: 'Question', tone: '' },
    plan: { label: 'Plan', tone: 'accent' },
    send: { label: 'Send', tone: 'amber' },
    publish: { label: 'Publish', tone: 'amber' },
    spend: { label: 'Spend', tone: 'amber' },
    account: { label: 'New account', tone: 'amber' },
    delete: { label: 'Delete', tone: 'red' },
  };
  const STATUS = { active: { label: 'Active', tone: 'green' }, paused: { label: 'Paused', tone: 'amber' }, closed: { label: 'Closed', tone: '' } };
  const DAYS = [[1, 'Mon', 'Monday'], [2, 'Tue', 'Tuesday'], [3, 'Wed', 'Wednesday'], [4, 'Thu', 'Thursday'], [5, 'Fri', 'Friday'], [6, 'Sat', 'Saturday'], [0, 'Sun', 'Sunday']];

  // ---------- small helpers ----------

  const isObj = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  const arr = v => (Array.isArray(v) ? v : []);
  const str = v => (typeof v === 'string' ? v : '');
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const sentence = s => { const t = str(s).trim(); return !t || /[.!?…]$/.test(t) ? t : `${t}.`; };
  // The server's sentences are written for the lead, about "the owner". This page speaks to that person, so the one phrase is turned to
  // "you"; any other sentence of the server's is shown as it came.
  const toYou = s => str(s).replace('the owner pays himself', 'you pay yourself');

  function make(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  let seq = 0;
  const uid = p => `${p}-${++seq}`;

  function btn(cls, text, key, onClick) {
    const b = make('button', cls, text);
    b.type = 'button';
    if (key) b.dataset.fk = key;
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  // A labelled field: the label above, the control under it, an optional note.
  function field(label, control, note) {
    const box = make('div', 'biz-field');
    const l = make('label', 'biz-label', label);
    control.id = control.id || uid('biz-f');
    l.htmlFor = control.id;
    box.append(l, control);
    if (note) {
      const n = make('p', 'biz-note', note);
      n.id = uid('biz-n');
      control.setAttribute('aria-describedby', n.id);
      box.append(n);
    }
    return box;
  }
  function input(type, value, key, onInput, attrs) {
    const i = make('input', 'biz-input');
    i.type = type;
    i.value = value ?? '';
    i.dataset.fk = key;
    i.autocomplete = 'off';
    if (type === 'text') i.spellcheck = false;
    for (const [k, v] of Object.entries(attrs ?? {})) i.setAttribute(k, String(v));
    i.addEventListener('input', () => onInput(i.value));
    return i;
  }
  function select(options, value, key, onChange) {
    const s = make('select', 'biz-select');
    s.dataset.fk = key;
    for (const [v, label, disabled] of options) {
      const o = make('option', null, label);
      o.value = v;
      if (disabled) o.disabled = true;
      s.append(o);
    }
    s.value = value;
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }
  function switchRow(title, note, checked, key, onChange) {
    const row = make('label', 'switch-row');
    const box = make('input');
    box.type = 'checkbox';
    box.setAttribute('role', 'switch');
    box.checked = Boolean(checked);
    box.dataset.fk = key;
    const track = make('span', 'switch-track');
    track.setAttribute('aria-hidden', 'true');
    const text = make('span');
    text.append(title);
    if (note) text.append(make('small', null, note));
    row.append(box, track, text);
    box.addEventListener('change', () => onChange(box.checked, box));
    return row;
  }
  const pill = (text, tone) => {
    const p = MU.ui?.pill ? MU.ui.pill(text, tone) : make('span', 'pill', text);
    p.classList.add('biz-pill');
    return p;
  };

  // Times in plain words: "today 06:30", "tomorrow 06:30", "Mon 16 Nov 06:30"; and how long ago.
  const clock = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function whenText(ts) {
    if (!num(ts)) return '';
    const d = new Date(ts);
    const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(d) - day(new Date())) / 86400000);
    if (diff === 0) return `today ${clock(ts)}`;
    if (diff === 1) return `tomorrow ${clock(ts)}`;
    if (diff === -1) return `yesterday ${clock(ts)}`;
    return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${clock(ts)}`;
  }
  function agoText(ts) {
    if (!num(ts)) return '';
    const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    if (mins < 60 * 36) return `${plural(Math.round(mins / 60), 'hour', 'hours')} ago`;
    return `${plural(Math.round(mins / 1440), 'day', 'days')} ago`;
  }
  function spanText(ms) {
    const mins = Math.round(num(ms) / 60000);
    if (mins < 1) return 'under a minute';
    if (mins < 60) return `${mins} min`;
    return `${Math.floor(mins / 60)} h ${mins % 60} min`;
  }
  const bytesText = n => (num(n) < 1024 ? `${num(n)} bytes` : `${(num(n) / 1024).toFixed(1)} KB`);

  const refOf = c => `${c.provider}:${c.id}`;
  const modelLabel = ref => {
    const hit = arr(MU.catalog).find(c => refOf(c) === ref);
    return hit ? str(hit.label) || ref : ref;
  };
  const providerLabel = id => arr(MU.providerRegistry).find(p => p.id === id)?.name ?? id;

  // A link is used only when it is plain http on this computer (the hub's own screens).
  const LOCAL_LINK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?(\/[^\s]*)?$/i;

  // ---------- what the server said ----------

  // One answer of the server: idle (not asked), loading, ok, missing (404: the route is not in this build) or error.
  const slot = () => ({ state: 'idle', data: null, error: '' });
  const D = { biz: slot(), dec: slot(), brief: slot(), rt: slot(), starts: slot() };
  const ones = new Map(); // business id -> the answer of GET /api/business/one

  async function ask(path, body) {
    let res;
    try {
      res = await MU.request(path, body === undefined ? {} : { method: 'POST', body });
    } catch {
      return { ok: false, status: 0, error: 'Plenum did not answer. Check that it is running.' };
    }
    const data = await res.json().catch(() => null);
    if (data?.terms === true) window.dispatchEvent(new CustomEvent('plenum:terms-required'));
    if (res.ok && isObj(data)) return { ok: true, status: res.status, data };
    return { ok: false, status: res.status, error: str(data?.error) || `The request failed (${res.status}).` };
  }

  // Reads one answer into its slot. True when what the pane shows has changed.
  async function load(s, path) {
    const before = JSON.stringify([s.state, s.data, s.error]);
    if (s.state === 'idle') s.state = 'loading';
    const r = await ask(path);
    if (r.ok) Object.assign(s, { state: 'ok', data: r.data, error: '' });
    else if (r.status === 404) Object.assign(s, { state: 'missing', data: null, error: '' });
    else Object.assign(s, { state: 'error', error: r.error });
    return before !== JSON.stringify([s.state, s.data, s.error]);
  }

  const businesses = () => arr(D.biz.data?.businesses).filter(isObj);
  const open = () => businesses().filter(b => b.status !== 'closed');
  const bizById = id => businesses().find(b => b.id === id) ?? null;
  const bizName = id => str(bizById(id)?.name) || 'A business';
  const items = () => arr(D.dec.data?.items).filter(i => isObj(i) && (i.state ?? 'waiting') === 'waiting');
  const routines = () => arr(D.rt.data?.routines).filter(isObj);
  const runningIds = () => arr(D.rt.data?.running).map(String);
  const followUps = () => arr(D.rt.data?.followUps).filter(f => isObj(f) && str(f.key));
  // The programs that wait for a yes before they start (GET /api/programs/starts). They count with the items that wait.
  const startCards = () => arr(D.starts.data?.starts).filter(c => isObj(c) && str(c.id));
  const waitingCount = () => {
    const starts = startCards().length;
    if (D.dec.state !== 'ok') return starts || null;
    return (Number.isFinite(D.dec.data?.waiting) ? D.dec.data.waiting : items().length) + starts;
  };

  // ---------- what the person has on screen ----------

  let root = null;
  let parts = null; // { head, say, panel }
  const ui = {
    sel: ALL,           // the business shown, or all
    tab: 'today',
    range: 'day',
    notes: new Map(),   // item n -> the note being typed
    drafts: new Map(),  // item n -> { state, name, text, cut, sha256, seen, error, select }
    charters: new Map(), // business id -> { state, data, error }: BUSINESS.md as it was read for this page
    books: new Map(),   // routine id -> { state, data, error }: its playbook as it was read for this page, before Keep
    busy: new Set(),    // keys of requests on their way
    first: null,        // the Start your first business form, or the New business form
    newOpen: false,     // the New business form is open (Setup)
    made: null,         // what the last Create answered
    arming: '',         // the routine whose switch is being turned on
    editor: null,       // the routine being made or changed
    setup: null,        // { id, f, dirty }
    focus: '',          // the control to focus after the next draw
    said: { text: '', bad: false },
  };

  // On screen: the pane's column shows and this tab is the one in front.
  const shown = () => Boolean(root && root.isConnected && MU.pane.active() === TAB && root.getClientRects().length > 0);
  const state = () => MU.state ?? {};
  const projects = () => arr(state().projects);
  const projectName = id => str(projects().find(p => p.id === id)?.name) || 'a folder that is no longer open';

  // What the last action did, in one line that stays in view while the pane scrolls. A success goes away after a few seconds; a refusal
  // or a failure stays until the next action or another tab.
  let sayTimer = 0;
  function say(text, bad) {
    clearTimeout(sayTimer);
    ui.said = { text: str(text), bad: Boolean(bad) };
    if (ui.said.text && !ui.said.bad) sayTimer = setTimeout(() => say(''), 8000);
    showSaid();
  }
  function showSaid() {
    if (!parts) return;
    parts.say.textContent = ui.said.text;
    parts.say.classList.toggle('biz-bad', ui.said.bad);
  }

  function paintCount() {
    const n = waitingCount();
    MU.pane.count(TAB, n ? n : null, 'amber');
  }

  // ---------- reading ----------

  const briefPath = () => `/api/business/brief?range=${ui.range}${ui.sel === ALL ? '' : `&id=${encodeURIComponent(ui.sel)}`}`;
  const oneOf = id => { if (!ones.has(id)) ones.set(id, slot()); return ones.get(id); };

  // A redraw would close a menu that is open and break a text that is being composed (an input method). While either is going on the
  // draw waits; it is made when the menu closes or the composition ends.
  let late = false;
  let menu = null; // the select that is probably open
  let composing = false;
  const drawingWaits = () => composing || Boolean(menu && root?.contains(menu) && document.activeElement === menu);
  function drawLate() {
    if (!late || drawingWaits()) return;
    late = false;
    paint();
  }

  let reading = null;
  let readAgain = false;
  // Reads what the tab on screen needs. Calls that come while one read runs are folded into one more read after it.
  function refresh() {
    if (reading) { readAgain = true; return reading; }
    reading = (async () => {
      do {
        readAgain = false;
        const jobs = [load(D.dec, '/api/decisions?state=waiting&limit=100'), load(D.starts, '/api/programs/starts')];
        if (shown()) {
          jobs.push(load(D.biz, '/api/business'), load(D.rt, '/api/routines'));
          if (ui.tab !== 'routines') jobs.push(load(D.brief, briefPath()));
          const want = ui.editor?.business || (ui.sel !== ALL ? ui.sel : '');
          if (want) jobs.push(load(oneOf(want), `/api/business/one?id=${encodeURIComponent(want)}`));
          const folder = ui.tab === 'routines' && D.rt.state === 'ok' ? factsFolder() : '';
          if (folder) jobs.push(loadFacts(folder));
        }
        const changed = (await Promise.all(jobs)).some(Boolean);
        // The business on screen is gone (closed elsewhere, or removed): all businesses are shown, and the brief is read for them.
        if (ui.sel !== ALL && D.biz.state === 'ok' && !bizById(ui.sel)) {
          ui.sel = ALL;
          ui.setup = null;
          Object.assign(D.brief, slot());
          readAgain = true;
        }
        paintCount();
        if (changed) { if (drawingWaits()) late = true; else paint(); }
      } while (readAgain);
    })().finally(() => { reading = null; });
    return reading;
  }
  let soon = 0;
  const refreshSoon = () => { clearTimeout(soon); soon = setTimeout(refresh, 150); };

  // ---------- actions ----------

  // One POST with its key marked busy, so its buttons cannot be pressed twice. Resolves to the answer.
  async function act(key, path, body) {
    if (ui.busy.has(key)) return { ok: false, status: -1, error: '' };
    const held = root?.contains(document.activeElement) ? document.activeElement.dataset.fk ?? '' : '';
    ui.busy.add(key);
    paint();
    const parked = document.activeElement?.dataset?.fk ?? '';
    const r = await ask(path, body);
    ui.busy.delete(key);
    // A control that is switched off while its request runs cannot keep the focus, so the focus waits on the tab. The next draw gives it
    // back, unless the caller names another place or the person has moved on meanwhile.
    const now = document.activeElement;
    if (held && !ui.focus && (!root?.contains(now) || (now.dataset?.fk ?? '') === parked)) ui.focus = held;
    return r;
  }

  // The one refusal of an item is the option the server added and named (item.refuse). Nothing else is a no here: an option the model
  // worded "No problem, send it" is a yes, and is treated as one.
  const isRefusal = (item, choice) => Boolean(str(item.refuse)) && choice === item.refuse;

  async function answer(item, choice) {
    const n = item.n;
    const note = str(ui.notes.get(n)).trim();
    const next = neighbourKey(n);
    const refusal = isRefusal(item, choice);
    const body = note ? { n, choice, note } : { n, choice };
    if (!refusal && str(item.draft)) {
      // A yes is tied to the draft he was shown: the hash that came with the text goes back as `seen`. A draft that was never opened
      // here is opened now, and the answer waits for a second tap.
      const d = ui.drafts.get(n);
      if (d?.state === 'loading') { say(TEXT.draftWait, true); return paint(); }
      if (!d || !d.seen) {
        await openDraft(item, true);
        say(TEXT.readFirst, true);
        ui.focus = `item|${n}|text`;
        return paint();
      }
      body.seen = d.sha256;
    }
    const r = await act(`item|${n}`, '/api/decisions/answer', body);
    if (r.status === -1) return;
    if (r.ok) {
      // The answer is recorded; when the line for the business's record could not be written, the server says so in one sentence.
      const record = r.data.record === 'failed' && str(r.data.why) ? ` ${sentence(r.data.why)}` : '';
      // What a yes does not do is the server's sentence, never this page's own.
      const pay = !refusal && str(item.payNote) ? ` ${sentence(toYou(item.payNote))}` : '';
      say(`Answered #${n} "${str(item.title)}": ${choice}.${pay}${record}`, Boolean(record));
      forget(n);
      ui.focus = next;
    } else if (r.status === 409) {
      // The server's sentence as it is (the draft changed after it was opened, the item no longer waits, the draft was lost). The list is
      // read again, and so is the draft, so what is on screen is what a next answer would be about.
      say(sentence(r.error), true);
      if (str(item.draft)) await openDraft(item, true);
    } else {
      say(`#${n} was not answered. ${sentence(r.error)}`, true);
    }
    paint();
    refresh();
  }

  // The answer to a program that waits to start. A yes sends back the sha256 of the card as it is drawn here, so it is a yes to the
  // text on screen; the server's sentence is shown as it is when the card no longer waits or is another one now.
  async function answerStart(card, allow) {
    const id = str(card.id);
    const label = str(card.label) || 'The program';
    const r = await act(`start|${id}`, '/api/programs/starts/answer', allow ? { id, allow: true, seen: str(card.sha256) } : { id, allow: false });
    if (r.status === -1) return;
    if (r.ok) say(allow ? `${label} starts with the task "${str(card.title)}".` : `${label} was not started.`);
    else say(sentence(r.error), true);
    if (r.ok && D.starts.data) D.starts.data = { ...D.starts.data, starts: startCards().filter(c => c.id !== id) };
    ui.focus = 'tab|today';
    paintCount();
    paint();
    refresh();
  }

  async function withdraw(item) {
    const next = neighbourKey(item.n);
    const r = await act(`item|${item.n}`, '/api/decisions/withdraw', { n: item.n });
    if (r.status === -1) return;
    if (r.ok || r.status === 409) {
      say(r.ok ? `#${item.n} "${str(item.title)}" is marked as not needed.` : `#${item.n} no longer waits. The list was read again.`, !r.ok);
      forget(item.n);
      ui.focus = next;
    } else {
      say(`#${item.n} was not changed. ${sentence(r.error)}`, true);
    }
    paint();
    refresh();
  }

  // Takes an item off the screen at once; the next read confirms it.
  function forget(n) {
    ui.notes.delete(n);
    ui.drafts.delete(n);
    if (D.dec.data) {
      D.dec.data = { ...D.dec.data, items: arr(D.dec.data.items).filter(i => i?.n !== n), waiting: Math.max(0, num(D.dec.data.waiting) - 1) };
      paintCount();
    }
  }
  // Where the focus goes when item n leaves the list: the next item's first button, else the one before, else the tab.
  function neighbourKey(n) {
    const list = visibleItems();
    const at = list.findIndex(i => i.n === n);
    const other = list[at + 1] ?? list[at - 1];
    return other ? `item|${other.n}|opt|0` : 'tab|today';
  }

  // Opens the draft, or closes it. again: read it anew and leave it open (after a 409, or when an answer needs it read first).
  // seen: the text was shown here, so its sha256 may go back with a yes. A draft that is closed is read anew when it is opened again, so
  // the text on screen and the hash that is sent are always from the same read.
  async function openDraft(item, again = false) {
    const had = ui.drafts.get(item.n);
    if (!again && had && had.state !== 'closed') { ui.drafts.set(item.n, { state: 'closed' }); return paint(); }
    ui.drafts.set(item.n, { state: 'loading' });
    paint();
    const r = await ask(`/api/decisions/draft?n=${encodeURIComponent(item.n)}`);
    if (ui.drafts.get(item.n)?.state !== 'loading') return;
    ui.drafts.set(item.n, r.ok
      ? { state: 'ok', name: str(r.data.name), text: str(r.data.text), cut: r.data.cut === true, sha256: str(r.data.sha256), seen: true }
      : { state: 'error', error: r.status === 404 && !/draft|file|gone|found/i.test(r.error) ? 'The draft cannot be read in this build of Plenum.' : sentence(r.error) });
    paint();
  }

  // BUSINESS.md of a business, read for this page: the text and its sha256 from one read. again: read anew and leave it open.
  async function openCharter(b, again = false) {
    const had = ui.charters.get(b.id);
    if (!again && had && had.state !== 'closed') { ui.charters.set(b.id, { state: 'closed' }); return paint(); }
    ui.charters.set(b.id, { state: 'loading' });
    paint();
    const r = await ask(`/api/business/charter?id=${encodeURIComponent(b.id)}`);
    if (ui.charters.get(b.id)?.state !== 'loading') return;
    ui.charters.set(b.id, r.ok
      ? { state: 'ok', data: r.data }
      : { state: 'error', error: r.status === 404 && !/business/i.test(r.error) ? 'BUSINESS.md cannot be read here in this build of Plenum. Open the file in the folder.' : sentence(r.error) });
    paint();
  }

  // "I made this change": the sha256 that came with the text on screen goes back as `seen`, never a fresh one. A 409 is the server's
  // sentence, shown as it is (the file is another text now, or it is a link), and the file is read again.
  async function confirmCharter(b) {
    const c = ui.charters.get(b.id);
    const seen = c?.state === 'ok' ? str(c.data.sha256) : '';
    if (!seen) { say(TEXT.charterRead, true); return openCharter(b, true); }
    const r = await act('su|charter', '/api/business/charter-seen', { id: b.id, seen });
    if (r.status === -1) return;
    if (r.ok) say('BUSINESS.md is confirmed as your text. Leads are no longer told it is unconfirmed.');
    else say(sentence(r.error), true);
    ui.focus = 'su|charter|open';
    // Read again in every case: after a yes the page shows the new state, after a 409 the text that is there now.
    await openCharter(b, true);
    refresh();
  }

  // Copy text: the clipboard, and when it refuses a text box with the text selected.
  async function copyDraft(item) {
    const d = ui.drafts.get(item.n);
    if (d?.state !== 'ok') return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(d.text);
      ok = true;
    } catch {
      // The clipboard refused (the window is not in front, or no permission): the text box below is the way.
    }
    ui.drafts.set(item.n, { ...d, select: !ok });
    say(ok ? `The text of #${item.n} is on the clipboard.` : TEXT.clipRefused, !ok);
    ui.focus = ok ? `item|${item.n}|copy` : `item|${item.n}|box`;
    paint();
    if (!ok) root?.querySelector(`.biz-draft-box[data-n="${CSS.escape(String(item.n))}"]`)?.select();
  }

  async function pauseAll(on) {
    const r = await act('pause-all', '/api/business/pause-all', { paused: on });
    if (r.status === -1) return;
    // Paused: the banner above the list says so, and the status line does not say it a second time.
    say(r.ok ? (on ? '' : 'Routines may start again.') : `That did not work. ${sentence(r.error)}`, !r.ok);
    paint();
    refresh();
  }

  async function setStatus(b, status, key) {
    if (status === 'closed') {
      const yes = await MU.confirm({ title: `Close ${str(b.name)}?`, body: 'Its routines stop and it leaves Today. Its files and its record are kept, and you can open it again under Setup.', action: 'Close the business', focusCancel: true });
      if (!yes) return;
    }
    const r = await act(key, '/api/business/status', { id: b.id, status });
    if (r.status === -1) return;
    const done = { active: 'runs again', paused: 'is paused. Nothing new starts for it', closed: 'is closed' }[status];
    say(r.ok ? `${str(b.name)} ${done}.` : `${str(b.name)} was not changed. ${sentence(r.error)}`, !r.ok);
    paint();
    refresh();
  }

  async function createBusiness() {
    const f = ui.first;
    if (!f) return;
    const name = f.name.trim();
    const purpose = f.purpose.trim();
    if (!name) { say('Give the business a name.', true); ui.focus = 'first|name'; return paint(); }
    if (!f.project) { say('Choose the folder the business lives in.', true); ui.focus = 'first|project'; return paint(); }
    const body = { name, purpose, project: f.project };
    if (f.template) body.template = f.template;
    if (f.lead) body.leads = [f.lead];
    const r = await act('first', '/api/business', body);
    if (r.status === -1) return;
    if (!r.ok) { say(`The business was not created. ${sentence(r.error)}`, true); return paint(); }
    const made = isObj(r.data.business) ? r.data.business : {};
    // The new business is on the page at once, as the server answered it; the read that follows confirms it.
    if (made.id && D.biz.data && !bizById(made.id)) D.biz.data = { ...D.biz.data, businesses: [...businesses(), made] };
    ui.made = { name: str(made.name) || name, created: arr(r.data.created).map(String), skipped: arr(r.data.skipped).map(String), routines: arr(r.data.routines).map(String), leads: arr(made.leads).map(String) };
    ui.first = null;
    ui.newOpen = false;
    if (made.id) pick(made.id, false);
    ui.tab = 'today';
    ui.focus = 'tab|today';
    say(`${ui.made.name} is set up.`);
    paint();
    refresh();
  }

  // The switch sends the switch and nothing else. The server changes only the fields it is sent, and a prompt that is sent counts as
  // the owner saving the playbook, which would accept a changed playbook without Keep.
  async function switchRoutine(r, on) {
    const res = await act(`rt|${r.id}`, '/api/routines', { id: r.id, on });
    if (res.status === -1) return;
    ui.arming = '';
    ui.focus = `rt|${r.id}|on`;
    say(res.ok ? `${str(r.name)} is switched ${on ? 'on' : 'off'}.` : `${str(r.name)} was not switched ${on ? 'on' : 'off'}. ${sentence(res.error)}`, !res.ok);
    paint();
    refresh();
  }

  // Ends the hold after a Stop: routines may start by themselves again.
  async function resumeRoutines() {
    const r = await act('rt|resume', '/api/routines/resume', {});
    if (r.status === -1) return;
    say(r.ok ? 'Routines may start again.' : `That did not work. ${sentence(r.error)}`, !r.ok);
    ui.focus = 'tab|routines';
    paint();
    refresh();
  }

  // Stop on a follow-up run (the timer started it after an answer of yours): its key is what the server stops.
  async function stopFollowUp(f) {
    const r = await act(`fu|${f.key}`, '/api/routines/stop', { id: f.key });
    if (r.status === -1) return;
    say(r.ok ? 'Stop was sent to the follow-up run. It shows as running until it has ended.' : `The follow-up run was not stopped. ${sentence(r.error)}`, !r.ok);
    ui.focus = 'tab|routines';
    await refresh();
    paint();
  }

  // The playbook of a routine, read for this page before Keep: the text and its sha256 from one read. again: read anew and leave open.
  async function openBook(r, again = false) {
    const had = ui.books.get(r.id);
    if (!again && had && had.state !== 'closed') { ui.books.set(r.id, { state: 'closed' }); ui.focus = `rt|${r.id}|keep`; return paint(); }
    ui.books.set(r.id, { state: 'loading' });
    paint();
    const res = await ask(`/api/routines/playbook?id=${encodeURIComponent(r.id)}`);
    if (ui.books.get(r.id)?.state !== 'loading') return;
    ui.books.set(r.id, res.ok ? { state: 'ok', data: res.data } : { state: 'error', error: res.status === 404 && !/playbook|routine|folder/i.test(res.error) ? 'The playbook cannot be read here in this build of Plenum. Open the file in the folder.' : sentence(res.error) });
    if (res.ok) ui.focus = `rt|${r.id}|book`;
    paint();
  }

  // Keep: the sha256 that came with the text on screen goes back as `seen`, never a fresh one. A 409 is the server's sentence, shown
  // as it is (the file is another text now), and the playbook is read again.
  async function keepBook(r) {
    const b = ui.books.get(r.id);
    const seen = b?.state === 'ok' ? str(b.data.sha256) : '';
    if (!seen) return openBook(r, true);
    const res = await act(`rt|${r.id}`, '/api/routines/keep', { id: r.id, seen });
    if (res.status === -1) return;
    if (res.ok) {
      ui.books.delete(r.id);
      say(r.on === true ? `${str(r.name)} will run with the new playbook.` : `${str(r.name)}: the new playbook is accepted. It is still switched off.`);
      ui.focus = `rt|${r.id}|edit`;
    } else {
      say(`${str(r.name)} was not changed. ${sentence(res.error)}`, true);
      if (res.status === 409) await openBook(r, true);
    }
    paint();
    refresh();
  }

  async function routineAct(r, what) {
    if (what === 'delete') {
      const yes = await MU.confirm({ title: `Delete ${str(r.name)}?`, body: 'The routine is removed. The record of its runs is kept.', action: 'Delete the routine', tone: 'danger', focusCancel: true });
      if (!yes) return;
    }
    const res = await act(`rt|${r.id}`, `/api/routines/${what}`, { id: r.id });
    if (res.status === -1) return;
    // Stop only asks: the run ends after the server has stopped it, and until then the row still says Running. (Keep is keepBook.)
    // Stop answers what happened: Stop was sent to a run, or (happened) the routine had not started yet and now will not.
    const ok = { run: `${str(r.name)} was started.`, stop: res.ok && str(res.data.happened) ? `${str(r.name)}: ${sentence(res.data.happened)}` : `Stop was sent to ${str(r.name)}. It shows as running until it has ended.`, delete: `${str(r.name)} was deleted.` }[what];
    const bad = { run: 'was not started', stop: 'was not stopped', delete: 'was not deleted' }[what];
    say(res.ok ? ok : `${str(r.name)} ${bad}. ${sentence(res.error)}`, !res.ok);
    if (what === 'delete' && res.ok) ui.focus = 'rt|new';
    if ((what === 'run' || what === 'stop') && res.ok) {
      // Stop exists only once a read says the routine runs, and Run now is off while it runs: read first, then give the focus to the
      // control a person may want next if it is there, else to the row's Edit button, never to the tab strip.
      await refresh();
      const want = (what === 'run' ? ['stop'] : ['run', 'stop']).map(k => `rt|${r.id}|${k}`).find(k => { const n = byFk(k); return n && !n.disabled; });
      ui.focus = want ?? `rt|${r.id}|edit`;
    }
    paint();
    refresh();
  }

  // What the editor would send for each field, as text, so two states of the form can be compared.
  function sentOf(e) {
    return {
      name: str(e.name).trim(),
      when: e.type === 'every' ? `every ${Math.round(Number(e.hours))}` : `daily ${e.at} ${[...e.days].sort((a, b) => a - b).join(',')}`,
      prompt: e.source === 'file' ? `file ${str(e.file).trim()}` : `text ${e.text}`,
      onlyIf: str(e.folder).trim(),
      leads: [...e.leads].join(' '),
    };
  }

  async function saveRoutine() {
    const e = ui.editor;
    if (!e) return;
    const name = e.name.trim();
    if (!name) { say('Give the routine a name.', true); ui.focus = 'ed|name'; return paint(); }
    if (!e.business) { say('Choose the business this routine works for.', true); ui.focus = 'ed|business'; return paint(); }
    const home = arr(bizById(e.business)?.projects)[0] ?? '';
    const when = e.type === 'every' ? { type: 'every', hours: Math.round(Number(e.hours)) } : { type: 'daily', at: e.at, days: [...e.days].sort((a, b) => a - b) };
    const fields = {
      name, when,
      prompt: e.source === 'file' ? { text: '', file: e.file.trim() } : { text: e.text, file: '' },
      onlyIf: { folder: e.folder.trim() }, leads: [...e.leads],
    };
    let body = { business: e.business, project: e.project || home, kind: 'lead', ...fields };
    if (e.id) {
      // A routine that exists: only what was changed here is sent, so the switch, the next run and a playbook that waits for Keep stay
      // as they are unless this form changed them.
      const was = sentOf(editorOf(routines().find(r => r.id === e.id) ?? {}));
      const now = sentOf(e);
      body = { id: e.id };
      for (const k of Object.keys(fields)) if (now[k] !== was[k]) body[k] = fields[k];
      if (Object.keys(body).length === 1) {
        ui.editor = null;
        ui.focus = `rt|${e.id}|edit`;
        say('Nothing was changed.');
        return paint();
      }
    }
    const res = await act('ed', '/api/routines', body);
    if (res.status === -1) return;
    if (!res.ok) { say(`The routine was not saved. ${sentence(res.error)}`, true); return paint(); }
    ui.editor = null;
    ui.focus = e.id ? `rt|${e.id}|edit` : 'rt|new';
    say(e.id ? `${name} is saved.` : `${name} is saved. It is switched off until you turn it on.`);
    paint();
    refresh();
  }

  async function setMultiWriter(project, on, box) {
    const res = await act(`mw|${project}`, '/api/threads/multiwriter', { project, on });
    if (res.status === -1) return;
    if (res.ok) {
      try { MU.threads?.adopt?.(res.data); } catch { /* the page keeps its own state; the next read says what is true */ }
      say(on ? 'More than one thread may now write in this folder.' : 'Only the folder\'s writer thread may write again.');
    } else {
      if (box) box.checked = !on;
      say(`That was not changed. ${sentence(res.error)}`, true);
    }
    paint();
    refresh();
  }

  async function saveSetup() {
    const s = ui.setup;
    const b = s && bizById(s.id);
    if (!b) return;
    const f = s.f;
    if (!f.name.trim()) { say('Give the business a name.', true); ui.focus = 'su|name'; return paint(); }
    // An empty number is not zero: zero stops every routine of the business, so it must be typed.
    for (const [k, label, key] of [['runsPerDay', 'Runs a day', 'runs'], ['minutesPerDay', 'Minutes of model time a day', 'minutes']]) {
      if (String(f[k]).trim() === '' || !Number.isFinite(Number(f[k]))) { say(`${label} needs a number. Use 0 only to stop all routines.`, true); ui.focus = `su|${key}`; return paint(); }
    }
    const lines = {};
    for (const [k, v] of Object.entries(f.lines)) if (String(v).trim() !== '') lines[k] = Number(v);
    const body = { id: b.id, name: f.name.trim(), purpose: f.purpose.trim(), leads: [...f.leads], runsPerDay: Number(f.runsPerDay), minutesPerDay: Number(f.minutesPerDay), lines, allowApi: f.allowApi === true, hubRoom: f.hubRoom.trim() };
    const res = await act('su', '/api/business/update', body);
    if (res.status === -1) return;
    if (res.ok) {
      ui.setup = null;
      // The record the server answered is on the page at once, so the form does not show the old values until the next read.
      if (isObj(res.data.business) && D.biz.data) D.biz.data = { ...D.biz.data, businesses: businesses().map(x => (x.id === b.id ? res.data.business : x)) };
      say(`${body.name} is saved.`);
    } else say(`${str(b.name)} was not saved. ${sentence(res.error)}`, true);
    ui.focus = 'su|save';
    paint();
    refresh();
  }

  // Unsaved changes of the Setup form are never dropped without a question. True when the person may go on.
  async function mayLeaveSetup() {
    if (!ui.setup?.dirty) return true;
    const yes = await MU.confirm({ title: 'Discard changes?', body: 'Your changes to this business are not saved.', action: 'Discard', focusCancel: true });
    // The control that asked (the business switcher) shows the business that is still on screen.
    if (!yes) paint();
    return Boolean(yes);
  }
  async function pickAsked(id) {
    if (id !== ui.sel && !(await mayLeaveSetup())) return;
    pick(id);
  }

  // The switch for per-token models applies at once. Its state on screen follows the answer: a refusal puts it back.
  async function setAllowApi(b, on, boxEl) {
    const s = ui.setup;
    const was = s?.f.allowApi === true;
    if (s) s.f.allowApi = on;
    const r = await act('su|api', '/api/business/update', { id: b.id, allowApi: on });
    if (r.status === -1) { if (boxEl) boxEl.checked = was; return; }
    if (r.ok) {
      if (isObj(r.data.business) && D.biz.data) D.biz.data = { ...D.biz.data, businesses: businesses().map(x => (x.id === b.id ? r.data.business : x)) };
      say(on ? `${str(b.name)} may use models billed per token.` : `${str(b.name)} uses only your subscriptions.`);
    } else {
      if (s) s.f.allowApi = was;
      say(`${str(b.name)} was not changed. ${sentence(r.error)}`, true);
    }
    ui.focus = 'su|api';
    paint();
    refresh();
  }

  // Shows one business, or all. The brief and the files' state are read for it.
  function pick(id, andRead = true) {
    ui.sel = id;
    ui.setup = null;
    ui.arming = '';
    ui.charters.clear();
    say('');
    Object.assign(D.brief, slot());
    if (andRead) { paint(); refresh(); }
  }

  // ---------- drawing: shared parts ----------

  // The calm line for a part whose route is missing, the failure with Try again, or null when the part can be drawn.
  function gate(key, s) {
    if (s.state === 'missing') return make('p', 'biz-calm', TEXT.missing[key]);
    if (s.state === 'error' && !s.data) {
      const box = make('div', 'biz-fail');
      box.append(make('p', 'biz-calm biz-bad', `${TEXT.what[key]} could not be read. ${sentence(s.error)}`), btn('ghost small', 'Try again', `retry|${key}`, () => { Object.assign(s, slot()); paint(); refresh(); }));
      return box;
    }
    if (s.state === 'idle' || s.state === 'loading') {
      const p = make('p', 'biz-calm biz-wait');
      p.append(make('span', 'spinner'), 'Reading…');
      return p;
    }
    return null;
  }

  function section(title, cls, extra) {
    const box = make('section', `biz-sec ${cls ?? ''}`.trim());
    const head = make('div', 'biz-sec-head');
    const h = make('h3', 'biz-sec-title', title);
    h.id = uid('biz-h');
    box.setAttribute('aria-labelledby', h.id);
    head.append(h);
    if (extra) head.append(extra);
    box.append(head);
    return box;
  }

  // ---------- drawing: the head ----------

  function paintHead() {
    const head = parts.head;
    const kids = [];
    const list = businesses();
    if (D.biz.state === 'ok' && list.length) {
      const options = [[ALL, 'All businesses'], ...list.map(b => [b.id, b.status === 'closed' ? `${str(b.name)} (closed)` : str(b.name)])];
      if (ui.sel !== ALL && !bizById(ui.sel)) ui.sel = ALL;
      const sw = select(options, ui.sel, 'head|sel', v => pickAsked(v));
      sw.classList.add('biz-switcher');
      sw.setAttribute('aria-label', 'Business shown');
      kids.push(sw);
      const paused = D.biz.data.paused === true;
      const pa = btn('ghost small biz-pause-all', paused ? 'Resume all' : 'Pause all', 'head|pause', () => pauseAll(!paused));
      pa.setAttribute('aria-pressed', String(paused));
      pa.disabled = ui.busy.has('pause-all');
      pa.title = paused ? 'Let routines start again' : 'Stop every business from starting anything new';
      kids.push(pa);
    }
    const tabs = make('div', 'biz-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Businesses');
    for (const t of TABS) {
      const b = btn('biz-tab', t.label, `tab|${t.id}`, () => setTab(t.id));
      b.setAttribute('role', 'tab');
      b.id = `biz-tab-${t.id}`;
      b.setAttribute('aria-selected', String(ui.tab === t.id));
      b.setAttribute('aria-controls', 'biz-panel');
      b.tabIndex = ui.tab === t.id ? 0 : -1;
      if (t.id === 'setup' && ui.setup?.dirty) {
        const dot = make('span', 'biz-dot', ' •');
        dot.setAttribute('aria-hidden', 'true');
        b.append(dot);
        b.setAttribute('aria-label', 'Setup, unsaved changes');
      }
      if (t.id === 'today' && waitingCount()) b.append(MU.ui?.badge ? MU.ui.badge(waitingCount(), 'amber') : make('span', 'badge', waitingCount()));
      tabs.append(b);
    }
    tabs.addEventListener('keydown', e => {
      const at = TABS.findIndex(t => t.id === ui.tab);
      const to = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
      if (to < 0 || to >= TABS.length || to === at) return;
      e.preventDefault();
      ui.focus = `tab|${TABS[to].id}`;
      setTab(TABS[to].id);
    });
    const top = make('div', 'biz-top');
    top.append(...kids);
    head.replaceChildren(...(kids.length ? [top] : []), tabs);
    if (D.biz.state === 'ok' && D.biz.data.paused === true) head.append(make('p', 'biz-banner', TEXT.pausedAll));
  }

  function setTab(id) {
    if (ui.tab === id) return;
    ui.tab = id;
    ui.arming = '';
    say('');
    paint();
    refresh();
  }

  // ---------- drawing: Today ----------

  const visibleItems = () => items().filter(i => ui.sel === ALL || i.business === ui.sel);

  function firstForm(title, lead) {
    const taken = new Set(businesses().filter(b => b.status !== 'closed').flatMap(b => arr(b.projects)));
    const free = projects().filter(p => !taken.has(p.id));
    const templates = arr(D.biz.data?.templates).filter(isObj);
    ui.first ??= { name: '', purpose: '', project: '', template: '', lead: '', leadSet: false };
    const f = ui.first;
    if (!free.some(p => p.id === f.project)) f.project = free.find(p => p.id === state().activeProject)?.id ?? free[0]?.id ?? '';
    if (!templates.some(t => t.id === f.template)) f.template = templates[0]?.id ?? '';
    // The lead: the model the folder already uses, until the person picks another or none.
    const own = str(projects().find(p => p.id === f.project)?.model) || str(state().model);
    const offers = [...new Set([own, ...arr(MU.catalog).map(refOf)].filter(Boolean))];
    if (!f.leadSet) f.lead = own;
    if (f.lead && !offers.includes(f.lead)) f.lead = '';
    const box = section(title, 'biz-first');
    if (lead) box.append(make('p', 'biz-note', lead));
    if (!free.length) {
      box.append(make('p', 'biz-calm', projects().length ? 'Every open folder already belongs to a business. Add a folder for the new one.' : 'A business lives in a folder. Add a folder first.'));
      if (typeof MU.openAddForm === 'function') box.append(btn('ghost small', 'Add a folder', 'first|add', () => MU.openAddForm()));
      return box;
    }
    const form = make('form', 'biz-form');
    form.noValidate = true;
    const about = make('p', 'biz-note', str(templates.find(t => t.id === f.template)?.about));
    const tpl = select(templates.map(t => [t.id, str(t.label) || t.id]), f.template, 'first|template', v => { f.template = v; about.textContent = str(templates.find(t => t.id === v)?.about); });
    form.append(
      field('Name', input('text', f.name, 'first|name', v => { f.name = v; }, { maxlength: 60, placeholder: 'For example: Catalog files' })),
      field('What it does, in one sentence', input('text', f.purpose, 'first|purpose', v => { f.purpose = v; }, { maxlength: 300, placeholder: 'What is sold, and to whom' })),
      field('Folder', select(free.map(p => [p.id, `${str(p.name)} (${str(p.path)})`]), f.project, 'first|project', v => { f.project = v; paint(); }), 'Its instructions, plan and playbooks are written here. A file that is already there is never overwritten.'),
      field('Lead model', select([...offers.map(ref => [ref, ref === own ? `${modelLabel(ref)} (this folder's model)` : modelLabel(ref)]), ['', 'Choose later, under Setup']], f.lead, 'first|lead', v => { f.lead = v; f.leadSet = true; }), 'The model that runs its routines. Under Setup you can add more, in your order. Plenum never uses one you did not list.'),
    );
    if (templates.length) {
      const tf = field('Template', tpl);
      tf.append(about);
      form.append(tf);
    }
    const row = make('div', 'biz-actions');
    const create = make('button', 'primary small', ui.busy.has('first') ? 'Creating…' : 'Create');
    create.type = 'submit';
    create.dataset.fk = 'first|create';
    create.disabled = ui.busy.has('first');
    row.append(create);
    if (ui.newOpen) row.append(btn('ghost small', 'Cancel', 'first|cancel', () => { ui.newOpen = false; ui.first = null; ui.focus = 'su|new'; paint(); }));
    form.append(row, make('p', 'biz-note', 'Its routines arrive switched off. Nothing runs until you turn one on.'));
    form.addEventListener('submit', e => { e.preventDefault(); createBusiness(); });
    box.append(form);
    return box;
  }

  function madeNote() {
    const m = ui.made;
    if (!m) return null;
    const box = make('div', 'biz-made');
    box.setAttribute('role', 'status');
    const lines = [`${m.name} is set up.`];
    if (m.created.length) lines.push(`Written to its folder: ${m.created.join(', ')}.`);
    if (m.routines.length) lines.push(`Its routines, all switched off: ${m.routines.join(', ')}.`);
    for (const s of m.skipped) lines.push(sentence(s));
    lines.push(m.leads.length
      ? `Next: write your instructions in BUSINESS.md, then switch on the routines you want. Its lead is ${m.leads.map(modelLabel).join(', ')}.`
      : 'Next: write your instructions in BUSINESS.md, choose its leads under Setup, then switch on the routines you want.');
    for (const l of lines) box.append(make('p', 'biz-made-line', l));
    box.append(btn('ghost small', 'Got it', 'made|ok', () => { ui.made = null; ui.focus = 'tab|today'; paint(); }));
    return box;
  }

  function itemEl(item) {
    const n = item.n;
    const busy = ui.busy.has(`item|${n}`);
    const type = TYPES[item.type] ?? TYPES.question;
    const box = make('article', 'biz-item');
    box.dataset.n = String(n);
    const title = make('h4', 'biz-item-title', str(item.title) || 'An item with no title');
    title.id = uid('biz-it');
    box.setAttribute('aria-labelledby', title.id);

    const top = make('div', 'biz-item-top');
    top.append(pill(bizName(item.business)), pill(type.label, type.tone), make('span', 'biz-item-n', `#${n}`));
    if (num(item.createdAt)) top.append(make('span', 'biz-age', agoText(item.createdAt)));

    const who = str(item.from?.label) || (str(item.from?.ref) ? modelLabel(item.from.ref) : '');
    const rt = routines().find(r => r.id === item.routine);
    const where = rt ? `the routine ${str(rt.name)}` : str(item.routine) ? 'a routine' : 'a chat';
    // Whose words the type is: the server's sentence, beside who asked.
    const from = make('p', 'biz-item-from', who ? `Asked by ${who} in ${where}.` : `Asked in ${where}.`);
    box.append(top, title, from);
    // An item only the refusal can answer (its draft was never found, or a send or publish came with no draft): the server's sentence.
    const lost = item.onlyRefuse === true || item.draftLost === true;
    // The same holds while the draft was opened and could not be read: the server records no yes for text he was not shown.
    const unread = str(item.draft) && ui.drafts.get(n)?.state === 'error';
    const only = lost || unread;
    if (lost) box.append(make('p', 'biz-line biz-line-warn biz-item-only', sentence(str(item.draftNote) || str(D.dec.data?.notes?.draftLost))));

    if (str(item.draft)) {
      const d = ui.drafts.get(n);
      const isOpen = Boolean(d) && d.state !== 'closed';
      const row = make('div', 'biz-draft-row');
      const ob = btn('ghost small', isOpen ? 'Close draft' : 'Open draft', `item|${n}|draft`, () => openDraft(item));
      ob.setAttribute('aria-expanded', String(isOpen));
      row.append(ob, make('span', 'biz-draft-name', str(item.draft)));
      box.append(row);
      if (isOpen) {
        const well = make('div', 'biz-draft');
        if (d.state === 'loading') {
          const p = make('p', 'biz-calm biz-wait');
          p.append(make('span', 'spinner'), 'Reading the draft…');
          well.append(p);
        } else if (d.state === 'error') {
          well.append(make('p', 'biz-calm biz-bad', d.error));
        } else {
          const text = make('pre', 'biz-draft-text', d.text);
          text.tabIndex = 0;
          text.dataset.fk = `item|${n}|text`;
          text.setAttribute('aria-label', `The draft ${d.name}`);
          well.append(text);
          if (d.cut) well.append(make('p', 'biz-note', 'The draft is longer than what is shown here. Open the file to read all of it.'));
          const acts = make('div', 'biz-actions');
          acts.append(btn('ghost small', 'Copy text', `item|${n}|copy`, () => copyDraft(item)));
          well.append(acts);
          if (d.select) {
            const ta = make('textarea', 'biz-draft-box');
            ta.readOnly = true;
            ta.value = d.text;
            ta.rows = 4;
            ta.dataset.n = String(n);
            ta.dataset.fk = `item|${n}|box`;
            ta.setAttribute('aria-label', 'The draft as text you can select and copy');
            ta.addEventListener('focus', () => ta.select());
            well.append(ta);
          }
        }
        box.append(well);
      }
    }

    if (str(item.recommend)) box.append(make('p', 'biz-rec', `The model recommends: ${item.recommend}`));

    const opts = make('div', 'biz-opts');
    opts.setAttribute('role', 'group');
    opts.setAttribute('aria-label', `Answer #${n}`);
    // The buttons are the item's options as the server sent them: the model's own first, the server's refusal last. An item that only
    // the refusal can answer shows that one button.
    const refuse = str(item.refuse);
    const all = arr(item.options).map(String).filter(Boolean);
    const options = only ? (refuse ? [refuse] : []) : all;
    options.forEach((choice, i) => {
      const b = btn('ghost small biz-opt', choice, `item|${n}|opt|${i}`, () => answer(item, choice));
      if (refuse && choice === refuse) b.dataset.refuse = '';
      else if (str(item.recommend) && choice.toLowerCase() === item.recommend.toLowerCase()) b.dataset.rec = '';
      b.disabled = busy;
      opts.append(b);
    });
    const foot = make('div', 'biz-item-foot');
    const note = input('text', ui.notes.get(n) ?? '', `item|${n}|note`, v => { ui.notes.set(n, v); }, { maxlength: 500, placeholder: 'A note for the model (optional)', 'aria-label': `A note with your answer to #${n}` });
    note.classList.add('biz-note-input');
    const no = btn('biz-quiet', 'Not needed', `item|${n}|no`, () => withdraw(item));
    no.title = 'Take this item off the list without an answer';
    no.disabled = busy;
    foot.append(note, no);
    box.append(opts);
    box.append(foot);
    return box;
  }

  // A program that waits for your yes before it starts: which program, where, and the whole task text that is sent. The two buttons
  // are the only answers; no answer is never a yes (the card goes away at its time and the program is not started).
  function startEl(card) {
    const id = str(card.id);
    const busy = ui.busy.has(`start|${id}`);
    const label = str(card.label) || 'The program';
    const box = make('article', 'biz-item biz-start');
    box.dataset.start = id;
    const title = make('h4', 'biz-item-title', `Start ${label}: ${str(card.title) || 'a task'}`);
    title.id = uid('biz-st');
    box.setAttribute('aria-labelledby', title.id);
    const top = make('div', 'biz-item-top');
    top.append(pill('Start a program', 'amber'), pill(label));
    if (num(card.askedAt)) top.append(make('span', 'biz-age', agoText(card.askedAt)));
    const who = str(card.lead);
    const where = str(card.routine) ? `the routine ${card.routine}` : 'a chat';
    box.append(top, title, make('p', 'biz-item-from', who ? `Asked by ${who} in ${where}.` : `Asked in ${where}.`));
    const facts = make('dl', 'biz-start-facts');
    const fact = (name, value) => { if (value) facts.append(make('dt', 'biz-start-key', name), make('dd', 'biz-start-val', value)); };
    fact('Program', [label, str(card.model)].filter(Boolean).join(', '));
    fact('Folder', str(card.folder));
    fact('Scope', arr(card.scope).map(String).filter(Boolean).join(', ') || 'The whole folder');
    fact('Agent type', str(card.type));
    box.append(facts);
    const head = make('p', 'biz-start-label', `${TEXT.startText}:`);
    head.id = uid('biz-stt');
    const text = make('pre', 'biz-draft-text biz-start-text', str(card.text) || TEXT.startNoText);
    text.tabIndex = 0;
    text.dataset.fk = `start|${id}|text`;
    text.setAttribute('aria-labelledby', head.id);
    box.append(head, text);
    if (num(card.until)) box.append(make('p', 'biz-note biz-start-until', `With no answer by ${clock(card.until)} it is not started.`));
    const opts = make('div', 'biz-opts');
    opts.setAttribute('role', 'group');
    opts.setAttribute('aria-label', `Start ${label}, or not`);
    const yes = btn('ghost small biz-opt', `Start ${label}`, `start|${id}|yes`, () => answerStart(card, true));
    const no = btn('ghost small biz-opt', 'No', `start|${id}|no`, () => answerStart(card, false));
    no.dataset.refuse = '';
    yes.disabled = busy;
    no.disabled = busy;
    opts.append(yes, no);
    box.append(opts);
    return box;
  }
  // The cards of every program that waits, above everything else on Today: they wait a few minutes only. Null with none.
  function startsSection() {
    const cards = startCards();
    if (!cards.length) return null;
    const sec = section(TEXT.startHead, 'biz-starts', MU.ui?.badge?.(cards.length, 'amber') ?? null);
    if (str(D.starts.data?.why)) sec.append(make('p', 'biz-note biz-about', sentence(D.starts.data.why)));
    const list = make('div', 'biz-items');
    for (const card of cards) list.append(startEl(card));
    sec.append(list);
    return sec;
  }

  // The line that says routines are held after a Stop, with the time it ends and the button that ends it now. Null with no hold.
  function holdBox() {
    const sch = isObj(D.rt.data?.scheduler) ? D.rt.data.scheduler : null;
    if (!sch || !isObj(sch.hold) || !num(sch.hold.until)) return null;
    const box = make('div', 'biz-hold');
    box.setAttribute('role', 'status');
    box.append(make('p', 'biz-hold-text', str(sch.why) ? sentence(sch.why) : `No routine starts by itself until ${clock(sch.hold.until)}.`));
    const go = btn('ghost small', 'Resume routines', 'rt|resume', () => resumeRoutines());
    go.disabled = ui.busy.has('rt|resume');
    box.append(go);
    return box;
  }

  // The lines of one business's brief (BUSINESS-DESIGN.md section 5.4). Each function returns a line, lines or nothing.
  const line = (text, cls) => make('p', `biz-line ${cls ?? ''}`.trim(), text);
  const BRIEF_LINES = [
    b => {
      const r = isObj(b.runs) ? b.runs : {};
      const total = num(r.done) + num(r.failed) + num(r.stopped) + num(r.skipped) + num(r.nothing);
      const span = ui.range === 'week' ? 'This week' : 'Today';
      if (!total) return line(`${span}: nothing ran.`);
      const bits = [`${num(r.done)} ran`, `${num(r.failed)} failed`, `${num(r.skipped)} skipped`];
      if (num(r.stopped)) bits.push(`${num(r.stopped)} stopped`);
      if (num(r.nothing)) bits.push(`${num(r.nothing)} had nothing to do`);
      return line(`${span}: ${bits.join(', ')}.`, num(r.failed) ? 'biz-line-warn' : '');
    },
    b => {
      const l = b.runs?.last;
      if (!isObj(l) || !str(l.name)) return null;
      const at = num(l.at) ? ` ${whenText(l.at)}` : '';
      const out = [];
      if (l.state === 'done') out.push(line(`Last run: ${l.name}${at}. ${sentence(l.why)}`.trim()));
      else if (l.state === 'nothing') out.push(line(`Last check: ${l.name}${at}, nothing to do.`));
      else out.push(line(`Last run: ${l.name}${at}, ${{ failed: 'failed', stopped: 'stopped', interrupted: 'cut off', skip: 'skipped', skipped: 'skipped' }[l.state] ?? str(l.state)}. ${sentence(l.why)}`.trim(), l.state === 'failed' ? 'biz-line-bad' : ''));
      if (str(l.done)) out.push(line(`Finished: ${sentence(l.done)}`));
      if (str(l.next)) out.push(line(`Next step: ${sentence(l.next)}`));
      return out;
    },
    // No next run is promised while nothing starts by itself (everything paused, or the scheduler is off for this start).
    b => (noStarts() ? [] : arr(b.next)).filter(n => isObj(n) && num(n.at)).slice(0, 3).map(n => line(`Next run: ${str(routines().find(r => r.id === n.routine)?.name) || str(n.name) || str(n.routine) || 'a routine'}, ${whenText(n.at)}.`)),
    b => {
      const use = arr(b.usage).filter(isObj);
      if (!use.length) return null;
      const list = make('ul', 'biz-use');
      for (const u of use) {
        const li = make('li', 'biz-use-row');
        const known = Number.isFinite(u.usedPercent) && u.state !== 'unknown';
        const pct = Math.round(num(u.usedPercent));
        const cap = num(u.line);
        const over = known && (u.state === 'limit' || (cap > 0 && pct >= cap));
        const meter = make('progress', 'biz-meter');
        meter.max = 100;
        meter.value = Math.min(100, pct);
        if (over) meter.dataset.full = '';
        const name = str(u.label) || providerLabel(str(u.provider));
        meter.setAttribute('aria-label', `${name} plan use`);
        if (!known) {
          li.append(make('span', 'biz-use-name', name), make('span', 'biz-use-pct biz-use-unknown', cap ? `plan use not known yet (its line is ${cap}%)` : 'plan use not known yet'));
          list.append(li);
          continue;
        }
        li.append(make('span', 'biz-use-name', name), meter, make('span', `biz-use-pct${over ? ' biz-bad' : ''}`, cap ? `${pct}% of its ${cap}% line` : `${pct}% of the plan`));
        list.append(li);
      }
      return list;
    },
    b => (isObj(b.minutes) && num(b.minutes.of) ? line(`${num(b.minutes.used)} of ${num(b.minutes.of)} minutes of model time used${ui.range === 'week' ? '' : ' today'}.`) : null),
    b => arr(b.goals).filter(g => isObj(g) && str(g.text)).map(g => line(`Goal: ${g.text}, ${num(g.now)} of ${num(g.target)}${str(g.unit) ? ` ${g.unit}` : ''}${str(g.by) ? ` by ${g.by}` : ''}.`)),
    b => {
      const bits = [];
      if (num(b.tasks)) bits.push(`${plural(num(b.tasks), 'task', 'tasks')} handed to the team`);
      if (num(b.outside)) bits.push(`${plural(num(b.outside), 'outside step', 'outside steps')} approved by you`);
      if (num(b.outsideRefused)) bits.push(`${plural(num(b.outsideRefused), 'outside step', 'outside steps')} refused by you`);
      if (num(b.decisions?.waiting)) bits.push(`${num(b.decisions.waiting)} waiting for you${num(b.decisions.oldestAt) ? ` (the oldest from ${agoText(b.decisions.oldestAt)})` : ''}`);
      return bits.length ? line(`${bits.join(', ')}.`.replace(/^./, c => c.toUpperCase())) : null;
    },
    b => {
      const list = arr(b.handoffs).filter(h => isObj(h) && str(h.program) && num(h.count));
      // The program in words: the label the record carries, or, for a line written without one, its id read aloud.
      const named = h => str(h.label) || (str(h.program).startsWith('hub:') ? `${str(h.program).slice(4)} on the hub` : str(h.program));
      return list.length ? line(`Handed to programs: ${list.map(h => `${named(h)} ${plural(num(h.count), 'time', 'times')}${num(h.ok) < num(h.count) ? ` (${num(h.count) - num(h.ok)} failed)` : ''}`).join(', ')}.`) : null;
    },
    // BUSINESS.md: what holds now (charterChanged), and that it was flagged in this time. The record's own lines are not shown as
    // they are: they speak of "the owner", and a line of this morning is no longer true once he has confirmed the text.
    b => {
      const flagged = arr(b.flags).map(String).filter(Boolean).length > 0;
      if (b.charterChanged === true) return line('BUSINESS.md is not the text you last confirmed. Read it under Setup and confirm it, or put your own text back.', 'biz-line-warn');
      if (!flagged) return null;
      return b.charterChanged === false
        ? line('BUSINESS.md was changed in this time. The text that is there now is the one you confirmed.')
        : line('BUSINESS.md was changed in this time. Look at it under Setup.', 'biz-line-warn');
    },
  ];

  function planLine(id) {
    const one = ones.get(id);
    const list = arr((one?.data?.files ?? one?.data)?.plan?.items).filter(isObj);
    if (!list.length) return null;
    const count = mark => list.filter(i => str(i.mark).trim() === mark).length;
    return line(`Plan: ${count('')} planned, ${count('~')} being done, ${count('x')} done, ${count('?')} waiting for you.`);
  }

  function briefCard(b, full) {
    const rec = bizById(b.id) ?? b;
    const status = str(rec.status) || str(b.status) || 'active';
    const card = make('article', 'biz-card');
    card.dataset.id = str(b.id);
    const head = make('div', 'biz-card-head');
    const name = make('h4', 'biz-card-name', str(b.name) || str(rec.name));
    name.id = uid('biz-c');
    card.setAttribute('aria-labelledby', name.id);
    const st = STATUS[status] ?? STATUS.active;
    head.append(name, pill(st.label, st.tone));
    if (status !== 'closed') {
      const key = `card|${b.id}|pause`;
      const p = btn('ghost small biz-pause', status === 'paused' ? 'Resume' : 'Pause', key, () => setStatus(rec, status === 'paused' ? 'active' : 'paused', key));
      p.setAttribute('aria-label', `${status === 'paused' ? 'Resume' : 'Pause'} ${str(rec.name)}`);
      p.disabled = ui.busy.has(key);
      head.append(p);
    }
    card.append(head);
    if (str(rec.purpose)) card.append(make('p', 'biz-card-purpose', rec.purpose));
    if (full) {
      for (const fn of BRIEF_LINES) {
        try {
          const out = fn(b);
          if (out) card.append(...[].concat(out));
        } catch (err) { console.error('Businesses: a line of the brief could not be drawn.', err); }
      }
      if (ui.sel !== ALL) {
        const pl = planLine(b.id);
        if (pl) card.append(pl);
      }
    }
    return card;
  }

  function hubLine() {
    const h = D.brief.data?.hub;
    if (!isObj(h)) return null;
    const box = make('p', 'biz-hub');
    if (h.connected !== true) {
      box.textContent = 'Plenum Hub is not connected, so its counts are not shown.';
      return box;
    }
    const m = Number.isFinite(h.waitingForYou) ? h.waitingForYou : null;
    const a = Number.isFinite(h.approvalsForYou) ? h.approvalsForYou : null;
    box.append(m === null && a === null ? 'Plenum Hub is connected. Its counts are not known.' : `Plenum Hub: ${plural(m ?? 0, 'message waits', 'messages wait')} for you, ${plural(a ?? 0, 'approval', 'approvals')}. `);
    if (LOCAL_LINK.test(str(h.adminUrl))) {
      const link = make('a', 'biz-link', 'Open the hub\'s screens');
      link.href = h.adminUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.dataset.fk = 'hub|link';
      box.append(link);
    }
    return box;
  }

  const fileNotes = () => [D.biz.data?.newer === true ? TEXT.bizNewer : '', D.biz.data?.damaged === true ? TEXT.bizDamaged : ''].filter(Boolean).map(t => make('p', 'biz-calm biz-bad', t));

  function paintToday(panel) {
    // First what waits only minutes: a program that starts after your yes. It is shown whatever else this tab can or cannot draw.
    const starting = startsSection();
    if (starting) panel.append(starting);
    const made = madeNote();
    if (made) panel.append(made);
    const g = gate('biz', D.biz);
    if (g) {
      panel.append(g);
      if (D.biz.state !== 'missing') return;
    }
    for (const note of fileNotes()) panel.append(note);
    const held = holdBox();
    if (held) panel.append(held);
    if (D.biz.state === 'ok' && !open().length) {
      panel.append(firstForm('Start your first business', TEXT.noBusiness));
      if (businesses().length) panel.append(make('p', 'biz-note', 'Your closed businesses are under Setup. Open one again there.'));
      return;
    }

    // The list first.
    const list = visibleItems();
    const waiting = section('Waiting for you', 'biz-waiting', D.dec.state === 'ok' && list.length ? MU.ui?.badge?.(list.length, 'amber') : null);
    const dg = gate('dec', D.dec);
    if (dg) waiting.append(dg);
    else {
      if (D.dec.state === 'error') waiting.append(make('p', 'biz-calm biz-bad', `The list could not be read again. ${sentence(D.dec.error)}`));
      waiting.append(make('p', 'biz-note biz-approved', TEXT.approved));
      for (const hint of arr(D.dec.data?.hints).map(String).filter(Boolean)) waiting.append(make('p', 'biz-line biz-line-warn', sentence(hint)));
      if (!list.length) waiting.append(make('p', 'biz-calm', TEXT.nothingWaits));
      else {
        // Whose words the options and the type are, and what a yes never does: the server's own sentences, said once for the whole list.
        const notes = D.dec.data?.notes;
        const about = [str(notes?.options), str(notes?.type), toYou(str(notes?.pay) || str(list[0]?.payNote))].filter(Boolean).map(sentence).join(' ');
        if (about) waiting.append(make('p', 'biz-note biz-about', about));
      }
      const ul = make('div', 'biz-items');
      for (const item of list) ul.append(itemEl(item));
      waiting.append(ul);
    }
    panel.append(waiting);
    if (D.biz.state !== 'ok') return;

    // Then each business in a few lines.
    const seg = make('div', 'seg biz-range');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Time span of the brief');
    for (const [id, label] of [['day', 'Today'], ['week', 'This week']]) {
      const b = btn('seg-btn', label, `range|${id}`, () => { if (ui.range === id) return; ui.range = id; Object.assign(D.brief, slot()); paint(); refresh(); });
      b.setAttribute('aria-pressed', String(ui.range === id));
      seg.append(b);
    }
    const brief = section(ui.sel === ALL ? 'How each business stands' : 'How it stands', 'biz-brief', seg);
    const shownBiz = open().filter(b => ui.sel === ALL || b.id === ui.sel);
    const bg = gate('brief', D.brief);
    if (bg) brief.append(bg);
    if (D.brief.state === 'error' && D.brief.data) brief.append(make('p', 'biz-calm biz-bad', `The brief could not be read again. ${sentence(D.brief.error)}`));
    const rows = arr(D.brief.data?.businesses).filter(isObj);
    const cards = make('div', 'biz-cards');
    for (const b of shownBiz) {
      const row = rows.find(r => r.id === b.id);
      cards.append(briefCard(row ?? b, Boolean(row)));
    }
    if (ui.sel !== ALL && bizById(ui.sel)?.status === 'closed') brief.append(make('p', 'biz-calm', 'This business is closed. Its files and record are kept. Open it again under Setup.'));
    brief.append(cards);
    panel.append(brief);
    const hub = hubLine();
    if (hub) panel.append(hub);
  }

  // ---------- drawing: Routines ----------

  function whenWords(w) {
    if (!isObj(w)) return 'No time set';
    if (w.type === 'every') return num(w.hours) === 1 ? 'Every hour' : `Every ${num(w.hours)} hours`;
    const days = [...new Set(arr(w.days).map(d => (d === 7 ? 0 : d)))];
    const names = DAYS.filter(([d]) => days.includes(d));
    const which = !days.length || days.length === 7 ? 'Every day'
      : days.length === 5 && [1, 2, 3, 4, 5].every(d => days.includes(d)) ? 'Monday to Friday'
        : names.map(d => d[1]).join(', ');
    return `${which} at ${str(w.at) || '00:00'}`;
  }

  function lastWords(r) {
    const l = isObj(r.last) ? r.last : {};
    if (!num(l.at)) return 'It has not run yet.';
    const at = whenText(l.at);
    const lead = str(l.lead) ? `, led by ${modelLabel(l.lead)}` : '';
    const tail = [str(l.done) ? `Finished: ${sentence(l.done)}` : '', str(l.next) ? `Next step: ${sentence(l.next)}` : ''].filter(Boolean).join(' ');
    if (l.state === 'running') return `Running since ${at}${lead}.`;
    if (l.state === 'held') return `Not started ${at}. ${sentence(l.why)}`.trim();
    // A finished run can carry a sentence too (its lead's plan use was not known, so the stop line could not be checked).
    if (l.state === 'done') return `Last run ${at}: finished in ${spanText(l.ms)}${lead}. ${[sentence(l.why), tail].filter(Boolean).join(' ')}`.trim();
    if (l.state === 'nothing') return `Last check ${at}: nothing to do, so no model was started.`;
    if (l.state === 'failed') return `Last run ${at}: failed. ${sentence(l.why)}`.trim();
    if (l.state === 'stopped') return `Last run ${at}: stopped. ${sentence(l.why)}`.trim();
    if (l.state === 'interrupted') return `Last run ${at}: cut off. ${sentence(l.why) || 'Plenum closed during this run.'}`;
    if (l.state === 'skip' || l.state === 'skipped') return `Skipped ${at}. ${sentence(l.why)}`.trim();
    return `Last run ${at}: ${str(l.state) || 'no result'}. ${sentence(l.why)}`.trim();
  }

  const isHeld = r => r.playbookChanged === true || r.changed === true || r.held === true || r.hold === 'playbook' || /^(held|changed)$/.test(str(r.last?.state));

  // The two facts about a routine's folder (BUSINESS-DESIGN.md section 5.3): may the Routines thread write, and the approval mode.
  // GET /api/routines sends them for every folder that has a routine; for a folder without one they are asked for by its id.
  const facts = new Map();
  const sentFolder = (data, project) => {
    const f = Array.isArray(data?.folders) ? data.folders.find(x => x?.project === project) : isObj(data?.folders) ? data.folders[project] : null;
    return isObj(f) ? f : routines().find(r => r.project === project && isObj(r.folder))?.folder ?? null;
  };
  // The folder of the editor's routine, when GET /api/routines did not say its two facts.
  const factsFolder = () => {
    const e = ui.editor;
    const project = e ? e.project || arr(bizById(e.business)?.projects)[0] || '' : '';
    return project && !sentFolder(D.rt.data, project) ? project : '';
  };
  async function loadFacts(project) {
    const r = await ask(`/api/routines?project=${encodeURIComponent(project)}`);
    const f = r.ok ? sentFolder(r.data, project) : null;
    const sig = JSON.stringify(f ?? null);
    if (sig === JSON.stringify(facts.get(project) ?? null)) return false;
    if (isObj(f)) facts.set(project, f); else facts.delete(project);
    return true;
  }
  function folderFacts(project) {
    const data = D.rt.data ?? {};
    const sent = [sentFolder(data, project), facts.get(project)].filter(isObj);
    const pickOf = (keys, ok) => { for (const o of sent) for (const k of keys) if (ok(o[k])) return o[k]; return undefined; };
    let canWrite = pickOf(['canWrite'], v => typeof v === 'boolean');
    let approvals = pickOf(['approvals'], v => ['ask', 'auto', 'all'].includes(v));
    const st = state();
    if (canWrite === undefined && st.activeProject === project) {
      const thread = arr(st.threads).find(t => str(t.name).toLowerCase() === 'routines');
      canWrite = st.multiWriter === true ? true : thread ? thread.writer === true : false;
    }
    if (approvals === undefined) approvals = projects().find(p => p.id === project)?.approvals;
    // Whether "More than one thread may write" is on: the page's own state for the open folder, else what the server said, else not
    // known. canWrite is not the same fact (the Routines thread may be that folder's one writer), so it is never used for the switch.
    const multi = st.activeProject === project ? st.multiWriter === true : pickOf(['multiWriter'], v => typeof v === 'boolean') ?? null;
    return { canWrite: canWrite ?? null, approvals: ['ask', 'auto', 'all'].includes(approvals) ? approvals : null, multi };
  }

  function folderLines(project, keyPrefix) {
    const f = folderFacts(project);
    const box = make('div', 'biz-facts');
    const write = make('div', 'biz-fact');
    write.dataset.fact = 'write';
    write.dataset.state = f.canWrite === true ? 'ok' : f.canWrite === false ? 'warn' : 'unknown';
    write.append(make('p', 'biz-fact-text', f.canWrite === true ? TEXT.mayWrite : f.canWrite === false ? TEXT.readOnly : TEXT.writeUnknown));
    if (f.canWrite !== true || f.multi) {
      const row = switchRow('More than one thread may write', `In ${projectName(project)}`, f.multi === true, `${keyPrefix}|mw`, (on, boxEl) => setMultiWriter(project, on, boxEl));
      const mwBox = row.querySelector('input');
      mwBox.disabled = ui.busy.has(`mw|${project}`);
      // Not known for a folder that is not the open one: the switch shows no state rather than a guess.
      if (f.multi === null) { mwBox.indeterminate = true; mwBox.setAttribute('aria-checked', 'mixed'); }
      write.append(row);
    }
    const mode = make('div', 'biz-fact');
    mode.dataset.fact = 'mode';
    mode.dataset.state = f.approvals === 'ask' ? 'ok' : f.approvals ? 'warn' : 'unknown';
    mode.append(make('p', 'biz-fact-text', f.approvals === 'ask' ? TEXT.ask : f.approvals === 'all' ? TEXT.all : f.approvals ? TEXT.auto : `Plenum cannot tell this folder's approval mode from here. ${TEXT.ask}`));
    box.append(write, mode);
    return { box, facts: f };
  }

  function routineRow(r) {
    const running = runningIds().includes(String(r.id));
    const busy = ui.busy.has(`rt|${r.id}`);
    const held = isHeld(r);
    const row = make('article', 'biz-rt');
    row.dataset.id = str(r.id);
    row.dataset.on = String(r.on === true);
    const name = make('h4', 'biz-rt-name', str(r.name) || 'A routine');
    name.id = uid('biz-r');
    row.setAttribute('aria-labelledby', name.id);

    const top = make('div', 'biz-rt-top');
    const sw = make('label', 'switch biz-rt-switch');
    const box = make('input');
    box.type = 'checkbox';
    box.setAttribute('role', 'switch');
    box.checked = r.on === true;
    box.disabled = busy;
    box.dataset.fk = `rt|${r.id}|on`;
    box.setAttribute('aria-label', `${str(r.name)}: switched ${r.on === true ? 'on' : 'off'}`);
    const track = make('span', 'switch-track');
    track.setAttribute('aria-hidden', 'true');
    sw.append(box, track);
    box.addEventListener('change', () => {
      if (!box.checked) return switchRoutine(r, false);
      // Switching on waits for one more press, under the two lines about the folder.
      box.checked = false;
      ui.arming = r.id;
      ui.editor = null;
      ui.focus = `rt|${r.id}|arm`;
      paint();
      refresh();
    });
    top.append(sw, name);
    if (running) top.append(pill('Running', 'accent'));
    if (ui.sel === ALL) top.append(pill(bizName(r.business)));

    // A business that is paused or closed holds every one of its routines, so no next run is promised.
    const bz = bizById(r.business);
    const heldBy = bz && bz.status !== 'active' ? bz : null;
    const when = make('p', 'biz-rt-when', `${whenWords(r.when)}. ${r.on !== true ? 'Switched off.' : heldBy ? `Paused with ${str(heldBy.name) || 'its business'}: it will not start until you press Resume.` : num(r.next) ? (noStarts() ? TEXT.noStart : `Next run ${whenText(r.next)}.`) : 'The next run is not set yet.'}`);
    row.append(top, when, make('p', `biz-rt-last${r.last?.state === 'failed' ? ' biz-bad' : ''}`, lastWords(r)));
    if (held) row.append(make('p', 'biz-rt-held', TEXT.held));

    const acts = make('div', 'biz-actions');
    const run = btn('ghost small', 'Run now', `rt|${r.id}|run`, () => routineAct(r, 'run'));
    run.disabled = busy || running;
    acts.append(run);
    if (running) {
      const stop = btn('ghost small biz-stop', 'Stop', `rt|${r.id}|stop`, () => routineAct(r, 'stop'));
      stop.setAttribute('aria-label', `Stop ${str(r.name)}`);
      acts.append(stop);
    }
    const book = held ? ui.books.get(r.id) : null;
    const bookOpen = Boolean(book) && book.state !== 'closed';
    if (held) {
      const kb = btn('ghost small', bookOpen ? 'Close the playbook' : 'Read the new playbook', `rt|${r.id}|keep`, () => openBook(r));
      kb.setAttribute('aria-expanded', String(bookOpen));
      acts.append(kb);
    }
    acts.append(
      btn('biz-quiet', 'Edit', `rt|${r.id}|edit`, () => { ui.editor = editorOf(r); ui.arming = ''; ui.focus = 'ed|name'; paint(); refresh(); }),
      btn('biz-quiet', 'Delete', `rt|${r.id}|delete`, () => routineAct(r, 'delete')),
    );
    row.append(acts);

    // Keep: the playbook as a run would get it is read here first, and Keep accepts that text and no other.
    if (bookOpen) {
      const well = make('div', 'biz-draft biz-book');
      if (book.state === 'loading') {
        const p = make('p', 'biz-calm biz-wait');
        p.append(make('span', 'spinner'), TEXT.bookWait);
        well.append(p);
      } else if (book.state === 'error') {
        well.append(make('p', 'biz-calm biz-bad', book.error));
      } else {
        const data = book.data;
        well.append(make('p', 'biz-draft-name', str(data.file)));
        const text = make('pre', 'biz-draft-text', str(data.text));
        text.tabIndex = 0;
        text.dataset.fk = `rt|${r.id}|book`;
        text.setAttribute('aria-label', `The playbook ${str(data.file)} as a run would get it`);
        well.append(text);
        if (data.cut === true) well.append(make('p', 'biz-note', TEXT.bookCut(str(data.text).length, num(data.length))));
        if (data.changed === false) well.append(make('p', 'biz-note', TEXT.bookSame));
        const go = make('div', 'biz-actions');
        const keep = btn('primary small', 'Keep this text', `rt|${r.id}|keepyes`, () => keepBook(r));
        keep.disabled = busy;
        go.append(keep, btn('ghost small', 'Close', `rt|${r.id}|bookclose`, () => openBook(r)));
        well.append(go);
      }
      row.append(well);
    }

    if (ui.arming === r.id) {
      const arm = make('div', 'biz-arm');
      const h = make('h5', 'biz-arm-title', 'Before you switch this on');
      const { box: lines } = folderLines(r.project, `rt|${r.id}`);
      const go = make('div', 'biz-actions');
      const yes = btn('primary small', 'Switch on', `rt|${r.id}|arm`, () => switchRoutine(r, true));
      yes.disabled = busy;
      go.append(yes, btn('ghost small', 'Cancel', `rt|${r.id}|disarm`, () => { ui.arming = ''; ui.focus = `rt|${r.id}|on`; paint(); }));
      arm.append(h, lines, go);
      row.append(arm);
    }
    return row;
  }

  // A follow-up run that is going on: the timer started it so that the lead acts on your answers. It belongs to no routine, so it has
  // a row of its own with Running and a Stop.
  function followUpRow(f) {
    const busy = ui.busy.has(`fu|${f.key}`);
    const row = make('article', 'biz-rt biz-follow');
    row.dataset.follow = str(f.key);
    const name = make('h4', 'biz-rt-name', str(f.name) || 'Follow-up');
    name.id = uid('biz-f');
    row.setAttribute('aria-labelledby', name.id);
    const top = make('div', 'biz-rt-top');
    top.append(name, pill('Running', 'accent'));
    if (ui.sel === ALL && str(f.business)) top.append(pill(bizName(f.business)));
    const lead = str(f.lead) ? `, led by ${modelLabel(f.lead)}` : '';
    row.append(top, make('p', 'biz-rt-last', `${TEXT.followUp} in ${projectName(f.project)}. Plenum started it by itself${num(f.since) ? ` ${whenText(f.since)}` : ''}${lead}.`));
    const acts = make('div', 'biz-actions');
    const stop = btn('ghost small biz-stop', 'Stop', `fu|${f.key}|stop`, () => stopFollowUp(f));
    stop.setAttribute('aria-label', 'Stop the follow-up run');
    stop.disabled = busy;
    acts.append(stop);
    row.append(acts);
    return row;
  }

  function editorOf(r) {
    const w = isObj(r?.when) ? r.when : {};
    const only = ui.sel !== ALL ? ui.sel : open().length === 1 ? open()[0].id : '';
    return {
      id: str(r?.id), on: r?.on === true, business: str(r?.business) || only, project: str(r?.project), name: str(r?.name),
      type: w.type === 'every' ? 'every' : 'daily', at: str(w.at) || '06:30', hours: num(w.hours) || 6,
      days: new Set(arr(w.days).length ? arr(w.days).map(d => (d === 7 ? 0 : d)) : [1, 2, 3, 4, 5]),
      source: str(r?.prompt?.text) && !str(r?.prompt?.file) ? 'text' : 'file', file: str(r?.prompt?.file), text: str(r?.prompt?.text),
      folder: str(r?.onlyIf?.folder), leads: arr(r?.leads).map(String),
    };
  }

  // An ordered list of models with Up, Down and Remove, and a menu to add one.
  function leadsEditor(list, offers, key, emptyText, changed) {
    const box = make('div', 'biz-leads');
    if (!list.length) box.append(make('p', 'biz-note', emptyText));
    const ol = make('ol', 'biz-lead-list');
    list.forEach((ref, i) => {
      const li = make('li', 'biz-lead');
      const label = modelLabel(ref);
      li.append(make('span', 'biz-lead-rank', `${i + 1}.`), make('span', 'biz-lead-name', label));
      const move = (to, fkey) => { const [x] = list.splice(i, 1); list.splice(to, 0, x); ui.focus = fkey; changed(); };
      const up = btn('biz-quiet', 'Up', `${key}|${ref}|up`, () => move(i - 1, `${key}|${ref}|${i - 1 > 0 ? 'up' : 'down'}`));
      up.setAttribute('aria-label', `Move ${label} up`);
      up.disabled = i === 0;
      const down = btn('biz-quiet', 'Down', `${key}|${ref}|down`, () => move(i + 1, `${key}|${ref}|${i + 1 < list.length - 1 ? 'down' : 'up'}`));
      down.setAttribute('aria-label', `Move ${label} down`);
      down.disabled = i === list.length - 1;
      const rm = btn('biz-quiet', 'Remove', `${key}|${ref}|rm`, () => { list.splice(i, 1); ui.focus = `${key}|add`; changed(); });
      rm.setAttribute('aria-label', `Remove ${label}`);
      li.append(up, down, rm);
      ol.append(li);
    });
    if (list.length) box.append(ol);
    const free = offers.filter(ref => !list.includes(ref));
    if (free.length) {
      const add = select([['', 'Add a model…'], ...free.map(ref => [ref, modelLabel(ref)])], '', `${key}|add`, v => { if (!v) return; list.push(v); ui.focus = `${key}|add`; changed(); });
      add.setAttribute('aria-label', 'Add a model');
      box.append(add);
    }
    return box;
  }

  function editorEl() {
    const e = ui.editor;
    const box = section(e.id ? `Change ${e.name || 'the routine'}` : 'New routine', 'biz-editor');
    const form = make('form', 'biz-form');
    form.noValidate = true;
    const redraw = () => paint();
    if (!e.id) {
      const opts = open().map(b => [b.id, str(b.name)]);
      form.append(field('Business', select([['', 'Choose a business…'], ...opts], e.business, 'ed|business', v => { e.business = v; e.project = ''; e.leads = []; redraw(); refresh(); })));
    }
    form.append(field('Name', input('text', e.name, 'ed|name', v => { e.name = v; }, { maxlength: 60, placeholder: 'For example: Morning intake' })));

    const when = make('fieldset', 'biz-set');
    when.append(make('legend', 'biz-label', 'When'));
    when.append(select([['daily', 'On set days, at a time'], ['every', 'Every few hours']], e.type, 'ed|type', v => { e.type = v; redraw(); }));
    when.firstElementChild.nextElementSibling.setAttribute('aria-label', 'How often');
    if (e.type === 'daily') {
      const at = input('time', e.at, 'ed|at', v => { e.at = v; });
      at.setAttribute('aria-label', 'Time of day');
      when.append(at);
      const days = make('div', 'biz-days');
      days.setAttribute('role', 'group');
      days.setAttribute('aria-label', 'Days of the week');
      for (const [d, short, long] of DAYS) {
        const l = make('label', 'biz-day');
        const c = make('input');
        c.type = 'checkbox';
        c.checked = e.days.has(d);
        c.dataset.fk = `ed|day|${d}`;
        c.setAttribute('aria-label', long);
        c.addEventListener('change', () => { if (c.checked) e.days.add(d); else e.days.delete(d); });
        l.append(c, make('span', null, short));
        days.append(l);
      }
      when.append(days);
    } else {
      const hrs = input('number', e.hours, 'ed|hours', v => { e.hours = v; }, { min: 1, max: 168, step: 1 });
      hrs.setAttribute('aria-label', 'Hours between runs (1 to 168)');
      when.append(hrs, make('span', 'biz-note', 'hours between runs (1 to 168)'));
    }
    form.append(when);

    const one = e.business ? ones.get(e.business) : null;
    const books = arr((one?.data?.files ?? one?.data)?.playbooks).map(String);
    const what = make('fieldset', 'biz-set');
    what.append(make('legend', 'biz-label', 'What the lead is told'));
    const src = select([['file', 'A playbook from the folder'], ['text', 'A prompt written here']], e.source, 'ed|source', v => { e.source = v; redraw(); });
    src.setAttribute('aria-label', 'Where the instructions come from');
    what.append(src);
    if (e.source === 'file') {
      const names = books.map(n => (n.includes('/') ? n : `playbooks/${n}`));
      if (names.length) {
        if (!names.includes(e.file)) e.file = e.file || names[0];
        const options = names.map(n => [n, n]);
        if (!names.includes(e.file)) options.unshift([e.file, `${e.file} (not in the folder)`]);
        const pb = select(options, e.file, 'ed|file', v => { e.file = v; });
        pb.setAttribute('aria-label', 'Playbook');
        what.append(pb);
      } else {
        const pb = input('text', e.file, 'ed|file', v => { e.file = v; }, { maxlength: 200, placeholder: 'playbooks/intake.md', 'aria-label': 'Playbook file, inside the business folder' });
        what.append(pb);
      }
      what.append(make('p', 'biz-note', 'A playbook is your instruction. If its text changes later, the routine waits until you press Keep.'));
    } else {
      const ta = make('textarea', 'biz-input biz-prompt');
      ta.value = e.text;
      ta.rows = 4;
      ta.maxLength = 8000;
      ta.dataset.fk = 'ed|text';
      ta.setAttribute('aria-label', 'Prompt');
      ta.placeholder = 'What the lead should do each time';
      ta.addEventListener('input', () => { e.text = ta.value; });
      what.append(ta);
    }
    form.append(what);

    form.append(field('Start only when this folder holds a file (optional)', input('text', e.folder, 'ed|folder', v => { e.folder = v; }, { maxlength: 200, placeholder: 'inbox' }), 'A folder inside the business folder. While it is empty no model is started, which costs nothing.'));

    const bizLeads = arr(bizById(e.business)?.leads).map(String);
    const offers = [...new Set([...bizLeads, ...arr(MU.catalog).map(refOf)])];
    const leads = make('fieldset', 'biz-set');
    leads.append(make('legend', 'biz-label', 'Leads, in your order'), leadsEditor(e.leads, offers, 'ed|lead', bizLeads.length ? `It uses the business's leads: ${bizLeads.map(modelLabel).join(', ')}.` : 'It uses the business\'s leads. The business has none yet: add them under Setup.', redraw));
    form.append(leads);

    const project = e.project || arr(bizById(e.business)?.projects)[0] || '';
    if (project && !e.on) {
      const pre = make('div', 'biz-arm');
      pre.append(make('h5', 'biz-arm-title', 'Before you switch it on'), folderLines(project, 'ed').box);
      form.append(pre);
    }

    const row = make('div', 'biz-actions');
    const save = make('button', 'primary small', ui.busy.has('ed') ? 'Saving…' : 'Save');
    save.type = 'submit';
    save.dataset.fk = 'ed|save';
    save.disabled = ui.busy.has('ed');
    row.append(save, btn('ghost small', 'Cancel', 'ed|cancel', () => { ui.focus = e.id ? `rt|${e.id}|edit` : 'rt|new'; ui.editor = null; paint(); }));
    form.append(row);
    form.addEventListener('submit', ev => { ev.preventDefault(); saveRoutine(); });
    box.append(form);
    return box;
  }

  // Whether no routine starts by itself now: everything is paused, or the scheduler says it is held (its reason is on the Routines tab).
  const noStarts = () => D.biz.data?.paused === true || D.brief.data?.paused === true || (isObj(D.rt.data?.scheduler) && D.rt.data.scheduler.paused === true);

  function paintRoutines(panel) {
    const g = gate('rt', D.rt);
    if (g) { panel.append(g); return; }
    if (D.rt.state === 'error') panel.append(make('p', 'biz-calm biz-bad', `The routines could not be read again. ${sentence(D.rt.error)}`));
    const sch = isObj(D.rt.data.scheduler) ? D.rt.data.scheduler : {};
    const list = routines().filter(r => ui.sel === ALL || r.business === ui.sel);
    const anyOn = list.some(r => r.on === true);
    const add = btn('ghost small', 'New routine', 'rt|new', () => { ui.editor = editorOf(null); ui.arming = ''; ui.focus = ui.editor.business ? 'ed|name' : 'ed|business'; paint(); refresh(); });
    add.disabled = D.biz.state === 'ok' && !open().length;
    const sec = section('Routines', 'biz-routines', add);
    const allPaused = D.biz.data?.paused === true || D.brief.data?.paused === true || /^Everything is paused/.test(str(sch.why));
    const held = allPaused ? null : holdBox();
    if (held) sec.append(held);
    else sec.append(make('p', 'biz-note', allPaused ? 'Everything is paused, so no routine starts.'
      : sch.paused === true ? `No routine starts by itself for now. ${sentence(sch.why)}`.trim()
        : anyOn ? 'A routine starts a lead model at its time, as an ordinary chat turn in the folder\'s Routines thread.'
          : 'No routine is switched on, so nothing runs by itself.'));
    // What the scheduler says about its last start by itself (for example that a lead's plan use was not known).
    if (str(sch.note)) sec.append(make('p', 'biz-note biz-sched-note', sentence(sch.note)));
    if (D.rt.data.newer === true) sec.append(make('p', 'biz-calm biz-bad', TEXT.newer));
    if (ui.editor && !ui.editor.id) sec.append(editorEl());
    if (!list.length && !ui.editor) sec.append(make('p', 'biz-calm', D.biz.state === 'ok' && !open().length ? 'Start a business under Today first. Its routines appear here.' : 'There is no routine yet. A template brings some, or make one with New routine.'));
    const rows = make('div', 'biz-rts');
    for (const f of followUps().filter(x => ui.sel === ALL || x.business === ui.sel)) rows.append(followUpRow(f));
    for (const r of list) rows.append(ui.editor?.id === r.id ? editorEl() : routineRow(r));
    sec.append(rows);
    panel.append(sec);
  }

  // ---------- drawing: Setup ----------

  function setupOf(b) {
    if (ui.setup?.id === b.id && ui.setup.dirty) return ui.setup;
    const sig = JSON.stringify(b);
    if (ui.setup?.id === b.id && ui.setup.sig === sig) return ui.setup;
    ui.setup = {
      id: b.id, sig, dirty: false,
      f: { name: str(b.name), purpose: str(b.purpose), leads: arr(b.leads).map(String), runsPerDay: String(b.runsPerDay ?? ''), minutesPerDay: String(b.minutesPerDay ?? ''), lines: Object.fromEntries(Object.entries(isObj(b.lines) ? b.lines : {}).map(([k, v]) => [k, String(v)])), allowApi: b.allowApi === true, hubRoom: str(b.hubRoom) },
    };
    return ui.setup;
  }

  function paintSetup(panel) {
    const g = gate('biz', D.biz);
    if (g) { panel.append(g); return; }
    for (const note of fileNotes()) panel.append(note);
    if (ui.newOpen || !businesses().length) {
      panel.append(firstForm(businesses().length ? 'New business' : 'Start your first business', businesses().length ? '' : TEXT.noBusiness));
      return;
    }
    const b = ui.sel === ALL ? null : bizById(ui.sel);
    if (!b) {
      const add = btn('ghost small', 'New business', 'su|new', () => { ui.newOpen = true; ui.first = null; ui.focus = 'first|name'; paint(); });
      const sec = section('Your businesses', 'biz-all', add);
      const rows = make('div', 'biz-cards');
      for (const x of businesses()) {
        const row = make('div', 'biz-row');
        const st = STATUS[x.status] ?? STATUS.active;
        const main = make('div', 'biz-row-main');
        main.append(make('span', 'biz-row-name', str(x.name)), make('span', 'biz-row-sub', str(x.purpose)));
        const go = btn('ghost small', 'Set up', `su|open|${x.id}`, () => { ui.focus = 'su|name'; pickAsked(x.id); });
        go.setAttribute('aria-label', `Set up ${str(x.name)}`);
        row.append(main, pill(st.label, st.tone), go);
        rows.append(row);
      }
      sec.append(rows, make('p', 'biz-note', TEXT.apart));
      panel.append(sec);
      return;
    }

    const s = setupOf(b);
    const f = s.f;
    // The line above Save says so as soon as a field changes, without drawing the form again (a redraw would cost the caret).
    const save = make('button', 'primary small', ui.busy.has('su') ? 'Saving…' : 'Save');
    save.type = 'submit';
    save.dataset.fk = 'su|save';
    save.disabled = ui.busy.has('su');
    const UNSAVED = 'You have changes that are not saved.';
    const unsaved = make('p', 'biz-note biz-bad biz-unsaved', s.dirty ? UNSAVED : '');
    unsaved.id = uid('biz-u');
    unsaved.hidden = !s.dirty;
    if (s.dirty) save.setAttribute('aria-describedby', unsaved.id);
    else save.removeAttribute('aria-describedby');
    const touch = () => {
      const first = !s.dirty;
      s.dirty = true;
      unsaved.textContent = UNSAVED;
      unsaved.hidden = false;
      if (!unsaved.isConnected) acts.prepend(unsaved);
      save.setAttribute('aria-describedby', unsaved.id);
      if (first) paintHead();
    };
    const status = str(b.status) || 'active';
    const st = STATUS[status] ?? STATUS.active;
    const form = make('form', 'biz-form');
    form.noValidate = true;

    const about = section('About', 'biz-about');
    about.append(
      field('Name', input('text', f.name, 'su|name', v => { f.name = v; touch(); }, { maxlength: 60 })),
      field('What it does, in one sentence', input('text', f.purpose, 'su|purpose', v => { f.purpose = v; touch(); }, { maxlength: 300 })),
      make('p', 'biz-note', `Folder: ${arr(b.projects).map(projectName).join(', ') || 'none'}.`),
    );

    const stSec = section('Status', 'biz-status');
    const row = make('div', 'biz-actions');
    row.append(pill(st.label, st.tone));
    if (status === 'closed') row.append(btn('ghost small', 'Open again', 'su|reopen', () => setStatus(b, 'active', 'su|status')));
    else {
      row.append(btn('ghost small', status === 'paused' ? 'Resume' : 'Pause', 'su|pause', () => setStatus(b, status === 'paused' ? 'active' : 'paused', 'su|status')));
      row.append(btn('ghost small biz-close', 'Close', 'su|close', () => setStatus(b, 'closed', 'su|status')));
    }
    for (const x of row.querySelectorAll('button')) x.disabled = ui.busy.has('su|status');
    stSec.append(row, make('p', 'biz-note', status === 'active' ? 'Its routines run at their times.' : status === 'paused' ? 'Nothing new starts for it until you press Resume.' : 'Closed: kept for the record, with its files. It is hidden from Today.'));

    const leads = section('Leads', 'biz-leads-sec');
    leads.append(make('p', 'biz-note', 'The models that may lead its routines, in your order. The first that can run is used; Plenum never swaps in one you did not list.'), leadsEditor(f.leads, arr(MU.catalog).map(refOf), 'su|lead', 'No lead yet. Add the model that should run its routines.', () => { touch(); paint(); }));

    const one = ones.get(b.id)?.data;
    const today = isObj(one?.today) ? one.today : isObj(one) ? one : {};
    const use = arr(arr(D.brief.data?.businesses).find(x => x?.id === b.id)?.usage).filter(isObj);
    const limits = section('Limits', 'biz-limits');
    limits.append(
      field('Runs a day', input('number', f.runsPerDay, 'su|runs', v => { f.runsPerDay = v; touch(); }, { min: 0, max: 500, step: 1 }), Number.isFinite(today.runs) ? `${today.runs} used today.` : ''),
      field('Minutes of model time a day', input('number', f.minutesPerDay, 'su|minutes', v => { f.minutesPerDay = v; touch(); }, { min: 0, max: 1440, step: 1 }), Number.isFinite(today.minutes) ? `${Math.round(today.minutes)} used today.` : ''),
    );
    const subs = [...new Set([...Object.keys(f.lines), ...use.map(u => str(u.provider)).filter(Boolean)])];
    const lineBox = make('fieldset', 'biz-set');
    lineBox.append(make('legend', 'biz-label', 'Where routines stop on each plan'), make('p', 'biz-note', 'In percent of the plan\'s fullest window. Empty means the team\'s line, 90 unless you changed it. A line only stops work; it never raises itself.'));
    for (const id of subs) {
      const u = use.find(x => x.provider === id);
      const name = str(u?.label) || providerLabel(id);
      const r2 = make('div', 'biz-limit');
      const inp = input('number', f.lines[id] ?? '', `su|line|${id}`, v => { f.lines[id] = v; touch(); }, { min: 1, max: 100, step: 1, placeholder: String(f.lines[id] ? 90 : num(u?.line) || 90), 'aria-label': `${name}: stop at percent` });
      r2.append(make('span', 'biz-limit-name', name), inp, make('span', 'biz-limit-now', !u ? '%' : Number.isFinite(u.usedPercent) ? `% · now ${Math.round(u.usedPercent)}%` : '% · use not known yet'));
      lineBox.append(r2);
    }
    const more = arr(MU.providerRegistry).filter(p => !subs.includes(p.id));
    if (more.length) {
      const add = select([['', 'Add a line for a plan…'], ...more.map(p => [p.id, p.name])], '', 'su|line|add', v => { if (!v) return; f.lines[v] = v === 'codex' ? '50' : '90'; touch(); ui.focus = `su|line|${v}`; paint(); });
      add.setAttribute('aria-label', 'Add a line for a plan');
      lineBox.append(add);
    }
    // This switch is not a field of the form: it applies at once, as the other switches of this pane do, and says so only after the answer.
    const apiRow = switchRow('Models billed per token may work for this business', 'Off: only your subscriptions are used, and a limit is never worked round with a paid route.', f.allowApi, 'su|api', (on, boxEl) => setAllowApi(b, on, boxEl));
    apiRow.querySelector('input').disabled = ui.busy.has('su|api');
    limits.append(lineBox, apiRow);

    const hub = section('Plenum Hub', 'biz-hubroom');
    hub.append(field('Room on the hub', input('text', f.hubRoom, 'su|room', v => { f.hubRoom = v; touch(); }, { maxlength: 64, placeholder: 'The room\'s name, as it is on the hub' }), 'Its agents talk in this room only. Leave it empty to keep the business off the hub.'));

    const files = isObj(one?.files) ? one.files : isObj(one) ? one : null;
    const fileSec = section('Its files', 'biz-files');
    const names = [['charter', 'BUSINESS.md', 'your instructions'], ['state', 'STATE.md', 'what is in progress'], ['plan', 'PLAN.md', 'the checklist']];
    if (files && names.some(([k]) => isObj(files[k]))) {
      const ul = make('ul', 'biz-file-list');
      for (const [k, name, what] of names) {
        const x = files[k];
        if (!isObj(x)) continue;
        ul.append(make('li', `biz-file${x.refused === true || x.unreadable === true ? ' biz-line-warn' : ''}`, fileWords(x, name, what)));
      }
      const books = arr(files.playbooks).map(String);
      ul.append(make('li', 'biz-file', books.length ? `Playbooks: ${books.join(', ')}.` : 'Playbooks: none yet.'));
      fileSec.append(ul);
      const pl = planLine(b.id);
      if (pl) fileSec.append(pl);
      if (isObj(files.charter)) fileSec.append(charterBox(b, files.charter));
    } else {
      fileSec.append(make('p', 'biz-note', 'BUSINESS.md holds your instructions, STATE.md and PLAN.md are kept by the lead, and playbooks/ holds one file for each recurring job.'));
    }

    const apart = make('p', 'biz-note biz-apart', TEXT.apart);
    const acts = make('div', 'biz-actions biz-save-row');
    // The line is in the row only while something is unsaved, so nothing hidden is left in the page.
    if (s.dirty) acts.append(unsaved);
    acts.append(save);
    form.append(about, stSec, leads, limits, hub, acts);
    form.addEventListener('submit', e => { e.preventDefault(); saveSetup(); });
    panel.append(form, fileSec, apart);
  }

  // One file of the business's folder, in words. A file Plenum does not read (a link, a second name) and one it could not read just now
  // are never shown as "not there yet".
  function fileWords(x, name, what) {
    if (x.refused === true) return `${name} (${what}): Plenum does not read it. ${sentence(x.why) || 'It is a link or has a second name on the disk.'} Make it a plain file in the folder.`;
    if (x.unreadable === true) return `${name} (${what}): it could not be read just now. Plenum tries again the next time this page is read.`;
    if (x.exists === false) return `${name} (${what}): not there yet.`;
    return `${name} (${what})${Number.isFinite(x.bytes) ? `: ${bytesText(x.bytes)}` : ''}${num(x.changedAt) ? `, changed ${whenText(x.changedAt)}` : ''}.`;
  }

  // BUSINESS.md: whether it is the text the owner confirmed, the text itself, and the button that confirms it.
  function charterBox(b, ch) {
    const c = ui.charters.get(b.id);
    const isOpen = Boolean(c) && c.state !== 'closed';
    const now = c?.state === 'ok' ? c.data : ch;
    const changed = now.changed === true;
    const unknown = now.unknown === true;
    const box = make('div', 'biz-charter');
    box.dataset.state = changed ? 'changed' : 'ok';
    const head = make('div', 'biz-charter-head');
    head.append(make('h4', 'biz-charter-title', 'Your instructions (BUSINESS.md)'), pill(!changed ? 'Confirmed' : unknown ? 'Unconfirmed' : 'Changed', changed ? 'amber' : 'green'));
    box.append(head);
    const at = num(now.confirmedAt) ? whenText(now.confirmedAt) : '';
    box.append(make('p', `biz-charter-say${changed ? ' biz-line-warn' : ''}`,
      !changed ? (at ? `This is the text you confirmed ${at}.` : TEXT.charterSame)
        : unknown ? TEXT.charterUnknown
          : `BUSINESS.md is not the text you confirmed${at ? ` ${at}` : ''}. Until you confirm it, leads are told to treat what is new in it as unconfirmed.`));
    const acts = make('div', 'biz-actions');
    const ob = btn('ghost small', isOpen ? 'Close BUSINESS.md' : 'Read BUSINESS.md', 'su|charter|open', () => openCharter(b));
    ob.setAttribute('aria-expanded', String(isOpen));
    acts.append(ob);
    box.append(acts);
    if (!isOpen) {
      if (changed) box.append(make('p', 'biz-note', TEXT.charterRead));
      return box;
    }
    const well = make('div', 'biz-draft');
    if (c.state === 'loading') {
      const p = make('p', 'biz-calm biz-wait');
      p.append(make('span', 'spinner'), 'Reading BUSINESS.md…');
      well.append(p);
    } else if (c.state === 'error') {
      well.append(make('p', 'biz-calm biz-bad', c.error));
    } else {
      const d = c.data;
      if (d.state === 'file' && (str(d.text) || !str(d.why))) {
        const text = make('pre', 'biz-draft-text', str(d.text) || '(The file is empty.)');
        text.tabIndex = 0;
        text.dataset.fk = 'su|charter|text';
        text.setAttribute('aria-label', 'The text of BUSINESS.md');
        well.append(text);
      }
      // Why it cannot be shown or confirmed here (no file, a link, too long, not readable now): the server's sentence.
      if (str(d.why)) well.append(make('p', `biz-note${d.state === 'file' || d.state === 'missing' ? '' : ' biz-bad'}`, sentence(d.why)));
      if (changed && str(d.sha256)) {
        const row = make('div', 'biz-actions');
        const yes = btn('primary small', ui.busy.has('su|charter') ? 'Confirming…' : 'I made this change', 'su|charter|yes', () => confirmCharter(b));
        yes.disabled = ui.busy.has('su|charter');
        row.append(yes);
        well.append(row, make('p', 'biz-note', d.state === 'missing' ? 'Press it only if you removed the file yourself.' : 'Press it only if every line above is yours. If a line is not, take it out of the file first, then read it here again.'));
      }
    }
    box.append(well);
    return box;
  }

  // ---------- drawing: all of it ----------

  const TABS = [
    { id: 'today', label: 'Today', paint: paintToday },
    { id: 'routines', label: 'Routines', paint: paintRoutines },
    { id: 'setup', label: 'Setup', paint: paintSetup },
  ];

  const byFk = key => (key && root ? [...root.querySelectorAll('[data-fk]')].find(n => n.dataset.fk === key) ?? null : null);

  // Draws the pane again from what is known. The focus stays on the control it was on (by its key), with the caret where it was.
  function paint() {
    if (!root || !parts) return;
    const act = document.activeElement;
    const had = root.contains(act) && act.dataset?.fk ? { key: act.dataset.fk, from: act.selectionStart, to: act.selectionEnd } : null;
    const scroll = root.parentElement?.scrollTop ?? 0;
    // One odd answer must not leave the old pane on screen without a word: a part that cannot be drawn says so, in its own place.
    try { paintHead(); } catch (err) {
      console.error('Businesses: the head could not be drawn.', err);
      parts.head.replaceChildren(make('p', 'biz-calm biz-bad', TEXT.undrawn));
    }
    const panel = make('div', 'biz-panel');
    panel.id = 'biz-panel';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `biz-tab-${ui.tab}`);
    try { (TABS.find(t => t.id === ui.tab) ?? TABS[0]).paint(panel); } catch (err) {
      console.error('Businesses: a tab could not be drawn.', err);
      panel.replaceChildren(make('p', 'biz-calm biz-bad', TEXT.undrawn));
    }
    parts.panel.replaceWith(panel);
    parts.panel = panel;
    showSaid();
    drawNotices();
    const want = ui.focus || had?.key;
    const explicit = Boolean(ui.focus);
    ui.focus = '';
    if (!want || !(explicit || had)) return;
    const found = byFk(want);
    const target = found && !found.disabled ? found : byFk(`tab|${ui.tab}`);
    if (!target) return;
    target.focus({ preventScroll: !explicit });
    if (!explicit && root.parentElement) root.parentElement.scrollTop = scroll;
    if (had && target.dataset.fk === had.key && typeof had.from === 'number' && typeof target.setSelectionRange === 'function') {
      try { target.setSelectionRange(had.from, had.to); } catch { /* this kind of field has no caret to place */ }
    }
  }

  // The registered notice that fits the folder's approval mode, under the two lines. Each is asked for once and lives in an element of
  // its own that is put back after every draw, so a strip the person has not answered yet does not vanish when the pane is drawn again.
  const noticeHosts = new Map();
  function drawNotices() {
    const arm = ui.tab === 'routines' ? parts.panel.querySelector('.biz-arm') : null;
    if (!arm) return;
    const project = ui.arming ? routines().find(r => r.id === ui.arming)?.project : ui.editor && !ui.editor.on ? (ui.editor.project || arr(bizById(ui.editor.business)?.projects)[0]) : '';
    if (!project) return;
    const mode = folderFacts(project).approvals;
    const id = mode === 'ask' ? 'cli-no-ask' : mode ? 'auto-approve' : '';
    if (!id) return;
    let host = noticeHosts.get(id);
    if (!host) {
      host = make('div', 'biz-notices');
      host.dataset.notice = id;
      noticeHosts.set(id, host);
      try { MU.notice?.(id, { into: host }); } catch { /* a notice is a courtesy; the two lines above say the same */ }
    }
    arm.querySelector('.biz-facts')?.after(host);
  }

  // Escape leaves what is open the way Cancel does and puts the focus back on the key that opened it. A dialog of the app is not inside
  // the pane, so its own Escape never comes here.
  function onKeys(e) {
    const t = e.target;
    if (t?.tagName === 'SELECT') {
      const wasOpen = menu === t;
      if (e.key === 'Escape' || e.key === 'Tab') {
        menu = null;
        setTimeout(drawLate, 0);
        // Escape that closes an open list is spent on that.
        if (e.key === 'Escape' && wasOpen) return;
      } else if (e.key === ' ' || e.key === 'Enter' || e.key === 'F4' || (e.altKey && e.key === 'ArrowDown')) menu = t;
    }
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (ui.arming) {
      e.preventDefault();
      const id = ui.arming;
      ui.arming = '';
      ui.focus = `rt|${id}|on`;
      paint();
    } else if (ui.editor && ui.tab === 'routines') {
      e.preventDefault();
      ui.focus = ui.editor.id ? `rt|${ui.editor.id}|edit` : 'rt|new';
      ui.editor = null;
      paint();
    } else {
      const open = t?.closest?.('.biz-item')?.querySelector('[data-fk$="|draft"][aria-expanded="true"]');
      if (!open) return;
      e.preventDefault();
      const key = open.dataset.fk;
      open.click();
      ui.focus = key;
      paint();
    }
  }

  function build(body) {
    root = make('div', 'ext-biz');
    root.addEventListener('keydown', onKeys);
    root.addEventListener('mousedown', e => { if (e.target?.tagName === 'SELECT') menu = menu === e.target ? null : e.target; });
    root.addEventListener('focusout', e => { if (e.target === menu) { menu = null; setTimeout(drawLate, 0); } });
    root.addEventListener('change', e => { if (e.target === menu) { menu = null; setTimeout(drawLate, 0); } });
    root.addEventListener('compositionstart', () => { composing = true; });
    root.addEventListener('compositionend', () => { composing = false; setTimeout(drawLate, 0); });
    parts = { head: make('header', 'biz-head'), say: make('p', 'biz-say'), panel: make('div', 'biz-panel') };
    parts.say.setAttribute('role', 'status');
    parts.say.setAttribute('aria-live', 'polite');
    root.append(parts.head, parts.say, parts.panel);
    body.replaceChildren(root);
    paint();
  }

  // ---------- wiring ----------

  MU.pane.register({
    id: TAB,
    title: TITLE,
    icon: 'list',
    order: 45,
    titleButton: true,
    render: body => build(body),
    onShow: () => { paint(); refresh(); },
    onClose: () => { root = null; parts = null; },
  });

  // The events of the three modules. The count follows the decisions event at once; the rest is read again when the pane is on screen.
  let toldHold = 0;
  window.addEventListener('plenum:event', e => {
    const ev = e.detail;
    if (!isObj(ev)) return;
    // A Stop holds the routines (lib/routines.mjs): said once for each hold, with the time, whether or not this pane is open.
    if (ev.type === 'routine' && ev.action === 'hold' && str(ev.why) && num(ev.hold?.until) && ev.hold.until !== toldHold) {
      toldHold = ev.hold.until;
      try { MU.toast?.(sentence(ev.why), 'ok', 12000); } catch { /* the Routines tab says it too */ }
    }
    if (ev.type === 'decisions') {
      if (Number.isFinite(ev.waiting) && D.dec.state === 'ok' && !shown()) {
        D.dec.data = { ...D.dec.data, waiting: ev.waiting };
        paintCount();
      }
      refreshSoon();
    } else if (ev.type === 'program-start') {
      // A program waits for a yes (or no longer does). The count follows at once; a new card brings the pane to Today, because the
      // card waits a few minutes only and a chat that is on screen has no card of its own for it.
      if (ev.action === 'asked') {
        if (!shown()) { ui.tab = 'today'; try { MU.pane.open(TAB); } catch { /* the count on the title bar still says it */ } }
        refresh();
      } else refreshSoon();
    } else if (ev.type === 'business' || ev.type === 'routine') {
      if (shown()) refreshSoon();
    } else if (ev.type === 'state' && shown() && (ui.arming || ui.editor)) {
      // The folder's approval mode or its writers changed while the two lines are on screen: they are read again.
      refreshSoon();
    }
  });

  MU.openBusinesses = () => MU.pane.open(TAB);

  // The count on the title bar button: one read, after the page has started, never on the start path.
  Promise.resolve(MU.ready).then(() => setTimeout(refresh, 1500), () => {});
})();
