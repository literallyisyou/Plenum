// ext-build-info. Settings > Updates > Build: which build of Plenum this is, with a Copy button that puts the build line and the system
// facts the page can read on the clipboard, for a bug report (DECISIONS item 91). Adds itself through window.MuseUI (app.js); layout and
// colour are in ext-build-info.css and every colour is a shared token.
//  - GET /api/build-info -> { version, build, commit, dirty, builtAt, line } (lib/routes/build-info.mjs). The line reads like
//    "Plenum 0.6.0 (build 20261113.0412, 0af7276)", or "Plenum 0.6.0 (development copy)" when no build was stamped.
//  - Copy gives the line, then "System: <operating system>", "Electron <version>" and "Chrome <version>" when the page can read them.
// Text reaches the page through textContent only. Nothing here reads a path, a user name or a key.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it, or without the Settings page, there is nothing to attach to.
  if (!MuseUI || !MuseUI.settings || typeof MuseUI.settings.register !== 'function') return;

  const SAVED_MS = 2500;
  const UNREADABLE = 'The build could not be read. Reload the window to try again.';
  const COPY_FAILED = 'Could not copy. Select the build line and copy it by hand.';

  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

  // The operating system, in words: the user agent names it, and the platform string is the fallback.
  function osName() {
    const nav = window.navigator ?? {};
    const ua = String(nav.userAgent ?? '');
    if (/Windows NT/.test(ua)) return 'Windows';
    if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
    if (/CrOS/.test(ua)) return 'ChromeOS';
    if (/Linux|X11/.test(ua)) return 'Linux';
    return String(nav.userAgentData?.platform ?? nav.platform ?? '') || 'unknown';
  }
  const versionIn = (ua, name) => new RegExp(name + '/(\\d+(?:\\.\\d+){0,3})').exec(ua)?.[1] ?? null;

  // The text Copy puts on the clipboard.
  function reportText(line) {
    const ua = String(window.navigator?.userAgent ?? '');
    const electron = versionIn(ua, 'Electron');
    const chrome = versionIn(ua, 'Chrome');
    const lines = [line, `System: ${osName()}`];
    if (electron) lines.push(`Electron ${electron}`);
    if (chrome) lines.push(`Chrome ${chrome}`);
    return lines.join('\n');
  }

  async function copy(text) {
    try {
      if (typeof MuseUI.copyText === 'function') return (await MuseUI.copyText(text)) === true;
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  async function read() {
    try {
      await (MuseUI.ready ?? Promise.resolve());
      const res = await MuseUI.request('/api/build-info', {
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
      });
      if (!res.ok) return null;
      const info = await res.json();
      return isObj(info) && typeof info.line === 'string' && info.line ? info.line : null;
    } catch {
      return null;
    }
  }

  // One row: the name, the line, Copy, and a line under it that says whether the copy worked.
  function render(body) {
    const root = make('div', 'eb-root');
    const row = make('div', 'eb-row');
    const label = make('span', 'eb-label', 'Build');
    const value = make('span', 'eb-line', 'Reading the build...');
    const copyBtn = make('button', 'ghost small eb-copy', 'Copy');
    copyBtn.type = 'button';
    copyBtn.disabled = true;
    copyBtn.setAttribute('aria-label', 'Copy the build and system details for a report');
    const note = make('p', 'eb-note');
    note.setAttribute('role', 'status');
    row.append(label, value, copyBtn);
    root.append(row, note);
    body.append(root);

    let line = null;
    let timer = null;
    const say = (text, bad) => {
      note.textContent = text;
      note.classList.toggle('eb-bad', Boolean(bad));
      clearTimeout(timer);
      if (text && !bad) timer = setTimeout(() => { note.textContent = ''; }, SAVED_MS);
    };
    copyBtn.addEventListener('click', async () => {
      if (line === null) return;
      const ok = await copy(reportText(line));
      say(ok ? 'Copied. Paste it into your report.' : COPY_FAILED, !ok);
    });
    read().then(found => {
      if (found === null) {
        value.textContent = 'Unknown';
        say(UNREADABLE, true);
        return;
      }
      line = found;
      value.textContent = found;
      copyBtn.disabled = false;
    });
  }

  MuseUI.settings.register({ id: 'build', scope: 'app', title: 'Build', order: 70, group: 'updates', render });
})();
