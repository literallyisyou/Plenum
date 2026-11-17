// Setting a business up from a council's verdict (14 Nov 2026; lib/setup.mjs holds the logic, lib/routes/setup.mjs the routes).
// What this file draws:
//   - on a council card that has a verdict: one button, "Set up as a business";
//   - the form (in the drawer): the ideas the server read from the verdict (rename, drop, add your own), the folder new businesses are
//     made in, the lead model, the template, how the lead works (two choices, in true words), and one button, "Start setup". Nothing is
//     made before that press;
//   - in the Businesses pane, on Today: one card for each setup with its state (not started, running step N, waiting for your answers,
//     paused and why, done, failed and why, stopped), "Continue setup" / "Try again", Stop, and the Setup chat. public/ext-business.js
//     asks for that part through window.PlenumBizSetup.todayEl() and offers "From a council verdict" through .pick();
//   - above the chat of a Setup thread: "Waiting for you: K".
// THE CONTRACT THIS PAGE READS (lib/routes/setup.mjs):
//   GET  /api/business/setup                    { parent, threadName, limits, auto: { on, why }, setups: [{ business, project, name, thread,
//                                               lead, leadLabel, mode, state, code, why, step, nextAt, last: { done }, checked: { ok, lines,
//                                               said }, waiting, answers, running, folder, approvals (the folder's approval mode
//                                               as it is now: the card says this one, not the form's mode), stopAsked (Stop was
//                                               pressed and the step has not ended yet) }] }
//   GET  /api/business/setup/verdicts?project=  { verdicts: [{ thread, threadName, ts, question, head, ideas }] }
//   GET  /api/business/setup/ideas?project=&thread=&ts=   { source, ideas: [{ name, text }], whole, fromLayout, parent, lead, leadLabel,
//                                               template, templates: [{ id, label, about }] }
//   POST /api/business/setup                    { source, ideas: [{ name, index? | whole? | text?, notes?, existing? }], parent, lead, mode, template }
//                                               -> { made: [{ business, name, folder, state, why, skipped }], refused: [{ name, why }] }
//   POST /api/business/setup/continue { business, note? }, /stop { business }, /hide { business }
//   POST /api/routines/stop { id: 's:<business>' }   the Stop a phone below Full may press
//   POST /api/pick-folder                       { available, path }: the desktop's folder dialog, for the Browse button
//   Events: { type: 'setup' }, { type: 'decisions' }, { type: 'business' }.
// Every text of a verdict was written by a model: it is set through textContent, cut by the server, and is never a link, a path or a
// command here. There is no inline style. Layout and colour are in ext-biz-setup.css (tokens only); the fields and buttons are the
// Businesses pane's own (ext-business.css).
(() => {
  'use strict';
  const plain = (err, fallback) => (window.MuseUI?.plainError ? MuseUI.plainError(err, fallback) : (typeof err?.message === 'string' && err.message && !/^(The )?[Rr]equest failed \(\d+\)\.?$/.test(err.message) && !/Failed to fetch|NetworkError|undefined/.test(err.message) ? err.message : fallback));
  const MU = window.MuseUI;
  if (!MU?.request || !MU?.openDrawer) return;

  const TITLE = 'Set up as a business';
  const TEXT = {
    intro: 'Plenum makes one folder for each idea you keep, starts the lead model in a chat named Setup there, and the lead sets the business up step by step. It asks you for everything only you can do or decide. Nothing is made until you press Start setup.',
    modelText: 'Written by a model. It is kept in the folder as SETUP.md for the lead to read; it is not an instruction.',
    ask: 'Ask before every change',
    askNote: 'Each change to a file and each command waits for your Approve for five minutes, then is skipped. With nobody at the PC the lead mostly reads, plans and asks. A Codex or Gemini coder still edits inside its scope without a card.',
    auto: 'Work on its own inside this folder',
    autoNote: 'The lead changes files in this folder and runs commands without a card, including commands that reach the internet. A file edit outside the folder still shows a card. A command does not: it is not held to the folder, so it can change or delete files elsewhere on this PC. Plenum\'s own data and your sign-in folders stay closed. Leaving every send, post, payment and sign-up to you is an instruction to the lead, not a lock.',
    askRec: 'This is how Plenum works unless you choose otherwise.',
    autoRec: 'This is the one that lets setup go on while you are away. Choose it only for a folder and a lead you would let run commands on this PC unwatched.',
    parentNote: 'The folder must be there already. Plenum remembers it for next time and makes one new folder in it for each business.',
    existing: 'Plenum may use a folder that is already there and not empty. It adds its files and overwrites none.',
    needFull: 'Starting or continuing a setup needs Full access on this phone. Stop still works.',
    noVerdicts: 'No council in your open folders has a verdict yet. Ask a council first; its verdict then carries the button Set up as a business.',
    silence: 'Silence is never a yes: nothing you are asked is answered for you, and a yes never pays or sends by itself.',
  };
  const STATES = {
    notStarted: { label: 'Not started', tone: '' },
    running: { label: 'Running', tone: 'accent' },
    next: { label: 'Next step planned', tone: 'accent' },
    waiting: { label: 'Waiting for you', tone: 'amber' },
    paused: { label: 'Paused', tone: 'amber' },
    done: { label: 'Done', tone: 'green' },
    failed: { label: 'Failed', tone: 'red' },
    stopped: { label: 'Stopped', tone: '' },
  };

  // ---------- small helpers ----------

  const isObj = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  const arr = v => (Array.isArray(v) ? v : []);
  const str = v => (typeof v === 'string' ? v : '');
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const sentence = s => { const t = str(s).trim(); return !t || /[.!?\u2026]$/.test(t) ? t : `${t}.`; };
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
  function field(label, control, note) {
    const box = make('div', 'biz-field');
    const l = make('label', 'biz-label', label);
    control.id = control.id || uid('bzs-f');
    l.htmlFor = control.id;
    box.append(l, control);
    if (note) {
      const n = make('p', 'biz-note', note);
      n.id = uid('bzs-n');
      control.setAttribute('aria-describedby', n.id);
      box.append(n);
    }
    return box;
  }
  function input(value, key, onInput, attrs) {
    const i = make('input', 'biz-input');
    i.type = 'text';
    i.value = value ?? '';
    i.dataset.fk = key;
    i.autocomplete = 'off';
    i.spellcheck = false;
    for (const [k, v] of Object.entries(attrs ?? {})) i.setAttribute(k, String(v));
    i.addEventListener('input', () => onInput(i.value));
    return i;
  }
  const pill = (text, tone) => {
    const p = MU.ui?.pill ? MU.ui.pill(text, tone) : make('span', 'pill', text);
    p.classList.add('biz-pill');
    return p;
  };
  const clock = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function whenText(ts) {
    if (!num(ts)) return '';
    const d = new Date(ts);
    const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(d) - day(new Date())) / 86400000);
    if (diff === 0) return `at ${clock(ts)}`;
    if (diff === 1) return `tomorrow at ${clock(ts)}`;
    return `on ${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} at ${clock(ts)}`;
  }
  const refOf = c => `${c.provider}:${c.id}`;
  const modelLabel = ref => {
    const hit = arr(MU.catalog).find(c => refOf(c) === ref);
    return hit ? str(hit.label) || ref : ref;
  };
  const state = () => MU.state ?? {};
  const projects = () => arr(state().projects);

  // A paired phone below Full reads and stops; it does not start or continue a setup (lib/remote/tiers.mjs).
  function phoneTier() {
    try {
      const shell = window.plenumShell;
      const c = shell && typeof shell.connection === 'function' ? shell.connection() : null;
      return str(c?.tier) || str(shell?.tier);
    } catch { return ''; }
  }
  const belowFull = () => { const t = phoneTier(); return t === 'approve' || t === 'read'; };
  const STOP_PATH = '/api/routines/stop';

  async function ask(path, body) {
    if (body !== undefined && path !== STOP_PATH && belowFull()) return { ok: false, status: 403, error: TEXT.needFull };
    let res;
    try {
      res = await MU.request(path, body === undefined ? {} : { method: 'POST', body });
    } catch {
      return { ok: false, status: 0, error: 'Plenum did not answer. Check that it is running.' };
    }
    const data = await res.json().catch(() => null);
    if (data?.terms === true) window.dispatchEvent(new CustomEvent('plenum:terms-required'));
    if (res.ok && isObj(data)) return { ok: true, status: res.status, data };
    return { ok: false, status: res.status, error: plain({ message: str(data?.error) }, 'Plenum could not do that. Try again.') };
  }

  // ---------- the setups ----------

  const D = { state: 'idle', data: null, error: '' };
  const ui = { busy: new Set(), notes: new Map(), said: new Map() };
  const setups = () => arr(D.data?.setups).filter(s => isObj(s) && str(s.business));
  const told = () => { try { window.dispatchEvent(new CustomEvent('plenum:biz-setup')); } catch { /* the pane reads again when it opens */ } };

  let reading = null;
  let again = false;
  function read() {
    if (reading) { again = true; return reading; }
    reading = (async () => {
      do {
        again = false;
        const before = JSON.stringify([D.state, D.data, D.error]);
        const r = await ask('/api/business/setup');
        if (r.ok) Object.assign(D, { state: 'ok', data: r.data, error: '' });
        else if (r.status === 404) Object.assign(D, { state: 'missing', data: null, error: '' });
        else Object.assign(D, { state: 'error', error: r.error });
        if (before !== JSON.stringify([D.state, D.data, D.error])) told();
        drawStrip();
      } while (again);
    })().finally(() => { reading = null; });
    return reading;
  }
  let soon = 0;
  const readSoon = () => { clearTimeout(soon); soon = setTimeout(read, 200); };

  // What a setup's state means, in one or two sentences.
  function stateWords(s) {
    // "Nothing starts by itself in this start of Plenum" is said once, above the cards, not on each of them.
    const once = D.data?.auto?.on === false ? str(D.data.auto.why) : '';
    const why = sentence((once ? str(s.why).replace(once, '') : str(s.why)).trim());
    const waiting = num(s.waiting);
    switch (s.state) {
      case 'running': return s.stopAsked === true ? `Stop is taken: step ${num(s.step)} is being stopped. Nothing starts after it until you press Continue setup.` : `Running step ${num(s.step)}.`;
      case 'next': {
        if (s.code === 'scheduler') return `Step ${num(s.step)} is done. ${why || 'Press Continue setup to run the next one.'}`.trim();
        // A time is promised only while steps do start by themselves in this start of Plenum.
        const when = num(s.nextAt) && D.data?.auto?.on !== false ? `The next step starts by itself ${whenText(s.nextAt)}.` : '';
        const idle = D.data?.auto?.on === false && !why ? 'Press Continue setup to run the next one.' : '';
        return [why || `Step ${num(s.step)} is done.`, when, idle].filter(Boolean).join(' ');
      }
      case 'waiting': {
        const head = waiting > 0 ? `Waiting for your answers (${waiting}).` : /^Your answer/.test(why) ? '' : num(s.answers) > 0 ? 'Your answers are saved.' : 'Waiting for you.';
        const when = num(s.nextAt) && D.data?.auto?.on !== false ? `The next step starts by itself ${whenText(s.nextAt)}.` : '';
        return [head, why, when].filter(Boolean).join(' ');
      }
      case 'paused': return `Paused. ${why}`;
      case 'done': return 'Setup is done. Plenum checked the folder against what the lead said.';
      case 'failed': return why || 'The last step failed.';
      case 'stopped': return why || 'You stopped this setup.';
      default: return why || 'Not started yet.';
    }
  }

  // How the lead works in the folder NOW (the folder's own approval mode, as the server reads it), not what the form asked for once:
  // the person may have changed it since, or setting it may have failed at the start.
  const MODE_NOW = {
    ask: 'The folder is on Ask first.',
    auto: 'The folder is on Auto-approve: files are changed and commands run without a card.',
    all: 'The folder is on Approve all: files are changed and commands run without a card, and most other cards are answered too.',
  };
  function modeWords(s) {
    const now = MODE_NOW[str(s.approvals)];
    if (now) return now;
    return s.mode === 'auto' ? 'Set up to work on its own in this folder; Plenum cannot tell the folder\'s approval mode from here.' : 'Set up to ask before every change; Plenum cannot tell the folder\'s approval mode from here.';
  }

  async function act(s, what) {
    const id = s.business;
    const key = `${id}|${what}`;
    if (ui.busy.has(key)) return;
    ui.busy.add(key);
    told();
    let r;
    if (what === 'cont') {
      const note = str(ui.notes.get(id)).trim();
      r = await ask('/api/business/setup/continue', note ? { business: id, note } : { business: id });
      if (r.ok) ui.notes.delete(id);
    } else if (what === 'stop') {
      // A phone below Full stops the running step with the routines' Stop, which it may always use.
      r = belowFull() ? await ask(STOP_PATH, { id: `s:${id}` }) : await ask('/api/business/setup/stop', { business: id });
    } else {
      r = await ask('/api/business/setup/hide', { business: id });
    }
    ui.busy.delete(key);
    if (r.ok) ui.said.delete(id);
    else ui.said.set(id, sentence(r.error));
    told();
    read();
  }

  async function openChat(s) {
    try {
      if (state().activeProject !== s.project) await MU.update({ activeProject: s.project });
      if (str(s.thread)) await MU.threads.switchTo(s.thread);
    } catch (err) {
      ui.said.set(s.business, sentence(str(err?.message) || 'The Setup chat could not be opened.'));
      told();
    }
  }

  function cardEl(s) {
    const id = s.business;
    const st = STATES[s.state] ?? STATES.paused;
    const phone = belowFull();
    const box = make('article', 'biz-item bzs-card');
    box.dataset.business = id;
    box.dataset.state = str(s.state);
    const title = make('h4', 'biz-item-title', str(s.name) || 'A business');
    title.id = uid('bzs-t');
    box.setAttribute('aria-labelledby', title.id);
    const top = make('div', 'biz-item-top');
    // One pill says the state; what waits for the person is counted in it, or beside it when the state is another one.
    const waits = num(s.waiting) > 0 ? `Waiting for you: ${num(s.waiting)}` : '';
    top.append(pill(s.state === 'waiting' && waits ? waits : st.label, st.tone));
    if (num(s.step)) top.append(make('span', 'biz-item-n', `Step ${num(s.step)}`));
    if (waits && s.state !== 'waiting') top.append(pill(waits, 'amber'));
    box.append(top, title);
    if (s.state === 'running') {
      const p = make('p', 'biz-line bzs-words biz-wait');
      p.append(make('span', 'spinner'), stateWords(s));
      box.append(p);
    } else {
      box.append(make('p', `biz-line bzs-words${s.state === 'failed' ? ' biz-line-bad' : ''}`, stateWords(s)));
    }
    if (str(s.last?.done) && s.state !== 'running') box.append(make('p', 'biz-note bzs-last', `The lead's last line: ${s.last.done}`));
    // What Plenum's own check of "setup is complete" found.
    const checked = isObj(s.checked) ? s.checked : null;
    if (checked && (s.state === 'done' || checked.ok === false)) {
      const list = make('ul', 'bzs-check');
      for (const row of arr(checked.ok ? checked.said : checked.lines).map(String).filter(Boolean)) list.append(make('li', checked.ok ? 'bzs-check-ok' : 'bzs-check-open', row));
      if (list.children.length) box.append(list);
    }
    box.append(make('p', 'biz-note bzs-facts', `Lead: ${str(s.leadLabel) || modelLabel(str(s.lead)) || 'none'}. ${modeWords(s)}${str(s.folder) ? ` Folder: ${s.folder}` : ''}`));
    const said = ui.said.get(id);
    if (said) {
      const p = make('p', 'biz-line biz-line-bad bzs-said', said);
      p.setAttribute('role', 'alert');
      box.append(p);
    }
    const canGo = !phone && s.state !== 'running' && s.state !== 'done';
    if (canGo) {
      const note = input(ui.notes.get(id) ?? '', `bzs|${id}|note`, v => { ui.notes.set(id, v); }, { maxlength: 500, placeholder: 'A line for the lead with the next step (optional)', 'aria-label': `A line for the lead of ${str(s.name)}` });
      note.classList.add('biz-note-input');
      box.append(note);
    }
    const acts = make('div', 'biz-actions bzs-actions');
    if (canGo) {
      const label = ui.busy.has(`${id}|cont`) ? 'Starting\u2026' : s.state === 'failed' ? 'Try again' : s.state === 'notStarted' ? 'Start now' : 'Continue setup';
      const go = btn('ghost small bzs-go', label, `bzs|${id}|cont`, () => act(s, 'cont'));
      go.disabled = ui.busy.has(`${id}|cont`);
      acts.append(go);
    }
    if (s.state === 'running' || (!phone && ['next', 'waiting', 'notStarted', 'paused'].includes(s.state))) {
      // The key is one the Businesses pane leaves switched on for a phone below Full (its Stop keys).
      const stop = btn('ghost small bzs-stop', 'Stop', `rt|setup-${id}|stop`, () => act(s, 'stop'));
      stop.disabled = ui.busy.has(`${id}|stop`);
      if (s.state !== 'running') stop.title = 'Setup does not go on by itself until you press Continue setup';
      acts.append(stop);
    }
    if (!phone && str(s.thread)) acts.append(btn('ghost small', 'Open the Setup chat', `bzs|${id}|chat`, () => openChat(s)));
    if (!phone && ['done', 'failed', 'stopped'].includes(s.state)) {
      const hide = btn('biz-quiet', 'Hide', `bzs|${id}|hide`, () => act(s, 'hide'));
      hide.title = 'Take this card off the list. The business and its folder stay.';
      acts.append(hide);
    }
    box.append(acts);
    return box;
  }

  // The part of Today that shows the setups: null when there is none to show.
  function todayEl({ business = '' } = {}) {
    if (D.state === 'idle') { read(); return null; }
    const list = setups().filter(s => !business || s.business === business);
    if (D.state === 'error' && !list.length) return null;
    if (!list.length) return null;
    const box = make('section', 'biz-sec bzs-sec');
    const head = make('div', 'biz-sec-head');
    const h = make('h3', 'biz-sec-title', 'Being set up');
    h.id = uid('bzs-h');
    box.setAttribute('aria-labelledby', h.id);
    head.append(h);
    box.append(head);
    if (belowFull()) box.append(make('p', 'biz-note', TEXT.needFull));
    else if (D.data?.auto?.on === false && str(D.data?.auto?.why)) box.append(make('p', 'biz-note bzs-auto', sentence(D.data.auto.why)));
    const cards = make('div', 'biz-items bzs-cards');
    for (const s of list) cards.append(cardEl(s));
    box.append(cards);
    return box;
  }

  // ---------- the form ----------

  let F = null; // the form on screen: { source, data, rows, parent, lead, template, mode, busy, error, askExisting, focus }

  function redraw(focus) {
    if (focus && F) F.focus = focus;
    try { MU.refreshDrawer(); } catch { /* the drawer was closed */ }
  }

  async function browse() {
    const r = await ask('/api/pick-folder', {});
    if (!F) return;
    if (r.ok && str(r.data.path)) { F.parent = r.data.path; redraw('bzs|parent'); } else if (r.ok && r.data.available === false) { F.error = 'The folder dialog is part of the desktop app. Type the folder\'s full path here.'; redraw('bzs|parent'); }
  }

  async function submit() {
    if (!F || F.busy) return;
    const kept = F.rows.filter(r => r.keep);
    if (!kept.length) { F.error = 'Keep at least one idea.'; return redraw(); }
    F.busy = true;
    F.error = '';
    redraw();
    const ideas = kept.map(r => ({
      name: r.name.trim(),
      ...(r.whole ? { whole: true } : Number.isInteger(r.index) ? { index: r.index } : { text: r.text.trim() }),
      ...(r.notes.trim() ? { notes: r.notes.trim() } : {}),
      ...(F.existing ? { existing: true } : {}),
    }));
    const r = await ask('/api/business/setup', { source: F.source, ideas, parent: F.parent.trim(), lead: F.lead, mode: F.mode, template: F.template });
    if (!F) return;
    F.busy = false;
    if (!r.ok) {
      F.error = sentence(r.error);
      if (r.status === 409 && /already there/.test(r.error)) F.askExisting = true;
      return redraw('bzs|start');
    }
    const made = arr(r.data.made);
    const refused = arr(r.data.refused);
    F = null;
    try { MU.closeDrawer(); } catch { /* it is closed */ }
    // What is said is what happened: which businesses were made, whether their first step runs or waits, and which were not made.
    const words = [];
    if (made.length === 1) {
      const m = made[0];
      words.push(m.state === 'running' ? `${str(m.name)} is being set up. Its card is in Businesses, on Today.` : `${str(m.name)} was made. ${sentence(m.why) || 'Its first step has not started yet.'} Its card is in Businesses, on Today.`);
    } else if (made.length > 1) {
      const running = made.filter(m => m.state === 'running').length;
      words.push(`${made.length} businesses were made. ${running === 0 ? 'No first step has started yet' : running === 1 ? 'The first one is being set up, the others wait for their turn' : `${running} are being set up, the others wait for their turn`}. Their cards are in Businesses, on Today.`);
    } else words.push('No business was made.');
    for (const x of refused) words.push(`${str(x.name)} was not made: ${sentence(x.why)}`);
    for (const m of made) for (const sk of arr(m.skipped)) if (sentence(sk) !== sentence(m.why)) words.push(sentence(sk));
    try { MU.toast?.(words.join(' '), refused.length ? 'bad' : 'ok', 12000); } catch { /* the cards say it */ }
    await read();
    try { MU.openBusinesses?.(); } catch { /* the title bar button still opens it */ }
  }

  function ideaRow(r, i) {
    const box = make('div', 'bzs-idea');
    box.dataset.keep = String(r.keep);
    const top = make('div', 'bzs-idea-top');
    const keep = make('input');
    keep.type = 'checkbox';
    keep.checked = r.keep;
    keep.dataset.fk = `bzs|idea|${i}|keep`;
    keep.id = uid('bzs-k');
    keep.addEventListener('change', () => { r.keep = keep.checked; redraw(`bzs|idea|${i}|keep`); });
    const kl = make('label', 'bzs-keep', 'Set this up');
    kl.htmlFor = keep.id;
    top.append(keep, kl);
    if (r.own) top.append(btn('biz-quiet', 'Remove', `bzs|idea|${i}|remove`, () => { F.rows.splice(i, 1); redraw('bzs|add'); }));
    box.append(top);
    if (!r.keep) {
      box.append(make('p', 'biz-note', `${r.name || 'This idea'} is left out.`));
      return box;
    }
    box.append(field('Name of the business', input(r.name, `bzs|idea|${i}|name`, v => { r.name = v; }, { maxlength: 60 })));
    if (r.own) {
      box.append(field('The idea, in your words', input(r.text, `bzs|idea|${i}|text`, v => { r.text = v; }, { maxlength: 2000, placeholder: 'What is sold, and to whom' })));
    } else {
      const text = make('p', 'bzs-idea-text', r.text);
      text.tabIndex = 0;
      text.setAttribute('aria-label', `The idea as the council wrote it: ${r.name}`);
      box.append(text);
    }
    box.append(field('Your notes for the lead (optional)', input(r.notes, `bzs|idea|${i}|notes`, v => { r.notes = v; }, { maxlength: 1000 })));
    return box;
  }

  function renderForm(body) {
    body.replaceChildren();
    const root = make('div', 'bzs-form-root');
    body.append(root);
    if (!F) return;
    if (F.loading) {
      const p = make('p', 'biz-calm biz-wait');
      p.append(make('span', 'spinner'), 'Reading the verdict\u2026');
      root.append(p);
      return;
    }
    if (F.failed) {
      root.append(make('p', 'biz-calm biz-bad', F.failed), btn('ghost small', 'Close', 'bzs|close', () => { F = null; MU.closeDrawer(); }));
      return;
    }
    if (belowFull()) {
      root.append(make('p', 'biz-calm', TEXT.needFull));
      return;
    }
    const d = F.data;
    const form = make('form', 'biz-form bzs-form');
    form.noValidate = true;
    form.append(make('p', 'biz-note', TEXT.intro));
    if (str(d.source?.question)) {
      const q = make('div', 'bzs-q');
      q.append(make('span', 'biz-label', 'The question the council answered'), make('p', 'bzs-q-text', d.source.question));
      form.append(q);
    }

    const ideas = make('fieldset', 'bzs-ideas');
    ideas.append(make('legend', 'biz-label', F.rows.some(r => r.whole) ? 'The business' : 'The ideas of the verdict'));
    ideas.append(make('p', 'biz-note', d.fromLayout || F.rows.some(r => r.own) ? TEXT.modelText : `Plenum could not read a list of ideas in this verdict, so it is one business. ${TEXT.modelText}`));
    F.rows.forEach((r, i) => ideas.append(ideaRow(r, i)));
    const more = make('div', 'biz-actions');
    more.append(btn('ghost small', 'Add an idea of your own', 'bzs|add', () => { F.rows.push({ name: '', text: '', notes: '', keep: true, own: true }); redraw(`bzs|idea|${F.rows.length - 1}|name`); }));
    if (!F.rows.some(r => r.whole) && arr(d.ideas).length > 1) more.append(btn('ghost small', 'One business from the whole verdict', 'bzs|whole', () => { F.rows = [{ name: str(d.whole?.name), text: str(d.whole?.text), notes: '', keep: true, whole: true }]; redraw('bzs|idea|0|name'); }));
    ideas.append(more);
    form.append(ideas);

    const parent = input(F.parent, 'bzs|parent', v => { F.parent = v; }, { maxlength: 400, placeholder: 'For example D:\\Businesses' });
    const pf = field('Folder your businesses are kept in', parent, TEXT.parentNote);
    if (window.plenumShell || window.plenum) {
      const row = make('div', 'biz-actions');
      row.append(btn('ghost small', 'Browse\u2026', 'bzs|browse', () => browse()));
      pf.append(row);
    }
    form.append(pf);
    if (F.askExisting) {
      const row = make('label', 'bzs-check-row');
      const box = make('input');
      box.type = 'checkbox';
      box.checked = F.existing === true;
      box.dataset.fk = 'bzs|existing';
      box.addEventListener('change', () => { F.existing = box.checked; });
      row.append(box, make('span', null, TEXT.existing));
      form.append(row);
    }

    const offers = [...new Set([str(d.lead), ...arr(MU.catalog).map(refOf)].filter(Boolean))];
    if (!offers.includes(F.lead)) F.lead = offers[0] ?? '';
    const lead = make('select', 'biz-select');
    lead.dataset.fk = 'bzs|lead';
    for (const ref of offers) {
      const o = make('option', null, ref === str(d.lead) ? `${modelLabel(ref)} (this folder's model)` : modelLabel(ref));
      o.value = ref;
      lead.append(o);
    }
    lead.value = F.lead;
    lead.addEventListener('change', () => { F.lead = lead.value; });
    form.append(field('Lead model', lead, 'The model that does the setup and asks you. Plenum never puts another model in its place by itself.'));

    const templates = arr(d.templates).filter(isObj);
    if (templates.length > 1) {
      const about = make('p', 'biz-note', str(templates.find(t => t.id === F.template)?.about));
      const tpl = make('select', 'biz-select');
      tpl.dataset.fk = 'bzs|template';
      for (const t of templates) {
        const o = make('option', null, str(t.label) || t.id);
        o.value = t.id;
        tpl.append(o);
      }
      tpl.value = F.template;
      tpl.addEventListener('change', () => { F.template = tpl.value; about.textContent = str(templates.find(t => t.id === tpl.value)?.about); });
      const tf = field('Template', tpl);
      tf.append(about);
      form.append(tf);
    }

    const modes = make('fieldset', 'bzs-modes');
    modes.append(make('legend', 'biz-label', 'How the lead works in the new folders'));
    for (const [id, label, note] of [['ask', TEXT.ask, TEXT.askNote], ['auto', TEXT.auto, TEXT.autoNote]]) {
      const row = make('label', 'bzs-mode');
      const radio = make('input');
      radio.type = 'radio';
      radio.name = 'bzs-mode';
      radio.value = id;
      radio.checked = F.mode === id;
      radio.dataset.fk = `bzs|mode|${id}`;
      radio.addEventListener('change', () => { if (radio.checked) F.mode = id; });
      const words = make('span', 'bzs-mode-words');
      words.append(make('span', 'bzs-mode-name', label), make('small', 'biz-note', note), make('small', 'biz-note bzs-mode-rec', id === 'ask' ? TEXT.askRec : TEXT.autoRec));
      row.append(radio, words);
      modes.append(row);
    }
    form.append(modes);
    form.append(make('p', 'biz-note', TEXT.silence));

    if (F.error) {
      const p = make('p', 'biz-line biz-line-bad bzs-error', F.error);
      p.setAttribute('role', 'alert');
      form.append(p);
    }
    const row = make('div', 'biz-actions bzs-foot');
    const start = make('button', 'primary small', F.busy ? 'Starting\u2026' : 'Start setup');
    start.type = 'submit';
    start.dataset.fk = 'bzs|start';
    start.disabled = F.busy === true;
    row.append(start, btn('ghost small', 'Cancel', 'bzs|cancel', () => { F = null; MU.closeDrawer(); }));
    form.append(row);
    form.addEventListener('submit', e => { e.preventDefault(); submit(); });
    root.append(form);
    if (F.focus) {
      const want = F.focus;
      F.focus = '';
      const target = [...root.querySelectorAll('[data-fk]')].find(n => n.dataset.fk === want);
      if (target && !target.disabled) target.focus();
    }
  }

  // Opens the form for one verdict: { project, thread, ts }.
  async function open(source) {
    F = { loading: true, source };
    MU.openDrawer(TITLE, renderForm);
    const q = `project=${encodeURIComponent(str(source.project))}&thread=${encodeURIComponent(str(source.thread))}&ts=${encodeURIComponent(String(source.ts))}`;
    const r = await ask(`/api/business/setup/ideas?${q}`);
    if (!F || F.source !== source) return;
    if (!r.ok) {
      F = { failed: sentence(r.error), source };
      return redraw();
    }
    const d = r.data;
    const list = arr(d.ideas).filter(isObj);
    // A verdict that gave no list is one business built on the whole text.
    const rows = d.fromLayout || list.length > 1
      ? list.map((x, index) => ({ name: str(x.name), text: str(x.text), notes: '', keep: true, index }))
      : [{ name: str(d.whole?.name) || str(list[0]?.name), text: str(d.whole?.text) || str(list[0]?.text), notes: '', keep: true, whole: true }];
    F = { source: { project: str(d.source?.project), thread: str(d.source?.thread), ts: d.source?.ts }, data: d, rows, parent: str(d.parent), lead: str(d.lead), template: str(d.template), mode: 'ask', busy: false, error: '', askExisting: false, existing: false, focus: 'bzs|idea|0|name' };
    redraw();
  }

  // "From a council verdict": the councils of the open folders that have a verdict, newest first.
  let P = null;
  function renderPick(body) {
    body.replaceChildren();
    const root = make('div', 'bzs-form-root');
    body.append(root);
    if (!P) return;
    if (P.loading) {
      const p = make('p', 'biz-calm biz-wait');
      p.append(make('span', 'spinner'), 'Reading your councils\u2026');
      root.append(p);
      return;
    }
    if (!P.list.length) {
      root.append(make('p', 'biz-calm', P.error || TEXT.noVerdicts));
      return;
    }
    root.append(make('p', 'biz-note', 'Pick the verdict to build on. The next step shows its ideas; nothing is made yet.'));
    const list = make('div', 'biz-items bzs-verdicts');
    P.list.forEach((v, i) => {
      const box = make('article', 'biz-item bzs-verdict');
      const top = make('div', 'biz-item-top');
      top.append(pill(v.projectName), make('span', 'biz-age', new Date(v.ts).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })), make('span', 'biz-item-n', v.ideas === 1 ? '1 idea' : `${v.ideas} ideas`));
      box.append(top, make('h4', 'biz-item-title', v.question || 'A council without a saved question'), make('p', 'biz-note bzs-head', v.head));
      const acts = make('div', 'biz-actions');
      acts.append(btn('ghost small bzs-go', 'Use this verdict', `bzs|pick|${i}`, () => { P = null; open({ project: v.project, thread: v.thread, ts: v.ts }); }));
      box.append(acts);
      list.append(box);
    });
    root.append(list);
  }
  async function pick() {
    P = { loading: true, list: [], error: '' };
    MU.openDrawer('From a council verdict', renderPick);
    const mine = P;
    const all = [];
    let error = '';
    for (const p of projects().slice(0, 30)) {
      const r = await ask(`/api/business/setup/verdicts?project=${encodeURIComponent(p.id)}`);
      if (r.ok) for (const v of arr(r.data.verdicts).filter(isObj)) all.push({ project: p.id, projectName: str(p.name), thread: str(v.thread), ts: num(v.ts), question: str(v.question), head: str(v.head), ideas: num(v.ideas) });
      else if (r.status !== 404) error = sentence(r.error);
    }
    if (P !== mine) return;
    P = { loading: false, list: all.sort((a, b) => b.ts - a.ts).slice(0, 20), error };
    try { MU.refreshDrawer(); } catch { /* closed */ }
  }

  // ---------- the chat: the button on a verdict, and the strip above a Setup chat ----------

  function markVerdicts() {
    const phone = belowFull();
    for (const card of document.querySelectorAll('article.turn.council[data-verdict-ts]')) {
      const had = card.querySelector(':scope > .bzs-row');
      if (phone) { had?.remove(); continue; }
      if (had) continue;
      const ts = Number(card.dataset.verdictTs);
      if (!Number.isFinite(ts) || ts <= 0) continue;
      const row = make('div', 'bzs-row');
      row.append(btn('ghost small bzs-btn', TITLE, null, () => {
        const project = state().activeProject;
        let thread = '';
        try { thread = str(MU.threads.scope()); } catch { thread = ''; }
        if (project) open({ project, thread: thread || project, ts });
      }));
      card.querySelector(':scope > .consensus')?.after(row) ?? card.append(row);
    }
  }

  // "Waiting for you: K" above the chat while a Setup thread is on screen.
  let strip = null;
  function drawStrip() {
    let scope = '';
    try { scope = str(MU.threads.scope()); } catch { scope = ''; }
    const s = setups().find(x => x.project === state().activeProject && str(x.thread) && x.thread === scope);
    const n = s ? num(s.waiting) : 0;
    if (!s || n < 1) {
      if (strip) { try { MU.slots.remove('bannerSlot', 'biz-setup-waiting'); } catch { strip.remove(); } strip = null; }
      return;
    }
    const text = `Waiting for you: ${n}`;
    if (strip && strip.dataset.text === text) return;
    if (!strip) {
      strip = make('div', 'bzs-strip');
      strip.setAttribute('role', 'status');
      strip.append(make('span', 'bzs-strip-text'), btn('ghost small', 'Show', null, () => { try { MU.openBusinesses?.(); } catch { /* the title bar button opens it */ } }));
      try { MU.slots.add('bannerSlot', 'biz-setup-waiting', strip, 40); } catch { strip = null; return; }
    }
    strip.dataset.text = text;
    strip.querySelector('.bzs-strip-text').textContent = `${text}. ${str(s.name)} cannot go on with these until you answer.`;
  }

  // ---------- wiring ----------

  window.PlenumBizSetup = { todayEl, pick, open, read };

  // Before the Businesses pane is opened the page asks for the setups only when a chat named Setup is on screen (the strip is for it),
  // or when the server says one changed: a start with no setup asks nothing more than it did.
  const onSetupChat = () => { try { return str(MU.threads.info()?.name) === 'Setup'; } catch { return false; } };
  const firstRead = () => { if (D.state === 'idle' && !reading && onSetupChat()) read(); };
  try { MU.threads?.onRender?.(() => { markVerdicts(); drawStrip(); firstRead(); }); } catch { /* the form is still reached from Businesses */ }
  window.addEventListener('plenum:event', e => {
    const ev = e.detail;
    if (!isObj(ev)) return;
    if (ev.type === 'setup' || ev.type === 'needs-you') read();
    else if ((ev.type === 'decisions' || ev.type === 'business') && D.state !== 'idle') readSoon();
  });
  try { window.plenumShell?.onConnection?.(() => { markVerdicts(); told(); }); } catch { /* read again at the next draw */ }
  // After the page has started, never on the start path.
  Promise.resolve(MU.ready).then(() => setTimeout(() => { firstRead(); markVerdicts(); }, 1800), () => {});
})();
