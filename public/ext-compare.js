// ext-compare. Owned by its panel builder. Builds on window.MuseUI (see app.js).
// Quick compare: one prompt goes to two to four models at once. Each answer streams into its own column, and the
// user keeps the one to continue from. Only Keep writes to the chat. Replies are plain text, set with textContent.
(function () {
  const MuseUI = window.MuseUI;
  // A caught error in plain words, as one sentence: the server's own sentence, or a fixed one when Plenum did not answer or sent only a
  // status (never the browser's "Failed to fetch" or "Request failed (500)").
  const plain = err => {
    const t = String((MuseUI?.plainError ? MuseUI.plainError(err) : err?.message) || 'That could not be done.').trim();
    return /[.!?…]$/.test(t) ? t : `${t}.`;
  };
  // The error a refusal becomes: the server's sentence when it sent one, else only its status (plain() words that).
  const refusal = (status, data) => {
    const said = typeof data?.error === 'string' ? data.error.trim() : '';
    return Object.assign(new Error(said || `The request was refused (${status}).`), { status, fromServer: Boolean(said) });
  };
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const TITLE = 'Quick compare';
  const MIN_SEATS = 2;
  const MAX_SEATS = 4;
  // Seat letters, in the order the models were picked. The server gives each seat the same letter.
  const SEAT_IDS = ['a', 'b', 'c', 'd'];
  // The providers a seat can use: the council's list (lib/council.mjs). The server applies the same rules again.
  const SEAT_PROVIDERS = ['muse', 'anthropic', 'codex', 'gemini', 'cursor', 'grok', 'antigravity', 'xai', 'openai', 'deepseek', 'mistral', 'googleai'];
  // The group names come from the provider registry (app.js PROVIDER_REGISTRY), so a new provider is named in one place.
  const GROUP_NAMES = Object.fromEntries(MuseUI.providerRegistry.map(p => [p.id, p.name]));
  const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
  const STATUS_TEXT = { waiting: 'Waiting', writing: 'Writing', done: 'Done', failed: 'Failed', stopped: 'Stopped' };
  const INTRO = 'Send one message to two to four models at once and compare the replies side by side. Nothing reaches the chat until you keep one.';
  const HINT = 'Ctrl+Enter to compare';

  // The picks, the draft and the effort survive a redraw, so closing the drawer loses nothing that was typed.
  let chosen = [];
  let draft = '';
  let effort = null;
  // Whether the pictures in the composer go with the prompt. null until the person has chosen; then they do when there are any.
  let withImages = null;
  // The compare in progress, or the last one: { project, prompt, seats, active, kept, error }.
  let run = null;
  // A message about the controls (for example "Write a prompt first."), shown until the next change.
  let flash = null;
  // The drawer's elements. Each draw builds them again, so a stale reference is never painted.
  let view = null;
  let controller = null;
  let userStopped = false;
  let painting = false;

  // "Claude Opus 5.5", not "Muse Wonder Full (Muse Code subscribers)": the bracketed part is menu help.
  const refOf = c => `${c.provider}:${c.id}`;
  const shortLabel = c => c.label.replace(/\s*\([^)]*\)\s*$/, '').trim();
  function labelFor(ref) {
    const hit = MuseUI.catalog.find(c => refOf(c) === ref);
    return hit ? shortLabel(hit) : ref;
  }

  // An element with a class and text. Text goes in with textContent, so nothing is read as HTML.
  function make(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---------- the side menu entry and the drawer ----------

  // The entry sits above Accounts in the side menu. It only opens the drawer.
  function sideButton() {
    const b = make('button', 'side-link');
    b.type = 'button';
    b.id = 'compareBtn';
    b.title = 'Send one prompt to several models and keep the reply you pick';
    b.append(MuseUI.icon('layers'), TITLE);
    b.addEventListener('click', openCompare);
    return b;
  }

  function openCompare() {
    MuseUI.openDrawer(TITLE, draw);
    // The prompt takes the focus without scrolling the drawer to it: the drawer opens at its top, on the first group of models.
    view?.prompt.focus({ preventScroll: true });
  }

  // Builds the whole panel from the module state. openDrawer and refreshDrawer both call it.
  function draw(body) {
    effort ??= MuseUI.state.effort || 'high';
    view = { checks: new Map(), shown: undefined };
    const panel = make('div', 'cmp-panel');
    view.grid = make('div', 'cmp-grid');
    const intro = make('p', 'cmp-intro', INTRO);
    panel.append(intro, modelsCard(), askCard(), view.grid);
    body.append(panel);
    // Several companies get the message here, so the multi-provider strip sits at the top of the panel (LEGAL multi-provider).
    MuseUI.notice?.('multi-provider', { before: intro });
    paint();
  }

  // ---------- the models ----------

  function modelsCard() {
    const card = make('section', 'card cmp-card');
    card.append(MuseUI.span('kicker', 'Models'));
    view.groups = make('div', 'cmp-groups');
    view.count = make('p', 'cmp-count');
    drawModels();
    card.append(view.groups, view.count);
    return card;
  }

  function drawModels() {
    const available = MuseUI.modelChoices();
    view.groups.replaceChildren();
    view.checks.clear();
    for (const provider of SEAT_PROVIDERS) {
      const models = available.filter(c => c.provider === provider);
      for (const ref of chosen) {
        if (!ref.startsWith(`${provider}:`) || models.some(c => refOf(c) === ref)) continue;
        models.push({ provider, id: ref.slice(provider.length + 1), label: `${labelFor(ref)} — not offered to this account` });
      }
      if (!models.length) continue;
      const group = make('div', 'cmp-group');
      group.append(make('span', 'cmp-group-name', GROUP_NAMES[provider] ?? provider));
      const chips = make('div', 'cmp-chips');
      for (const c of models) {
        const ref = refOf(c);
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = ref;
        box.checked = chosen.includes(ref);
        box.addEventListener('change', () => toggle(ref));
        const chip = make('label', 'cmp-chip');
        chip.append(box, make('span', null, shortLabel(c)));
        chips.append(chip);
        view.checks.set(ref, box);
      }
      group.append(chips);
      view.groups.append(group);
    }
  }

  // A pick adds or removes a model. Four is the most, so the other boxes stop accepting once four are chosen.
  function toggle(ref) {
    flash = null;
    chosen = chosen.includes(ref) ? chosen.filter(r => r !== ref) : [...chosen, ref].slice(0, MAX_SEATS);
    if (!chosen.includes(ref) && !MuseUI.modelChoices().some(c => refOf(c) === ref)) drawModels();
    paint();
  }

  // ---------- the prompt and the controls ----------

  // The pictures waiting in the composer (public/ext-images.js), each { name, mime, data, size }. A PDF or a text file is not sent here.
  function composerPictures() {
    return (window.MuseImages?.list() ?? []).filter(file => file.kind === 'image');
  }

  function askCard() {
    const card = make('section', 'card cmp-card');
    card.append(MuseUI.span('kicker', 'Prompt'));
    view.prompt = make('textarea', 'cmp-prompt');
    view.prompt.rows = 4;
    view.prompt.spellcheck = false;
    view.prompt.placeholder = 'Ask every model the same question';
    view.prompt.setAttribute('aria-label', 'Prompt');
    view.prompt.value = draft;
    view.prompt.addEventListener('input', () => {
      draft = view.prompt.value;
      flash = null;
      paint();
    });
    view.prompt.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        startRun();
      }
    });

    view.effort = document.createElement('select');
    view.effort.setAttribute('aria-label', 'Effort');
    for (const e of EFFORTS) view.effort.append(new Option(EFFORT_LABELS[e], e));
    view.effort.value = effort;
    view.effort.addEventListener('change', () => { effort = view.effort.value; });
    const effortField = make('label', 'cmp-effort');
    effortField.append(make('span', 'field-label', 'Effort'), view.effort);

    view.compare = MuseUI.button('primary small', 'Compare');
    view.compare.addEventListener('click', startRun);
    view.stop = MuseUI.button('ghost small', 'Stop');
    view.stop.addEventListener('click', stopRun);
    const actions = make('div', 'cmp-actions');
    actions.append(effortField, view.compare, view.stop, make('span', 'cmp-hint', HINT));

    // The pictures in the composer go with the prompt to every column whose model takes them; the others get a line saying so.
    view.images = document.createElement('input');
    view.images.type = 'checkbox';
    view.images.addEventListener('change', () => { withImages = view.images.checked; paint(); });
    view.imagesLabel = make('label', 'cmp-images');
    view.imagesLabel.append(view.images, make('span', null, 'Include the attached images'));
    view.imagesCount = make('span', 'cmp-hint', '');

    view.status = make('p', 'cmp-status');
    view.status.setAttribute('role', 'status');
    card.append(view.prompt, view.imagesLabel, view.imagesCount, actions, view.status);
    return card;
  }

  // Locks what cannot change while a run is going. The picks, the prompt and the effort wait for the run to end.
  function paintControls() {
    const busy = Boolean(run?.active);
    const picked = chosen.length;
    for (const [ref, box] of view.checks) {
      const on = chosen.includes(ref);
      box.checked = on;
      box.disabled = busy || (!on && picked >= MAX_SEATS);
    }
    view.count.textContent = `${picked} picked. Choose ${MIN_SEATS} to ${MAX_SEATS}.`;
    // Checked when the composer holds pictures, unless the person has unchecked it.
    const pictures = composerPictures();
    view.images.checked = pictures.length > 0 && withImages !== false;
    view.images.disabled = busy || !pictures.length;
    view.imagesCount.textContent = pictures.length
      ? `${pictures.length} picture${pictures.length === 1 ? '' : 's'} attached in the composer.`
      : 'Attach pictures in the composer to send them with the prompt.';
    view.prompt.readOnly = busy;
    view.effort.disabled = busy;
    view.compare.disabled = busy || !MuseUI.state.activeProject;
    view.compare.hidden = busy;
    view.stop.hidden = !busy;
  }

  // The line under the controls: what to do next, what a run is doing, or how the last one ended.
  function paintStatus() {
    const project = MuseUI.state.activeProject;
    let text = 'Pick two to four models, write a prompt, then press Compare.';
    let bad = false;
    if (!project) {
      text = 'Add a project folder first. The kept reply goes into that project’s chat.';
      bad = true;
    } else if (flash) {
      text = flash.text;
      bad = flash.bad;
    } else if (run?.active) {
      const finished = run.seats.filter(s => s.status === 'done' || s.status === 'failed' || s.status === 'stopped').length;
      text = `${finished} of ${run.seats.length} finished.`;
    } else if (run?.error) {
      text = run.error;
      bad = true;
    } else if (run && run.seats.some(s => s.status === 'done')) {
      text = run.seats.some(s => s.status === 'failed')
        ? 'Keep the reply you want to continue from, or retry a failed column (it is billed again). The chat gets your prompt and that reply.'
        : 'Keep the reply you want to continue from. The chat gets your prompt and that reply.';
    } else if (run && run.seats.every(s => s.status === 'stopped')) {
      text = 'Stopped before any reply finished.';
    } else if (run) {
      text = 'No model returned a reply. Each column says why. A failed column can be retried; that is billed again.';
    }
    view.status.textContent = text;
    view.status.className = bad ? 'cmp-status bad' : 'cmp-status';
  }

  // ---------- the columns ----------

  // Brings the controls, the status line and the columns up to date with the run.
  function paint() {
    if (!view) return;
    paintColumns();
    paintControls();
    paintStatus();
  }

  // Text arrives in many small pieces, so the page is redrawn at most once per frame.
  function schedule() {
    if (painting) return;
    painting = true;
    requestAnimationFrame(() => {
      painting = false;
      paint();
    });
  }

  // A run builds its columns once. While it runs, a column only takes new text and a status, so the Keep
  // buttons and the scroll positions stay where they are.
  function paintColumns() {
    if (view.shown !== run) {
      view.shown = run;
      view.cols = run ? run.seats.map(makeColumn) : [];
      view.grid.replaceChildren(...(run ? view.cols.map(c => c.root) : [make('p', 'cmp-empty', 'The replies appear here, one column per model.')]));
    }
    if (!run) return;
    for (const col of view.cols) updateColumn(col, run);
  }

  function makeColumn(seat) {
    const root = make('section', 'cmp-col');
    root.setAttribute('aria-label', seat.label);
    const pill = make('span', 'pill');
    const head = make('div', 'cmp-col-head');
    head.append(make('span', 'cmp-col-name', seat.label), pill);
    const text = make('div', 'cmp-col-text');
    const protocol = make('div');
    protocol.hidden = true;
    const error = make('p', 'cmp-col-error');
    error.hidden = true;
    // Quiet buttons: there is one Keep per column, and the one filled button of this drawer is Compare.
    const keep = MuseUI.button('ghost small', 'Keep this reply');
    keep.addEventListener('click', () => keepReply(seat));
    // A failed column can be asked again on its own: the same message, effort and pictures, the same chat. The other columns stay as they are.
    const retry = MuseUI.button('ghost small', 'Retry this column');
    retry.title = 'Asks this model again with the same message. It is billed again; the other columns are not asked.';
    retry.addEventListener('click', () => retryColumn(seat));
    // The buttons that fit the failure's kind (Open Accounts, Sign in, Pick another model, Open the log), as under a failed reply in
    // the chat (failControls), before Retry; and the sentence a press of one says.
    const fail = make('span', 'cmp-col-fail');
    fail.hidden = true;
    const say = make('p', 'cmp-col-say');
    say.hidden = true;
    const foot = make('div', 'cmp-col-foot');
    foot.append(keep, fail, retry);
    root.append(head, text, protocol, error, foot, say);
    return { seat, root, pill, text, protocol, error, keep, retry, fail, say, failKey: '' };
  }

  // The buttons of a failed column, by the failure's kind: the same table as under a failed reply in the chat (MuseUI.failedReply,
  // public/ext-turns.js; the server sends the kind with the failed column). Each only opens a place or says where one is: nothing is
  // signed in, no model is changed and no column is asked again from here. Retry this column stays the way to ask again.
  function failControls(seat) {
    return MuseUI.failedReply?.controls?.({
      words: seat.error,
      kind: seat.kind,
      model: seat.ref,
      again: 'come back to Quick compare and press Retry this column',
      say: (text, bad) => {
        seat.said = { text, bad };
        paint();
      },
      pick: () => {
        const box = view?.checks.get(seat.ref);
        if (!box?.isConnected) return { ok: false, text: 'The model is chosen in the Models list at the top of Quick compare. Tick another one there, then press Compare.' };
        box.scrollIntoView({ block: 'center' });
        box.focus({ preventScroll: true });
        return { ok: true, text: 'The Models list has the focus at this model. Untick it, tick another one, then press Compare. Every column is asked again, and billed again.' };
      },
    }) ?? [];
  }

  function updateColumn(col, current) {
    const { seat } = col;
    col.pill.textContent = STATUS_TEXT[seat.status];
    col.pill.className = seat.status === 'done' ? 'pill ok' : seat.status === 'failed' ? 'pill bad' : 'pill';
    // The reply follows its newest words, unless the reader has scrolled up to read earlier ones.
    const near = col.text.scrollHeight - col.text.scrollTop - col.text.clientHeight < 40;
    const streaming = seat.status === 'writing';
    if (seat.text !== col.lastText || streaming !== col.wasStreaming) {
      const visible = PlenumAssistantContent.clean(seat.text, { streaming });
      if (col.text.textContent !== visible.text) col.text.textContent = visible.text;
      const details = PlenumAssistantContent.details(visible.hidden);
      col.protocol.replaceChildren(...(details ? [details] : []));
      col.protocol.hidden = !details;
      col.lastText = seat.text;
      col.wasStreaming = streaming;
    }
    col.text.dataset.empty = seat.status === 'waiting' ? 'Waiting for the first words…' : '';
    if (near) col.text.scrollTop = col.text.scrollHeight;
    col.error.hidden = !seat.error;
    col.error.textContent = seat.error;
    col.keep.disabled = seat.status !== 'done' || current.active || current.kept;
    // A failed column has nothing to keep: it offers Retry instead.
    col.keep.hidden = seat.status === 'failed' && !current.active;
    col.retry.hidden = seat.status !== 'failed' || current.active || current.kept;
    // The failure's own buttons stand where Retry stands, and are built once per failure.
    const failed = !col.retry.hidden;
    const key = failed ? `${seat.kind ?? ''}|${seat.error}` : '';
    if (key !== col.failKey) {
      col.failKey = key;
      col.fail.replaceChildren(...(failed ? failControls(seat) : []));
    }
    col.fail.hidden = !failed || !col.fail.children.length;
    const said = failed ? seat.said : null;
    col.say.hidden = !said;
    col.say.textContent = said ? said.text : '';
    col.say.className = said?.bad ? 'cmp-col-say bad' : 'cmp-col-say';
  }

  // ---------- running a compare ----------

  // The thread of a run, as ext-pipelines.js sends it: nothing when the page had no thread yet.
  const threadPart = r => (r.thread ? { thread: r.thread } : {});

  async function startRun() {
    if (run?.active) return;
    const project = MuseUI.state.activeProject;
    const prompt = draft.trim();
    flash = null;
    if (!project) flash = { text: 'Add a project folder first.', bad: true };
    else if (!prompt) flash = { text: 'Write a prompt first.', bad: true };
    else if (chosen.length < MIN_SEATS) flash = { text: `Pick at least ${MIN_SEATS} models.`, bad: true };
    if (flash) return paint();

    // The pictures go with the prompt when the box is checked. Only their names and sizes are kept for the chat (Keep).
    const pictures = withImages !== false ? composerPictures() : [];
    const current = {
      project,
      // The thread on screen when the compare starts (Main's is the project's id). Keep writes to this one, whichever thread is on screen later.
      thread: MuseUI.state.activeThread || null,
      prompt,
      seats: chosen.map((ref, i) => ({ id: SEAT_IDS[i], ref, label: labelFor(ref), status: 'waiting', text: '', error: '' })),
      images: pictures.map(({ name, size }) => ({ name, size })),
      // What was sent, kept so one failed column can be asked again with exactly the same request.
      sent: { seats: [...chosen], effort, pictures: pictures.map(({ name, mime, data }) => ({ name, mime, data })) },
      active: true,
      kept: false,
      error: '',
    };
    run = current;
    return execute(current, null);
  }

  // Sends the request of `current` and folds the stream into its columns. With `only` (a column's letter) just that column is asked again.
  async function execute(current, only) {
    const { project, prompt, sent } = current;
    userStopped = false;
    controller = new AbortController();
    paint();
    try {
      const res = await MuseUI.request('/api/compare', {
        method: 'POST',
        body: {
          project,
          ...threadPart(current),
          prompt,
          seats: sent.seats,
          effort: sent.effort,
          ...(sent.pictures.length ? { images: sent.pictures } : {}),
          ...(only ? { only } : {}),
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw refusal(res.status, data);
      }
      // The run's id is claimed from its first event, so the events channel does not draw this compare as one started in
      // another window.
      await readSSE(res, ev => {
        MuseUI.claimRun?.(ev.runId);
        onEvent(current, ev);
      });
    } catch (err) {
      if (err.name !== 'AbortError') current.error = plain(err);
    } finally {
      controller = null;
      current.active = false;
      // A seat that never finished is stopped when the user stopped the run, and failed otherwise.
      for (const s of current.seats) {
        if (only && s.id !== only) continue;
        if (s.status === 'done' || s.status === 'failed' || s.status === 'stopped') continue;
        s.status = userStopped ? 'stopped' : 'failed';
        s.error = userStopped ? '' : (current.error || 'The connection ended before this reply finished.');
      }
      paint();
    }
  }

  // Asks one failed column again. The column starts empty and the others keep their replies; the run counts as running until it ends.
  function retryColumn(seat) {
    const current = run;
    if (!current || current.active || current.kept || seat.status !== 'failed' || !current.seats.includes(seat)) return;
    flash = null;
    current.error = '';
    seat.status = 'waiting';
    seat.text = '';
    seat.error = '';
    seat.kind = '';
    seat.said = null;
    current.active = true;
    return execute(current, seat.id);
  }

  function stopRun() {
    if (!controller) return;
    userStopped = true;
    controller.abort();
  }

  // Folds one server event into the run: a delta extends its seat's text, and a done event ends that seat.
  function onEvent(current, ev) {
    const seat = current.seats.find(s => s.id === ev.seat);
    if (ev.type === 'delta' && seat) {
      seat.status = 'writing';
      seat.text += ev.text;
    } else if (ev.type === 'done' && seat) {
      seat.text = typeof ev.text === 'string' ? ev.text : seat.text;
      if (ev.ok) {
        seat.status = 'done';
        seat.error = '';
      } else if (ev.error === 'Stopped.') {
        seat.status = 'stopped';
        seat.error = '';
      } else {
        seat.status = 'failed';
        seat.error = ev.error || 'No reply came back.';
        // The failure's kind, when the server knows it: it picks the buttons under the column (failControls).
        seat.kind = typeof ev.kind === 'string' ? ev.kind : '';
        seat.said = null;
      }
    } else if (ev.type === 'error') {
      current.error = ev.message || 'The run failed.';
    }
    schedule();
  }

  // Reads a server-sent stream and hands each JSON event to handle. The framing is the same one app.js reads.
  async function readSSE(res, handle) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (!data) continue;
        // A line that is not JSON is skipped: one bad line does not end the compare with the engine's words.
        let ev = null;
        try { ev = JSON.parse(data); } catch { ev = null; }
        if (ev) handle(ev);
      }
    }
  }

  // ---------- keeping a reply ----------

  // Keep writes the prompt and the chosen reply into the chat, then closes the drawer so the chat shows them.
  async function keepReply(seat) {
    const current = run;
    if (!current || current.active || current.kept || seat.status !== 'done' || !current.seats.includes(seat)) return;
    if (current.project !== MuseUI.state.activeProject || (current.thread || null) !== (MuseUI.state.activeThread || null)) {
      flash = { text: 'Switch back to the project and thread this compare ran in, then keep the reply.', bad: true };
      return paint();
    }
    current.kept = true;
    flash = null;
    paint();
    try {
      await MuseUI.api('/api/compare/keep', { project: current.project, ...threadPart(current), prompt: current.prompt, seat: seat.ref, text: seat.text, images: current.images ?? [] });
      MuseUI.toast(`Kept the ${seat.label} reply. It is in the chat.`);
      run = null;
      draft = '';
      MuseUI.closeDrawer();
      MuseUI.refresh();
    } catch (err) {
      current.kept = false;
      flash = { text: plain(err), bad: true };
      paint();
    }
  }

  MuseUI.events.on('catalog', () => {
    if (!view?.groups.isConnected || MuseUI.el.drawer.hidden) return;
    const focusedRef = [...view.checks].find(([, box]) => box === document.activeElement)?.[0];
    drawModels();
    paint();
    if (focusedRef) view.checks.get(focusedRef)?.focus({ preventScroll: true });
  });

  // Attach. The entry is added once, above Accounts, when the panel script loads.
  if (!document.getElementById('compareBtn')) MuseUI.el.accountsBtn.before(sideButton());
})();
