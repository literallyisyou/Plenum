// ext-accounts-api. Owned by its panel builder. Builds on window.MuseUI (see app.js).
// The model-provider key panel, a section of Settings > Accounts (MuseUI.settings.register, scope 'app', group 'accounts'). A key goes
// to the server in one request, which tests it and then saves it. This file keeps no copy of a key: the input is cleared after a
// save, and the panel shows only a provider's status and the server's plain messages. When the provider's check could not run (no
// internet, a limit, a busy provider), the server does not save the key and says so; the key stays in the box and Save anyway sends it
// again with force, which saves it as "not checked yet" until a Test passes.
(function () {
  const plain = (err, fallback) => (window.MuseUI?.plainError ? MuseUI.plainError(err, fallback) : (typeof err?.message === 'string' && err.message && !/^(The )?[Rr]equest failed \(\d+\)\.?$/.test(err.message) && !/Failed to fetch|NetworkError|undefined/.test(err.message) ? err.message : fallback));
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const SECTION = 'ext-apikeys';
  // The Settings section: its id, its title and where it sorts. The Accounts section is order 10 and the tool test is order 30
  // (UI-ARCH section 5: coding agents, API keys, OpenRouter, tools for API models), so the keys come right after Accounts.
  const SECTION_ID = 'api-keys';
  const SECTION_TITLE = 'API keys';
  const SECTION_ORDER = 20;
  const TITLE = 'Model providers (per token)';
  const LOADING = 'Checking the provider keys…';
  // The badge letter for each provider. A provider this table does not name gets the first letter of its label.
  const MARKS = { xai: 'X', openai: 'O', deepseek: 'D', mistral: 'M', googleai: 'G', openrouter: 'R' };

  // Only https addresses become links, so a key page from the server cannot point the panel anywhere else.
  function isHttps(url) {
    return typeof url === 'string' && /^https:\/\//.test(url);
  }

  // The server does not echo a key, but a message goes on screen, so the key is removed from it as well.
  function scrub(text, key) {
    const msg = String(text ?? '');
    return key ? msg.split(key).join('') : msg;
  }

  function make2(tag, cls) {
    const node = document.createElement(tag);
    node.className = cls;
    return node;
  }

  function statusLine(text) {
    const p = MuseUI.para(text);
    p.className = 'ext-apikeys-status';
    return p;
  }

  // The section is a heading, the route choices and a list. Its own updates stay inside it. The API finder's quiet link goes at the
  // end when that panel has loaded (MuseUI.apiFinderEntry). The panels load one after another, so it is asked for when the section
  // is drawn, which is when Settings opens.
  function buildSection() {
    const section = document.createElement('section');
    section.className = SECTION;
    section.setAttribute('aria-label', TITLE);
    const heading = document.createElement('h3');
    heading.className = 'ext-apikeys-title';
    heading.textContent = TITLE;
    const routes = document.createElement('div');
    routes.className = 'ext-apikeys-routes';
    const list = document.createElement('div');
    list.className = 'ext-apikeys-list';
    section.append(heading, routes, list);
    const finder = typeof MuseUI.apiFinderEntry === 'function' ? MuseUI.apiFinderEntry() : null;
    if (finder) section.append(finder);
    // The per-token billing strip sits above the key rows (LEGAL api-keys-spend). It informs and never blocks a key.
    MuseUI.notice?.('api-keys-spend', { before: list });
    const panel = { list, routes, cards: new Map(), ui: null, routeSeq: 0 };
    list.append(statusLine(LOADING));
    livePanels.add(panel);
    loadKeys(panel);
    return section;
  }

  async function loadKeys(panel) {
    let data;
    try {
      data = await MuseUI.api('/api/keys');
    } catch (err) {
      return showError(panel, plain(err, 'The provider keys could not be read. Try again.'));
    }
    if (!Array.isArray(data?.providers)) return showError(panel, 'The provider list did not come back. Try again.');
    if (data.routes) paintRoutes(panel, data.routes);
    panel.cards.clear();
    if (data.providers.length === 0) {
      panel.list.replaceChildren(statusLine('No model providers are listed.'));
      return;
    }
    panel.list.replaceChildren(...data.providers.map(p => {
      const card = providerCard(p, panel);
      panel.cards.set(p.id, card);
      return card.root;
    }));
  }

  function showError(panel, message) {
    const box = document.createElement('div');
    box.className = 'ext-apikeys-error';
    box.append(statusLine(message));
    const again = MuseUI.button('ghost small', 'Try again');
    again.addEventListener('click', () => {
      panel.list.replaceChildren(statusLine(LOADING));
      loadKeys(panel);
    });
    box.append(again);
    panel.list.replaceChildren(box);
  }

  // Reads every provider's status again and updates the cards in place. Typed text and messages stay as they are.
  async function refreshStatus(panel) {
    try {
      const data = await MuseUI.api('/api/keys');
      for (const p of data?.providers ?? []) panel.cards.get(p.id)?.apply(p);
      if (data?.routes) paintRoutes(panel, data.routes);
      panel.misses = 0;
      if (panel.retry && typeof clearTimeout === 'function') clearTimeout(panel.retry);
      return true;
    } catch {
      // The cards keep their last status, which says how old it is. While the panel is open and the page is seen, Plenum asks again by itself,
      // a little later each time.
      retryLater(panel);
      return false;
    }
  }

  // After a read that failed: again in 5 s, 15 s, 45 s, then every 2 minutes. Only while this panel is on the page and the page is visible;
  // coming back to the page reads at once (see below).
  const RETRY_MS = [5000, 15000, 45000, 120000];
  function retryLater(panel) {
    if (typeof setTimeout !== 'function') return;
    clearTimeout(panel.retry);
    panel.misses = (panel.misses ?? 0) + 1;
    const wait = RETRY_MS[Math.min(panel.misses, RETRY_MS.length) - 1];
    panel.retry = setTimeout(() => {
      if (!panel.list.isConnected) return;
      if (document.visibilityState === 'hidden') return;
      refreshStatus(panel);
    }, wait);
  }

  // 'Checked 12 min ago': shown only when a card's reading is older than 5 minutes.
  const STALE_MS = 5 * 60 * 1000;
  function ageText(at, now) {
    const gone = now - at;
    if (gone < STALE_MS) return '';
    const min = Math.round(gone / 60000);
    return min < 60 ? `Checked ${min} min ago` : `Checked ${Math.floor(min / 60)} h ago`;
  }
  const livePanels = new Set();
  function tickAges() {
    for (const panel of [...livePanels]) {
      if (!panel.list.isConnected) {
        livePanels.delete(panel);
        continue;
      }
      for (const card of panel.cards.values()) card.age?.();
    }
  }
  if (typeof setInterval === 'function') setInterval(tickAges, 30000);
  document.addEventListener?.('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    for (const panel of [...livePanels]) {
      if (!panel.list.isConnected) continue;
      const old = [...panel.cards.values()].some(c => c.checkedAt && Date.now() - c.checkedAt() >= STALE_MS);
      if (old || panel.misses) refreshStatus(panel);
    }
  });

  // A plain link to the provider's key page. It has target _blank because desktop/main.cjs cancels any
  // navigation away from the app, so a link without it would do nothing in the desktop window. The
  // main process hands such a link to the browser.
  function keyPageLink(p) {
    if (!isHttps(p.keyUrl)) return null;
    const a = document.createElement('a');
    a.className = 'ext-apikeys-link';
    a.href = p.keyUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = `Open the ${p.label} key page`;
    return a;
  }

  // ---------- route choices ----------
  // Each coding agent runs on its plan sign-in or on an API key, and the person picks which (lib/proc.mjs keyRoutesFrom). The
  // server keeps the choice and the answer says what a run does now. The wording is LEGAL's: GEMINI_DESC is the notice text of
  // amend-26, and the links go to the providers' own pages, which open in a new window.
  const ROUTES_INTRO = 'Each coding agent runs on either its plan sign-in or an API key. Your choice is saved as soon as you make it.';
  const CLAUDE_DESC = 'Your Claude subscription and an Anthropic API key bill differently. Plenum never sends a subscription token to the Anthropic API.';
  const CLAUDE_CHOICES = [['cli', 'Claude Code with my subscription'], ['api', 'Anthropic API key']];
  const CLAUDE_TERMS = { label: "Anthropic's rule for Claude Code", url: 'https://code.claude.com/docs/en/legal-and-compliance' };
  const GEMINI_LABEL = 'Use my Google AI key with Gemini CLI';
  const GEMINI_DESC = "Google's terms allow Gemini CLI through an API key but restrict its account sign-in from other apps. Plenum uses your Google AI key for Gemini unless you switch this off; those requests are billed per token.";
  const GEMINI_TERMS = { label: "Google's Gemini CLI terms", url: 'https://www.geminicli.com/docs/resources/tos-privacy' };
  // Each Gemini CLI model can have a route of its own, which wins over the switch for that model (lib/proc.mjs keyRoutesFrom,
  // geminiModels). 'auto' is no choice of its own: the model follows the switch.
  const GEMINI_MODELS_INTRO = 'Each Gemini model can also use a route of its own: your Google AI key, billed per token, or your Gemini subscription through the Google sign-in. A model\'s own choice wins over the switch above.';
  const GEMINI_MODEL_CHOICES = [['auto', 'Same as the switch'], ['key', 'Google AI key (per token)'], ['sign-in', 'Gemini subscription (Google sign-in)']];
  const CODEX_LABEL = 'Use my OpenAI API key with Codex';
  const CODEX_DESC = 'Codex normally uses your ChatGPT sign-in. Turn this on to bill your OpenAI API key per token instead.';
  const CODEX_TERMS = { label: "ChatGPT's Terms of Use", url: 'https://openai.com/policies/terms-of-use/' };

  // A switch with its label and a plain line under it (the same switch row the rest of the app uses).
  function routeSwitch(label, desc, onChange) {
    const row = document.createElement('label');
    row.className = 'switch-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => onChange(input.checked));
    const track = document.createElement('span');
    track.className = 'switch-track';
    track.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.append(label);
    const small = document.createElement('small');
    small.textContent = desc;
    text.append(small);
    row.append(input, track, text);
    return { row, input };
  }

  // A link to a provider's own page. Only https addresses become links.
  function routeLink({ label, url }) {
    const a = document.createElement('a');
    a.className = 'ext-apikeys-link';
    a.textContent = label;
    if (isHttps(url)) {
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    return a;
  }

  // One Gemini model's route: its name, a menu of the three choices, and a line that says what its run does now. The menu saves
  // on change (one request, as the switches do).
  function geminiModelRow(panel, model) {
    const row = document.createElement('div');
    row.className = 'field ext-apikeys-model';
    row.dataset.model = model.id;
    const select = document.createElement('select');
    const selectId = `ext-apikeys-gm-${String(model.id).replace(/[^A-Za-z0-9_-]/g, '_')}`;
    select.id = selectId;
    const name = document.createElement('label');
    name.className = 'field-label';
    name.htmlFor = selectId;
    name.textContent = model.label ?? model.id;
    for (const [value, text] of GEMINI_MODEL_CHOICES) select.append(new Option(text, value));
    select.addEventListener('change', () => saveRoute(panel, { geminiModel: { id: model.id, route: select.value } }));
    const note = document.createElement('p');
    note.className = 'field-note';
    row.append(name, select, note);
    return { id: model.id, row, select, note };
  }

  // What one model's run does now, in words. choice is its own route or null; route is what the server says its run takes.
  function geminiModelNote(m) {
    if (m.route === 'key') return m.choice ? 'Runs on your Google AI key, billed per token.' : 'Follows the switch: runs on your Google AI key, billed per token.';
    if (m.choice === 'sign-in') return 'Runs on your Gemini subscription through the Google sign-in.';
    if (m.choice === 'key') return 'No Google AI key is saved, so this model signs in with Google until you save one.';
    return 'Follows the switch: runs on the Google sign-in.';
  }

  // The per-model list under the Gemini switch. It is built again only when the server lists other models.
  function paintGeminiModels(panel, models) {
    const ui = panel.ui;
    const list = Array.isArray(models) ? models : [];
    const same = ui.geminiModels.rows.length === list.length && ui.geminiModels.rows.every((r, i) => r.id === list[i].id);
    if (!same) {
      const old = new Set(ui.geminiModels.rows.map(r => r.select));
      ui.controls = ui.controls.filter(c => !old.has(c));
      ui.geminiModels.rows = list.map(m => geminiModelRow(panel, m));
      ui.controls.push(...ui.geminiModels.rows.map(r => r.select));
      ui.geminiModels.list.replaceChildren(...ui.geminiModels.rows.map(r => r.row));
      ui.geminiModels.box.hidden = list.length === 0;
    }
    list.forEach((m, i) => {
      const r = ui.geminiModels.rows[i];
      r.select.value = m.choice === 'key' || m.choice === 'sign-in' ? m.choice : 'auto';
      r.note.textContent = geminiModelNote(m);
    });
  }

  // The three choices are built once and painted from the server's answer, so a change keeps the focus where it was.
  function buildRoutes(panel) {
    const controls = [];
    const gemini = routeSwitch(GEMINI_LABEL, GEMINI_DESC, on => saveRoute(panel, { gemini: on }));
    const geminiStatusLine = statusLine('');
    controls.push(gemini.input);
    const modelsBox = document.createElement('div');
    modelsBox.className = 'ext-apikeys-models';
    const modelsList = document.createElement('div');
    modelsList.className = 'ext-apikeys-models-list';
    modelsBox.append(statusLine(GEMINI_MODELS_INTRO), modelsList);
    modelsBox.hidden = true;

    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Claude route');
    const buttons = new Map();
    for (const [value, label] of CLAUDE_CHOICES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn';
      b.textContent = label;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => saveRoute(panel, { claude: value }));
      buttons.set(value, b);
      controls.push(b);
      seg.append(b);
    }
    const claudeStatusLine = statusLine('');

    const codex = routeSwitch(CODEX_LABEL, CODEX_DESC, on => saveRoute(panel, { codex: on }));
    const codexStatusLine = statusLine('');
    controls.push(codex.input);

    const claudeBlock = document.createElement('div');
    claudeBlock.className = 'ext-apikeys-route';
    claudeBlock.append(statusLine(CLAUDE_DESC), seg, claudeStatusLine, routeLink(CLAUDE_TERMS));
    const geminiBlock = document.createElement('div');
    geminiBlock.className = 'ext-apikeys-route';
    geminiBlock.append(gemini.row, geminiStatusLine, modelsBox, routeLink(GEMINI_TERMS));
    const codexBlock = document.createElement('div');
    codexBlock.className = 'ext-apikeys-route';
    codexBlock.append(codex.row, codexStatusLine, routeLink(CODEX_TERMS));
    controls.push(...buttons.values());
    panel.routes.replaceChildren(statusLine(ROUTES_INTRO), claudeBlock, geminiBlock, codexBlock);
    return {
      controls,
      gemini: { input: gemini.input, status: geminiStatusLine },
      geminiModels: { box: modelsBox, list: modelsList, rows: [] },
      codex: { input: codex.input, status: codexStatusLine },
      claude: { buttons, status: claudeStatusLine },
    };
  }

  // Shows the server's route status. What a run does now is said in words, with the Claude choice and the switches as they are.
  function paintRoutes(panel, routes) {
    // The routes as last drawn from the server, so a change that was not saved can be put back (saveRoute).
    panel.savedRoutes = routes;
    if (!panel.ui) panel.ui = buildRoutes(panel);
    const ui = panel.ui;
    const g = routes.gemini ?? {};
    ui.gemini.input.checked = g.on === true;
    // route is what a run does now. keyBlocked: the key is on and saved, but the Gemini CLI is set to its own sign-in, so it is not used.
    ui.gemini.status.textContent = g.route === 'key'
      ? 'Gemini uses your Google AI key. Those requests are billed per token.'
      : g.keyBlocked
        ? 'Gemini CLI is set to its Google sign-in, so your Google AI key is not used. Run gemini, type /auth and pick "Gemini API key" so your key is used.'
        : !g.on
          ? 'Gemini uses its Google sign-in.'
          : 'The switch is on, but no Google AI key is saved, so Gemini uses its Google sign-in for now. A saved key will be used instead.';
    paintGeminiModels(panel, g.models);
    const c = routes.claude ?? {};
    for (const [value, button] of ui.claude.buttons) button.setAttribute('aria-pressed', String(c.route === value));
    const automatic = c.choice === null || c.choice === undefined ? ' Chosen automatically. Pick one to keep it.' : '';
    ui.claude.status.textContent = c.route === 'api' && c.saved === false
      ? `No Anthropic API key is saved, so Claude cannot run through it yet. ${c.cli?.installed === false ? 'Add a key, or install Claude Code and choose the subscription.' : 'Add a key, or choose the Claude Code subscription.'}${automatic}`
      : c.route === 'api'
      ? `Claude runs through your Anthropic API key, billed per token.${automatic}`
      : c.cli?.installed === false
        ? `Claude Code is not installed, so Claude cannot run through your subscription yet. Install Claude Code, or choose the Anthropic API key.${automatic}`
        : `Claude runs through Claude Code with your Claude subscription.${automatic}`;
    const x = routes.codex ?? {};
    ui.codex.input.checked = x.on === true;
    ui.codex.status.textContent = !x.on
      ? 'Codex uses its ChatGPT sign-in.'
      : x.saved
        ? 'Codex uses your OpenAI API key, billed per token.'
        : 'The switch is on, but no OpenAI API key is saved, so Codex uses its ChatGPT sign-in for now. A saved key will be used instead.';
  }

  // One change is one request. The controls wait for the answer, and only the answer to the latest change is shown. A refused
  // change is reported, and the saved state is read again so the controls show what the server has.
  async function saveRoute(panel, patch) {
    const seq = ++panel.routeSeq;
    setRoutesBusy(panel, true);
    try {
      const data = await MuseUI.api('/api/key-routes', patch);
      if (seq === panel.routeSeq && data?.routes) paintRoutes(panel, data.routes);
    } catch (err) {
      MuseUI.toast(plain(err, 'The change was not saved. Try again.'), 'bad');
      // When the saved state cannot be read either, the controls go back to what was last read, so a switch never shows a change
      // that was not saved. The later retry confirms it.
      const read = await refreshStatus(panel);
      if (!read && seq === panel.routeSeq && panel.savedRoutes) paintRoutes(panel, panel.savedRoutes);
    } finally {
      if (seq === panel.routeSeq) setRoutesBusy(panel, false);
    }
  }

  function setRoutesBusy(panel, busy) {
    if (!panel.ui) return;
    for (const control of panel.ui.controls) control.disabled = busy;
  }

  // One provider: its status pill, a password input, Save and Test buttons, and the key page link.
  function providerCard(p, panel) {
    const mark = MARKS[p.id] ?? String(p.label ?? p.id).charAt(0).toUpperCase();
    const sub = p.envVar ? `API key · ${p.envVar}` : 'API key';
    const card = MuseUI.cardShell(mark, p.id, p.label, sub, 'Not set', false);
    const pill = card.querySelector('.pill');
    card.append(MuseUI.para(`Billed per token by ${p.label}. Separate from your subscriptions; Plenum never sends this key to any other provider.`));

    const input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = `Paste your ${p.label} key`;
    input.setAttribute('aria-label', `${p.label} API key`);

    const result = document.createElement('div');
    result.className = 'result';
    result.setAttribute('role', 'status');
    // tone is 'ok', 'bad' or '' for a neutral line while work is running.
    const show = (text, tone) => {
      result.textContent = text;
      result.className = tone ? `result ${tone}` : 'result';
    };

    const save = MuseUI.button('primary small', 'Save key');
    // Shown only after a save the provider's check could not settle. It sends the key still in the box once more, with force.
    const anyway = MuseUI.button('ghost small', 'Save anyway');
    anyway.hidden = true;
    // Takes Save anyway away. A hidden button cannot hold the focus, so the focus goes to the key box first and the keyboard stays in the card.
    const hideAnyway = () => {
      if (document.activeElement === anyway) input.focus();
      anyway.hidden = true;
    };
    const test = MuseUI.button('ghost small', 'Test saved key');
    const remove = MuseUI.button('ghost small', 'Remove key');
    let configured = false;
    let notChecked = false;
    let busy = false;
    const paint = () => {
      save.disabled = busy;
      anyway.disabled = busy;
      // Testing and removing need a saved key, so those buttons wait until one exists.
      test.disabled = busy || !configured;
      remove.disabled = busy || !configured;
    };
    // When the server last told this card its state. The line shows only when that is more than 5 minutes ago.
    let checkedAt = Date.now();
    const age = make2('p', 'ext-apikeys-age');
    age.hidden = true;
    const paintAge = () => {
      age.textContent = ageText(checkedAt, Date.now());
      age.hidden = !age.textContent;
    };
    const apply = status => {
      checkedAt = Date.now();
      paintAge();
      configured = Boolean(status.configured);
      // A key kept without the provider's check says so until a Test passes (the server sends checked: false for it).
      notChecked = configured && status.checked === false;
      pill.textContent = configured ? `Saved from ${status.source || 'this computer'}${notChecked ? ', not checked yet' : ''}` : 'Not set';
      pill.className = configured && !notChecked ? 'pill ok' : 'pill';
      paint();
    };

    // Sends the key in the box. force is true only from Save anyway. A key the provider's check could not settle is not saved; the box
    // keeps it and Save anyway is offered, so the person decides without pasting it again.
    const send = async force => {
      const key = input.value.trim();
      if (!key) return show('Paste a key first.', 'bad');
      busy = true;
      hideAnyway();
      paint();
      show(force ? 'Saving the key…' : 'Checking the key…', '');
      try {
        const r = await MuseUI.api('/api/keys', force ? { provider: p.id, key, force: true } : { provider: p.id, key });
        if (r.canSaveAnyway) {
          // The box can be edited while the check runs. The answer is about the text that was sent, so Save anyway is offered only
          // while the box still holds that text; otherwise the person checks the new text with Save key.
          if (input.value.trim() !== key) {
            show('The key in the box changed while it was being checked. Press Save key to check it.', '');
            return;
          }
          // The reason alone (the message also points to Accounts, which is where this button is), then what the button does.
          show(`${scrub(r.reason || r.message, key)} Save anyway keeps this key without the check.`, '');
          anyway.hidden = false;
          return;
        }
        const text = scrub(r.message || (r.saved ? 'Saved.' : 'The key was not saved.'), key);
        show(text, r.saved ? 'ok' : 'bad');
        if (r.saved) {
          // The key is in the server now. Clearing the box means it is no longer on this screen.
          input.value = '';
          MuseUI.toast(`${p.label} key saved`);
          await refreshStatus(panel);
        }
      } catch (err) {
        show(scrub(err.message, key), 'bad');
      } finally {
        busy = false;
        paint();
      }
    };
    save.addEventListener('click', () => send(false));
    anyway.addEventListener('click', () => send(true));
    // Changing the key makes the last answer about the old text, so Save anyway goes away until the new text is checked.
    input.addEventListener('input', hideAnyway);
    // Enter in the box saves, the same as the button. A disabled button ignores the click.
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') save.click();
    });

    test.addEventListener('click', async () => {
      busy = true;
      paint();
      show('Checking the saved key…', '');
      try {
        const r = await MuseUI.api('/api/keys/test', { provider: p.id });
        // A check that could not run (verdict 'unchecked') is not a refusal: the key may be fine, so it is not shown in the failure style.
        const unsettled = !r.ok && r.verdict === 'unchecked';
        const said = r.message || (r.ok ? 'The saved key works.' : 'The saved key did not work.');
        show(unsettled ? `Could not be confirmed. ${said}` : said, r.ok ? 'ok' : unsettled ? '' : 'bad');
        // A passed check clears "not checked yet" on the card.
        if (r.ok && notChecked) await refreshStatus(panel);
      } catch (err) {
        show(err.message, 'bad');
      } finally {
        busy = false;
        paint();
      }
    });

    // Removing deletes the key from the saved keys, so it asks first. The card then shows what the server holds, which is the
    // answer that counts: a key that is still there (the desktop app did not confirm) keeps its status.
    remove.addEventListener('click', async () => {
      const sure = await MuseUI.confirm({ title: `Remove the ${p.label} key?`, body: 'Plenum deletes this key from the saved keys and stops using it. To use this provider again, paste the key again.', action: 'Remove', tone: 'danger', focusCancel: true });
      if (!sure) return;
      busy = true;
      paint();
      show('Removing the key…', '');
      try {
        const r = await MuseUI.api('/api/keys/remove', { provider: p.id });
        show(r.message || (r.ok ? 'The key was removed.' : 'The key was not removed.'), r.ok ? 'ok' : 'bad');
        if (r.ok) MuseUI.toast(`${p.label} key removed`);
        await refreshStatus(panel);
      } catch (err) {
        show(err.message, 'bad');
      } finally {
        busy = false;
        paint();
      }
    });

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(save, anyway, test, remove);
    const link = keyPageLink(p);
    if (link) actions.append(link);
    card.append(input, actions, result, age);

    apply(p);
    return { root: card, apply, age: paintAge, checkedAt: () => checkedAt };
  }

  // Attach. Settings draws every section each time the page opens, so this one is drawn fresh from the server's saved state and
  // nothing is watched. A page without the Settings registry has nowhere to show the panel.
  if (typeof MuseUI.settings?.register === 'function') {
    MuseUI.settings.register({ id: SECTION_ID, scope: 'app', title: SECTION_TITLE, group: 'accounts', order: SECTION_ORDER, render: body => body.append(buildSection()) });
  }
})();
