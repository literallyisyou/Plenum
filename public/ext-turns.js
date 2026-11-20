// Edit, Rewind, regenerate and copy on every turn. Loaded by ext.js and adds itself through window.MuseUI.
// Under each turn sits a small row of ghost buttons. A question gets Edit: it and the messages after it leave the chat
// (POST /api/chat/rewind), and its text goes back into the composer. A question of the chat also gets Rewind (pro-05): the
// choices are Code and chat, Code only and Chat only. Code is the files of the project: the turn snapshot taken before that question
// (lib/hooks/10-snapshot.mjs) puts them back after an approval card (window.MuseRestore, public/ext-checkpoints.js). Chat only cuts the
// chat like Edit, without filling the composer. A reply gets Copy (its Markdown, to the clipboard) and Insert (into the composer). The
// last reply of the chat also gets Regenerate: the chat is cut back to the question before it, and that question is sent again, to the
// chat's model or to the one chosen in the row. A panel may add its own buttons to a turn's row: every function in window.MuseTurnExtras
// is called with { kind, message, index, messages, article } and the nodes it returns go into the row.
// The rows are drawn and used only while the page is idle. The server does the cutting; this file only draws the rows and sends the text back.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const BAR = 'ext-turns-bar';
  const COPIED_MS = 1400;
  // True while an Edit or a Regenerate request is on its way, so the rows wait and a second request cannot start.
  let working = false;
  // Set while a redraw of the rows is queued for the next frame, so a burst of changes is drawn once.
  let frame = 0;

  // app.js puts Stop on the send button while a reply streams. The rows are drawn and used only when this is false.
  const runGoing = () => MuseUI.el.send.classList.contains('stop');
  const composerHasText = () => MuseUI.el.input.value.trim() !== '';

  // The messages that draw a question turn, in order, each with its place in the transcript. This mirrors messageNodes in
  // app.js: a compact summary and a build's own note draw no question turn, and every other user message does. A council
  // question draws one too, and it gets no row, because the server edits only plain questions.
  function questionsOf(messages) {
    const out = [];
    messages.forEach((m, index) => {
      if (m.role === 'user' && !m.compact && m.kind !== 'build') out.push({ m, index });
    });
    return out;
  }

  // The messages that draw a reply turn, in order, with their place. This mirrors messageNodes as well: a reply made only of
  // tool steps draws no turn, and council, build and advisor messages draw their own cards. A reply that failed or was stopped, with no text and
  // no steps, draws an error line or a quiet note instead of a reply turn (app.js, B-49).
  function repliesOf(messages) {
    const out = [];
    messages.forEach((m, index) => {
      if (m.role === 'user' || m.compact) return;
      if (m.kind === 'council' || m.kind === 'build' || m.kind === 'advisor') return;
      const hasText = String(m.content ?? '').trim() !== '';
      if (!hasText && (m.error || m.aborted)) return;
      if (hasText || !(m.tools ?? []).length) out.push({ m, index });
    });
    return out;
  }

  // The place of the plain question that a reply answers: the last one before the reply, or -1 when there is none.
  function questionBefore(messages, at) {
    for (let i = at - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'user' && m.kind === 'chat' && !m.compact) return i;
    }
    return -1;
  }

  // Puts text in the composer the way a reply is put there: the box resizes (app.js listens for input) and takes focus.
  function setComposer(text) {
    const input = MuseUI.el.input;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    input.focus();
  }

  function rowOf(controls) {
    const row = document.createElement('div');
    row.className = BAR;
    row.append(...controls);
    return row;
  }

  // The nodes the panels that registered in window.MuseTurnExtras add for one turn. A function that fails is logged and skipped.
  // The reply element is also reachable as classList, because the Review button (ext-review.js) reads the element it is given.
  function extrasFor(kind, message, index, messages, article) {
    const out = [];
    const extras = Array.isArray(window.MuseTurnExtras) ? window.MuseTurnExtras : [];
    for (const fn of extras) {
      if (typeof fn !== 'function') continue;
      try {
        const ctx = { kind, message, index, messages, article };
        Object.defineProperty(ctx, 'classList', { get: () => article.classList });
        const got = fn(ctx);
        for (const node of Array.isArray(got) ? got : [got]) {
          if (node instanceof Node) out.push(node);
        }
      } catch (err) {
        console.error('A turn extra could not draw its button:', err);
      }
    }
    return out;
  }

  // Puts text on the clipboard. The clipboard API is missing, or refuses (no permission, or a page that is not secure). Then a
  // hidden text box holds the text, the page's copy command takes it, and the box is removed. False only when both fail.
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // The copy command below is the fallback.
    }
    const was = document.activeElement;
    const box = document.createElement('textarea');
    box.className = 'ext-turns-copy';
    box.readOnly = true;
    box.value = text;
    document.body.append(box);
    let ok = false;
    try {
      box.select();
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    } finally {
      box.remove();
      if (was instanceof HTMLElement) was.focus();
    }
    return ok;
  }

  // Copy the Markdown shown in the reply. Folded model protocol stays in its disclosure.
  function copyButton(text) {
    const b = MuseUI.button('ghost small ext-turns-btn', 'Copy');
    b.title = 'Copy this reply as Markdown';
    let timer = 0;
    b.addEventListener('click', async () => {
      if (!(await copyText(text))) {
        MuseUI.toast('The reply could not be copied. Select the text and copy it instead.', 'bad');
        return;
      }
      clearTimeout(timer);
      b.textContent = 'Copied';
      timer = setTimeout(() => { b.textContent = 'Copy'; }, COPIED_MS);
    });
    return b;
  }

  // Insert: into an empty composer at once. With text in the composer, Append and Replace take the button's place, so
  // nothing that was typed is lost without a choice.
  function insertButton(text) {
    const b = MuseUI.button('ghost small ext-turns-btn', 'Insert');
    b.title = 'Put this reply in the composer to edit';
    b.addEventListener('click', () => {
      if (!composerHasText()) {
        setComposer(text);
        MuseUI.toast('Reply inserted. Edit it, then send.');
        return;
      }
      const append = MuseUI.button('ghost small ext-turns-btn', 'Append');
      append.title = 'Add this reply after the text in the composer';
      const replace = MuseUI.button('ghost small ext-turns-btn', 'Replace');
      replace.title = 'Replace the text in the composer with this reply';
      // Either choice puts Insert back in the row, for the next reply.
      const done = () => {
        append.replaceWith(insertButton(text));
        replace.remove();
      };
      append.addEventListener('click', () => {
        const current = MuseUI.el.input.value;
        setComposer(`${current}${current.endsWith('\n') ? '\n' : '\n\n'}${text}`);
        done();
      });
      replace.addEventListener('click', () => {
        setComposer(text);
        done();
      });
      b.replaceWith(append, replace);
      append.focus();
    });
    return b;
  }

  // Council mode is the mode button that is pressed. Sent as plain text there, a question would ask every seat.
  const councilOn = () => document.querySelector('.seg-btn[data-mode][aria-pressed="true"]')?.dataset.mode === 'council';

  // The text that sends a question again. With a model chosen it goes through /ask. Without one, a question that starts with
  // a slash would run as a command, and in Council mode a plain send would ask every seat. Both go through /ask with the
  // chat's own model, which is what a plain send uses in Chat mode.
  // The chat's own model is the model of the chat on screen (the thread's, the project's, then the app's), not the app-wide one.
  const chatModel = () => MuseUI.modelInUse?.() || MuseUI.state.model;
  function sendText(text, ref) {
    if (ref) return `/ask ${ref} ${text}`;
    const model = chatModel();
    if ((text.startsWith('/') || councilOn()) && model) return `/ask ${model} ${text}`;
    return text;
  }

  // The chat on screen, named in full: a cut or a rewind acts on this thread even when another window or the phone switches the
  // project's active thread before the request arrives (DECISIONS 106). Main is named by the project's id. Taken before a confirm opens.
  const scopeNow = () => {
    const project = MuseUI.state.activeProject;
    return { project, thread: MuseUI.state.activeThread || project };
  };

  // Cuts the chat back to the message at index on the server, then draws the chat again. Resolves to the text of the
  // question that was cut, or to null when the server refused (the reason is shown).
  async function cutBack(index, scope = scopeNow()) {
    working = true;
    decorate();
    try {
      const data = await MuseUI.api('/api/chat/rewind', { ...scope, index });
      await MuseUI.refresh();
      return String(data.text ?? '');
    } catch (err) {
      MuseUI.toast(err.message, 'bad');
      return null;
    } finally {
      working = false;
      schedule();
    }
  }

  // What the Edit confirm says goes: the question, the messages after it (n of them), and where its text goes.
  function editGoes(n) {
    if (n === 0) return 'It is removed from the chat and its text goes back to the composer.';
    const which = n === 1 ? 'It and the message after it' : `It and the ${n} messages after it`;
    return `${which} are removed from the chat, and the text goes back to the composer.`;
  }

  // Edit: the question and everything after it go, and the question goes back into the composer to be changed and sent.
  async function editQuestion(index) {
    if (working || runGoing()) return;
    if (composerHasText()) return MuseUI.toast('The composer already has text. Clear it first, then edit the message.', 'bad');
    const n = (MuseUI.state.messages ?? []).length - index - 1;
    const scope = scopeNow();
    const sure = await MuseUI.confirm({ title: 'Edit message', body: `Edit this message? ${editGoes(n)} Undo stays above the composer until you send a message.`, action: 'Edit message', tone: 'danger', focusCancel: true });
    if (sure !== true) return;
    const text = await cutBack(index, scope);
    if (text === null) return;
    setComposer(text);
  }

  function editButton(index) {
    const b = MuseUI.button('ghost small ext-turns-btn', 'Edit');
    b.title = 'Edit this message. It and the replies after it are removed, and the text goes into the composer';
    b.addEventListener('click', () => editQuestion(index));
    return b;
  }

  // ---------- Rewind (pro-05) ----------

  const enc = encodeURIComponent;
  // Said in the Rewind tooltips: what a turn snapshot leaves out (lib/shadow.mjs), so a person does not expect those files back.
  const SECRETS_NOTE = 'Secret files such as .env and private keys are not kept and are not restored.';

  // Why a question has no code snapshot, for the disabled choices. The server says it in record.snap.skipped.
  function noSnapshotReason(m) {
    if (m.snap?.expired === true) return 'it is older than the last 50 turns, so its code is no longer kept';
    if (typeof m.snap?.skipped === 'string' && m.snap.skipped) return m.snap.skipped;
    return 'it was sent before turn snapshots were kept';
  }

  // The chat-only confirm: how many messages go, and the Undo line that stays above the composer.
  function chatGoes(n) {
    if (n === 0) return 'It is removed from the chat.';
    return n === 1 ? 'It and the message after it are removed.' : `It and the ${n} messages after it are removed.`;
  }

  // Chat only: the chat is cut back to the question, as Edit does, and the composer is left as it is.
  async function rewindChat(index) {
    if (working || runGoing()) return;
    const n = (MuseUI.state.messages ?? []).length - index - 1;
    const scope = scopeNow();
    const ok = await MuseUI.confirm({
      title: 'Rewind the chat to before this message?',
      body: `${chatGoes(n)} Undo stays above the composer until you send a message.`,
      action: 'Rewind chat',
      tone: 'danger',
      focusCancel: true,
    });
    if (!ok) return;
    await cutBack(index, scope);
  }

  // The button in the drawer that undoes the code rewind (the server keeps the files as they were before it, for this scope).
  function undoButton(scope) {
    const b = MuseUI.button('ghost', 'Undo code rewind');
    b.title = 'Put back the files this rewind changed';
    b.addEventListener('click', () => {
      window.MuseRestore?.run({
        title: 'Undo code rewind',
        url: '/api/snapshots/rewind',
        payload: { ...scope, undo: true },
        diffUrl: `/api/snapshots/diff?project=${enc(scope.project)}&thread=${enc(scope.thread)}&undo=1`,
        approveText: 'Approve undo',
        restoredText: ev => `Undo done: put back ${(ev.files ?? []).length} files and removed ${(ev.removed ?? []).length}.`,
      });
    });
    return b;
  }

  // Code only: the files go back to before this question. The card lists them, and the drawer offers Undo once they are back.
  function rewindCode(index, after) {
    const scope = scopeNow();
    return window.MuseRestore?.run({
      title: 'Rewind code',
      url: '/api/snapshots/rewind',
      payload: { ...scope, index },
      diffUrl: `/api/snapshots/diff?project=${enc(scope.project)}&thread=${enc(scope.thread)}&index=${index}`,
      approveText: 'Approve rewind',
      onEnd: (ev, view) => {
        // A rewind that stopped part way keeps its record (the server says so with undo set), so Undo is offered for it as well. The chat is
        // cut back only when the rewind finished.
        const kept = ev.type === 'error' && ev.undo === true;
        if (ev.type !== 'restored' && !kept) return;
        view.actions.append(undoButton(scope));
        if (ev.type === 'restored' && after) after(scope);
      },
    });
  }

  // The three choices that take the Rewind button's place. The two code choices need the snapshot the turn kept before it.
  function choiceButtons(m, index) {
    const hasSnap = typeof m.snap?.before?.tree === 'string' && m.snap.expired !== true;
    const reason = noSnapshotReason(m);
    const disabledTitle = `No snapshot before this turn: ${reason}`;
    const both = MuseUI.button('ghost small ext-turns-btn', 'Code and chat');
    both.title = hasSnap ? `Put the files back, then cut the chat back to before this message. ${SECRETS_NOTE}` : disabledTitle;
    both.disabled = !hasSnap;
    both.addEventListener('click', () => rewindCode(index, scope => cutBack(index, scope)));
    const code = MuseUI.button('ghost small ext-turns-btn', 'Code only');
    code.title = hasSnap ? `Put the files back to before this message; the chat stays. ${SECRETS_NOTE}` : disabledTitle;
    code.disabled = !hasSnap;
    code.addEventListener('click', () => rewindCode(index));
    const chat = MuseUI.button('ghost small ext-turns-btn', 'Chat only');
    chat.title = 'Cut the chat back to before this message, as Edit does; the files stay';
    chat.addEventListener('click', () => rewindChat(index));
    const cancel = MuseUI.button('ghost small ext-turns-btn', 'Cancel');
    cancel.title = 'Keep the chat and the files as they are';
    // Cancel puts the Rewind button back in the choices' place.
    cancel.addEventListener('click', () => {
      both.replaceWith(rewindGhost(m, index));
      code.remove();
      chat.remove();
      cancel.remove();
    });
    return [both, code, chat, cancel];
  }

  // The Rewind ghost button. Its click swaps in the choices, and Cancel swaps the button back.
  function rewindGhost(m, index) {
    const b = MuseUI.button('ghost small ext-turns-btn', 'Rewind');
    b.title = `Rewind code, chat or both to before this message. ${SECRETS_NOTE}`;
    b.addEventListener('click', () => {
      if (working || runGoing()) return;
      b.replaceWith(...choiceButtons(m, index));
    });
    return b;
  }

  // Regenerate: the chat is cut back to the question, and the question is sent again. The reply it gets replaces this one.
  async function regenerate(questionIndex, ref) {
    if (working || runGoing()) return;
    if (composerHasText()) return MuseUI.toast('The composer already has text. Clear it first, then regenerate the reply.', 'bad');
    // Without a chat model there is nothing to send the question to, so nothing is cut.
    if (!ref && councilOn() && !chatModel()) return MuseUI.toast('Choose a model first, then regenerate the reply.', 'bad');
    const text = await cutBack(questionIndex, scopeNow());
    if (text === null) return;
    setComposer(sendText(text, ref));
    MuseUI.el.form.requestSubmit();
  }

  // The model choice and the Regenerate button. The first choice is the chat's own model; then every model in the catalog.
  function regenerateControls(questionIndex) {
    const select = document.createElement('select');
    select.className = 'ext-turns-model';
    select.title = 'The model that writes the new reply';
    select.setAttribute('aria-label', 'Model for the new reply');
    select.append(new Option('Same model', ''));
    // A model its provider no longer offers (offered: false) is left out, as in the composer's model menu.
    for (const c of MuseUI.catalog ?? []) {
      if (c.offered === false) continue;
      const ref = `${c.provider}:${c.id}`;
      select.append(new Option(MuseUI.modelName(ref), ref));
    }
    const b = MuseUI.button('ghost small ext-turns-btn', 'Regenerate');
    b.title = 'Ask the question again, and replace this reply with the new one';
    b.addEventListener('click', () => regenerate(questionIndex, select.value));
    return [select, b];
  }

  // ---------- The buttons under a failed reply (DECISIONS: failed-reply buttons) ----------
  // app.js draws a failed reply's error as a card (.turn.error) and puts on it what is known: data-error-kind (the failure's kind) and
  // data-error-model (the model that failed). This part adds the buttons that fit the kind, in a row before Retry and Copy error
  // (ext-connection.js):
  //   Sign in / Open Accounts   opens Settings > Accounts at that program's card. It presses nothing there: no sign-in starts by itself.
  //   Pick another model        gives the model menu the focus and opens it. The person picks; nothing is switched here.
  //   Open the log              asks the desktop app to show the log's folder (POST /api/diag/open-log, the route Help uses); under a
  //                             plain server the answer says where the log is, and that sentence is shown.
  // Retry is not drawn here. Where sending the same message again cannot work (the kind's list has no 'retry'), the card is marked
  // data-retry="no" and a Retry that ext-connection.js put under it is taken out again, before the page is painted.
  // CLI_ACTIONS is the page's copy of FAILURE_ACTIONS in lib/cli-errors.mjs; API_ACTIONS covers the kinds of lib/api-errors.mjs, with
  // 'retry' exactly for the kinds that file calls retryable. build/v06/d-failed-reply/table.test.mjs pins both against the server's files.
  const FAIL = 'ext-turns-fail';
  const CLI_ACTIONS = {
    'not-signed-in': ['sign-in'],
    'sign-in-refused': ['retry', 'sign-in'],
    'sign-in-busy': ['retry', 'sign-in'],
    'model-unavailable': ['pick-model'],
    quota: ['pick-model'],
    overloaded: ['retry', 'pick-model'],
    network: ['retry'],
    'flags-rejected': ['pick-model', 'open-log'],
    'bad-output': ['retry', 'open-log'],
    crashed: ['retry', 'open-log'],
    unknown: ['retry', 'open-log'],
  };
  const API_ACTIONS = {
    auth: ['accounts'],
    'no-credit': ['pick-model'],
    forbidden: ['pick-model'],
    context: [],
    'model-gone': ['pick-model'],
    'rate-limit': ['retry'],
    overloaded: ['retry', 'pick-model'],
    timeout: ['retry'],
    server: ['retry', 'pick-model'],
    network: ['retry'],
    'bad-request': ['pick-model'],
    refusal: ['pick-model'],
    other: ['open-log'],
  };
  // The kinds Plenum sends again by itself (lib/cli-errors.mjs, lib/api-errors.mjs).
  const AUTO_AGAIN = new Set(['sign-in-busy', 'network', 'overloaded', 'crashed']);
  const actionsOf = kind => (Object.hasOwn(CLI_ACTIONS, kind) ? CLI_ACTIONS[kind] : Object.hasOwn(API_ACTIONS, kind) ? API_ACTIONS[kind] : null);

  // The Accounts card of each program, by the name Plenum's own sentences use and by the provider part of a model's id.
  const CARD_BY_LABEL = { 'Claude Code': 'claude', Claude: 'claude', Codex: 'codex', 'Gemini CLI': 'gemini', 'Muse Code': 'muse', Cursor: 'cursor', 'Grok Build': 'grok', Antigravity: 'antigravity' };
  const CARD_BY_PROVIDER = { anthropic: 'claude', claude: 'claude', codex: 'codex', gemini: 'gemini', muse: 'muse', cursor: 'cursor', grok: 'grok', antigravity: 'antigravity' };
  const LABEL_BY_CARD = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', muse: 'Muse Code', cursor: 'Cursor', grok: 'Grok Build', antigravity: 'Antigravity' };
  // An error with no kind (an adapter's own sign-in sentence, a reply stored before kinds were kept) is read only for the two sentences
  // Plenum itself writes: "<name> is not signed in." and "<name> does not offer ...". Nothing else is guessed from an error's words.
  const NOT_SIGNED_IN = /^(.{1,40}?) is not signed in\./;
  const NOT_OFFERED = /(?:^|\. ).{1,60}? does not offer\b/;
  const SAVED_KEY = /\bcould not use the saved\b[^.]{0,40}\bkey\b/;

  // What one failure offers, from its words, its kind and the model that failed: { kind, actions, card, label }, or null when nothing
  // is known about it.
  function failureFrom(words, kindSaid, model) {
    const said = NOT_SIGNED_IN.exec(words);
    let kind = kindSaid || '';
    if (!actionsOf(kind)) kind = said ? 'not-signed-in' : NOT_OFFERED.test(words) ? 'model-unavailable' : '';
    let actions = actionsOf(kind);
    if (!actions) return null;
    // A CLI that runs on a saved key and was refused (Codex on the OpenAI key) needs the key looked at, not a sign-in.
    if (kind === 'not-signed-in' && SAVED_KEY.test(words)) actions = ['accounts'];
    const provider = model.includes(':') ? model.slice(0, model.indexOf(':')) : '';
    // The program named by the sentence comes first (it is the one that failed); else the failed model's own.
    const card = (said && CARD_BY_LABEL[said[1]]) || CARD_BY_PROVIDER[provider] || (/^[a-z][a-z0-9-]{0,31}$/.test(provider) ? provider : '');
    return { kind, actions, card, label: LABEL_BY_CARD[card] ?? '' };
  }

  // What one error card offers.
  function failureOf(article) {
    return failureFrom(article.querySelector(':scope > .turn-body')?.textContent ?? '', article.dataset.errorKind || '', article.dataset.errorModel || '');
  }

  // Says one sentence under the card and, once, to a screen reader (ext-a11y.js; the same words twice in a moment are said once there).
  function sayUnder(article, text, bad = false) {
    let line = article.querySelector(':scope > .ext-turns-fail-say');
    if (!line) {
      line = document.createElement('p');
      line.className = 'ext-turns-fail-say';
      article.append(line);
    }
    line.textContent = text;
    line.classList.toggle('bad', bad);
    window.MuseA11y?.announce?.(text, { urgent: false });
  }

  // Each button below says its sentence through say(text, bad): under the chat's card (sayUnder), or where a panel puts it.
  // again (a panel's own): how the person asks again there, in place of "send your message again".
  function accountsButton(say, found, signIn, again = '') {
    const b = MuseUI.button('ghost small ext-turns-btn', signIn ? 'Sign in' : 'Open Accounts');
    b.dataset.failAction = signIn ? 'sign-in' : 'accounts';
    const where = found.label ? `at the ${found.label} card` : 'in Settings';
    b.title = signIn
      ? `Open Accounts ${where}. Nothing is signed in until you press the button there.`
      : `Open Accounts ${where} to check the saved key.`;
    b.addEventListener('click', () => {
      // The words are said first: opening Accounts covers this card.
      // A panel keeps its sentence with the failure and shows it again later, when Accounts may be closed: it does not say "is open".
      if (again) {
        say(signIn
          ? `No sign-in has started. In Accounts, press the sign-in button on the ${found.label ? `${found.label} ` : ''}card, then ${again}.`
          : `Check the saved key in Accounts, then ${again}.`);
      } else {
        say(signIn
          ? `Accounts is open${found.label ? ` at ${found.label}` : ''}. No sign-in has started: press the sign-in button on the card to start it.`
          : 'Accounts is open. Check the saved key there, then send your message again.');
      }
      MuseUI.openAccountsAt(found.card);
    });
    return b;
  }

  // pick (a panel's own): gives that panel's own model control the focus and returns { ok, text }. Without it: the chat's model menu.
  function modelButton(say, pick = null) {
    const b = MuseUI.button('ghost small ext-turns-btn', 'Pick another model');
    b.dataset.failAction = 'pick-model';
    b.title = pick
      ? 'Shows where this model is chosen. You pick the model; Plenum does not switch it for you.'
      : 'Open the model menu. You pick the model; Plenum does not switch it for you.';
    b.addEventListener('click', () => {
      if (pick) {
        const r = pick() ?? {};
        if (typeof r.text === 'string' && r.text) say(r.text, r.ok === false);
        return;
      }
      const ok = MuseUI.showModelMenu();
      say(ok
        ? 'The model menu has the focus. Pick a model, then send your message again.'
        : 'The model menu is not on screen right now. Open it above the message box, pick a model, then send your message again.', !ok);
    });
    return b;
  }

  function logButton(say) {
    const b = MuseUI.button('ghost small ext-turns-btn', 'Open the log');
    b.dataset.failAction = 'open-log';
    b.title = "Show the folder of Plenum's log file. Help (F1) has a report you can copy.";
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const res = await MuseUI.request('/api/diag/open-log', { method: 'POST', body: {}, signal: AbortSignal.timeout(8000) });
        const r = await res.json().catch(() => null);
        const told = r && typeof r === 'object' ? (typeof r.message === 'string' && r.message ? r.message : typeof r.error === 'string' ? r.error : '') : '';
        if (res.ok && r?.ok === true) say('The log folder is open.');
        else say(told || 'The folder could not be opened. Help (F1) shows the report and where the log is.', true);
      } catch {
        say('The folder could not be opened. Help (F1) shows the report and where the log is.', true);
      } finally {
        b.disabled = false;
      }
    });
    return b;
  }

  // Takes out a Retry that stands under a card whose failure sending again cannot fix. The Copy error beside it stays.
  function dropRetry(article) {
    for (const b of article.querySelectorAll(':scope > .ext-conn-bar button')) if (b.textContent === 'Retry') b.remove();
  }

  // Draws the buttons of every error card that has none yet. Runs inside the observers below (not in the next frame), so a Retry that
  // cannot help is gone before the page is painted. Only while idle, like every other row.
  function failPass() {
    if (working || runGoing()) return;
    for (const article of MuseUI.el.chat.querySelectorAll('.turn.error')) {
      if (article.dataset.retry === 'no') dropRetry(article);
      if (article.dataset.failSeen === '1') continue;
      article.dataset.failSeen = '1';
      const found = failureOf(article);
      if (!found) continue;
      if (!found.actions.includes('retry')) {
        article.dataset.retry = 'no';
        dropRetry(article);
      }
      // A kind Plenum sends again by itself carries its own line ("Plenum sends your message again in ..."), when the turn has one. The line
      // is shown as a quiet note, not as an error; Retry stays for sending at once.
      const auto = typeof article.dataset.errorNotice === 'string' ? article.dataset.errorNotice.trim() : '';
      if (auto && AUTO_AGAIN.has(found.kind) && found.actions.includes('retry')) {
        article.dataset.autoRetry = '1';
        sayUnder(article, auto, false);
      }
      const controls = controlsOf(found, (text, bad) => sayUnder(article, text, bad));
      if (!controls.length) continue;
      const row = document.createElement('div');
      row.className = FAIL;
      row.append(...controls);
      // Before Retry and Copy error when they are already there; they are added after it otherwise.
      article.insertBefore(row, article.querySelector(':scope > .ext-conn-bar, :scope > .ext-turns-fail-say'));
    }
  }
  // The buttons of one failure, in the kind's order, without Retry (the chat's Retry is ext-connection.js's; a panel has its own).
  function controlsOf(found, say, { again = '', pick = null } = {}) {
    const controls = [];
    for (const action of found.actions) {
      if (action === 'sign-in' || action === 'accounts') controls.push(accountsButton(say, found, action === 'sign-in', again));
      else if (action === 'pick-model') controls.push(modelButton(say, pick));
      else if (action === 'open-log') controls.push(logButton(say));
    }
    return controls;
  }
  // The same buttons for a failure a panel shows by itself: a column of Quick compare, a step of a pipeline. The panel gives the
  // failure's words, its kind (the server sends it with the failed column or step) and the model that failed, and:
  //   say(text, bad)  where a button's sentence goes (the panel keeps it with the failure, so a redraw shows it again)
  //   again           how the person asks again in that panel ("come back to Quick compare and press Retry this column")
  //   pick()          gives the panel's own model control the focus and returns { ok, text }; the chat's model menu is not that panel's
  // It returns the buttons, or [] when nothing is known about the failure. As in the chat, a button only opens a place or says where
  // one is: nothing is signed in, no model is changed and nothing is asked again from here.
  function panelControls({ words = '', kind = '', model = '', say, again = '', pick = null } = {}) {
    const found = failureFrom(String(words), String(kind || ''), String(model || ''));
    if (!found || typeof say !== 'function') return [];
    return controlsOf(found, (text, bad) => {
      say(text, bad === true);
      window.MuseA11y?.announce?.(text, { urgent: false });
    }, { again, pick });
  }
  // For the tests and for other panels: the two tables, what a kind offers, and a panel's buttons.
  MuseUI.failedReply = { cli: CLI_ACTIONS, api: API_ACTIONS, actionsOf, controls: panelControls };

  // Draws the rows. Only while idle; the rows already on the page are kept, but none of their controls can be pressed.
  function decorate() {
    const idle = !working && !runGoing();
    for (const control of MuseUI.el.chat.querySelectorAll(`.${BAR} button, .${BAR} select`)) control.disabled = !idle;
    if (!idle) return;
    const messages = MuseUI.state.messages ?? [];
    const questions = questionsOf(messages);
    const replies = repliesOf(messages);
    const chat = MuseUI.el.chat;
    const questionEls = [...chat.querySelectorAll('.turn.user')];
    const replyEls = [...chat.querySelectorAll('.turn.assistant')];
    // Each turn on the page must match a message, one for one, or a row would land on the wrong turn. A difference means the
    // page is still being drawn, so nothing is decorated until it is.
    if (questionEls.length !== questions.length || replyEls.length !== replies.length) return;
    // A chat that stands at its end stays there: the rows make the last turns taller, and the end would slip under the composer.
    // Whether it stands there is read once, before the first row of this pass is added.
    let added = false;
    let atEnd = false;
    const adding = () => {
      if (!added) atEnd = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 4;
      added = true;
    };

    // A turn of an earlier message that is not drawn yet is only its place in a long chat (app.js draws the chat from its end): a
    // hidden, empty article. It gets its row when its turn is drawn into it.
    questions.forEach(({ m, index }, i) => {
      const article = questionEls[i];
      if (article.hidden || m.kind !== 'chat' || article.querySelector(`:scope > .${BAR}`)) return;
      adding();
      article.append(rowOf([editButton(index), rewindGhost(m, index), ...extrasFor('question', m, index, messages, article)]));
    });

    // Only the last reply of the chat itself is regenerated, so the row is added for that one reply.
    const chatReplies = replies.filter(r => r.m.kind === 'chat');
    const lastChat = chatReplies[chatReplies.length - 1];
    replies.forEach((r, i) => {
      const article = replyEls[i];
      if (article.hidden || article.querySelector(`:scope > .${BAR}`)) return;
      const text = PlenumAssistantContent.clean(r.m.content).text;
      const controls = text.trim() ? [copyButton(text), insertButton(text)] : [];
      const question = r === lastChat ? questionBefore(messages, r.index) : -1;
      if (question >= 0) controls.push(...regenerateControls(question));
      controls.push(...extrasFor('reply', r.m, r.index, messages, article));
      adding();
      article.append(rowOf(controls));
    });
    if (atEnd) chat.scrollTo({ top: chat.scrollHeight, behavior: 'instant' });
  }

  // One more pass in the next frame, once the changes of a redraw are all in.
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      decorate();
    });
  }

  // The page redraws the chat by replacing its children, and the send button changes class when a run starts or ends.
  // A reply that is arriving is drawn into its run box many times a second. No row is drawn or changed while a run is going, so a
  // change inside a run box asks for no pass; the box itself joining or leaving the chat still does.
  const outsideRunBox = records => records.some(r => !(r.target instanceof Element && r.target.closest('.run-box')));
  // The buttons of a failed reply and the rows are drawn at once, before the page is painted: a row that arrived a frame later made
  // its turn taller under the reader's eyes and pushed the end of the chat out of the window. The pass in the next frame stays, for
  // what is only known then (a panel that registered its extras meanwhile).
  const pass = () => {
    failPass();
    decorate();
    schedule();
  };
  new MutationObserver(records => {
    if (outsideRunBox(records)) pass();
  }).observe(MuseUI.el.chat, { childList: true, subtree: true });
  new MutationObserver(pass).observe(MuseUI.el.send, { attributes: true, attributeFilter: ['class'] });
  pass();
})();
