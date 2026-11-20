// ext-help. Help: short topics, About (the build), and Diagnostics (a report a person can read, copy or save when something is wrong).
// Adds itself through window.MuseUI (app.js): a Help link in the sidebar above Commands, and F1 anywhere. Layout and colour are in
// ext-help.css and every colour is a shared token.
//  - GET /api/diag (or, before the License Agreement is accepted, GET /api/diag/basic) -> { text, at, pending, logSource, canOpenLog }
//    (lib/routes/diag.mjs). text is the whole report, already cleaned on the server: versions, what is found and signed in as yes or no,
//    sizes and counts, and the last error lines. It holds no key, token, chat, prompt, file or project path (lib/diag.mjs). The report is
//    shown in the drawer before anything is copied, and nothing is sent anywhere: Copy, Save as a file and Open log folder are the
//    person's own presses.
//  - POST /api/diag/open-log asks the desktop app to show the log folder. POST /api/diag/client-error tells the server about an error
//    this page caught (its message, file and line only; see below).
// Text reaches the page through textContent only.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it, or without the drawer, there is nothing to attach to.
  if (!MuseUI || typeof MuseUI.openDrawer !== 'function' || !MuseUI.el?.helpBtn) return;

  const TITLE = 'Help';
  const BUTTON_ID = 'helpPanelBtn';
  const ASK_MS = 8000;
  // A tool that had not answered when the report left is asked for again after this long, at most twice.
  const PENDING_MS = 1600;
  const PENDING_TRIES = 2;
  const MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');
  const MOD = MAC ? 'Cmd' : 'Ctrl';

  // The topics: a title and what it says. Every sentence is about something the app does today.
  const TOPICS = [
    { title: 'Start a chat', text: 'Add a project folder in the sidebar, then type in the message box and press Enter. Shift+Enter adds a line. Type / to see the commands.' },
    { title: 'Stop a run', text: 'Press Stop to interrupt an active run. The Review panel shows any changes already made.' },
    { title: 'Ask first and approvals', text: 'Use Permissions to see what requires your approval. A pending request shows the action and the available choices. Some providers also apply their own limits.' },
    { title: 'Models and sign-in', text: `Open Accounts (${MOD}+Shift+A) to sign in to a coding agent or to save an API key. A key stays on this computer. It is never put in a log, a chat or a report.` },
    { title: 'Settings', text: `Open Settings (${MOD}+,) for the look of the app, safety, updates, backups and more. Updates shows which build you have.` },
    { title: 'Keyboard shortcuts', text: `Press ${MOD}+/ to see them all.` },
  ];

  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const timeout = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ASK_MS) : undefined);

  async function copy(text) {
    try {
      if (typeof MuseUI.copyText === 'function') return (await MuseUI.copyText(text)) === true;
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  async function buildLine() {
    try {
      await (MuseUI.ready ?? Promise.resolve());
      const res = await MuseUI.request('/api/build-info', { signal: timeout() });
      if (!res.ok) return null;
      const info = await res.json();
      return isObj(info) && typeof info.line === 'string' && info.line ? info.line : null;
    } catch {
      return null;
    }
  }

  // The report: the full one, or, when the License Agreement is not accepted yet (403), the one that starts no tool. Resolves the answer, or
  // throws an Error whose message is a sentence for the person.
  async function readReport(fresh) {
    await (MuseUI.ready ?? Promise.resolve());
    let res = await MuseUI.request(`/api/diag${fresh ? '?fresh=1' : ''}`, { signal: timeout() });
    if (res.status === 403) res = await MuseUI.request('/api/diag/basic', { signal: timeout() });
    const data = await res.json().catch(() => null);
    if (!res.ok || !isObj(data) || typeof data.text !== 'string' || !data.text) {
      throw new Error(isObj(data) && typeof data.error === 'string' && data.error ? data.error : 'The report could not be made. Reload the window and try again.');
    }
    return data;
  }

  function saveAsFile(text, at) {
    const stamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(at)) ? String(at).slice(0, 16).replace(/[-:]/g, '').replace('T', '-') : 'report';
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    const name = `plenum-diagnostics-${stamp}.txt`;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return name;
  }

  // ---------- the drawer ----------

  function topicsPart() {
    const box = make('div', 'ext-help-topics');
    const entry = make('div', 'ext-help-bar');
    const capabilities = MuseUI.button('primary small', 'What Plenum can do');
    capabilities.addEventListener('click', () => MuseUI.openCapabilities?.());
    const setup = MuseUI.button('ghost small', 'Open setup');
    setup.addEventListener('click', () => MuseUI.openSetup?.());
    entry.append(capabilities, setup);
    if (MuseUI.openCapabilities && MuseUI.openSetup) box.append(entry);
    for (const topic of TOPICS) {
      const d = make('details', 'ext-help-topic');
      d.append(make('summary', 'ext-help-summary', topic.title), make('p', 'ext-help-text', topic.text));
      box.append(d);
    }
    const commands = make('button', 'ghost small ext-help-commands', 'Show the commands');
    commands.type = 'button';
    commands.addEventListener('click', () => MuseUI.el.helpBtn.click());
    box.append(commands);
    return box;
  }

  function aboutPart() {
    const box = make('section', 'ext-help-block');
    box.append(make('h3', 'ext-help-head', 'About'));
    const line = make('p', 'ext-help-line', 'Reading the build...');
    box.append(line);
    buildLine().then(found => {
      line.textContent = found ?? 'The build could not be read. Reload the window to try again.';
    });
    return box;
  }

  function diagnosticsPart() {
    const box = make('section', 'ext-help-block');
    box.append(make('h3', 'ext-help-head', 'Diagnostics'));
    box.append(make('p', 'ext-help-text', 'If something is wrong, this report helps whoever you ask. It holds versions, what is installed and signed in as yes or no, sizes and counts, and the last error lines. It never holds a key, a chat, a prompt or a file, and it names a project only by its last folder. Nothing is sent anywhere: you copy it or save it yourself.'));
    const bar = make('div', 'ext-help-bar');
    const show = make('button', 'primary small', 'Show diagnostics');
    const copyBtn = make('button', 'ghost small', 'Copy diagnostics');
    const save = make('button', 'ghost small', 'Save as a file');
    const open = make('button', 'ghost small', 'Open log folder');
    const refresh = make('button', 'ghost small', 'Refresh');
    for (const b of [show, copyBtn, save, open, refresh]) b.type = 'button';
    // Copy and Save act on the report that is shown, so they wait for it, and say so.
    const SHOW_FIRST = 'Press Show diagnostics first. The report is copied or saved as it is shown.';
    copyBtn.disabled = true;
    save.disabled = true;
    copyBtn.title = SHOW_FIRST;
    save.title = SHOW_FIRST;
    refresh.hidden = true;
    bar.append(show, copyBtn, save, open, refresh);
    const note = make('p', 'ext-help-note');
    note.setAttribute('role', 'status');
    const pre = make('pre', 'ext-help-report');
    pre.hidden = true;
    pre.tabIndex = 0;
    pre.setAttribute('aria-label', 'The diagnostics report');
    box.append(bar, note, pre);

    let data = null;
    let busy = false;
    let noteTimer = null;
    const say = (text, bad) => {
      note.textContent = text;
      note.classList.toggle('ext-help-bad', Boolean(bad));
      clearTimeout(noteTimer);
      if (text && !bad) noteTimer = setTimeout(() => { note.textContent = ''; }, 3000);
    };
    const showData = d => {
      data = d;
      pre.textContent = d.text;
      pre.hidden = false;
      copyBtn.disabled = false;
      save.disabled = false;
      copyBtn.title = '';
      save.title = '';
      refresh.hidden = false;
      show.hidden = true;
    };
    // Reads the report, again after a moment while a tool has not answered (two more times at most). Resolves the data or null.
    async function load(fresh) {
      if (busy) return data;
      busy = true;
      show.disabled = true;
      refresh.disabled = true;
      say('Reading...');
      try {
        let d = await readReport(fresh);
        showData(d);
        for (let n = 0; n < PENDING_TRIES && d.pending > 0; n += 1) {
          say('A tool is still being read. Updating in a moment...');
          await new Promise(resolve => setTimeout(resolve, PENDING_MS));
          if (!pre.isConnected) return data;
          d = await readReport(false);
          showData(d);
        }
        say('');
        return d;
      } catch (err) {
        say(String(err?.message ?? err), true);
        return null;
      } finally {
        busy = false;
        show.disabled = false;
        refresh.disabled = false;
      }
    }
    show.addEventListener('click', () => { void load(false); });
    refresh.addEventListener('click', () => { void load(true); });
    copyBtn.addEventListener('click', async () => {
      const d = data ?? (await load(false));
      if (!d) return;
      const ok = await copy(d.text);
      say(ok ? 'Copied. Read it, then paste it where you ask for help.' : 'Could not copy. Select the text above and copy it by hand.', !ok);
    });
    save.addEventListener('click', () => {
      if (!data) return;
      try {
        say(`Saved as ${saveAsFile(data.text, data.at)}.`);
      } catch {
        say('Could not save the file. Copy the text instead.', true);
      }
    });
    open.addEventListener('click', async () => {
      open.disabled = true;
      try {
        const res = await MuseUI.request('/api/diag/open-log', { method: 'POST', body: {}, signal: timeout() });
        const r = await res.json().catch(() => null);
        if (res.ok && isObj(r) && r.ok === true) say('The log folder is open.');
        else say(isObj(r) && typeof r.message === 'string' && r.message ? r.message : isObj(r) && typeof r.error === 'string' && r.error ? r.error : 'The folder could not be opened.', true);
      } catch {
        say('The folder could not be opened.', true);
      } finally {
        open.disabled = false;
      }
    });
    return box;
  }

  function renderHelp(body) {
    body.append(topicsPart(), aboutPart(), diagnosticsPart());
  }

  function openHelp() {
    MuseUI.openDrawer(TITLE, renderHelp);
    return true;
  }

  function sideLink() {
    const b = make('button', 'side-link');
    b.type = 'button';
    b.id = BUTTON_ID;
    b.title = 'Help, the build, and a report to copy when something is wrong (F1)';
    b.append(MuseUI.icon('list'), TITLE, make('kbd', '', 'F1'));
    b.addEventListener('click', openHelp);
    return b;
  }

  if (!document.getElementById(BUTTON_ID)) MuseUI.el.helpBtn.before(sideLink());
  MuseUI.openHelp = openHelp;

  // F1 opens Help from anywhere, a text field included. A dialog that is open keeps the key.
  document.addEventListener('keydown', e => {
    if (e.key !== 'F1' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing) return;
    if (typeof MuseUI.dialogOpen === 'function' && MuseUI.dialogOpen()) return;
    e.preventDefault();
    openHelp();
  });

  // ---------- errors this page catches ----------
  // The server keeps one line for each (its message, the script's file name and line, cleaned there) in its log and in the report, so a
  // person who cannot say what happened still has something to paste. Ten a page load at most; the stack is never sent.
  let reported = 0;
  const MAX_REPORTS = 10;
  function report(message, source, line, kind) {
    const text = String(message ?? '').trim();
    if (!text || /ResizeObserver loop/.test(text) || reported >= MAX_REPORTS) return;
    reported += 1;
    Promise.resolve()
      .then(() => MuseUI.request('/api/diag/client-error', { method: 'POST', body: { message: text.slice(0, 240), source: typeof source === 'string' ? source : '', line: Number.isInteger(line) ? line : 0, kind } }))
      .catch(() => {});
  }
  window.addEventListener('error', e => report(e.message, e.filename, e.lineno, 'error'));
  window.addEventListener('unhandledrejection', e => report(e.reason?.message ?? e.reason, '', 0, 'rejection'));
})();
