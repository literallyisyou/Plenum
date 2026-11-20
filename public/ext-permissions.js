// ext-permissions. Permission presets: Ask first, Fewer questions and Hands-off, one click from the title bar, from Settings > Safety and
// from the Mode menu's foot. A preset is only a named bundle of settings that already exist (the approval mode and the three Approve all
// and coder switches); it is applied through the routes the Mode menu and Settings already use (POST /api/project-approvals through
// MuseUI.setProjectApprovals, POST /api/settings through MuseUI.update), so the server's own checks decide what is saved. No preset
// touches the floor (credential folders, Plenum's own files, the visible indicators, Stop, the password guard). Hands-off asks the
// Approve all question first (MuseUI.askApproveAll, which honours Don't show again). Every piece of text is set with textContent, and
// nothing is styled inline. The table and the pure functions are on window.PlenumPermissions, so a test can read them without a page.
(function () {
  'use strict';

  // ---------- the presets ----------

  const MODE_NAME = { ask: 'Ask first', auto: 'Auto-approve', all: 'Approve all' };
  const ALL_COVERS = { computer: true, browser: true };
  const deepFreeze = v => {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) deepFreeze(x); }
    return v;
  };

  // The fields are exactly what the existing routes take. approveAllBlocked stays off in every preset: turning it on would let Approve all
  // answer the Deny-first cards of the destructive built-in rules, which no preset may do. It stays a switch in Project settings.
  // approveAllCovers only matters while the mode is Approve all, so Ask first and Fewer questions leave it as the person has it (null);
  // only Hands-off turns it on.
  const fieldsFor = (approvals, covers) => ({
    approvals,
    approveAllBlocked: false,
    approveAllCovers: covers ? { ...covers } : null,
    codersCannotAsk: 'run',
  });
  const PRESETS = deepFreeze([
    {
      id: 'ask',
      name: 'Ask first',
      tone: '',
      summary: 'Every edit and command waits for your OK. This is how Plenum starts.',
      words: [
        'Plenum shows a card before it edits a file or runs a command.',
        'Codex and Gemini coders can still edit on their own inside the project; Rewind can undo it. A project set to refuse such coders will run them after this choice.',
      ],
      toast: 'Edits and commands wait for your approval.',
      fields: fieldsFor('ask', null),
    },
    {
      id: 'fewer',
      name: 'Fewer questions',
      tone: 'amber',
      summary: 'Ordinary work inside the project runs without a card.',
      words: [
        'Edits and commands run without a card. Commands run with your user rights, so they can change or delete files outside the project too.',
        'Plenum still asks about file writes outside the project, commands a built-in rule blocks, and computer-use and browser cards. Cursor’s print transport runs with its own prompts off in this mode.',
      ],
      toast: 'Edits and commands run without asking, and a command can change files outside the project. File writes outside it, blocked commands and computer-use and browser cards still ask.',
      fields: fieldsFor('auto', null),
    },
    {
      id: 'hands',
      name: 'Hands-off',
      tone: 'red',
      summary: 'Plenum answers the cards for you, as far as its own switches go.',
      words: [
        'Approve all: edits, commands, writes outside the project, and the computer-use and browser cards are answered for you.',
        'Plenum’s own tools still show the Deny-first card for a command a built-in rule blocks. Gemini, Muse Code, Grok Build and Cursor’s print transport run with their own prompts off in this mode, so Plenum cannot see or stop what they run.',
        'In Plenum’s own tools, credential folders and Plenum’s own files stay blocked and the model never types a password. Stop and Ctrl+Alt+Esc always work.',
      ],
      // Shown only while the Approve all notice is not hidden (Don't show again skips the question).
      question: 'Plenum asks the Approve all question first.',
      toast: 'Approve all is on. Plenum’s own tools still show the Deny-first card for blocked commands. Gemini, Muse Code, Grok Build and Cursor’s print transport run with their own prompts off, so Plenum cannot see what they run.',
      fields: fieldsFor('all', ALL_COVERS),
    },
  ]);
  const byId = id => PRESETS.find(p => p.id === id) ?? null;

  // The exact settings of a preset, as plain lines. The sheet shows them under the words, before anything is applied.
  function fieldLines(preset) {
    const f = preset.fields;
    const on = v => (v ? 'on' : 'off');
    const cover = key => (f.approveAllCovers ? on(f.approveAllCovers[key]) : 'left as it is');
    return [
      `Approval mode: ${MODE_NAME[f.approvals]}`,
      `Approve all answers computer-use cards: ${cover('computer')}`,
      `Approve all answers browser cards: ${cover('browser')}`,
      `Approve all answers blocked-command cards: ${on(f.approveAllBlocked)}`,
      `Coders that cannot ask: ${f.codersCannotAsk === 'run' ? 'run anyway' : 'refuse'}`,
    ];
  }

  // Which preset a set of settings is: { approvals, approveAllBlocked, approveAllCovers, codersCannotAsk } as a project entry of the page
  // state carries them. Anything that matches none is 'custom'. A missing cover reads as on, as the server does; a missing coder value as run.
  // The covers count only for a preset that sets them (Hands-off): they do nothing in the other two modes.
  function detect(s) {
    if (!s || typeof s !== 'object') return 'custom';
    for (const p of PRESETS) {
      const f = p.fields;
      if (s.approvals === f.approvals
        && (s.approveAllBlocked === true) === f.approveAllBlocked
        && (!f.approveAllCovers || ((s.approveAllCovers?.computer !== false) === f.approveAllCovers.computer
          && (s.approveAllCovers?.browser !== false) === f.approveAllCovers.browser))
        && (s.codersCannotAsk ?? 'run') === f.codersCannotAsk) return p.id;
    }
    return 'custom';
  }

  // The app default as the same shape (the app has no blocked or coder switch of its own: those are per project).
  const appSettingsOf = state => ({
    approvals: state?.approvals ?? 'ask',
    approveAllBlocked: false,
    approveAllCovers: state?.approveAllCovers ?? { computer: true, browser: true },
    codersCannotAsk: 'run',
  });

  // The preset in force for a scope: 'project' (the active project), 'all' (the app default and every project: Custom when any differs) or
  // 'new' (the app default).
  function currentFor(scope, state) {
    const projects = Array.isArray(state?.projects) ? state.projects : [];
    if (scope === 'project') {
      const p = projects.find(x => x.id === state?.activeProject);
      return p ? detect(p) : 'custom';
    }
    const app = detect(appSettingsOf(state));
    if (scope === 'new') return app;
    return projects.every(p => detect(p) === app) ? app : 'custom';
  }

  // The requests that apply a preset to a scope, in the order they run: [{ kind: 'project', project, label, patch } | { kind: 'app', label, patch }].
  // The order keeps every project at or below the more open of "before" and "after" between two requests, so a stop half way never leaves a
  // project in Approve all, or answering more cards, than the person chose (and never without the Approve all question):
  //  'project': the project's own fields, one request. projectId names it (the page captures it before it asks anything).
  //  'all': the app default and project overrides change together in one settings request.
  //  'new': a project that follows the default today is first given its current values, so it keeps what it has (a pin never changes what a
  //         project uses), then the app default last.
  function plan(presetId, scope, state, projectId) {
    const preset = byId(presetId);
    if (!preset) throw new Error('Unknown preset.');
    const f = preset.fields;
    const projects = Array.isArray(state?.projects) ? state.projects : [];
    const covers = () => (f.approveAllCovers ? { ...f.approveAllCovers } : null);
    const appPatch = { approvals: f.approvals };
    if (f.approveAllCovers) appPatch.approveAllCovers = covers();
    const app = { kind: 'app', label: 'the app default', patch: appPatch };
    if (scope === 'project') {
      const p = projects.find(x => x.id === (projectId ?? state?.activeProject));
      if (!p) throw new Error('Add a project folder first.');
      const patch = { approvals: f.approvals, approveAllBlocked: f.approveAllBlocked, codersCannotAsk: f.codersCannotAsk };
      if (f.approveAllCovers) patch.approveAllCovers = covers();
      return [{ kind: 'project', project: p.id, label: p.name, patch }];
    }
    if (scope === 'all') {
      return [{ kind: 'app', label: 'all projects and the app default', patch: { ...appPatch, approvalsScope: 'all-projects' } }];
    }
    if (scope === 'new') {
      const steps = [];
      for (const p of projects) {
        const patch = {};
        if (!p.ownApprovals) patch.approvals = p.approvals ?? 'ask';
        const c = p.approveAllCovers ?? {};
        if (f.approveAllCovers && (c.computer === false || c.browser === false)) patch.approveAllCovers = { computer: c.computer !== false, browser: c.browser !== false };
        if (Object.keys(patch).length) steps.push({ kind: 'project', project: p.id, label: p.name, patch });
      }
      return [...steps, app];
    }
    throw new Error('Unknown scope.');
  }

  // True when applying the preset would turn Approve all on somewhere it is not on now (so the question is asked).
  function turnsOnAll(presetId, scope, state, projectId) {
    if (byId(presetId)?.fields.approvals !== 'all') return false;
    const projects = Array.isArray(state?.projects) ? state.projects : [];
    if (scope === 'project') return projects.find(x => x.id === (projectId ?? state?.activeProject))?.approvals !== 'all';
    if (scope === 'new') return state?.approvals !== 'all';
    return state?.approvals !== 'all' || projects.some(p => p.approvals !== 'all');
  }

  // The covers that are off now and that the preset turns on: [] for Ask first and Fewer questions, which leave them alone.
  function coversTurnedOn(presetId, scope, state, projectId) {
    const want = byId(presetId)?.fields.approveAllCovers;
    if (!want) return [];
    const projects = Array.isArray(state?.projects) ? state.projects : [];
    const sets = [];
    if (scope === 'project') sets.push(projects.find(x => x.id === (projectId ?? state?.activeProject))?.approveAllCovers ?? {});
    else {
      sets.push(appSettingsOf(state).approveAllCovers);
      if (scope === 'all') for (const p of projects) sets.push(p.approveAllCovers ?? {});
    }
    return ['computer', 'browser'].filter(k => want[k] && sets.some(c => c[k] === false));
  }

  // What choosing the preset would change from the settings in force, as plain lines (the card shows them before anything is applied).
  function changeLines(presetId, scope, state, projectId) {
    const preset = byId(presetId);
    if (!preset) return [];
    const f = preset.fields;
    const projects = Array.isArray(state?.projects) ? state.projects : [];
    const picked = scope === 'project' ? projects.filter(x => x.id === (projectId ?? state?.activeProject)) : scope === 'all' ? projects : [];
    const lines = [];
    const modes = [...new Set([...(scope === 'project' ? [] : [appSettingsOf(state).approvals]), ...picked.map(p => p.approvals ?? 'ask')])].filter(m => m !== f.approvals);
    if (modes.length) lines.push(`Approval mode: ${modes.map(m => MODE_NAME[m]).join(' and ')} → ${MODE_NAME[f.approvals]}`);
    const where = names => (scope === 'all' && names.length ? ` (${names.join(', ')})` : '');
    if (f.approveAllCovers) {
      const turned = coversTurnedOn(presetId, scope, state, projectId);
      for (const [key, word] of [['computer', 'computer-use'], ['browser', 'browser']]) {
        if (turned.includes(key)) lines.push(`Approve all answers ${word} cards: off → on`);
      }
    }
    const blocked = picked.filter(p => p.approveAllBlocked === true).map(p => p.name);
    if (blocked.length) lines.push(`Approve all answers blocked-command cards: on → off${where(blocked)}`);
    const refuse = picked.filter(p => p.codersCannotAsk === 'refuse').map(p => p.name);
    if (refuse.length) lines.push(`Coders that cannot ask: refuse → run anyway${where(refuse)}`);
    return lines;
  }

  const api = { PRESETS, byId, fieldLines, detect, appSettingsOf, currentFor, plan, turnsOnAll, coversTurnedOn, changeLines, MODE_NAME };
  if (typeof window !== 'undefined') window.PlenumPermissions = Object.freeze(api);

  // ---------- the page ----------

  const MuseUI = typeof window !== 'undefined' ? window.MuseUI : null;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI || typeof MuseUI.setProjectApprovals !== 'function') return;

  const SCOPES = [
    { id: 'project', label: () => `This project${activeProject() ? ` (${activeProject().name})` : ''}`, help: () => (activeProject() ? 'Only the project on screen.' : 'Needs a project. Add a project folder first.') },
    { id: 'all', label: () => 'Every project', help: () => 'Sets the app default and makes every project follow it. A project’s own approval settings are cleared, and projects you add later start in it too.' },
    { id: 'new', label: () => 'New projects', help: () => 'Sets the app default for projects you add later. A project that follows the default today keeps what it has now.' },
  ];
  const SCOPE_NAME = { project: () => activeProject()?.name ?? 'this project', all: () => 'every project', new: () => 'new projects' };
  const FLOOR_NOTE = 'In every preset, in Plenum’s own tools: credential folders and Plenum’s own files stay blocked, the model never types a password, the drive bar and badges show whenever a model controls the screen or the browser, and Stop always works. Some CLI agents run with their own prompts off in the two looser presets; the cards above say which.';

  const activeProject = () => MuseUI.state.projects?.find(p => p.id === MuseUI.state.activeProject) ?? null;
  const make = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  let busy = false;
  let scopeNow = 'project';
  const painters = new Set();
  let sheet = null;
  let opener = null;
  let seq = 0;

  const nameOf = id => (id === 'custom' ? 'Custom' : byId(id)?.name ?? 'Custom');
  function paintAll() {
    for (const paint of [...painters]) paint();
  }

  // ---------- applying ----------

  const settingsIsOpen = () => document.getElementById('settingsPage')?.hidden === false;
  const sentence = text => { const t = String(text ?? '').trim(); return !t || /[.!?]$/.test(t) ? t : `${t}.`; };

  // What each project that was already changed uses now, for the message after a request failed half way.
  function usesNow(steps, done) {
    const out = [];
    for (const step of steps.slice(0, done)) {
      if (step.kind === 'app') out.push(`the app default uses ${MODE_NAME[MuseUI.state.approvals ?? 'ask'] ?? 'Ask first'}`);
      else {
        const p = MuseUI.state.projects?.find(x => x.id === step.project);
        if (p) out.push(`${p.name} uses ${MODE_NAME[p.approvals ?? 'ask'] ?? 'Ask first'}`);
      }
    }
    return [...new Set(out)];
  }

  async function apply(presetId, scope) {
    if (busy) return false;
    const preset = byId(presetId);
    if (!preset) return false;
    // The scope and the project are fixed now, before any question: a dialog can stay open while another window changes the project on screen.
    const projectId = scope === 'project' ? activeProject()?.id ?? null : null;
    if (scope === 'project' && !projectId) {
      MuseUI.toast('Add a project folder first.', 'bad');
      return false;
    }
    busy = true;
    paintAll();
    const reopen = Boolean(sheet && !sheet.dlg.hidden);
    const settingsWas = settingsIsOpen();
    // The sheet comes back with the scope the person chose, unless the Approve all question sent them to Settings.
    const comeBack = () => {
      if (!reopen || (settingsIsOpen() && !settingsWas)) return;
      scopeNow = scope;
      openSheet(opener, true);
    };
    try {
      const covers = coversTurnedOn(presetId, scope, MuseUI.state, projectId);
      // Approve all is asked the way every other control asks it. The sheet steps aside for the question and comes back on Cancel.
      if (turnsOnAll(presetId, scope, MuseUI.state, projectId)) {
        if (reopen) closeSheet(false);
        if (!(await MuseUI.askApproveAll())) {
          comeBack();
          return false;
        }
      }
      if (scope === 'project' && activeProject()?.id !== projectId) {
        MuseUI.toast('The project on screen changed while the question was open, so nothing was changed. Open Permissions and choose again.', 'bad');
        comeBack();
        return false;
      }
      const steps = plan(presetId, scope, MuseUI.state, projectId);
      let done = 0;
      try {
        for (const step of steps) {
          if (step.kind === 'project') await MuseUI.setProjectApprovals(step.patch, step.project);
          else await MuseUI.update(step.patch);
          done += 1;
        }
      } catch (err) {
        const where = steps[done]?.label ?? 'a project';
        const now = usesNow(steps, done);
        MuseUI.toast(`${done ? `Changed ${done} of ${steps.length} settings. ` : ''}Could not change ${where}: ${sentence(err.message)}${now.length ? ` Now: ${now.join('; ')}.` : ''} Open Permissions to see what is in force.`, 'bad');
        comeBack();
        return false;
      } finally {
        window.dispatchEvent(new CustomEvent('plenum:approvals'));
      }
      const when = MuseUI.state.running ? ' It applies from the next message.' : '';
      if (scope === 'new') MuseUI.toast(`${preset.name} is now the default for new projects. Projects you have now keep what they use.`);
      else MuseUI.toast(`${preset.name} is on for ${SCOPE_NAME[scope]()}. ${preset.toast}${when}`);
      // The danger strips where the switches start, as the Mode menu and Settings draw them.
      if (preset.fields.approvals === 'auto' && scope !== 'new') {
        try { MuseUI.notice?.('auto-approve', { before: MuseUI.el.form }); } catch { /* a notice is an extra */ }
      }
      if (covers.length) {
        try { MuseUI.notice?.('approve-all-covers', { before: MuseUI.el.form }); } catch { /* a notice is an extra */ }
      }
      // The sheet already stepped aside for the Approve all question (Hands-off): the focus goes back to the control that opened it.
      if (reopen) {
        if (sheet && !sheet.dlg.hidden) closeSheet(true);
        else if (opener && typeof opener.focus === 'function') opener.focus();
      }
      return true;
    } catch (err) {
      MuseUI.toast(err.message, 'bad');
      return false;
    } finally {
      busy = false;
      paintAll();
    }
  }

  // ---------- the panel (used by the sheet and by Settings) ----------

  function buildPanel() {
    const id = ++seq;
    const root = make('div', 'perm-panel');
    const status = make('p', 'perm-status');
    status.setAttribute('role', 'status');
    const scopeBox = make('div', 'perm-scopes');
    scopeBox.setAttribute('role', 'radiogroup');
    scopeBox.setAttribute('aria-label', 'Where the preset applies');
    const radios = SCOPES.map(s => {
      const row = make('label', 'perm-scope');
      const input = make('input');
      input.type = 'radio';
      input.name = `perm-scope-${id}`;
      input.value = s.id;
      input.addEventListener('change', () => { if (input.checked) { scopeNow = s.id; paintAll(); } });
      const text = make('span', 'perm-scope-text');
      const title = make('strong');
      const help = make('small');
      text.append(title, help);
      row.append(input, text);
      scopeBox.append(row);
      return { s, input, title, help };
    });
    const cards = PRESETS.map(p => {
      const card = make('article', 'perm-card');
      card.dataset.preset = p.id;
      const head = make('div', 'perm-card-head');
      const name = make('h3', 'perm-card-name', p.name);
      const mark = make('span', 'perm-mark', 'In use');
      head.append(name, mark);
      const words = make('ul', 'perm-words');
      for (const w of p.words) words.append(make('li', '', w));
      const question = p.question ? make('li', 'perm-question', p.question) : null;
      if (question) words.append(question);
      const fields = make('ul', 'perm-fields');
      for (const line of fieldLines(p)) fields.append(make('li', '', line));
      const changes = make('div', 'perm-changes');
      const changesHead = make('p', 'perm-changes-head', 'This will change what is in force now:');
      const changesList = make('ul', 'perm-changes-list');
      changes.append(changesHead, changesList);
      const use = MuseUI.button('ghost small perm-use', `Use ${p.name}`);
      use.dataset.preset = p.id;
      use.addEventListener('click', () => { apply(p.id, scopeNow); });
      card.append(head, make('p', 'perm-summary', p.summary), words, fields, changes, use);
      return { p, card, mark, use, question, changes, changesList };
    });
    const floor = make('p', 'perm-floor', FLOOR_NOTE);
    root.append(status, scopeBox, ...cards.map(c => c.card), floor);

    function paint() {
      // A Settings card that was drawn again leaves its old panel behind, unattached: it stops painting.
      if (root.dataset.mounted === '1' && !root.isConnected) {
        painters.delete(paint);
        return;
      }
      const state = MuseUI.state;
      const project = activeProject();
      if (!project && scopeNow === 'project') scopeNow = 'all';
      const mine = project ? nameOf(currentFor('project', state)) : 'No project';
      status.textContent = `${project ? `${project.name}: ` : ''}${mine}. App default for new projects: ${nameOf(currentFor('new', state))}.`;
      for (const r of radios) {
        r.input.checked = r.s.id === scopeNow;
        r.input.disabled = busy || (r.s.id === 'project' && !project);
        r.title.textContent = r.s.label();
        r.help.textContent = r.s.help();
      }
      const now = currentFor(scopeNow, state);
      for (const c of cards) {
        const current = c.p.id === now;
        c.card.dataset.current = current ? '1' : '0';
        c.mark.hidden = !current;
        c.use.disabled = busy || current;
        c.use.textContent = current ? `${c.p.name} is in use` : `Use ${c.p.name}`;
        // Only while the Approve all question is still shown (Don't show again skips it).
        if (c.question) c.question.hidden = MuseUI.notices?.list?.().find(n => n.id === 'approve-all')?.hidden === true;
        const lines = current ? [] : changeLines(c.p.id, scopeNow, state, scopeNow === 'project' ? project?.id : undefined);
        c.changesList.replaceChildren(...lines.map(l => make('li', '', l)));
        c.changes.hidden = lines.length === 0;
      }
    }
    painters.add(paint);
    root.dataset.mounted = '0';
    paint();
    return root;
  }

  // ---------- the sheet ----------

  function focusables(dlg) {
    return [...dlg.querySelectorAll('button, input, [tabindex]')].filter(n => !n.disabled && n.getAttribute('tabindex') !== '-1' && n.getClientRects().length > 0);
  }

  function ensureSheet() {
    if (sheet) return sheet;
    const scrim = make('div', 'perm-scrim');
    scrim.hidden = true;
    const dlg = make('dialog', 'perm-sheet');
    dlg.hidden = true;
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-labelledby', 'permSheetTitle');
    const head = make('div', 'perm-sheet-head');
    const title = make('h2', 'perm-sheet-title', 'Permissions');
    title.id = 'permSheetTitle';
    const close = MuseUI.button('ghost small perm-close', 'Close');
    close.addEventListener('click', () => closeSheet(true));
    head.append(title, close);
    const lead = make('p', 'perm-lead', 'Pick how often Plenum asks. Each choice is a bundle of settings you can already change one by one; it never lowers the safety floor. Going back to Ask first is the same one click.');
    const panel = buildPanel();
    const more = MuseUI.button('ghost small perm-more', 'Safety settings…');
    more.addEventListener('click', () => { closeSheet(false); MuseUI.settings?.open?.('app', 'safety'); });
    dlg.append(head, lead, panel, more);
    scrim.addEventListener('click', () => closeSheet(true));
    // The sheet itself can hold the focus, so a click on its plain text keeps the focus inside it and Escape still reaches this handler.
    dlg.tabIndex = -1;
    dlg.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeSheet(true);
      } else if (e.key === 'Tab') {
        const list = focusables(dlg);
        if (!list.length) { e.preventDefault(); return; }
        const first = list[0];
        const last = list[list.length - 1];
        const at = document.activeElement;
        if (e.shiftKey && (at === first || !dlg.contains(at))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (at === last || !dlg.contains(at))) { e.preventDefault(); first.focus(); }
      }
    });
    // Focus that leaves the sheet while it is open is pulled back in.
    document.addEventListener('focusin', e => {
      if (!dlg.hidden && !busy && e.target && !dlg.contains(e.target) && !document.querySelector('dialog.risk-dialog[open], dialog.confirm-dialog[open]')) {
        (focusables(dlg)[0] ?? dlg).focus();
      }
    });
    document.body.append(scrim, dlg);
    sheet = { scrim, dlg, panel };
    return sheet;
  }

  // keepScope: the sheet comes back after a question or a failed apply with the scope the person had chosen.
  function openSheet(from, keepScope) {
    const s = ensureSheet();
    opener = from ?? opener ?? chip;
    if (keepScope !== true) scopeNow = activeProject() ? 'project' : 'all';
    paintAll();
    s.scrim.hidden = false;
    s.dlg.hidden = false;
    if (typeof s.dlg.show === 'function') s.dlg.show();
    else s.dlg.setAttribute('open', '');
    const target = s.dlg.querySelector('input[type="radio"]:checked') ?? s.dlg;
    target.focus();
    chip?.setAttribute('aria-expanded', 'true');
  }

  function closeSheet(returnFocus) {
    if (!sheet || sheet.dlg.hidden) return;
    sheet.scrim.hidden = true;
    sheet.dlg.hidden = true;
    if (typeof sheet.dlg.close === 'function') sheet.dlg.close();
    else sheet.dlg.removeAttribute('open');
    chip?.setAttribute('aria-expanded', 'false');
    if (returnFocus && opener && typeof opener.focus === 'function') opener.focus();
  }

  // ---------- the title bar control ----------

  const chip = MuseUI.ui.chip({ label: 'Permissions', title: 'Permissions', onClick: () => (sheet && !sheet.dlg.hidden ? closeSheet(true) : openSheet(chip)) });
  chip.classList.add('perm-chip');
  chip.setAttribute('aria-haspopup', 'dialog');
  chip.setAttribute('aria-expanded', 'false');
  function paintChip() {
    const project = activeProject();
    const id = project ? currentFor('project', MuseUI.state) : currentFor('new', MuseUI.state);
    const preset = byId(id);
    chip.textContent = `Permissions: ${nameOf(id)}`;
    chip.dataset.tone = preset ? preset.tone : 'amber';
    chip.dataset.preset = id;
    // The title bar's fit ladder (ext-permissions.css) shows only this name when the bar is tight; the full words stay in the accessible name.
    chip.dataset.short = nameOf(id);
    const label = `Permissions: ${nameOf(id)}${project ? ` in ${project.name}` : ''}. Change`;
    chip.title = label;
    chip.setAttribute('aria-label', label);
  }
  painters.add(paintChip);
  try {
    MuseUI.slots.add('titlebar', 'permissions', chip, 40);
  } catch (err) {
    console.warn('The Permissions control could not be added to the title bar.', err?.message ?? err);
  }
  paintChip();
  MuseUI.openPermissions = from => openSheet(from ?? null);
  MuseUI.permissions = { ...api, apply, open: openSheet, close: closeSheet };

  // A link in the Mode menu's foot, beside Safety settings.
  try {
    const foot = document.querySelector('#modeMenu .mode-foot');
    if (foot) {
      const link = MuseUI.button('ghost small mode-link', 'Permissions…');
      link.title = 'Ask first, Fewer questions or Hands-off, for this project, every project or new ones';
      link.addEventListener('click', () => {
        const menu = document.getElementById('modeMenu');
        if (menu) menu.hidden = true;
        document.getElementById('modeBtn')?.setAttribute('aria-expanded', 'false');
        openSheet(document.getElementById('modeBtn'));
      });
      foot.append(link);
    }
  } catch { /* the Mode menu is an extra */ }

  // The page redraws its shell after every state change; the app's own approval changes are announced on window.
  try { MuseUI.threads?.onRender?.(paintAll); } catch { /* an extra */ }
  window.addEventListener('plenum:approvals', paintAll);

  // ---------- Settings > Safety, at the top ----------

  if (typeof MuseUI.settings?.register === 'function') {
    MuseUI.settings.register({
      id: 'permissions',
      scope: 'app',
      title: 'Permissions',
      order: 1,
      group: 'safety',
      render(body) {
        body.append(MuseUI.para('Ask first, Fewer questions or Hands-off in one click. Each is a bundle of the settings below it. The current choice for the project on screen is always shown in the title bar.'));
        const panel = buildPanel();
        panel.dataset.mounted = '1';
        body.append(panel);
      },
    });
  }
})();
