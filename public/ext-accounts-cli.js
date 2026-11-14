// ext-accounts-cli. Owned by its panel builder. Builds on window.MuseUI (see app.js).
// The Cursor and Grok Build cards in the Coding agents group of Settings > Accounts (UI-ARCH sections 5 and 10.9). The cards read GET
// /api/accounts/cli, which reports whether each CLI is installed and signed in (lib/cursor.mjs cursorStatus, lib/grok.mjs grokStatus).
// Sign in opens a terminal running the CLI's own login (POST /api/accounts/cursor/login and POST /api/accounts/grok/login), and the
// sign-in stays with that CLI, never with Plenum. Text is set with textContent only, and nothing here stores a sign-in or a key.
// Two helpers for the setup guide (ext-setup.js) are kept here as well, beside the commands and the cards they share:
// MuseUI.cliInstallBlock(id, info), the install steps for a CLI that is missing, and MuseUI.watchSignIn(opts), which reads the
// sign-in status until a sign-in that was started shows. Both only read and draw; neither starts a sign-in.
// Accounts paints as each request returns: a card built with ctx.cliPending says it is checking, and MuseUI.redrawAgentCards(cli) puts the
// real cards in place when GET /api/accounts/cli answers.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI, and its codingAgents group, before the extra panels load. Without them there is nothing to attach to.
  if (!MuseUI || !MuseUI.codingAgents) return;

  // The install commands, the same ones lib/cursor.mjs CURSOR_HINT gives.
  const CURSOR_WINDOWS = "irm 'https://cursor.com/install?win32=true' | iex";
  const CURSOR_POSIX = 'curl https://cursor.com/install -fsS | bash';
  // The install commands, the same ones lib/grok.mjs GROK_HINT gives.
  const GROK_WINDOWS = 'irm https://x.ai/cli/install.ps1 | iex';
  const GROK_POSIX = 'curl -fsSL https://x.ai/cli/install.sh | bash';
  // The order of the cards in the group: Claude Code, Codex, Gemini CLI and Muse Code are 10 to 40 (app.js BUILT_IN_AGENTS), then Cursor, then Grok Build.
  const CURSOR_ORDER = 50;
  const GROK_ORDER = 60;
  // Antigravity (DECISIONS item 89): Google's CLI for Gemini subscriptions, after Grok Build. The commands lib/antigravity.mjs AGY_HINT gives.
  const AGY_ORDER = 70;
  const AGY_WINDOWS = 'irm https://antigravity.google/cli/install.ps1 | iex';
  const AGY_POSIX = 'curl -fsSL https://antigravity.google/cli/install.sh | bash';

  function make(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // The pill and its tone for the state. c is the CLI's status from GET /api/accounts/cli, or null when that read failed.
  function pillOf(c) {
    if (!c) return { text: 'Sign-in unknown', ok: false };
    if (!c.installed) return { text: 'Not installed', ok: false };
    if (c.signedIn === true) return { text: 'Signed in', ok: true };
    if (c.signedIn === false) return { text: 'Not signed in', ok: false };
    return { text: 'Sign-in unknown', ok: false };
  }

  // The card while GET /api/accounts/cli has not answered yet (ctx.cliPending: app.js paints Accounts as each request returns). It says so and
  // offers nothing; MuseUI.redrawAgentCards puts the real card in its place when the answer comes.
  function pendingCard(mark, id, name, account) {
    const card = MuseUI.cardShell(mark, id, name, account, 'Checking…', false);
    card.append(MuseUI.para('Checking this sign-in…'));
    return card;
  }

  // The two install commands, one for each system, each set as code so it can be copied.
  function installBlock(windows, posix) {
    const block = make('div', 'cli-cmds');
    block.append(
      make('p', 'cli-cmd-label', 'Windows, in PowerShell'),
      make('code', 'cli-cmd', windows),
      make('p', 'cli-cmd-label', 'macOS or Linux, in a terminal'),
      make('code', 'cli-cmd', posix),
    );
    return block;
  }

  // ---------- the install steps, for the setup guide ----------

  // Codex's command is the one lib/providers.mjs INSTALL_HINT gives. Gemini CLI's is built by the server for this computer
  // (providerStatus, installCommand), so the caller passes it in; this one is the plain form for when the server sent none.
  const CODEX_INSTALL = 'npm install -g @openai/codex';
  const GEMINI_INSTALL = 'npm install -g @google/gemini-cli';
  // The sentence after the install steps. button is the name of the button that reads the status again: the setup guide's is Check again,
  // the Accounts cards' is Refresh (opts.button of cliInstallBlock).
  const afterInstall = button => `Then press ${button}. If it still shows Not installed, restart Plenum.`;

  // One command as code, with a Copy button that puts exactly that text on the clipboard.
  function commandRow(label, command) {
    const row = make('div', 'cli-cmd-row');
    const copy = MuseUI.button('ghost small', 'Copy');
    copy.setAttribute('aria-label', `Copy the command${label ? ` for ${label}` : ''}`);
    copy.addEventListener('click', async () => {
      const ok = typeof MuseUI.copyText === 'function' ? await MuseUI.copyText(command) : false;
      if (ok) MuseUI.toast('Copied.');
      else MuseUI.toast('The command could not be copied. Select it and copy it by hand.', 'bad');
    });
    row.append(make('code', 'cli-cmd', command), copy);
    return row;
  }

  // The install steps for a CLI that is not installed: what to run, a Copy button for each command, and what to do afterwards.
  // id is the CLI's id in the setup guide; info is that CLI's status from the server (Gemini's own install command is read from it).
  // Muse Code has no install command in this repository, so it gets a plain sentence and no command. Returns null for an unknown id.
  // The caller builds it again with replaceChildren when it paints, so a repaint does not stack a second block.
  function cliInstallBlock(id, info, opts) {
    const button = typeof opts?.button === 'string' && opts.button ? opts.button : 'Check again';
    const block = make('div', 'cli-cmds');
    if (id === 'muse') {
      block.append(make('p', '', `Install Muse Code from its publisher, then press ${button}.`), make('p', '', 'If it still shows Not installed, restart Plenum.'));
      return block;
    }
    if (id === 'codex' || id === 'gemini') {
      const own = id === 'gemini' && typeof info?.installCommand === 'string' && info.installCommand ? info.installCommand : null;
      block.append(
        make('p', '', 'Run this in a terminal. It needs Node.js.'),
        commandRow(id === 'codex' ? 'Codex' : 'Gemini CLI', own ?? (id === 'codex' ? CODEX_INSTALL : GEMINI_INSTALL)),
        make('p', '', afterInstall(button)),
      );
      return block;
    }
    const pairs = { cursor: [CURSOR_WINDOWS, CURSOR_POSIX], grok: [GROK_WINDOWS, GROK_POSIX], antigravity: [AGY_WINDOWS, AGY_POSIX] }[id];
    if (!pairs) return null;
    block.append(
      make('p', '', 'Run the command for your system in a terminal.'),
      make('p', 'cli-cmd-label', 'Windows, in PowerShell'),
      commandRow('Windows', pairs[0]),
      make('p', 'cli-cmd-label', 'macOS or Linux, in a terminal'),
      commandRow('macOS or Linux', pairs[1]),
      make('p', '', afterInstall(button)),
    );
    return block;
  }
  MuseUI.cliInstallBlock = cliInstallBlock;

  // ---------- noticing a finished sign-in ----------

  // Sign-in happens in a terminal and a browser, outside Plenum, so Plenum has to look. watchSignIn reads the sign-in status on a timer
  // (every 2 seconds, every 4 after a minute) until it shows the person signed in, 3 minutes have passed, or the page that asked is
  // gone. It also reads at once when the window gets focus again or the tab becomes visible. A hidden page is not read for. The last
  // read is the first one after the 3 minutes; if the person is away then, it waits for them to come back. One read is in flight at
  // a time, and a second watch with the same id replaces the first. It never starts a sign-in and never signs anyone out.
  // opts: { id, read(), done(result), alive(), since, onWait(), onProgress(result), onDone(result), onGiveUp(), onClosed() }.
  // read() returns the status; a read that throws is a read that saw nothing. onProgress runs after each read, before done().
  // since is the time the sign-in window was opened, for a watch that is taken up again after a redraw (the 3 minutes count from it).
  const WATCH_FIRST_MS = 2000;
  const WATCH_SLOW_MS = 4000;
  const WATCH_SLOW_AFTER_MS = 60000;
  const WATCH_MAX_MS = 180000;
  const watchers = new Map();
  let listening = false;

  const pageHidden = () => document.visibilityState === 'hidden';
  // Away: the page is hidden, or its window is not the one in use (the person is in the terminal or the browser).
  const away = () => pageHidden() || (typeof document.hasFocus === 'function' && !document.hasFocus());
  function kickAll() {
    for (const w of [...watchers.values()]) w.kick();
  }
  function listen() {
    if (listening) return;
    listening = true;
    window.addEventListener?.('focus', kickAll);
    document.addEventListener?.('visibilitychange', kickAll);
  }
  function unlisten() {
    if (!listening || watchers.size) return;
    listening = false;
    window.removeEventListener?.('focus', kickAll);
    document.removeEventListener?.('visibilitychange', kickAll);
  }

  function watchSignIn(opts) {
    const { id, read, done, alive, since, onWait, onProgress, onDone, onGiveUp, onClosed } = opts ?? {};
    // Without timers (a bare test page) there is nothing to watch with; the person presses Refresh as before.
    if (typeof id !== 'string' || typeof read !== 'function' || typeof done !== 'function' || typeof setTimeout !== 'function') return null;
    watchers.get(id)?.stop();
    const w = { startedAt: typeof since === 'number' ? since : Date.now(), timer: null, busy: false, over: false };
    const stop = () => {
      if (w.over) return;
      w.over = true;
      clearTimeout(w.timer);
      if (watchers.get(id) === w) watchers.delete(id);
      unlisten();
    };
    // A callback that throws must not leave the timer running.
    const finish = (cb, arg) => {
      stop();
      try { cb?.(arg); } catch { /* the page keeps working without the notice */ }
    };
    const closed = () => typeof alive === 'function' && !alive();
    const late = () => Date.now() - w.startedAt >= WATCH_MAX_MS;
    const schedule = () => {
      if (w.over) return;
      w.timer = setTimeout(tick, Date.now() - w.startedAt >= WATCH_SLOW_AFTER_MS ? WATCH_SLOW_MS : WATCH_FIRST_MS);
    };
    async function tick() {
      if (w.over || w.busy) return;
      clearTimeout(w.timer);
      if (closed()) return finish(onClosed);
      // When the 3 minutes end while the person is away, nothing is decided yet: the timer stops, and the watch reads once more when
      // they come back (the focus and visibility events call tick). A sign-in that took longer is still noticed then.
      if (late() && away()) return;
      // A hidden tab waits; the visibility event reads when it comes back.
      if (pageHidden()) return schedule();
      w.busy = true;
      let result;
      let seen = false;
      try {
        result = await read();
        seen = true;
      } catch {
        // A failed read is a read that saw nothing: keep waiting.
      }
      w.busy = false;
      if (w.over) return;
      if (seen) {
        try { onProgress?.(result); } catch { /* the notice is only a convenience */ }
        if (w.over) return;
        if (done(result)) return finish(onDone, result);
      }
      if (closed()) return finish(onClosed);
      if (late()) return finish(onGiveUp);
      schedule();
    }
    w.stop = stop;
    w.kick = () => { if (!w.over && !w.busy && !pageHidden()) tick(); };
    watchers.set(id, w);
    listen();
    try { onWait?.(); } catch { /* as above */ }
    schedule();
    return { stop };
  }
  MuseUI.watchSignIn = watchSignIn;

  // The watch for a card in Accounts. It reads GET /api/accounts/cli and patches only this card while it waits (a redraw of the whole
  // page every 2 seconds would drop what the person is typing in another card). Most reads are the quick one, which answers from what
  // the server last saw; every 8 seconds one asks the server to look again (?refresh=1), because Antigravity is otherwise read only
  // every few minutes. When the sign-in shows, this one card is built again in place. A CLI that is already signed in is not watched:
  // the read would say so at once and mean nothing.
  // cardWatch keeps the time each sign-in window was opened, so a card that is drawn again (Refresh, or Accounts closed and opened)
  // within the 3 minutes goes on waiting instead of falling back to Not signed in.
  const FORCE_EVERY_MS = 8000;
  const cardWatch = new Map();
  const shown = card => card.isConnected !== false && !(typeof card.closest === 'function' && card.closest('[hidden]'));

  function watchCard(id, name, card, status, since) {
    if (status?.signedIn === true) {
      cardWatch.delete(id);
      return;
    }
    const pill = card.querySelector?.('.pill');
    const was = pillOf(status).text;
    const started = typeof since === 'number' ? since : Date.now();
    let forcedAt = Date.now();
    const watch = watchSignIn({
      id: `card-${id}`,
      since: started,
      read: () => {
        const force = Date.now() - forcedAt >= FORCE_EVERY_MS;
        if (force) forcedAt = Date.now();
        return MuseUI.api(force ? '/api/accounts/cli?refresh=1' : '/api/accounts/cli');
      },
      done: cli => cli?.[id]?.signedIn === true,
      alive: () => shown(card),
      onWait: () => { if (pill) pill.textContent = 'Waiting for sign-in'; },
      onDone: cli => {
        cardWatch.delete(id);
        MuseUI.toast(`Signed in to ${name}.`);
        redrawCard(id, card, cli);
      },
      onGiveUp: () => {
        cardWatch.delete(id);
        if (pill) pill.textContent = was;
        MuseUI.toast('Plenum has not seen the sign-in yet. Press Refresh to check again, or sign in again.');
      },
      // The card left the page. The time stays in cardWatch, so the card takes the watch up again if it is drawn within the 3 minutes.
      onClosed: () => { if (pill) pill.textContent = was; },
    });
    if (watch) cardWatch.set(id, started);
  }

  // A card that is drawn while its sign-in is still awaited goes on waiting. Called by each card when it is built.
  function resumeWatch(id, name, card, status) {
    const started = cardWatch.get(id);
    if (started === undefined) return;
    if (status?.signedIn === true || Date.now() - started >= WATCH_MAX_MS) cardWatch.delete(id);
    else watchCard(id, name, card, status, started);
  }

  // Builds one card again in its place from a fresh status, so the rest of the page (a key being typed, the scroll position) stays as
  // it is. Focus that was in the old card moves to the new one. If the card cannot be swapped, the page is drawn again as before.
  function redrawCard(id, card, cli) {
    try {
      const fresh = CARDS[id]({ cli });
      if (card.dataset?.card) fresh.dataset.card = card.dataset.card;
      const focused = typeof card.contains === 'function' && card.contains(document.activeElement);
      card.replaceWith(fresh);
      if (focused) fresh.querySelector?.('button:not([disabled])')?.focus?.();
    } catch {
      MuseUI.refreshDrawer();
    }
  }

  // Cursor's card text for the state. Every line says what happens, then the way back.
  function describeCursor(card, c) {
    if (!c) {
      card.append(MuseUI.para('Cursor status is not available yet. Press Refresh.'));
      return;
    }
    if (!c.installed) {
      // The server may name why the `agent` on PATH is not Cursor's CLI. That text is shown as it is sent.
      if (typeof c.note === 'string' && c.note) card.append(MuseUI.para(c.note));
      card.append(MuseUI.para('Install the Cursor CLI first, then press Refresh. Run the command for your system in a terminal:'));
      card.append(installBlock(CURSOR_WINDOWS, CURSOR_POSIX));
      card.append(MuseUI.para('If it still shows Not installed after Refresh, restart Plenum.'));
      return;
    }
    if (c.signedIn === true) {
      const email = typeof c.email === 'string' && c.email ? ` for ${c.email}` : '';
      card.append(MuseUI.para(`Cursor has a saved sign-in on this computer${email}.`));
      return;
    }
    if (c.signedIn === false) {
      card.append(MuseUI.para('Sign in to your Cursor account. A terminal opens and your browser completes the sign-in; then press Refresh.'));
      return;
    }
    card.append(MuseUI.para('Plenum could not tell whether Cursor is signed in. If it is not, sign in to your Cursor account: a terminal opens and your browser completes the sign-in. Then press Refresh.'));
  }

  // The Cursor card. ctx is { accounts, cli } from app.js renderAccounts; only cli is used here.
  function cursorCard(ctx) {
    if (ctx?.cliPending === true) return pendingCard('U', 'cursor', 'Cursor', 'Cursor account');
    const c = ctx?.cli?.cursor ?? null;
    const state = pillOf(c);
    const card = MuseUI.cardShell('U', 'cursor', 'Cursor', 'Cursor account', state.text, state.ok);
    describeCursor(card, c);
    card.append(MuseUI.para('Cursor asks Plenum before it edits or runs commands, so Ask first works. Its tools are its own.'));

    const actions = document.createElement('div');
    actions.className = 'actions';
    // The button names the product, as the other coding agents' buttons do. It is off until the CLI is installed.
    const signIn = MuseUI.button('primary small', 'Sign in to Cursor');
    signIn.disabled = !c?.installed;
    if (!c?.installed) signIn.title = 'Cursor is not installed. Install it, press Refresh, then sign in.';
    signIn.addEventListener('click', async () => {
      try {
        await MuseUI.api('/api/accounts/cursor/login', {});
        MuseUI.toast('Sign-in window opened. Finish in your browser, then press Refresh.');
        watchCard('cursor', 'Cursor', card, c);
      } catch (err) {
        MuseUI.toast(err.message, 'bad');
      }
    });
    const refresh = MuseUI.button('ghost small', 'Refresh');
    refresh.addEventListener('click', () => MuseUI.refreshDrawer());
    actions.append(signIn, refresh);
    card.append(actions);
    // The provider-terms strip sits above the Sign in row, as on the other coding agents' cards. It informs; the sign-in still runs on the button.
    MuseUI.notice?.('provider-terms', { before: actions });
    resumeWatch('cursor', 'Cursor', card, c);
    return card;
  }

  // Grok Build's card text for the state. The unknown state says what Plenum can and cannot tell (lib/grok.mjs grokStatus).
  function describeGrok(card, g) {
    if (!g) {
      card.append(MuseUI.para('Grok Build status is not available yet. Press Refresh.'));
      return;
    }
    if (!g.installed) {
      card.append(MuseUI.para('Install Grok Build first, then press Refresh. Run the command for your system in a terminal:'));
      card.append(installBlock(GROK_WINDOWS, GROK_POSIX));
      card.append(MuseUI.para('If it still shows Not installed after Refresh, restart Plenum.'));
      return;
    }
    if (g.signedIn === true) {
      card.append(MuseUI.para('Grok Build has a saved sign-in on this computer.'));
      return;
    }
    if (g.signedIn === false) {
      card.append(MuseUI.para('Sign in to your SuperGrok or X Premium Plus account. A terminal opens and your browser completes the sign-in; then press Refresh.'));
      return;
    }
    card.append(MuseUI.para('Plenum cannot tell whether Grok Build is signed in; the first reply says if sign-in is needed. Sign in to Grok Build opens a terminal, and your browser completes the sign-in there. Then press Refresh.'));
  }

  // The Grok Build card. The same ctx as Cursor's. Its sign-in is the CLI's own `grok login`, and the API key for Grok stays on the xAI card.
  function grokCard(ctx) {
    if (ctx?.cliPending === true) return pendingCard('K', 'grok', 'Grok Build', 'SuperGrok or X Premium Plus');
    const g = ctx?.cli?.grok ?? null;
    const state = pillOf(g);
    const card = MuseUI.cardShell('K', 'grok', 'Grok Build', 'SuperGrok or X Premium Plus', state.text, state.ok);
    describeGrok(card, g);
    card.append(MuseUI.para('Grok Build asks Plenum before it edits or runs commands. By API key, use the xAI card below.'));

    const actions = document.createElement('div');
    actions.className = 'actions';
    // The button names the product, as the other coding agents' buttons do. It is off until the CLI is installed.
    const signIn = MuseUI.button('primary small', 'Sign in to Grok Build');
    signIn.disabled = !g?.installed;
    if (!g?.installed) signIn.title = 'Grok Build is not installed. Install it, press Refresh, then sign in.';
    signIn.addEventListener('click', async () => {
      try {
        await MuseUI.api('/api/accounts/grok/login', {});
        MuseUI.toast('Sign-in window opened. Finish in your browser, then press Refresh.');
        watchCard('grok', 'Grok Build', card, g);
      } catch (err) {
        MuseUI.toast(err.message, 'bad');
      }
    });
    const refresh = MuseUI.button('ghost small', 'Refresh');
    refresh.addEventListener('click', () => MuseUI.refreshDrawer());
    actions.append(signIn, refresh);
    card.append(actions);
    // The provider-terms strip sits above the Sign in row, as on the other coding agents' cards. It informs; the sign-in still runs on the button.
    MuseUI.notice?.('provider-terms', { before: actions });
    resumeWatch('grok', 'Grok Build', card, g);
    return card;
  }

  MuseUI.codingAgents.add({ id: 'cursor', order: CURSOR_ORDER, card: cursorCard });
  MuseUI.codingAgents.add({ id: 'grok', order: GROK_ORDER, card: grokCard });

  // The Antigravity card. Its state comes from the last read of the account's models (lib/antigravity.mjs): signed in when the read
  // worked, not signed in when Antigravity said authentication is required. tier is the plan Antigravity named, such as Google AI Pro.
  function antigravityCard(ctx) {
    if (ctx?.cliPending === true) return pendingCard('A', 'antigravity', 'Antigravity', 'Google AI Pro, Ultra or Plus');
    const a = ctx?.cli?.antigravity ?? null;
    const state = pillOf(a);
    const card = MuseUI.cardShell('A', 'antigravity', 'Antigravity', 'Google AI Pro, Ultra or Plus', state.text, state.ok);
    if (!a) {
      card.append(MuseUI.para('Antigravity status is not available yet. Press Refresh.'));
    } else if (!a.installed) {
      card.append(MuseUI.para('Install the Antigravity CLI first in a terminal of your own, then restart Plenum:'));
      card.append(installBlock(AGY_WINDOWS, AGY_POSIX));
    } else if (a.signedIn === true) {
      card.append(MuseUI.para(a.tier ? `Signed in. Antigravity reports your plan as ${a.tier}; its models are in the model menu.` : 'Signed in; its models are in the model menu.'));
    } else if (a.signedIn === false) {
      card.append(MuseUI.para('Use the Google account of your Gemini subscription. A terminal opens and your browser completes the sign-in; then press Refresh.'));
    } else {
      card.append(MuseUI.para('Plenum has not read Antigravity yet. Press Refresh; if it says sign-in is needed, use Sign in to Antigravity.'));
    }
    card.append(MuseUI.para('Google moved Gemini subscriptions from Gemini CLI to Antigravity. Antigravity asks Plenum before it edits or runs commands.'));
    const actions = document.createElement('div');
    actions.className = 'actions';
    const signIn = MuseUI.button('primary small', a?.signedIn === true ? 'Sign in again' : 'Sign in to Antigravity');
    signIn.disabled = !a?.installed;
    if (!a?.installed) signIn.title = 'Antigravity is not installed. Install it, press Refresh, then sign in.';
    signIn.addEventListener('click', async () => {
      try {
        await MuseUI.api('/api/accounts/antigravity/login', {});
        MuseUI.toast('Sign-in window opened. Finish in your browser, then press Refresh.');
        watchCard('antigravity', 'Antigravity', card, a);
      } catch (err) {
        MuseUI.toast(err.message, 'bad');
      }
    });
    const refresh = MuseUI.button('ghost small', 'Refresh');
    refresh.addEventListener('click', () => MuseUI.refreshDrawer());
    actions.append(signIn, refresh);
    card.append(actions);
    MuseUI.notice?.('provider-terms', { before: actions });
    resumeWatch('antigravity', 'Antigravity', card, a);
    return card;
  }
  // The card builders by id, for redrawCard.
  const CARDS = { cursor: cursorCard, grok: grokCard, antigravity: antigravityCard };
  // Puts the real card in place of each pending one when GET /api/accounts/cli answers (cli is null when that read failed, and the cards say
  // so). A card that is no longer on the page is skipped. Called by app.js renderAccounts.
  MuseUI.redrawAgentCards = cli => {
    for (const id of Object.keys(CARDS)) {
      const card = document.querySelector(`[data-card="${id}"]`);
      if (card) redrawCard(id, card, cli ?? null);
    }
  };
  MuseUI.codingAgents.add({ id: 'antigravity', order: AGY_ORDER, card: antigravityCard });
})();
