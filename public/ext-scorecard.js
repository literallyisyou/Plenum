// ext-scorecard. Settings > Agents > Scorecard, directly under Team: Plenum checks 1 in 10 finished team tasks with a model on another
// subscription and keeps only the verdict. This section shows the switch, today's count, what runs now, the counts of each model in
// each kind, a calm suggestion to change the order of a kind's list (Move or Keep; nothing changes until Move), and a button that tries
// each worker once. Adds itself through window.MuseUI (app.js). Layout and colour are in ext-scorecard.css (tokens only).
//
// The server (lib/routes/scorecard.mjs, lib/scorecard.mjs, lib/scorecard-run.mjs) owns every fact AND every sentence of a count; this page
// shows them and changes them only through the routes. THE CONTRACT THIS PAGE READS (lib/scorecard.mjs viewOf; SCORECARD-BRIEF.md 1, 5, 6):
//  - GET /api/scorecard -> { on, teamOn, newer, damaged, unreadable, lead, privacy, switchLabel, status (a sentence about the switch, the
//    team or a file that cannot be changed, or null), damagedText, today: { text }, skipped: { text }, holdUntil (ms, 0 when none), paused:
//    { until, text, button } | null, running: null | { type: 'check' | 'try', count?, text }, results: [{ id, label, rows: [{ ref, label,
//    pass, fail, checks, unsure, text }] }] (only kinds that have counts), nothingYet (a sentence, or null), footnote, suggestions: [{ kind,
//    above, below, aboveStats: { pass, checks }, belowStats, aboveLabel, belowLabel, kindLabel, title, body }], tryLabel, tryNote, tried:
//    null | { at, lines: [sentence] } }. "Move above above below": above is the model that passed more and is lower in the kind's list now.
//    From the server's memory; it starts nothing. A suggestion is drawn only when both models have 20 checks in it, however the server counted.
//  - POST /api/scorecard { on } and { resume: true }; POST /api/scorecard/move and /keep { kind, above, below }; POST /api/scorecard/try
//    { project }. Each answers the view again (move and keep also said: the sentence for "Moved" or "Kept"; try also started: true).
//    The words "Moved" and "Kept" are shown only after that answer; a refusal (400, 409, 503) shows the server's own sentence and the page
//    then reads the view again. A 409 for a pair that is no longer the suggestion says "The scorecard changed."
//  - Events 'scorecard' (a count, a hold or a try changed) and 'team' (the order was saved): read again, only while the section is drawn.
// Nothing is asked before the section is drawn. With the routes missing (404) the section says so in one line. A field that is missing
// is unknown, never an error. Text reaches the page through textContent only. No notice id.
(function () {
  const MuseUI = window.MuseUI;
  if (!MuseUI || !MuseUI.settings || typeof MuseUI.settings.register !== 'function') return;

  const MIN_CHECKS = 20;
  // The sentences that do not depend on a count (SCORECARD-BRIEF.md section 1, word for word). The server sends the same ones; these are
  // what the page says when an answer lacks one.
  const TEXT = {
    lead: 'Plenum checks 1 in 10 finished team tasks with a model on another subscription, at most 10 a day. Only the verdict is kept, never the work.',
    privacy: 'The checker sees the task and its answer, so they go to that model\'s service too.',
    switchLabel: 'Spot-checks',
    nothing: 'No checks yet. The first comes after about 10 finished team tasks.',
    footnote: 'Plenum suggests a new order only after 20 checks of a model for that kind. It never takes a model off your team.',
    resume: 'Resume checks',
    tryButton: 'Try each worker (uses a little of each plan)',
    tryNote: 'Every model on your team gets one tiny task. A model that is retired or signed out is named here.',
    missing: 'This build has no scorecard yet.',
    down: 'Its server did not answer.',
  };

  // ---------- helpers (text only) ----------

  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = v => (typeof v === 'string' ? v : '');
  const count = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const list = v => (Array.isArray(v) ? v : []);

  // ---------- state ----------

  let data = null;            // the last answer of GET or POST /api/scorecard
  let phase = 'idle';         // idle | loading | ready | missing | error
  let errorText = '';
  let pending = 0;            // presses whose request is on its way
  let again = false;          // an event came while a read was running
  let changes = 0;            // presses answered; a read that started before one of them is thrown away
  let view = null;            // the parts of the section on the page
  const said = new Map();     // what a line says now: key ('switch', 'try' or 'kind:<id>') -> { text, bad }
  let holdTimer = null;
  let eventTimer = null;

  const onPage = () => Boolean(view && view.root.isConnected);
  // A counts file this build cannot change: every control is off.
  const locked = () => data?.newer === true || data?.unreadable === true;

  // ---------- requests ----------

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

  // The sentence for a press that did not go through: the server's own when it sent one.
  function whyNot(err) {
    const text = str(err?.message);
    if (!text || /^Request failed \(\d+\)$/.test(text) || err instanceof TypeError) return 'That did not go through. Plenum did not answer; try again.';
    return text;
  }

  async function load() {
    if (phase === 'loading' || pending) { again = true; return; }
    const first = !data;
    const at = changes;
    phase = 'loading';
    if (first) paint();
    try {
      const got = await get('/api/scorecard');
      if (!isObj(got)) throw new Error('');
      phase = 'ready';
      errorText = '';
      if (at === changes) data = got;
      else again = true;
    } catch (err) {
      if (err?.status === 404) {
        phase = 'missing';
        data = null;
      } else if (data) {
        phase = 'ready';
      } else {
        phase = 'error';
        errorText = err?.status ? str(err.message) || TEXT.down : TEXT.down;
      }
    }
    paint();
    if (again) { again = false; if (onPage()) load(); }
  }

  // Several events in a row become one read, and only while the section is on the page.
  function onEvent() {
    if (!onPage() || phase === 'missing') return;
    clearTimeout(eventTimer);
    eventTimer = setTimeout(() => { if (onPage()) load(); }, 250);
  }

  // One press: the request goes out, and what the server answers is shown. A refusal shows its sentence and reads the view again.
  async function press(key, path, body, saysAfter) {
    if (pending) return false;
    pending += 1;
    say(key, '');
    paint();
    let ok = false;
    try {
      const got = await MuseUI.api(path, body);
      changes += 1;
      if (isObj(got) && typeof got.on === 'boolean') data = got;
      ok = true;
      if (saysAfter) say(key, str(got?.said), false);
    } catch (err) {
      say(key, whyNot(err), true);
    }
    pending -= 1;
    paint();
    if (!ok) load();
    else if (again) { again = false; if (onPage()) load(); }
    return ok;
  }

  function say(key, text, bad) {
    if (text) said.set(key, { text, bad: bad === true });
    else said.delete(key);
  }

  // ---------- what is drawn ----------

  // The suggestions that may be drawn: the server names the pair, and both models need 20 checks in the kind, however it counted.
  function suggestionsNow() {
    const out = [];
    for (const s of list(data?.suggestions)) {
      if (!isObj(s) || !str(s.kind) || !str(s.above) || !str(s.below)) continue;
      if (count(s.aboveStats?.checks) < MIN_CHECKS || count(s.belowStats?.checks) < MIN_CHECKS) continue;
      if (!str(s.title) || !str(s.body)) continue;
      out.push(s);
    }
    return out;
  }

  // ---------- building and drawing ----------

  function build(body) {
    const root = make('div', 'sc-root');
    const main = make('div', 'sc-main');
    const lead = make('p', 'sc-line', TEXT.lead);
    const privacy = make('p', 'sc-note', TEXT.privacy);

    const row = make('label', 'switch-row');
    const input = make('input');
    input.type = 'checkbox';
    input.dataset.fk = 'switch';
    const track = make('span', 'switch-track');
    track.setAttribute('aria-hidden', 'true');
    const label = make('span', null, TEXT.switchLabel);
    row.append(input, track, label);
    input.addEventListener('change', () => {
      press('switch', '/api/scorecard', { on: input.checked }, false);
    });
    const switchLine = make('p', 'sc-note');
    switchLine.setAttribute('role', 'status');

    const status = make('div', 'sc-status');
    status.setAttribute('role', 'status');
    const results = make('div', 'sc-results');
    const foot = make('p', 'sc-note', TEXT.footnote);

    const tryBox = make('section', 'sc-sec sc-try');
    const tryButton = make('button', 'ghost small sc-try-button', TEXT.tryButton);
    tryButton.type = 'button';
    tryButton.dataset.fk = 'try';
    tryButton.addEventListener('click', () => {
      press('try', '/api/scorecard/try', { project: MuseUI.state?.activeProject ?? null }, false);
    });
    const tryNote = make('p', 'sc-note', TEXT.tryNote);
    const tryLine = make('p', 'sc-note sc-say');
    tryLine.setAttribute('role', 'status');
    const tryOut = make('div', 'sc-try-out');
    tryBox.append(tryButton, tryNote, tryLine, tryOut);

    const retry = make('button', 'ghost small sc-retry', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => load());
    const message = make('p', 'sc-line');
    message.setAttribute('role', 'status');

    main.append(lead, privacy, row, switchLine, status, results, foot, tryBox);
    root.append(main, message, retry);
    body.append(root);
    view = { root, main, lead, privacy, label, input, switchLine, status, results, foot, tryBox, tryButton, tryNote, tryLine, tryOut, message, retry };
  }

  const line = (text, className) => make('p', className || 'sc-note', text);

  function paintStatus(v) {
    const nodes = [];
    const live = data.on === true && data.teamOn !== false && !locked();
    if (str(data.damagedText)) nodes.push(line(data.damagedText, 'sc-note sc-warn'));
    if (live && str(data.today?.text)) nodes.push(line(data.today.text, 'sc-line'));
    if (live && str(data.skipped?.text)) nodes.push(line(data.skipped.text));
    if (str(data.running?.text)) nodes.push(line(data.running.text, 'sc-note sc-running'));
    const until = count(data.paused?.until);
    if (data.on === true && until > Date.now() && str(data.paused?.text)) {
      const box = make('div', 'sc-actions');
      box.append(line(data.paused.text));
      const button = make('button', 'ghost small', str(data.paused.button) || TEXT.resume);
      button.type = 'button';
      button.dataset.fk = 'resume';
      button.disabled = pending > 0 || locked();
      button.addEventListener('click', () => press('switch', '/api/scorecard', { resume: true }, false));
      box.append(button);
      nodes.push(box);
      // The hold ends by itself: read again just after.
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => { if (onPage()) load(); }, Math.min(until - Date.now() + 1000, 2 ** 31 - 1));
    }
    v.status.replaceChildren(...nodes);
  }

  function suggestionBox(s) {
    const box = make('div', 'sc-suggest');
    box.append(make('p', 'sc-suggest-title', s.title));
    box.append(line(s.body));
    const actions = make('div', 'sc-actions');
    const body = { kind: s.kind, above: s.above, below: s.below };
    const move = make('button', 'primary small', 'Move');
    move.type = 'button';
    move.dataset.fk = `move|${s.kind}`;
    move.disabled = pending > 0 || locked();
    move.addEventListener('click', () => press(`kind:${s.kind}`, '/api/scorecard/move', body, true));
    const keep = make('button', 'ghost small', 'Keep');
    keep.type = 'button';
    keep.dataset.fk = `keep|${s.kind}`;
    keep.disabled = pending > 0 || locked();
    keep.addEventListener('click', () => press(`kind:${s.kind}`, '/api/scorecard/keep', body, true));
    actions.append(move, keep);
    box.append(actions);
    return box;
  }

  function paintResults(v) {
    const kinds = list(data.results).filter(k => isObj(k) && str(k.id) && list(k.rows).some(r => isObj(r) && str(r.text)));
    if (!kinds.length) {
      v.results.replaceChildren(line(str(data.nothingYet) || TEXT.nothing));
      return;
    }
    const suggestions = suggestionsNow();
    const blocks = kinds.map(k => {
      const box = make('section', 'sc-kind');
      box.append(make('h6', 'sc-kind-title', str(k.label) || k.id));
      const s = suggestions.find(x => x.kind === k.id);
      if (s) box.append(suggestionBox(s));
      const note = said.get(`kind:${k.id}`);
      if (note) box.append(make('p', `sc-note sc-say${note.bad ? ' sc-bad' : ''}`, note.text));
      const ul = make('ul', 'sc-rows');
      for (const r of list(k.rows).filter(x => isObj(x) && str(x.text))) ul.append(make('li', 'sc-row', r.text));
      box.append(ul);
      return box;
    });
    v.results.replaceChildren(...blocks);
  }

  function paintTry(v) {
    const tryingNow = data.running?.type === 'try';
    v.tryButton.disabled = pending > 0 || tryingNow || locked();
    const note = said.get('try');
    v.tryLine.textContent = note ? note.text : '';
    v.tryLine.classList.toggle('sc-bad', note?.bad === true);
    v.tryLine.hidden = !note;
    const lines = tryingNow ? [] : list(data.tried?.lines).filter(t => typeof t === 'string' && t);
    v.tryOut.replaceChildren(...lines.map(t => make('p', 'sc-note sc-try-line', t)));
  }

  function paint() {
    if (!onPage()) return;
    const v = view;
    // Focus keeps its place across the redraw.
    const focus = v.root.contains(document.activeElement) ? document.activeElement.dataset?.fk ?? '' : '';
    v.root.setAttribute('aria-busy', pending || phase === 'loading' ? 'true' : 'false');
    const showMain = phase === 'ready' && data;
    v.main.hidden = !showMain;
    v.retry.hidden = phase !== 'error';
    v.message.hidden = Boolean(showMain);
    if (phase === 'missing') v.message.textContent = TEXT.missing;
    else if (phase === 'error') v.message.textContent = errorText || TEXT.down;
    else v.message.textContent = phase === 'loading' ? 'Reading the scorecard…' : '';
    if (!showMain) return;

    v.lead.textContent = str(data.lead) || TEXT.lead;
    v.privacy.textContent = str(data.privacy) || TEXT.privacy;
    v.label.textContent = str(data.switchLabel) || TEXT.switchLabel;
    v.foot.textContent = str(data.footnote) || TEXT.footnote;
    v.tryButton.textContent = str(data.tryLabel) || TEXT.tryButton;
    v.tryNote.textContent = str(data.tryNote) || TEXT.tryNote;
    v.input.checked = data.on === true;
    v.input.disabled = pending > 0 || locked();
    const sw = said.get('switch');
    const switchText = sw ? sw.text : str(data.status);
    v.switchLine.textContent = switchText;
    v.switchLine.hidden = !switchText;
    v.switchLine.classList.toggle('sc-bad', sw?.bad === true);

    paintStatus(v);
    paintResults(v);
    paintTry(v);
    if (focus) {
      const same = [...v.root.querySelectorAll('[data-fk]')].find(n => n.dataset.fk === focus && !n.disabled);
      if (same && document.activeElement !== same) same.focus();
    }
  }

  // ---------- Settings section ----------

  // Drawing reads the server's memory (GET /api/scorecard starts nothing). Nothing is read before the section is drawn.
  function render(body) {
    said.clear();
    clearTimeout(holdTimer);
    body.textContent = '';
    build(body);
    paint();
    load();
  }

  (async function start() {
    await (MuseUI.ready ?? Promise.resolve());
    MuseUI.settings.register({ id: 'scorecard', scope: 'app', group: 'agents', title: 'Scorecard', order: 31, render });
    MuseUI.events.on('scorecard', onEvent);
    MuseUI.events.on('team', onEvent);
  })();
})();
