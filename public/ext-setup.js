// ext-setup. The first-run setup wizard. It opens in the drawer by itself the first time Plenum is used with no saved key and
// no project or account is set up. The connection step offers either a coding subscription or an API key.
// It uses only routes the Accounts panel already has (GET /api/keys, POST /api/keys, POST /api/keys/test, GET /api/accounts and
// the sign-in routes). POST /api/keys takes only the providers in lib/api-providers.mjs, so Anthropic's key goes through the
// Claude key routes. A key is typed into a password box, sent once and cleared; the wizard keeps no copy of it. Text is set
// with textContent only.
// A row whose CLI is missing shows how to install it (MuseUI.cliInstallBlock), and after Sign in the wizard reads the sign-ins
// by itself until the sign-in shows (MuseUI.watchSignIn). Both helpers are in ext-accounts-cli.js and are looked up when they
// are used, so the wizard still works, with its older plain sentences, when that panel did not load.
// Each of the three status requests paints its own part as it returns (merge, rowReady, keyReady). The last step names the model that will
// answer (MuseUI.answering, in ext-model-info.js) and, when the chosen model cannot, offers Use <name> as a press; it never switches by itself.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const TITLE = 'Set up Plenum';
  // Written when the wizard is finished or closed, so it stays away on later visits. Skip for now does not write it.
  const DISMISSED = 'plenum-setup-dismissed';
  // The id of the Setup entry in the side menu.
  const BUTTON_ID = 'setupBtn';
  const WELCOME = 1;
  const SIGN_INS = 2;
  const API_KEYS = 3;
  const DONE = 4;
  // Sign-in states. A CLI that is not installed cannot be signed in to, so its button stays off.
  const IN = 'in';
  const OUT = 'out';
  const NONE = 'none';
  // The CLI is installed, but its sign-in could not be read (Cursor's status command timed out or was not read).
  const UNKNOWN = 'unknown';
  const STATE_TEXT = { in: 'Signed in', out: 'Not signed in', none: 'Not installed', unknown: 'Sign-in unknown' };
  // Shown only when the install steps cannot be drawn (ext-accounts-cli.js did not load).
  const MISSING = 'Not installed. Install it, then press Check again.';
  // While a row waits for its sign-in, one read in this many milliseconds asks the server to look again (?refresh=1) instead of
  // answering from what it last saw. Only GET /api/accounts/cli keeps such an answer.
  const FORCE_EVERY_MS = 8000;
  // A status older than this is read again when the wizard is opened or drawn again.
  const STALE_MS = 10000;

  // Each label and variable name matches lib/api-providers.mjs (Anthropic: lib/keys.mjs).
  const KEYS = [
    { id: 'anthropic', label: 'Anthropic (Claude)', envVar: 'ANTHROPIC_API_KEY', mark: 'C' },
    { id: 'xai', label: 'xAI (Grok)', envVar: 'XAI_API_KEY', mark: 'X' },
    { id: 'openai', label: 'OpenAI API', envVar: 'OPENAI_API_KEY', mark: 'O' },
    { id: 'deepseek', label: 'DeepSeek', envVar: 'DEEPSEEK_API_KEY', mark: 'D' },
    { id: 'mistral', label: 'Mistral', envVar: 'MISTRAL_API_KEY', mark: 'M' },
    { id: 'googleai', label: 'Google AI (Gemini API)', envVar: 'GOOGLE_AI_API_KEY', mark: 'G' },
    { id: 'openrouter', label: 'OpenRouter', envVar: 'OPENROUTER_API_KEY', mark: 'R' },
  ];

  // Claude's key is in use only when Claude runs through the API, which is when the Claude CLI is not installed.
  const claudeUsesKey = a => a?.claude?.route === 'api';
  // A sign-in the server could not read is null: it shows as unknown, not as signed out (as Cursor's and Grok Build's do).
  const cliState = (c, signedInKey) => (!c?.installed ? NONE : c[signedInKey] === null ? UNKNOWN : c[signedInKey] ? IN : OUT);
  // Cursor's status comes from GET /api/accounts/cli (see withCli). It is null when that read failed, and its sign-in may be unknown.
  const cursorState = c => (!c ? UNKNOWN : !c.installed ? NONE : c.signedIn === true ? IN : c.signedIn === false ? OUT : UNKNOWN);
  // Grok Build reads the same way: its status comes from GET /api/accounts/cli as accounts.grok (lib/grok.mjs grokStatus).
  const grokState = g => (!g ? UNKNOWN : !g.installed ? NONE : g.signedIn === true ? IN : g.signedIn === false ? OUT : UNKNOWN);

  // Step 2, in order. Each row reads its state from GET /api/accounts (Cursor's from GET /api/accounts/cli) and signs in through its own route.
  const CLIS = [
    {
      id: 'claude', name: 'Claude Code', account: 'Claude account', mark: 'C', path: '/api/accounts/claude/login',
      // Claude runs through the Claude CLI only when the CLI is installed; otherwise it uses the Anthropic key from step 3.
      state: a => (a?.claude?.route === 'cli' ? (a.claude.connected === null ? UNKNOWN : a.claude.connected ? IN : OUT) : NONE),
      missing: 'Install Claude Code to use your Claude subscription, or connect an Anthropic API key for usage-based billing.',
    },
    { id: 'codex', name: 'Codex', account: 'ChatGPT account', mark: 'X', path: '/api/accounts/codex/login', state: a => cliState(a?.codex, 'loggedIn'), missing: MISSING },
    { id: 'gemini', name: 'Gemini CLI', account: 'Google account', mark: 'G', path: '/api/accounts/gemini/login', state: a => cliState(a?.gemini, 'signedIn'), missing: MISSING },
    { id: 'muse', name: 'Muse Code', account: 'Meta account', mark: 'M', path: '/api/accounts/muse/login', state: a => cliState(a?.muse, 'signedIn'), missing: MISSING },
    // side: the status comes from GET /api/accounts/cli, not GET /api/accounts (the sign-in watch reads only the route it needs).
    { id: 'cursor', name: 'Cursor', account: 'Cursor account', mark: 'U', path: '/api/accounts/cursor/login', state: a => cursorState(a?.cursor), missing: MISSING, side: true },
    { id: 'grok', name: 'Grok Build', account: 'xAI account', mark: 'K', path: '/api/accounts/grok/login', state: a => grokState(a?.grok), missing: MISSING, side: true },
    // Antigravity (DECISIONS item 89) reads like Grok Build: its status comes from GET /api/accounts/cli as accounts.antigravity.
    { id: 'antigravity', name: 'Antigravity', account: 'Google AI Pro, Ultra or Plus', mark: 'A', path: '/api/accounts/antigravity/login', state: a => grokState(a?.antigravity), missing: MISSING, side: true },
  ];

  // GET /api/accounts/cli: the coding agents added after the first four (Cursor and Grok Build). A failed read is null, and its row says it is unknown.
  // fresh asks the server to look again and wait for it, a few seconds at most (lib/routes/cli-accounts.mjs), instead of answering from what it last saw.
  const CLI_ROUTE = '/api/accounts/cli';
  const cliStatus = fresh => MuseUI.api(fresh ? `${CLI_ROUTE}?refresh=1` : CLI_ROUTE).catch(() => null);
  const isSide = id => CLIS.some(c => c.id === id && c.side === true);
  // The sign-ins the rows read: GET /api/accounts, with Cursor's and Grok Build's status from GET /api/accounts/cli added as accounts.cursor and accounts.grok.
  const withCli = (accounts, cli) => ({ ...accounts, cursor: cli?.cursor ?? null, grok: cli?.grok ?? null, antigravity: cli?.antigravity ?? null });

  // Puts the parts a read brought into status and works out accounts. A part that is not named stays as it was.
  function merge(parts) {
    status = { keys: null, main: null, cli: null, cliPending: true, accounts: null, ...status, ...parts };
    status.accounts = status.main ? withCli(status.main, status.cli) : null;
  }
  // Whether a row's part of the status is here: a CLI row needs the accounts (and the cli read for the three added later), a key row its list.
  const rowReady = (c, s) => Boolean(s?.accounts) && !(c.side && s.cliPending);
  const keyReady = (id, s) => Boolean(s?.keys) && (id !== 'anthropic' || Boolean(s.accounts));
  // Whether a key is saved for a provider: Anthropic's through the Claude route, the others through GET /api/keys.
  function keyConfigured(s, id) {
    if (id === 'anthropic') return claudeUsesKey(s.accounts) && s.accounts.claude.connected === true;
    return s.keys.providers.some(p => p.id === id && p.configured === true);
  }
  // Only https addresses become links, so a key page from the server cannot point the wizard anywhere else.
  const isHttps = url => typeof url === 'string' && /^https:\/\//.test(url);
  // The server does not echo a key, but a message goes on screen, so the key is removed from it as well.
  const scrub = (text, key) => (key ? String(text ?? '').split(key).join('') : String(text ?? ''));

  // ---------- remembering the dismissal ----------

  // Storage can be blocked, so every access is guarded. A blocked read means the wizard may open again, which is harmless.
  function dismissed() {
    try {
      return localStorage.getItem(DISMISSED) === '1';
    } catch {
      return false;
    }
  }

  function remember() {
    try {
      localStorage.setItem(DISMISSED, '1');
    } catch {
      // Blocked storage: the wizard may come back on a later visit. The page works the same without it.
    }
  }

  // Clears the dismissal. Only the Setup entry calls this, so a click on it opens the wizard even after a dismissal.
  function forget() {
    try {
      localStorage.removeItem(DISMISSED);
    } catch {
      // Blocked storage: the flag cannot be cleared, but the Setup click still opens the wizard for this visit.
    }
  }

  // ---------- state ----------

  // What the server last sent, kept in parts because each request paints as it returns: { keys, main, cli, accounts, cliPending }. keys is GET /api/keys,
  // main is GET /api/accounts, cli is GET /api/accounts/cli (null when that read failed), and accounts is main with cli put in (withCli), null until main
  // is here. cliPending is true until the first answer of the cli read, so Cursor, Grok Build and Antigravity say Checking and not Sign-in unknown.
  let status = null;
  let statusAt = 0;    // when status was last read in full
  let loadSeq = 0;     // the number of the latest read; an answer of an older read is dropped
  let loading = false; // whether a read is on its way
  // The sign-in watch. waiting holds the ids of the rows whose sign-in window was opened and whose sign-in has not shown yet;
  // gaveUp holds the ids whose three minutes ran out, until the next full read. Both are kept by id, so they survive a redraw.
  const waiting = new Set();
  const gaveUp = new Set();
  let watch = null;    // the running watch (MuseUI.watchSignIn), or null
  let forcedAt = 0;    // when the watch last asked the server to look again
  let ui = null;       // the wizard's elements from the last draw
  let step = WELCOME;
  let connectionStep = SIGN_INS;
  let selectedCli = 'codex';
  let selectedKey = 'openai';
  let current = false; // true while the wizard is the drawer's content

  function make(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // The heading of each step takes focus when its step opens, so a screen reader announces the step.
  function stepHeading(text) {
    const h = make('h3', 'setup-heading', text);
    h.tabIndex = -1;
    return h;
  }

  // ---------- the drawer ----------

  // Builds the wizard into the drawer. Each draw builds the elements again; the step and the status survive a redraw.
  function draw(body) {
    body.append(build());
    showStep(false);
    if (!status) return void loadStatus();
    paintAll();
    if (loading) return;
    // A wizard that is opened again later shows what was read before, then reads again, so an old sign-in state does not stay.
    if (Date.now() - statusAt > STALE_MS) loadStatus();
  }

  function build() {
    ui = { clis: [], keys: [], panes: [], heads: [] };
    const root = make('div', 'setup');
    ui.count = make('p', 'setup-count');
    ui.line = make('p', 'setup-status');
    ui.line.setAttribute('role', 'status');
    const parts = [welcomePane(), signInPane(), keyPane(), donePane()];
    ui.panes = parts.map(p => p.pane);
    ui.heads = parts.map(p => p.heading);
    root.append(ui.count, ...ui.panes, ui.line, navFooter());
    return root;
  }

  // Opens the wizard in the drawer, as the other panels open, so the drawer's close button, the scrim and Escape all close it.
  function openWizard(at = WELCOME) {
    current = true;
    step = at;
    MuseUI.openDrawer(TITLE, draw);
    showStep(true);
  }

  // Closes the wizard without remembering it, so it can come back on a later visit (Skip for now).
  function closeWizard() {
    current = false;
    MuseUI.closeDrawer();
  }

  function finishSetup() {
    remember();
    closeWizard();
  }

  function goTo(at) {
    if (at === SIGN_INS || at === API_KEYS) connectionStep = at;
    step = at;
    showStep(true);
  }

  // Shows one step, sets the counter and the buttons, and moves focus to the step heading when asked.
  function showStep(focus) {
    if (!ui) return;
    ui.panes.forEach((pane, i) => { pane.hidden = i !== step - 1; });
    const connecting = step === SIGN_INS || step === API_KEYS;
    ui.count.textContent = step === WELCOME ? '1 of 3 · Get started' : connecting ? '2 of 3 · Connect a model' : '3 of 3 · Start a chat';
    ui.back.hidden = step === WELCOME;
    ui.next.hidden = !connecting;
    ui.finish.hidden = step !== DONE;
    if (step === DONE) {
      paintSummary();
      readModels();
    }
    if (focus) ui.heads[step - 1].focus();
  }

  function navFooter() {
    const foot = make('div', 'setup-foot');
    const skip = MuseUI.button('ghost small', 'Skip for now');
    skip.addEventListener('click', () => closeWizard());
    const nav = make('div', 'setup-nav');
    ui.back = MuseUI.button('ghost small', 'Back');
    ui.back.addEventListener('click', () => goTo(step === DONE ? connectionStep : WELCOME));
    ui.next = MuseUI.button('primary small', 'Continue');
    ui.next.addEventListener('click', () => goTo(DONE));
    ui.finish = MuseUI.button('ghost small', 'Close setup');
    ui.finish.addEventListener('click', () => finishSetup());
    nav.append(ui.back, ui.next, ui.finish);
    foot.append(skip, nav);
    return foot;
  }

  // ---------- step 1: welcome ----------

  function welcomePane() {
    const pane = make('section', 'setup-pane');
    const heading = stepHeading('Welcome to Plenum');
    const lead = make('p', 'setup-lead', 'Ask an AI to explain a project, plan a change, or work with your files. Connect one model to send your first message.');
    const choices = make('div', 'setup-choices');
    choices.append(
      setupChoice('Use a subscription', 'Sign in to a coding tool such as Codex or Claude Code. Your provider’s plan and limits apply.', SIGN_INS),
      setupChoice('Use an API key', 'Connect a provider that bills for requests. Use this if you already have an API account.', API_KEYS),
    );
    const actions = make('div', 'actions');
    const explore = MuseUI.button('ghost small', 'Explore what Plenum can do');
    explore.addEventListener('click', () => openCapabilities(WELCOME));
    actions.append(explore);
    pane.append(heading, lead, choices, actions);
    return { pane, heading };
  }

  function setupChoice(title, description, next) {
    const choice = MuseUI.button('setup-choice', '');
    choice.append(make('strong', '', title), make('span', '', description));
    choice.addEventListener('click', () => goTo(next));
    return choice;
  }

  function providerPicker(label, rows, chosen, onChange) {
    const field = make('label', 'setup-provider');
    const select = make('select');
    select.replaceChildren(...rows.map(({ id, label }) => new Option(label, id)));
    select.value = chosen;
    field.append(make('span', '', label), select);
    select.addEventListener('change', () => onChange(select.value));
    return { field, select };
  }

  function showSelected(rows, selected) {
    for (const row of rows) row.card.hidden = (row.c?.id ?? row.id) !== selected;
  }

  function alternateRoute(title, next) {
    const button = MuseUI.button('ghost small', title);
    button.addEventListener('click', () => goTo(next));
    return button;
  }

  // ---------- step 2: sign-ins ----------

  function signInPane() {
    const pane = make('section', 'setup-pane');
    const heading = stepHeading('Connect a coding subscription');
    const lead = make('p', 'setup-lead', 'Choose a coding tool you have access to. If you need to install it, follow its instructions and check again. Complete sign-in in the window that opens.');
    ui.clis = CLIS.map(c => cliRow(c));
    const rows = make('div', 'setup-rows');
    rows.append(...ui.clis.map(r => r.card));
    const { field } = providerPicker('Coding tool', CLIS.map(c => ({ id: c.id, label: c.name })), selectedCli, id => {
      selectedCli = id;
      showSelected(ui.clis, selectedCli);
    });
    showSelected(ui.clis, selectedCli);
    const again = MuseUI.button('ghost small', 'Check again');
    again.addEventListener('click', () => loadStatus(true));
    // Kept so a read it started can turn it off until the answer is in (a fresh read asks the CLIs and takes a few seconds).
    ui.again = again;
    const actions = make('div', 'actions');
    actions.append(again, alternateRoute('Use an API key instead', API_KEYS));
    pane.append(heading, lead, field, rows, actions);
    // The provider-terms strip sits above the sign-in rows (step 2, as in Accounts).
    MuseUI.notice?.('provider-terms', { before: rows });
    return { pane, heading };
  }

  function cliRow(c) {
    const card = MuseUI.cardShell(c.mark, c.id, c.name, c.account, 'Checking…', false);
    const row = { c, card, pill: card.querySelector('.pill'), note: make('p', '', 'Checking your accounts…'), button: MuseUI.button('primary small', 'Sign in'), busy: false };
    row.button.disabled = true;
    row.button.addEventListener('click', () => signIn(row));
    // The install steps of a missing CLI go here. The class is the Accounts group's, so the commands look as they do there.
    row.install = make('div', 'coding-agents');
    row.install.hidden = true;
    row.installKey = '';
    const actions = make('div', 'actions');
    actions.append(row.button);
    if (c.id === 'claude') {
      row.installGuide = make('a', 'setup-link', 'Claude Code installation guide ↗');
      row.installGuide.href = 'https://code.claude.com/docs/en/setup';
      row.installGuide.target = '_blank';
      row.installGuide.rel = 'noopener noreferrer';
      row.installGuide.hidden = true;
      row.toKeys = MuseUI.button('ghost small', 'Add an Anthropic key');
      row.toKeys.hidden = true;
      row.toKeys.addEventListener('click', () => {
        selectedKey = 'anthropic';
        ui.keySelect.value = selectedKey;
        ui.keys.forEach(paintKey);
        goTo(API_KEYS);
      });
      actions.append(row.installGuide, row.toKeys);
    }
    card.append(row.note, row.install, actions);
    return row;
  }

  // Opens step 3, the API keys.
  function showKeys() {
    goTo(API_KEYS);
  }

  // Starts the CLI's own sign-in window through its route. The person finishes the sign-in there, and the wizard watches for it:
  // the row says Waiting for sign-in and the status is read again every few seconds until the sign-in shows. Nothing is read
  // straight after the click: the sign-in cannot be there yet, and that read would only fix the old answer in place. A CLI that is
  // already signed in is not watched (there would be nothing to see), and without the watch helper the person presses Check again.
  async function signIn(row) {
    const id = row.c.id;
    row.busy = true;
    paintCli(row);
    let opened = false;
    try {
      await MuseUI.api(row.c.path, {});
      opened = true;
    } catch (err) {
      MuseUI.toast(err.message, 'bad');
    } finally {
      row.busy = false;
    }
    if (!opened) {
      // No window opened. The status is read again, since the reason may be on it (a CLI that is gone, for one).
      await loadStatus();
      return paintClis();
    }
    const signedIn = rowReady(row.c, status) ? row.c.state(status.accounts) === IN : false;
    if (signedIn || typeof MuseUI.watchSignIn !== 'function') {
      MuseUI.toast('Sign-in window opened. Finish it there, then press Check again.');
    } else {
      MuseUI.toast('Sign-in window opened. Finish it there. Plenum shows the sign-in here when it is done.');
      gaveUp.delete(id);
      waiting.add(id);
      startWatch();
    }
    paintClis();
  }

  // One watch for every waiting row: a second Sign in starts it again, so the rows share one timer and one read at a time.
  function startWatch() {
    forcedAt = Date.now();
    watch = MuseUI.watchSignIn({
      id: 'setup',
      read: readWaiting,
      done: () => waiting.size === 0,
      alive: onScreen,
      onProgress: () => {
        noticed();
        paintAll();
      },
      onGiveUp: () => {
        for (const id of waiting) gaveUp.add(id);
        waiting.clear();
        watch = null;
        paintClis();
      },
      // The wizard was closed. It reads the status again when it is next opened.
      onClosed: () => {
        waiting.clear();
        watch = null;
      },
    });
    // No timers on this page: nothing watches, and the rows keep their plain state.
    if (!watch) waiting.clear();
  }

  // The watch's read: only the routes the waiting rows need, with no message on a failure (a read that fails saw nothing).
  async function readWaiting() {
    const ids = [...waiting];
    const main = ids.some(id => !isSide(id));
    const side = ids.some(isSide);
    const fresh = side && Date.now() - forcedAt >= FORCE_EVERY_MS;
    if (fresh) forcedAt = Date.now();
    const [accounts, cli] = await Promise.all([main ? MuseUI.api('/api/accounts') : null, side ? cliStatus(fresh) : null]);
    if (!status?.accounts) return;
    if (main && !accounts?.claude) throw new Error('The status did not come back.');
    merge({ main: accounts ?? status.main, cli: cli ?? status.cli, cliPending: false });
  }

  // After a read: a waiting row that is now signed in says so once and stops waiting. With no row left, the watch ends.
  function noticed() {
    if (!status?.accounts) return;
    for (const c of CLIS) {
      if (!waiting.has(c.id) || !rowReady(c, status)) continue;
      const state = c.state(status.accounts);
      if (state === IN) MuseUI.toast(`Signed in to ${c.name}.`);
      if (state === IN || state === NONE) waiting.delete(c.id);
    }
    if (!waiting.size && watch) {
      watch.stop();
      watch = null;
    }
  }

  // The rows of the last draw. A row object from before a redraw is no longer on screen, so painting goes through these.
  function paintClis() {
    ui?.clis.forEach(paintCli);
  }

  // The install steps under a row whose CLI is missing (MuseUI.cliInstallBlock, ext-accounts-cli.js). They are built again only
  // when they change, so a repaint neither stacks a second block nor takes the focus off a Copy button. Returns whether steps show.
  function paintInstall(row, state) {
    const info = status?.accounts?.[row.c.id];
    const build = state === NONE && row.c.id !== 'claude' ? MuseUI.cliInstallBlock : null;
    const key = typeof build === 'function' ? `${row.c.id} ${info?.installCommand ?? ''}` : '';
    if (key !== row.installKey) {
      const block = key ? build(row.c.id, info) : null;
      row.installKey = block ? key : '';
      row.install.replaceChildren(...(block ? [block] : []));
    }
    row.install.hidden = !row.installKey;
    return Boolean(row.installKey);
  }

  function paintCli(row) {
    const id = row.c.id;
    const state = rowReady(row.c, status) ? row.c.state(status.accounts) : null;
    // Waiting: the sign-in window was opened from this row and the sign-in has not shown yet.
    const wait = waiting.has(id) && (state === OUT || state === UNKNOWN);
    const steps = paintInstall(row, state);
    row.pill.textContent = !state ? 'Checking…' : wait ? 'Waiting for sign-in' : STATE_TEXT[state];
    row.pill.className = state === IN ? 'pill ok' : 'pill';
    row.note.textContent = !state ? 'Checking your accounts…'
      : state === IN ? 'Signed in on this computer.'
        : state === NONE ? (steps ? 'Not installed.' : row.c.missing)
          : wait ? 'Finish the sign-in in the window that opened. Plenum checks every few seconds and shows it here.'
            : gaveUp.has(id) ? 'Plenum has not seen a sign-in yet. Press Sign in to try again, or Check again if you have finished.'
              : state === UNKNOWN ? 'Plenum could not read this sign-in. Sign in opens a window that you complete there, or press Check again.'
                : 'Not signed in. Sign in opens a window that you complete there.';
    row.button.textContent = state === IN || wait ? 'Sign in again' : 'Sign in';
    row.button.disabled = row.busy || state === null || state === NONE;
    if (row.toKeys) row.toKeys.hidden = state !== NONE;
    if (row.installGuide) row.installGuide.hidden = state !== NONE;
  }

  // ---------- step 3: API keys ----------

  function keyPane() {
    const pane = make('section', 'setup-pane');
    const heading = stepHeading('Connect an API provider');
    const lead = make('p', 'setup-lead', 'Choose a provider and create a key in its dashboard. Your provider bills for usage. Saving checks the key and uses this computer’s encrypted store when available.');
    ui.notice = make('p', 'setup-notice');
    ui.notice.hidden = true;
    ui.keys = KEYS.map(k => keyRow(k));
    const rows = make('div', 'setup-rows');
    rows.append(...ui.keys.map(r => r.card));
    const { field, select } = providerPicker('API provider', KEYS, selectedKey, id => {
      selectedKey = id;
      ui.keys.forEach(paintKey);
    });
    ui.keySelect = select;
    const actions = make('div', 'actions');
    actions.append(alternateRoute('Use a subscription instead', SIGN_INS));
    pane.append(heading, lead, field, ui.notice, rows, actions);
    // The per-token billing strip sits above the key rows (step 3, as in Accounts).
    MuseUI.notice?.('api-keys-spend', { before: rows });
    return { pane, heading };
  }

  function keyRow(k) {
    const card = MuseUI.cardShell(k.mark, k.id === 'anthropic' ? 'claude' : k.id, k.label, `API key · ${k.envVar}`, 'Checking…', false);
    const row = {
      id: k.id,
      label: k.label,
      card,
      pill: card.querySelector('.pill'),
      billing: `Billed per token by ${k.label}. Plenum sends this key only to ${k.label}.`,
      note: make('p', '', `Billed per token by ${k.label}. Plenum sends this key only to ${k.label}.`),
      input: document.createElement('input'),
      save: MuseUI.button('primary small', 'Save key'),
      test: MuseUI.button('ghost small', 'Test saved key'),
      link: make('a', 'setup-link'),
      result: make('div', 'result'),
      busy: false,
    };
    row.input.type = 'password';
    row.input.autocomplete = 'off';
    row.input.spellcheck = false;
    row.input.placeholder = `Paste your ${k.label} key`;
    row.input.setAttribute('aria-label', `API key for ${k.label}`);
    row.result.setAttribute('role', 'status');
    row.link.target = '_blank';
    row.link.rel = 'noopener noreferrer';
    row.link.hidden = true;
    row.save.addEventListener('click', () => saveKey(row));
    row.test.addEventListener('click', () => testKey(row));
    // Enter in the box saves, the same as the button. A disabled button ignores the click.
    row.input.addEventListener('keydown', e => {
      if (e.key === 'Enter') row.save.click();
    });
    const actions = make('div', 'actions');
    actions.append(row.save, row.test, row.link);
    card.append(row.note, row.input, actions, row.result);
    paintKey(row);
    return row;
  }

  // Sends the typed key once, to the route for its provider. The box is cleared after every attempt, so the key is not shown again.
  async function saveKey(row) {
    const key = row.input.value.trim();
    if (!key) return show(row, 'Paste a key first.', false);
    row.busy = true;
    paintKey(row);
    show(row, 'Checking the key…', null);
    try {
      const r = row.id === 'anthropic'
        ? await MuseUI.api('/api/accounts/claude/key', { key })
        : await MuseUI.api('/api/keys', { provider: row.id, key });
      // A check that could not run is not a refusal: the message says how to save the key anyway (in Accounts).
      show(row, scrub(r.message || (r.saved ? 'Saved.' : 'The key was not saved.'), key), r.saved === true ? true : r.canSaveAnyway === true ? null : false);
      if (r.saved === true) {
        MuseUI.toast(`${row.label} key saved`);
        await loadStatus();
      }
    } catch (err) {
      show(row, scrub(err.message, key), false);
    } finally {
      row.input.value = '';
      row.busy = false;
      paintKey(row);
    }
  }

  // Asks the provider whether the saved key is accepted. Test is only offered once a key is saved.
  async function testKey(row) {
    row.busy = true;
    paintKey(row);
    show(row, 'Checking the saved key…', null);
    try {
      const r = row.id === 'anthropic'
        ? await MuseUI.api('/api/accounts/claude/test', {})
        : await MuseUI.api('/api/keys/test', { provider: row.id });
      // A busy provider is not a refusal: the key could not be confirmed either way.
      const unsettled = r.ok !== true && r.verdict === 'unchecked';
      show(row, `${r.ok ? 'Accepted.' : unsettled ? 'Could not be confirmed.' : 'Refused.'} ${r.message ?? ''}`.trim(), r.ok === true ? true : unsettled ? null : false);
    } catch (err) {
      show(row, err.message, false);
    } finally {
      row.busy = false;
      paintKey(row);
    }
  }

  function show(row, text, ok) {
    row.result.textContent = text;
    row.result.className = ok === true ? 'result ok' : ok === false ? 'result bad' : 'result';
  }

  // Paints one key row: its status, whether Test can run, whether Save is allowed, and the key page link.
  function paintKey(row) {
    const s = keyReady(row.id, status) ? status : null;
    const listed = !s || row.id === 'anthropic' || s.keys.providers.some(p => p.id === row.id);
    row.card.hidden = row.id !== selectedKey;
    const configured = s ? keyConfigured(s, row.id) : false;
    const unused = Boolean(s) && row.id === 'anthropic' && !claudeUsesKey(s.accounts);
    row.pill.textContent = !s ? 'Checking…' : !listed ? 'Unavailable' : unused ? 'Not used' : configured ? 'Saved' : 'Not set';
    row.pill.className = configured ? 'pill ok' : 'pill';
    row.note.textContent = !listed ? 'This provider is unavailable. Choose another provider to continue.'
      : unused ? 'Claude Code runs through the Claude CLI here. You can change the Claude route in Accounts.'
        : row.billing;
    row.test.disabled = row.busy || !configured;
    row.save.disabled = row.busy || !s || !listed || s.keys.storage?.canSave === false;
    const page = s?.keys?.providers?.find(p => p.id === row.id)?.keyUrl;
    row.link.hidden = !isHttps(page);
    if (isHttps(page)) {
      row.link.href = page;
      row.link.textContent = `Open the ${row.label} key page`;
    }
  }

  // ---------- step 4: summary ----------

  function donePane() {
    const pane = make('section', 'setup-pane');
    const heading = stepHeading('Start your first chat');
    const lead = make('p', 'setup-lead', 'Add a folder you want to work in and try “Explain how this project is organized.” Plenum can show a plan before changing files.');
    ui.summary = make('ul', 'setup-list');
    ui.summaryNone = make('div', 'setup-pane');
    ui.summaryNone.hidden = true;
    const addKey = MuseUI.button('primary small', 'Add an API key');
    addKey.addEventListener('click', () => showKeys());
    const signIn = alternateRoute('Connect a subscription', SIGN_INS);
    const ways = make('div', 'actions');
    ways.append(signIn, addKey);
    ui.summaryNone.append(make('p', 'setup-lead', 'Connect a model before sending a message. You can add a project now and connect later from Accounts.'), ways);
    // Which model answers (MuseUI.answering, ext-model-info.js). When the chosen model cannot, one press sets one that can.
    ui.useModel = MuseUI.button('primary small', 'Use');
    ui.useModel.addEventListener('click', async () => {
      await MuseUI.useReadyModel?.();
      paintSummary();
    });
    ui.useModelRow = make('div', 'actions');
    ui.useModelRow.hidden = true;
    ui.useModelRow.append(ui.useModel);
    ui.start = MuseUI.button('primary small', 'Add a project folder');
    ui.start.addEventListener('click', () => {
      const project = MuseUI.state?.activeProject;
      finishSetup();
      if (project) MuseUI.el.input?.focus();
      else MuseUI.addProjectFromSettings?.();
    });
    const explore = MuseUI.button('ghost small', 'View capabilities');
    explore.addEventListener('click', () => openCapabilities(DONE));
    const actions = make('div', 'actions setup-start');
    actions.append(ui.start, explore);
    pane.append(heading, lead, ui.summary, ui.useModelRow, ui.summaryNone, actions);
    return { pane, heading };
  }

  // The sentence about the model that will answer, from what ext-model-info.js read. '' when that panel did not load or has read nothing.
  // Never changes the model: the Use button beside it is a press.
  function modelLine() {
    const now = MuseUI.answering?.();
    if (!now) return '';
    if (now.ready) return `Plenum will answer with ${now.name}.`;
    return `${now.name} is the chosen model, but it cannot answer yet: ${now.reason}.`;
  }

  function paintSummary() {
    if (ui?.start) ui.start.textContent = MuseUI.state?.activeProject ? 'Open project chat' : 'Add a project folder';
    // The summary needs every part: with one still on its way it would say too little.
    if (!ui || !ui.summary || !status?.keys || !status.accounts || status.cliPending) return;
    const signed = CLIS.filter(c => c.state(status.accounts) === IN).map(c => c.name);
    const saved = ui.keys.filter(r => keyConfigured(status, r.id)).map(r => r.label);
    const lines = [];
    if (signed.length) lines.push(`Signed in: ${signed.join(', ')}.`);
    if (saved.length) lines.push(`Keys saved: ${saved.join(', ')}.`);
    ui.summaryNone.hidden = lines.length > 0;
    // The model line only follows a real setup, so an empty summary still leads to the two ways forward.
    const model = lines.length ? modelLine() : '';
    if (model) lines.push(model);
    ui.summary.replaceChildren(...lines.map(text => make('li', '', text)));
    const pick = model && !MuseUI.answering?.()?.ready ? MuseUI.readyModel?.() : null;
    ui.useModelRow.hidden = !pick;
    if (pick) ui.useModel.textContent = `Use ${pick.name}`;
  }

  // The summary's model sentence depends on which providers answer now, which ext-model-info.js reads on its own timer. On the last step
  // it is read again, so a sign-in made a moment ago counts. A late answer is painted only while this step is still shown.
  let modelRead = 0;
  function readModels() {
    const mine = ++modelRead;
    Promise.resolve(MuseUI.refreshModelInfo?.()).then(() => {
      if (mine === modelRead && onScreen() && step === DONE) paintSummary();
    }, () => {});
  }

  // ---------- painting and reading the status ----------

  function paintAll() {
    if (!ui || !status) return;
    const storage = status.keys?.storage;
    // Session-only keys, or a store that refuses saves, are said plainly above the key boxes.
    ui.notice.textContent = storage?.message ?? '';
    ui.notice.hidden = !storage || storage.mode === 'keychain';
    ui.clis.forEach(paintCli);
    ui.keys.forEach(paintKey);
    paintSummary();
  }

  // Reads the keys and the sign-ins again and paints them. A failed read leaves the last status on screen and says so.
  // After a sign-in was started from a Cursor, Grok Build or Antigravity row, the server is asked to look again, not to answer
  // from what it last saw; that can take a few seconds, so the line says what is happening.
  // again is a press of Check again: the server looks at the accounts again instead of answering from what it kept (Claude Code's answer is kept
  // for 20 seconds).
  // Each of the three requests paints its part when it returns, so a slow one does not hold the rest back. A read that fails leaves what is
  // already on screen and says so; an answer of an older read (a second Check again) is dropped.
  async function loadStatus(again = false) {
    const seq = ++loadSeq;
    loading = true;
    const fresh = [...waiting, ...gaveUp].some(isSide);
    // A press of Check again says at once that it is looking, and the button stays off until the answer is in, so it is not pressed
    // again and again while the CLIs are asked. The quiet reads every few seconds change nothing on screen.
    if (fresh || again) showLine('Checking your sign-ins…', false);
    if (again && ui?.again) ui.again.disabled = true;
    const done = () => {
      if (again && ui?.again) ui.again.disabled = false;
    };
    let failure = '';
    const take = (request, accept) => request.then(value => {
      if (seq !== loadSeq) return;
      if (!accept(value)) throw new Error('The status did not come back. Try again.');
      paintAll();
    }).catch(err => {
      if (seq === loadSeq && !failure) failure = err.message || 'The status did not come back. Try again.';
    });
    await Promise.all([
      take(MuseUI.api('/api/keys'), keys => (Array.isArray(keys?.providers) ? (merge({ keys }), true) : false)),
      take(MuseUI.api(again ? '/api/accounts?fresh=1' : '/api/accounts'), main => (main?.claude ? (merge({ main }), true) : false)),
      take(cliStatus(fresh), cli => (merge({ cli, cliPending: false }), true)),
    ]);
    done();
    if (seq !== loadSeq) return;
    loading = false;
    if (failure) {
      showLine(failure, true);
      return;
    }
    statusAt = Date.now();
    showLine('', false);
    gaveUp.clear();
    noticed();
    paintAll();
  }

  function showLine(text, bad) {
    if (!ui) return;
    ui.line.textContent = text;
    ui.line.className = bad ? 'setup-status bad' : 'setup-status';
  }

  // ---------- opening on the first run ----------

  // Runs once when the page loads. It reads the keys and the sign-ins, and opens the wizard only when nothing is set up yet.
  async function firstRun() {
    // The agreement card comes first. Nothing about setup is read until the terms are accepted (ext-legal.js resolves this).
    await (MuseUI.legalReady ?? Promise.resolve());
    if (dismissed()) return;
    let keys;
    let accounts;
    let cli;
    try {
      [keys, accounts, cli] = await Promise.all([MuseUI.api('/api/keys'), MuseUI.api('/api/accounts'), cliStatus()]);
    } catch {
      // The server has not answered, so nothing is opened. The next visit checks again.
      return;
    }
    if (!Array.isArray(keys?.providers) || !accounts?.claude) return;
    merge({ keys, main: accounts, cli, cliPending: false });
    statusAt = Date.now();
    const hasAccount = KEYS.some(k => keyConfigured(status, k.id)) || CLIS.some(c => c.state(status.accounts) === IN);
    if (hasAccount && MuseUI.state?.projects?.length) return;
    // The person may have opened another panel while the check ran. The wizard waits for an empty drawer and never replaces one.
    if (!MuseUI.el.drawer.hidden) return;
    openWizard();
  }

  // ---------- closing ----------

  // A close of the drawer while the wizard is on screen counts as a dismissal, whichever control closed it: the close button,
  // the scrim, Escape or Finish. Skip for now clears current first, so it is not remembered.
  function onScreen() {
    return current && !MuseUI.el.drawer.hidden && MuseUI.el.drawerTitle.textContent === TITLE;
  }

  // Only a close the person makes is a dismissal: the close button, the scrim or Escape (README: Setup wizard). Settings (Ctrl+,), Read the
  // terms and other panels close the drawer themselves, and that is not a dismissal, so the wizard comes back next time (B-58). The
  // capture phase runs before the drawer closes, so the flag is set first.
  function personalClose(e) {
    if (!onScreen()) return;
    const byClick = e.type === 'click' && e.target.closest?.('#drawerClose, #scrim');
    const byEscape = e.type === 'keydown' && e.key === 'Escape' && !MuseUI.dialogOpen?.();
    if (byClick || byEscape) remember();
  }
  document.addEventListener('click', personalClose, true);
  document.addEventListener('keydown', personalClose, true);
  // Whatever closes the drawer, the wizard is no longer its content once it is hidden.
  new MutationObserver(() => {
    if (current && MuseUI.el.drawer.hidden) current = false;
  }).observe(MuseUI.el.drawer, { attributes: true, attributeFilter: ['hidden'] });

  document.addEventListener('keydown', e => {
    // A confirm dialog opened over the wizard (Decline and quit, for one) takes Escape for itself; the wizard stays open.
    if (e.key === 'Escape' && onScreen() && !MuseUI.dialogOpen?.()) MuseUI.closeDrawer();
  });

  // ---------- the side menu entry ----------

  // The entry sits above Accounts, after Pipelines. It only opens the wizard, so the same panel opens again after a dismissal.
  function sideButton() {
    const b = make('button', 'side-link');
    b.type = 'button';
    b.id = BUTTON_ID;
    b.title = 'Connect a model and get started';
    b.append(MuseUI.icon('sparkle'), 'Setup');
    b.addEventListener('click', openSetup);
    return b;
  }

  // The click clears the dismissal and opens the wizard at its first step. The first-run check never clears it.
  function openSetup() {
    forget();
    openWizard();
  }

  const CAPABILITIES = [
    ['Work in a project', 'Open a folder and ask Plenum to explain it, plan a change, edit files, or run tests. Add threads for separate conversations. Search chats in one project or across projects.'],
    ['Compare and collaborate', 'In Chat options, choose a lead model for one conversation or open Council for perspectives from several models. Quick compare sends one question to several selected models. Each provider’s billing applies.'],
    ['Review changes', 'Open Review to inspect changes from the last run. Mark files Viewed as you go. Approvals tell you when an action needs your decision. Use Stop to interrupt a run.'],
    ['Automate recurring work', 'Use agents for focused tasks and routines for scheduled project work. Review active runs and pending requests in the Agents pane.'],
    ['Use apps or a browser', 'Computer use can work with a screen or shared windows. On Mac, screen capture and input need Screen Recording and Accessibility permission. Chrome sharing uses the separate Plenum extension.'],
    ['Take Plenum with you', 'Pair a phone from Settings to use Plenum remotely while the host computer is running. The desktop controls which actions the phone can take.'],
  ];

  function openCapabilities(returnStep = null) {
    let heading;
    MuseUI.openDrawer('What Plenum can do', body => {
      heading = stepHeading('One workspace for your models');
      const guide = make('div', 'setup');
      guide.append(heading, make('p', 'setup-lead', 'Plenum runs on your computer and connects to the models you choose. Project chats and settings are saved on this computer. When you send a message, the selected provider receives the prompt and context needed for the work.'));
      const entries = make('div', 'setup-capabilities');
      for (const [title, detail] of CAPABILITIES) {
        const entry = make('section', 'setup-capability');
        entry.append(make('h4', '', title), make('p', '', detail));
        entries.append(entry);
      }
      const actions = make('div', 'actions setup-start');
      const setup = MuseUI.button('primary small', returnStep ? 'Back to setup' : 'Open setup');
      setup.addEventListener('click', () => returnStep ? openWizard(returnStep) : openSetup());
      const legal = MuseUI.button('ghost small', 'Privacy and terms');
      legal.addEventListener('click', () => MuseUI.openLegal?.());
      actions.append(setup, legal);
      guide.append(actions, entries);
      body.append(guide);
    });
    heading?.focus();
  }

  MuseUI.openSetup = openSetup;
  MuseUI.openCapabilities = () => openCapabilities();

  // Attach. The entry is added once, above Accounts, when the panel script loads.
  if (!document.getElementById(BUTTON_ID)) MuseUI.el.accountsBtn.before(sideButton());

  firstRun().catch(() => {});
})();
