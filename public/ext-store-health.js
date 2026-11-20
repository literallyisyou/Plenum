// Store health notices. Loaded by ext.js and adds itself through window.MuseUI.
// 1. When Plenum could not read or find its saved state file at start, it loaded the last backup (or started fresh) and says so
//    here once. The server keeps that outcome (GET /api/store/health) until Dismiss acknowledges it (POST /api/store/health/ack),
//    so a reload does not bring the notice back. This file keeps no copy of it.
// 2. When a save fails (a folder that cannot be written, a full disk, a locked file), the change on screen is not in the file and
//    is lost on restart. The server puts the message in the state it sends (saveFailure, lib/store.mjs), at start and after every
//    change, and this notice follows it: it is there while the failure is, and gone once a save works.
// 3. Settings > General > Backups lists the dated copies Plenum keeps of the chats and settings (GET /api/store/backups) and
//    restores one after a confirm (POST /api/store/restore). Each row says how many messages and chats the copy holds, so nobody
//    has to restore a copy to see what is in it. Its layout uses the row classes of the Build section and style.css.
// Every string is set with textContent.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  // The last part of a path, whichever separator the system uses. Only the file name is shown, never the folder it is in.
  const fileName = p => String(p ?? '').split(/[\\/]/).pop();

  function show(health) {
    const box = document.createElement('div');
    box.className = 'ext-store-banner';
    box.setAttribute('role', 'alert');

    const copy = document.createElement('div');
    copy.className = 'ext-store-copy';
    const head = document.createElement('p');
    head.className = 'ext-store-head';
    // missing: the file was not there at start, but a backup was (it was deleted or moved while Plenum was not running).
    // chats: one saved chat was not a list of messages, so that chat starts empty and its old value is kept beside the state file.
    head.textContent = health.missing
      ? health.recovered === 'defaults'
        ? 'Plenum could not find its saved state file, and its backup could not be used, so it started fresh.'
        : 'Plenum could not find its saved state file, so it loaded the last backup.'
      : health.recovered === 'chats'
        ? 'Plenum could not read a saved chat, so that chat starts empty.'
        : health.recovered === 'backup' || health.recovered === 'backup-readonly'
          ? 'Plenum could not read its saved state file, so it loaded the last backup.'
          : 'Plenum could not read its saved state file, so it started fresh.';
    const note = document.createElement('p');
    note.className = 'ext-store-note';
    // unread: the file could not be opened (another program may have held it), so it is not known to be damaged.
    note.textContent = health.missing
      ? health.recovered === 'defaults'
        ? health.corruptFile
          ? `The damaged backup was kept as ${fileName(health.corruptFile)} in ${health.home}. The next save writes a new state file.`
          : `The backup could not be read, so it was not changed. The next save writes a new state file in ${health.home}.`
        : `The file may have been deleted or moved while Plenum was not running. The next save writes a new one in ${health.home}.`
      : health.recovered === 'chats' && health.corruptFile
        ? `The old messages were kept as ${fileName(health.corruptFile)} in ${health.home}.`
      : health.unread
        ? `The file may have been in use by another program. It was left as it was, and before Plenum next saves, it is copied to state.json.unread-<time> in ${health.home}.`
        : health.corruptFile
          ? `The damaged file was kept as ${fileName(health.corruptFile)} in ${health.home}.`
          : 'The damaged file could not be moved aside.';
    copy.append(head, note);

    const dismiss = MuseUI.button('ghost small ext-store-dismiss', 'Dismiss');
    dismiss.addEventListener('click', async () => {
      dismiss.disabled = true;
      try {
        await MuseUI.api('/api/store/health/ack', {});
        box.remove();
      } catch (err) {
        dismiss.disabled = false;
        MuseUI.toast(err.message, 'bad');
      }
    });

    box.append(copy, dismiss);
    // Above the chat, so the notice is the first thing read after a start that recovered.
    MuseUI.el.chat.before(box);
  }

  // The notice for a save that failed. One box at most, kept while the server reports the failure. Dismiss hides it until the failure
  // has cleared and comes back, so a notice that was dismissed is not shown again for the same run of failures.
  let failBox = null;
  let failText = '';
  let failDismissed = false;

  function showSaveFailure(message) {
    if (typeof message !== 'string' || !message) {
      failBox?.remove();
      failBox = null;
      failText = '';
      failDismissed = false;
      return;
    }
    if (failDismissed || (failBox && failText === message)) return;
    failBox?.remove();
    failText = message;
    const box = document.createElement('div');
    box.className = 'ext-store-banner ext-store-save';
    box.setAttribute('role', 'alert');
    const copy = document.createElement('div');
    copy.className = 'ext-store-copy';
    const head = document.createElement('p');
    head.className = 'ext-store-head';
    head.textContent = message;
    const note = document.createElement('p');
    note.className = 'ext-store-note';
    note.textContent = 'What you changed is shown, but it is not saved and is lost when Plenum closes. Check that the Plenum folder can be written to and the disk has room. This goes away when a save works.';
    copy.append(head, note);
    const dismiss = MuseUI.button('ghost small ext-store-dismiss', 'Dismiss');
    dismiss.addEventListener('click', () => {
      failDismissed = true;
      box.remove();
      failBox = null;
    });
    box.append(copy, dismiss);
    MuseUI.el.chat.before(box);
    failBox = box;
  }

  // The state the server sends at connect (hello) and after every change carries saveFailure: a message, or null.
  window.addEventListener('plenum:event', e => {
    const ev = e.detail;
    if (ev && (ev.type === 'hello' || ev.type === 'state') && ev.state && typeof ev.state === 'object') showSaveFailure(ev.state.saveFailure ?? null);
  });
  showSaveFailure(MuseUI.state?.saveFailure ?? null);

  // ---------- Settings > General > Backups ----------
  // The newest copies show first; Show all brings the rest. Every string is set with textContent, and the name a restore sends is
  // the one the server listed.
  const FIRST_ROWS = 6;
  const KIND_WORDS = { update: 'before an update', restore: 'before a restore' };

  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // A sentence with a path in it, as pieces (spans) with a break point (wbr) after every separator of the path.
  function pathParts(before, path, after) {
    const part = text => make('span', null, text);
    const parts = [part(before)];
    for (const piece of String(path).split(/([\\/])/)) {
      if (!piece) continue;
      parts.push(part(piece));
      if (piece === '\\' || piece === '/') parts.push(document.createElement('wbr'));
    }
    parts.push(part(after));
    return parts;
  }

  function sizeWords(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1024) return `${n} bytes`;
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  // What a copy holds, as the server counted it: "31 messages in 3 chats". Nothing when the server gave no numbers.
  function countWords(copy) {
    const messages = copy.messages;
    const chats = copy.chats;
    if (!Number.isInteger(messages) || !Number.isInteger(chats) || messages < 0 || chats < 0) return '';
    if (messages === 0) return 'no messages';
    return `${messages} ${messages === 1 ? 'message' : 'messages'} in ${chats} ${chats === 1 ? 'chat' : 'chats'}`;
  }

  // A copy with no message in it and no more bytes than an empty state takes (about 380) holds nothing to bring back.
  const BARE_BYTES = 512;
  const isBare = copy => copy.messages === 0 && copy.chats === 0 && Number.isFinite(copy.bytes) && copy.bytes < BARE_BYTES;

  // The time of every copy as its row shows it. The time is to the minute, so copies of one kind made in the same minute (two
  // restores in a row) get a number after it, the oldest first: "(1)", "(2)". The list is newest first.
  function whenLabels(copies) {
    const groups = new Map();
    for (const copy of copies) {
      const key = `${copy.time}|${copy.kind}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(copy);
    }
    const labels = new Map();
    for (const group of groups.values()) {
      group.forEach((copy, i) => {
        const when = timeWords(copy.time);
        labels.set(copy, group.length > 1 ? `${when} (${group.length - i})` : when);
      });
    }
    return labels;
  }

  function timeWords(ms) {
    const d = new Date(Number(ms));
    if (Number.isNaN(d.getTime())) return 'Unknown time';
    try {
      return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
      return d.toLocaleString();
    }
  }

  // The sentence a restore leaves for the window that loads next. It is kept for this tab only and shown once.
  const RESTORED_KEY = 'plenum.store.restored';
  function reloadWith(text) {
    const loc = window.location;
    if (!loc || typeof loc.reload !== 'function') return false;
    try {
      window.sessionStorage.setItem(RESTORED_KEY, text);
    } catch {
      // Without storage the window still loads again; only the sentence is missing.
    }
    loc.reload();
    return true;
  }
  try {
    const told = window.sessionStorage.getItem(RESTORED_KEY);
    if (told) {
      window.sessionStorage.removeItem(RESTORED_KEY);
      MuseUI.toast(told, 'ok', 8000);
    }
  } catch {
    // A page without storage has nothing to say.
  }

  function renderBackups(body) {
    const root = make('div', 'eb-root');
    const intro = make('p', 'note-quiet', 'Plenum keeps dated copies of your chats and settings: one an hour while you work, then one a day for a week, one before each update and one before each restore. Each row says what the copy holds. Restoring a copy brings back the chats and settings from that time.');
    const list = make('div', 'eb-root');
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', 'Saved copies');
    // "Show all" is under the list, not in it: a list holds only its copies. The row is hidden while it holds nothing.
    const under = make('div', 'eb-row');
    const setUnder = (...nodes) => {
      under.replaceChildren(...nodes);
      under.hidden = nodes.length === 0;
    };
    setUnder();
    const status = make('p', 'eb-note');
    status.setAttribute('role', 'status');
    const where = make('p', 'eb-note');
    root.append(intro, list, under, status, where);
    body.append(root);

    let showAll = false;
    let busy = false;
    const say = (text, bad) => {
      status.textContent = text;
      status.classList.toggle('eb-bad', Boolean(bad));
    };

    // The one line the list shows in place of its rows. It is an item of the list, so a screen reader hears it as one.
    const only = text => {
      const line = make('p', 'note-quiet', text);
      line.setAttribute('role', 'listitem');
      list.replaceChildren(line);
      setUnder();
    };

    async function restore(copy, btn, when) {
      if (busy) return;
      const holds = countWords(copy);
      const sure = await MuseUI.confirm({
        title: 'Restore this copy?',
        body: `Your chats and settings go back to how they were on ${when}${holds ? ` (${holds})` : ''}. What you have now is kept as a copy in this list first, marked "before a restore", so you can come back to it.`,
        action: 'Restore',
        focusCancel: true,
      });
      if (!sure) return;
      busy = true;
      btn.disabled = true;
      say('Restoring...');
      try {
        const done = await MuseUI.api('/api/store/restore', { name: copy.name, confirm: true });
        // fresh is false when nothing had changed since the last restore: the server made no second copy of the same thing, and
        // the copy that restore kept is still the one that holds what the person had before.
        const told = !done || !done.kept
          ? `Restored the copy from ${when}.`
          : done.fresh === false
            ? `Restored the copy from ${when}. Nothing had changed since your last restore, so the copy "before a restore" that is already in the list is still the one to go back to.`
            : `Restored the copy from ${when}. What you had before is in the list as the newest copy "before a restore".`;
        // Every chat and setting changed at once (the theme and what the panels remember too), so the window is loaded again and
        // says the result when it is back. A page that cannot reload reads the state again and says it here.
        if (reloadWith(told)) return;
        await MuseUI.refresh();
        say(told);
        MuseUI.toast(told, 'ok', 6000);
      } catch (err) {
        say(err && err.message ? err.message : 'The copy could not be restored. Nothing was changed.', true);
      } finally {
        busy = false;
        // The section may have been drawn again by the refresh; this list is filled again only while it is still on the page.
        if (root.isConnected) await fill(true);
      }
    }

    function draw(copies) {
      if (copies.length === 0) {
        only('No copies yet. The first one is made within an hour of use.');
        return;
      }
      list.replaceChildren();
      setUnder();
      const labels = whenLabels(copies);
      const shown = showAll ? copies : copies.slice(0, FIRST_ROWS);
      for (const copy of shown) {
        const row = make('div', 'eb-row');
        row.setAttribute('role', 'listitem');
        const when = labels.get(copy);
        const kind = KIND_WORDS[copy.kind];
        // A copy of a bare state (no message and no room for a project: a start with nothing yet) has nothing to bring back, so it
        // gets a sentence in place of the Restore button.
        if (isBare(copy)) {
          row.append(make('span', 'eb-label', when), make('span', 'eb-line', [`Empty, ${sizeWords(copy.bytes)}`, kind, 'nothing to restore'].filter(Boolean).join(', ')));
          list.append(row);
          continue;
        }
        const btn = MuseUI.button('ghost small', 'Restore');
        // The label names the kind and the number too, so no two buttons of the list read the same.
        btn.setAttribute('aria-label', kind ? `Restore the copy from ${when}, ${kind}` : `Restore the copy from ${when}`);
        btn.addEventListener('click', () => restore(copy, btn, when));
        row.append(make('span', 'eb-label', when), make('span', 'eb-line', [countWords(copy), sizeWords(copy.bytes), kind].filter(Boolean).join(', ')), btn);
        list.append(row);
      }
      if (!showAll && copies.length > shown.length) {
        const more = MuseUI.button('ghost small', `Show all ${copies.length} copies`);
        more.addEventListener('click', () => {
          showAll = true;
          draw(copies);
          // The focus goes to the first copy that was not shown before, since the button it was on is gone.
          (list.children[FIRST_ROWS] ?? list).querySelector('button')?.focus();
        });
        setUnder(more);
      }
    }

    async function fill(keepStatus) {
      try {
        const data = await MuseUI.api('/api/store/backups');
        const copies = Array.isArray(data && data.backups) ? data.backups.filter(c => c && typeof c.name === 'string') : [];
        draw(copies);
        // The folder's path breaks after each separator, never inside a name, so a narrow window shows whole words.
        where.replaceChildren(...(typeof data.folder === 'string' && data.folder ? pathParts('The copies are files in ', data.folder, '.') : []));
        if (!keepStatus) say(typeof data.problem === 'string' ? data.problem : '', typeof data.problem === 'string');
      } catch (err) {
        list.replaceChildren();
        // The next step is right there: read the list again.
        const again = MuseUI.button('ghost small', 'Try again');
        again.addEventListener('click', () => {
          only('Reading the copies...');
          fill(false);
        });
        setUnder(again);
        if (!keepStatus) say(`The list of copies could not be read (${err && err.message ? err.message : 'no answer'}). Press Try again.`, true);
      }
    }

    only('Reading the copies...');
    fill(false);
  }

  if (MuseUI.settings && typeof MuseUI.settings.register === 'function') {
    MuseUI.settings.register({ id: 'backups', scope: 'app', title: 'Backups', group: 'general', order: 85, render: renderBackups });
  }

  // Asked once at load. A server that cannot be reached, or one without this route, shows nothing.
  MuseUI.api('/api/store/health').then(data => {
    if (data && data.health) show(data.health);
  }).catch(() => {});
})();
