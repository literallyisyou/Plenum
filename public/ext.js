// Loads the extra panels after the main page script. Each panel adds itself through window.MuseUI.
// The panels in KNOWN load first, in this order: their tags are written as soon as the page has looked for the Plenum token (a panel may
// ask the server for something the moment it runs), and they do not wait for the server's list. Any other ext-*.js panel the server lists
// (GET /api/ext-modules) loads after them, sorted by name; only the extra panels wait for that list. If it cannot be read, it is asked
// for again after 3, 6, 12, 24 and 48 seconds (B-95: the approvals, computer, browser and phone panels are extras, so one bad moment
// must not leave them out). When every try fails, a notice says so and points to a reload.
// SURFACE: a panel that works on one surface only is not downloaded on another (ext-phone.js starts with the same check, and its
// stylesheet is only for the phone), so the desktop skips both. The surface is what the page says of itself (html data-surface).
(function () {
  // Keep this order: the panels were written to load in it. ext-legal and ext-notices come first: the agreement card must be
  // ready before any panel asks the server for anything, and the notice registry must exist before a panel calls MuseUI.risk.
  // ext-remote comes next: its title-bar chip is a floor item, so it loads with the known panels. ext-drive comes after it: the drive
  // bar and its pill are floor items too (Stop must stay on screen), so they do not wait on the server's list either.
  const KNOWN = ['ext-legal', 'ext-notices', 'ext-remote', 'ext-drive', 'ext-accounts-api', 'ext-openrouter', 'ext-tools', 'ext-projects', 'ext-history', 'ext-compare', 'ext-prompts', 'ext-checkpoints', 'ext-plan', 'ext-cost', 'ext-images', 'ext-pipelines', 'ext-setup'];
  // The same shape the server accepts, so a name that reaches a URL is always a plain panel name.
  const NAME = /^ext-[a-z0-9-]{1,40}$/;
  const SURFACE = { 'ext-phone': 'phone' };
  const surfaceOk = name => !SURFACE[name] || document.documentElement?.dataset?.surface === SURFACE[name];

  // Names the server lists. null when the list cannot be read (a request that fails or is refused, or an answer of the wrong shape),
  // and [] for a real empty list. Without MuseUI nothing can be asked, so that is [].
  // The request carries the Plenum token (MuseUI.request), so it waits until the page has looked for the token (MuseUI.ready).
  async function discovered() {
    try {
      if (!window.MuseUI?.request) return [];
      await (window.MuseUI.ready ?? Promise.resolve());
      const res = await window.MuseUI.request('/api/ext-modules', {
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
      });
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data.modules) ? data.modules.filter(n => typeof n === 'string' && NAME.test(n)) : null;
    } catch {
      return null;
    }
  }

  const loaded = new Set();
  function load(name) {
    if (loaded.has(name) || !surfaceOk(name)) return;
    loaded.add(name);
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/' + name + '.css';
    document.head.append(css);
    const js = document.createElement('script');
    js.src = '/' + name + '.js';
    js.async = false;
    document.body.append(js);
  }

  const extrasOf = names => names.filter(name => !KNOWN.includes(name) && surfaceOk(name)).sort();
  const RETRY_MS = [3000, 6000, 12000, 24000, 48000];
  // Asks again after each wait in RETRY_MS until an answer can be read, then loads the extra panels from it.
  function retry(attempt) {
    if (attempt >= RETRY_MS.length) {
      window.MuseUI?.toast?.('Some panels did not load, because the list of panels could not be read. Reload the window to try again.', 'bad');
      return;
    }
    setTimeout(() => {
      discovered().then(again => {
        if (again === null) return retry(attempt + 1);
        for (const name of extrasOf(again)) load(name);
      });
    }, RETRY_MS[attempt]);
  }
  // The tags of the KNOWN panels are written, in order, when the page has looked for the token, without waiting for the list. The extra
  // panels load from the first answer to the list that can be read, and that is asked for at the same time.
  const asked = discovered();
  const known = Promise.resolve(window.MuseUI?.ready).catch(() => {}).then(() => {
    for (const name of KNOWN) load(name);
  });
  asked.then(async first => {
    // The extras come after the KNOWN tags, as before.
    await known;
    if (first !== null) {
      for (const name of extrasOf(first)) load(name);
      return;
    }
    retry(0);
  });
})();
