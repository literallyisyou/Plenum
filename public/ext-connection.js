// The connection banner and Retry for failed sends. Loaded by ext.js and adds itself through window.MuseUI.
// When a call to the local server cannot reach it, one banner says so instead of a line per call, and the page checks the server
// every 5 seconds until it answers again. A failed send gets Retry, which puts the text of that send back in the composer from
// MuseUI.lastSent; it does not send it. Copy error is on every failed send. Only the last "Cannot reach the Plenum server" line stays visible.
// The fetch wrapper only watches same-origin /api/ calls. It never changes a request or a response.
// In the desktop app the shell starts a server that stopped again by itself (desktop/server-supervisor.cjs, DECISIONS item 91), so the
// banner says the server is being restarted and the page comes back without a reload: the composer and everything typed in it stay.
// The page keeps how many times it came back in the data-plenum-reconnects attribute of the page element (the smoke run of the shell
// reads it).
// Calm (wave 4): a lost events channel is not yet a lost server. The server is asked at once (/api/health) and the banner shows only when
// that fails too, or when the channel has not said hello again within 3 seconds. A short drop that heals by itself shows nothing at all,
// and "Connected to the Plenum server again." is said only after a banner that was on screen for more than 2 seconds. While the channel
// is up nothing is checked; while it is down the check runs every 5 seconds, every 30 seconds when the page is not seen.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const LINE = 'Cannot reach the Plenum server';
  const EVERY_MS = 5000;
  // Checked while the server is up: a small file from the fixed static list, so an idle page does not run the status check.
  const UP_CHECK = '/mark.svg';
  // Checked while the banner shows: the health route, which does no work and answers only once the server is running again. A server
  // from before that route answers 404 there, and is checked on the status endpoint instead.
  const DOWN_CHECK = '/api/health';
  const DOWN_CHECK_OLD = '/api/status';
  // After this long without an answer the banner says the restarts may have run out (the desktop app then shows its own box).
  const LONG_MS = 30_000;
  // How long a lost channel has to say hello again before the banner shows, how long a banner must have been seen before its return is
  // announced, and how often a page that is not seen checks.
  const CALM_MS = 3000;
  const TOLD_MS = 2000;
  const HIDDEN_EVERY_MS = 30_000;
  // The desktop app's preload says desktop: true. The phone's and the paired browser's shell (mobile/shell/boot.js) also defines
  // window.plenumShell, with desktop: false: there no server is being restarted, and the shell's own strip says how the link stands.
  const SHELL = window.plenumShell && typeof window.plenumShell === 'object' ? window.plenumShell : null;
  const DESKTOP = SHELL?.desktop === true;
  const REMOTE = Boolean(SHELL) && !DESKTOP;
  const TEXT_DOWN = DESKTOP
    ? "Plenum's server stopped and is being restarted. This page reconnects by itself, and what you typed is kept."
    : REMOTE
      ? 'Not connected to your computer. Plenum keeps trying, and what you typed is kept.'
      : 'Cannot reach the Plenum server. Retrying every 5 seconds.';
  const TEXT_LONG = "Plenum's server has not come back yet. If a box asks what to do, choose Try again. What you typed is kept.";
  const TEXT_TOKEN = "Plenum's server is running again but does not accept this page. Reload the page to continue.";
  // The server answers, but the live link to it does not come back.
  const TEXT_LINK = 'Plenum is running, but the live link to it dropped. It reconnects by itself, and what you typed is kept.';
  // The original fetch. The checks use it, so they never pass through the wrapper below.
  const real = window.fetch.bind(window);

  let down = false;    // the banner is showing
  let probing = false; // one check at a time, so a tick and a click cannot overlap
  let downAt = 0;      // when the banner first showed, for the longer wording
  let refused = false; // the server answers but not to this page's token
  let healthMissing = false; // the server has no /api/health (a server from before it)
  let reconnects = 0;
  let downs = 0;
  let lost = false;     // the events channel was lost and has not said hello again
  let why = '';         // why the banner shows: 'server' (it cannot be reached) or 'link' (it answers, the channel does not come back)
  let calm = 0;         // the timer that gives a lost channel CALM_MS to come back
  let lastProbe = 0;    // when the server was last checked
  let suspect = false;  // a call could not reach the server: the next check asks the health route
  let counted = true;   // the return from the last outage was counted (data-plenum-reconnects)
  let seenAt = 0;       // when the banner was put on screen in this outage (0: it has not been seen)
  let shellAway = false; // on a phone or paired browser: the shell says its link to the computer is not up, and its strip says so
  let shellBackAt = 0;  // on a phone or paired browser: when the shell's link came back

  const banner = document.createElement('div');
  banner.className = 'ext-conn-banner';
  banner.setAttribute('role', 'alert');
  banner.hidden = true;
  const note = document.createElement('span');
  note.className = 'ext-conn-text';
  note.textContent = TEXT_DOWN;
  const retryNow = MuseUI.button('ghost small ext-conn-btn', 'Retry now');
  retryNow.addEventListener('click', () => probe());
  // Only for a server that refuses this page's token: the page has to be loaded again to get the new one. The person presses it.
  const reload = MuseUI.button('ghost small ext-conn-btn', 'Reload');
  reload.hidden = true;
  reload.addEventListener('click', () => location.reload());
  banner.append(note, retryNow, reload);
  // Above the transcript, in the same column as the messages.
  MuseUI.el.chat.before(banner);

  // True for a call to this server's own API. Calls to any other address are never watched.
  function isLocalApi(input) {
    try {
      const raw = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input?.url ?? ''));
      const url = new URL(raw, location.href);
      return url.origin === location.origin && url.pathname.startsWith('/api/');
    } catch {
      return false;
    }
  }

  // A reply of any status means the server is up. A network failure on a local call means it is down. The error is passed on
  // unchanged, so the caller handles it as it did before this panel.
  window.fetch = async (input, init) => {
    const local = isLocalApi(input);
    try {
      const res = await real(input, init);
      // The token refusal of a server that started again with a new token is not a sign that this page's server is up (C-21).
      if (local && !(res.status === 401 && res.headers?.get?.('x-plenum-auth') === 'token')) answered();
      return res;
    } catch (err) {
      if (local && isNetworkError(err)) missed();
      throw err;
    }
  };

  // The browser's own failure of a call that could not reach the server ("Failed to fetch", "NetworkError when attempting to fetch
  // resource.", "Load failed"). A TypeError for anything else (a bad header, a bug in a caller) says nothing about the server.
  function isNetworkError(err) {
    if (!(err instanceof TypeError)) return false;
    return /failed to fetch|network ?error|load failed|fetch failed|network connection/i.test(String(err.message ?? ''));
  }

  // Writes a count into the page element's data attributes, where the shell's smoke run reads it. A page without one is not an error.
  function stamp(name, value) {
    try {
      document.documentElement.dataset[name] = String(value);
    } catch {
      // Nothing to write into.
    }
  }

  // The banner's words for how things stand now.
  function wording() {
    if (refused) note.textContent = TEXT_TOKEN;
    else if (why === 'link') note.textContent = TEXT_LINK;
    else note.textContent = DESKTOP && Date.now() - downAt > LONG_MS ? TEXT_LONG : TEXT_DOWN;
    reload.hidden = !refused;
  }

  // Shows the banner. reason: 'server' when the server cannot be reached, 'link' when it answers but the channel does not come back.
  function showBanner(reason) {
    if (down) {
      // A server that cannot be reached says so over the softer words.
      if (reason === 'server' && why !== 'server') {
        why = 'server';
        wording();
      }
      return;
    }
    down = true;
    counted = false;
    why = reason;
    downAt = Date.now();
    refused = false;
    downs += 1;
    stamp('plenumDowns', downs);
    wording();
    paintBanner();
  }

  // Puts the banner on screen while it is due. On a phone or a paired browser it waits while the shell's own strip says the link to the
  // computer is down (two lines would say the same thing), and for CALM_MS after that link came back, so a page that heals with the
  // link shows nothing.
  function paintBanner() {
    const quiet = REMOTE && (shellAway || Date.now() - shellBackAt < CALM_MS);
    const show = down && !quiet;
    if (show && !seenAt) seenAt = Date.now();
    banner.hidden = !show;
  }

  // The server may be gone: a call could not reach it, or the events channel was lost. It is asked at once, and the banner shows only
  // if that check fails too (probe). A banner already on screen stays as it is.
  function missed() {
    if (down) return;
    suspect = true;
    void probe();
  }

  // The server answered. The banner goes, unless it shows because the channel does not come back: that one waits for the channel.
  function answered() {
    if (!down || why === 'link') return;
    hideBanner();
  }

  // The banner goes. Its return is announced only when it was on screen for more than TOLD_MS, and the state is read again (the
  // composer is not touched). A drop that never showed the banner leaves the reading to the channel's hello.
  function hideBanner() {
    if (!down) return;
    const seen = seenAt ? Date.now() - seenAt : 0;
    down = false;
    refused = false;
    why = '';
    seenAt = 0;
    banner.hidden = true;
    countBack();
    if (seen > TOLD_MS) MuseUI.toast(REMOTE ? 'Connected to your computer again.' : 'Connected to the Plenum server again.');
    MuseUI.refresh();
  }

  // The events channel said hello again: whatever the banner said, it goes.
  function markUp() {
    const was = lost;
    lost = false;
    clearTimeout(calm);
    if (down) hideBanner();
    // Back before anyone was told: only counted, for the shell's smoke run.
    else if (was) countBack();
  }

  // One return counted per outage, however it ended (the banner went, or the channel came back before it showed).
  function countBack() {
    if (counted) return;
    counted = true;
    reconnects += 1;
    stamp('plenumReconnects', reconnects);
  }

  // The events channel was lost. It gets CALM_MS to say hello again before the banner shows; the server is asked at once meanwhile.
  function markDown() {
    if (!lost) {
      lost = true;
      counted = false;
      clearTimeout(calm);
      calm = setTimeout(() => {
        if (lost && !down) showBanner('link');
      }, CALM_MS);
    }
    missed();
  }

  // The server answered, but it refused this page's token (it started again with another one). It is up, yet this page cannot use it.
  // A server that has just started answers 401 for a moment, until the desktop shell has given it its token (keys-hello), so a refusal in
  // the first 10 seconds of the banner counts as "still starting" and the longer wording waits.
  const TOKEN_GRACE_MS = 10_000;
  function markRefused() {
    if (!down || refused) return;
    if (Date.now() - downAt < TOKEN_GRACE_MS) return;
    refused = true;
    wording();
  }

  // One check call. The route is behind the Plenum token like every other /api/ route.
  const check = path => real(path, {
    cache: 'no-store',
    headers: MuseUI.headers ? MuseUI.headers() : {},
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined,
  });

  // One check: every 5 seconds, and at once for Retry now. An ok answer from the health route ends the banner. A network failure
  // starts it (or keeps it up). An answer that refuses the token says so in the banner.
  async function probe() {
    if (probing) return;
    probing = true;
    lastProbe = Date.now();
    // Once something looks wrong (the channel is lost, a call failed, the banner shows) the health route is asked: it answers only once
    // the server is running.
    const asking = down || lost || suspect;
    suspect = false;
    try {
      let res = await check(asking ? (healthMissing ? DOWN_CHECK_OLD : DOWN_CHECK) : UP_CHECK);
      if (asking && !healthMissing && res.status === 404) {
        healthMissing = true;
        res.body?.cancel().catch(() => {});
        res = await check(DOWN_CHECK_OLD);
      }
      res.body?.cancel().catch(() => {});
      if (res.ok) answered();
      else if (res.status === 401 && res.headers?.get?.('x-plenum-auth') === 'token') markRefused();
      else if (down) wording();
    } catch (err) {
      // The check itself could not reach the server, or had no answer in time: the server is down.
      if (isNetworkError(err) || err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        showBanner('server');
        wording();
      } else console.error('The connection check failed:', err);
    } finally {
      probing = false;
    }
  }

  // The events channel (GET /api/events) is open while the server is up, so its loss is the first sign the server may be gone:
  // app.js announces it as 'plenum:connection' with detail { connected }.
  window.addEventListener('plenum:connection', e => {
    if (e.detail?.connected) markUp();
    else markDown();
  });

  // On a phone or a paired browser the shell tells how its link to the computer stands (plenumShell.onConnection: 'connected',
  // 'reconnecting', 'offline' or 'asleep'). While it is not connected the shell's strip speaks for both. When it comes back, the server
  // is asked at once, and a banner still due shows only after CALM_MS.
  if (REMOTE && typeof SHELL.onConnection === 'function') {
    try {
      SHELL.onConnection(view => {
        const away = view?.state !== 'connected';
        if (away === shellAway) return;
        shellAway = away;
        if (!away) {
          shellBackAt = Date.now();
          setTimeout(paintBanner, CALM_MS + 10);
          if (down) void probe();
        }
        paintBanner();
      });
    } catch {
      // Without the shell's word the banner shows as it always did.
    }
  }

  // Every 5 seconds while there is something to watch: the channel is not up, or the banner shows. A channel that is up says so itself
  // when it goes, so nothing is asked then. A page that is not seen checks every 30 seconds.
  function tick() {
    if (!down && MuseUI.events?.connected === true) return;
    if (document.hidden && Date.now() - lastProbe < HIDDEN_EVERY_MS) return;
    return probe();
  }
  setInterval(tick, EVERY_MS);

  // True for a turn whose text is the connection line the app writes when a refresh cannot reach the server.
  function isLine(turn) {
    return (turn.querySelector(':scope > .turn-body')?.textContent ?? '').startsWith(LINE);
  }

  // Keeps only the last connection line visible. The others get a class that the stylesheet hides.
  function dedupe() {
    const lines = [...MuseUI.el.chat.querySelectorAll('.turn.error, .turn.system')].filter(isLine);
    lines.forEach((turn, i) => turn.classList.toggle('ext-conn-dup', i < lines.length - 1));
  }

  // Puts back the text of the last send that failed: the text that was sent, not the last saved message (B-5). It is not sent:
  // the user presses Send. app.js keeps that text in MuseUI.lastSent until its run goes through, so a refused send is never
  // replaced by an older message from the transcript.
  function retryLast() {
    const input = MuseUI.el.input;
    const last = MuseUI.lastSent;
    if (!last?.text) return MuseUI.toast('There is no failed message to retry.', 'bad');
    // A draft is never overwritten, the same rule app.js follows when it inserts a reply.
    if (input.value.trim()) return MuseUI.toast('The composer already has text. Clear it first, then retry.', 'bad');
    input.value = last.text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  }

  async function copyError(turn) {
    const text = turn.querySelector(':scope > .turn-body')?.textContent ?? '';
    // MuseUI.copyText falls back to the page's copy command when the clipboard API refuses.
    const copied = MuseUI.copyText ? await MuseUI.copyText(text) : await navigator.clipboard.writeText(text).then(() => true, () => false);
    if (copied) MuseUI.toast('Error copied.');
    else MuseUI.toast('The error could not be copied.', 'bad');
  }

  // Retry is offered only when there is a failed message to put back (B-5). A failure with no message behind it gets Copy error alone.
  function bar(turn, withRetry) {
    const row = document.createElement('div');
    row.className = 'ext-conn-bar';
    if (withRetry) {
      const retry = MuseUI.button('ghost small ext-conn-btn', 'Retry');
      retry.addEventListener('click', retryLast);
      row.append(retry);
    }
    const copy = MuseUI.button('ghost small ext-conn-btn', 'Copy error');
    copy.addEventListener('click', () => copyError(turn));
    row.append(copy);
    return row;
  }

  // Retry and Copy error under each failed send. The connection lines get none of their own.
  function addBars() {
    const retryable = Boolean(MuseUI.lastSent?.text);
    for (const turn of MuseUI.el.chat.querySelectorAll('.turn.error')) {
      if (isLine(turn) || turn.querySelector(':scope > .ext-conn-bar')) continue;
      turn.append(bar(turn, retryable));
    }
  }

  function sweep() {
    dedupe();
    // The send button shows Stop while a run is going. Retry waits until the page is idle.
    if (!MuseUI.el.send.classList.contains('stop')) addBars();
  }

  // The page redraws the transcript by replacing its children, so each redraw runs the sweep again. The send button's class
  // changes when a run starts or ends, which also decides whether the Retry bars may be added.
  new MutationObserver(sweep).observe(MuseUI.el.chat, { childList: true, subtree: true });
  new MutationObserver(sweep).observe(MuseUI.el.send, { attributes: true, attributeFilter: ['class'] });
  sweep();
})();
