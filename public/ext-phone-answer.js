// Answering what waits from the phone's Today card (wave 8, 17 Nov 2026).
//
// public/ext-business.js draws the phone's Today card (MuseUI.businessToday) and, until now, a row of what waits only opened the item
// in the Businesses pane. This file gives each row its answers on the card itself, so a waiting question, plan or setup prompt is
// answered in one tap, or in two when a draft has to be read first. ext-business.js calls MuseUI.phoneAnswer.row(item, ctx) for each
// row and MuseUI.phoneAnswer.gate(item, choice) before a yes of its own pane.
//
// THE PAGE DECIDES NOTHING (DECISIONS items 125 and 128). Every rule is the server's:
//   - how an item is answered here is item.phone, from GET /api/decisions (lib/phone-answer.mjs describe): mode 'tap' (its options are
//     buttons), 'read' (the draft is opened first), 'text' (typed on Today) or 'refuse' (only the server's No), and unlock;
//   - the options are the server's, with its own No last; a no is choice === item.refuse and nothing else;
//   - a yes to an item with a draft sends `seen`, the sha256 that came WITH the text shown here (one read: GET /api/decisions/draft); a
//     draft that was not read here cannot be said yes to here; a 409 is shown in the server's words and the draft is read again;
//   - a draft too long to show in full gets no yes here (the server refuses it as well);
//   - nothing is answered by itself: no default, no timer, no "answer all". One tap answers one item.
// THE UNLOCK. A yes that is a step outside (item.phone.unlock: a send, publish, spend, account or delete, any item with a draft, any item
// that talks of money) asks for the phone's unlock first: the app is locked (plenumShell.lock()), its own lock screen comes up, and the
// yes is sent only after the person has unlocked it and the phone is connected again. With no lock set in Plenum on the phone there is
// nothing to ask with, so that yes is not sent from the phone, and the sentence says what to do. A No never asks. On the desktop there
// is no phone shell and nothing is asked. Only a phone at Full is offered answers (below Full, row() answers nothing, and the Bridge
// refuses the POST in any case: lib/remote/tiers.mjs).
// Every text goes through textContent; there is no inline style. Layout is in ext-phone-answer.css (tokens only).
(() => {
  'use strict';
  const MU = window.MuseUI;
  if (!MU) return;

  const TEXT = {
    read: 'Read and answer',
    reading: 'Reading the draft…',
    readFirst: 'Read the draft first. It is open here; then answer.',
    typed: 'Answer on Today',
    typedNote: 'This one is answered with a text you type.',
    close: 'Close',
    cut: 'This draft is too long to show in full here, so a yes cannot be recorded for it from this card. Open it on Today, or answer No.',
    unlockNote: 'A yes here asks for this phone\'s unlock first.',
    noLock: 'This yes lets something leave your PC or is about money, so it asks for this phone\'s unlock, and no lock is set in Plenum on this phone. Set one in Phone settings, or answer at the computer. No still works.',
    notUnlocked: 'The phone was not unlocked, so nothing was sent. Tap the answer again when you are ready.',
    notSent: 'Plenum did not answer. Check that the phone is connected, then tap again.',
    where: 'Where',
    needs: 'The lead needs back',
  };
  const UNLOCK_WAIT_MS = 120000;
  const STEP_MS = 200;

  const str = v => (typeof v === 'string' ? v : '');
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const make = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  };
  const sentence = text => { const t = str(text).trim(); return !t || /[.!?…]$/.test(t) ? t : `${t}.`; };

  // drafts: item n -> { state: 'loading' | 'ok' | 'error', name, text, cut, sha256, error }. busy: the items whose answer is on its way.
  const S = { drafts: new Map(), busy: new Set(), deps: {} };

  const shellOf = () => {
    const s = S.deps.shell !== undefined ? S.deps.shell : window.plenumShell;
    return s && typeof s === 'object' && s.desktop === false ? s : null;
  };
  const sleep = ms => (S.deps.sleep ? S.deps.sleep(ms) : new Promise(r => setTimeout(r, ms)));
  const now = () => (S.deps.now ? S.deps.now() : Date.now());
  const isRefusal = (item, choice) => Boolean(str(item?.refuse)) && choice === item.refuse;

  // The phone's unlock, asked again. { ok: true, asked } or { ok: false, reason: 'no-lock' | 'timeout' }.
  async function askUnlock() {
    const sh = shellOf();
    if (!sh) return { ok: true, asked: false };
    let mode = '';
    try { mode = str(sh.connection?.()?.lockMode); } catch { mode = ''; }
    if (mode === 'off' || typeof sh.lock !== 'function') return { ok: false, reason: 'no-lock' };
    let locked = false;
    try { locked = (await sh.lock()) === true; } catch { locked = false; }
    if (!locked) return { ok: false, reason: 'no-lock' };
    // The app is locked now: its lock screen is in front and its link to the computer is closed. The link comes back only after the
    // person has unlocked the app, so "connected again after it was away" is the unlock.
    const until = now() + UNLOCK_WAIT_MS;
    let away = false;
    for (;;) {
      let st = '';
      try { st = str(sh.connection?.()?.state); } catch { st = ''; }
      if (st !== 'connected') away = true;
      else if (away) return { ok: true, asked: true };
      if (now() > until) return { ok: false, reason: 'timeout' };
      await sleep(STEP_MS);
    }
  }

  // Before a yes: { ok: true } when it may be sent, { ok: false, why } with one sentence when it may not. A No is never held.
  async function gate(item, choice) {
    if (!isObj(item) || isRefusal(item, choice) || item.phone?.unlock !== true) return { ok: true, asked: false };
    const out = await askUnlock();
    if (out.ok) return out;
    return { ok: false, why: out.reason === 'no-lock' ? TEXT.noLock : TEXT.notUnlocked };
  }

  async function call(path, body) {
    let res;
    try {
      res = await MU.request(path, body === undefined ? {} : { method: 'POST', body });
    } catch {
      return { ok: false, status: 0, error: TEXT.notSent };
    }
    const data = await res.json().catch(() => null);
    if (res.ok && isObj(data)) return { ok: true, status: res.status, data };
    return { ok: false, status: res.status, error: str(data?.error) || TEXT.notSent };
  }

  // Reads the draft: the text and its sha256 come from one answer, and that hash is the only one a yes from this card ever sends.
  async function openDraft(item, ctx) {
    const n = item.n;
    S.drafts.set(n, { state: 'loading' });
    ctx.repaint?.();
    const r = await call(`/api/decisions/draft?n=${encodeURIComponent(n)}`);
    if (S.drafts.get(n)?.state !== 'loading') return;
    S.drafts.set(n, r.ok
      ? { state: 'ok', name: str(r.data.name), text: str(r.data.text), cut: r.data.cut === true, sha256: str(r.data.sha256) }
      : { state: 'error', error: sentence(r.error) });
    ctx.repaint?.();
  }

  async function answer(item, choice, ctx) {
    const n = item.n;
    if (S.busy.has(n)) return;
    const refusal = isRefusal(item, choice);
    const body = { n, choice };
    if (!refusal && str(item.draft)) {
      const d = S.drafts.get(n);
      // A yes is tied to the draft that was shown here. One that was not read here, or cannot be shown whole, gets no yes from here.
      if (d?.state !== 'ok' || d.cut || !d.sha256) {
        ctx.say?.(d?.state === 'ok' ? TEXT.cut : TEXT.readFirst, true);
        if (d?.state !== 'ok') await openDraft(item, ctx);
        return;
      }
      body.seen = d.sha256;
    }
    S.busy.add(n);
    ctx.repaint?.();
    let said = '';
    let bad = false;
    try {
      const g = await gate(item, choice);
      if (!g.ok) {
        said = g.why;
        bad = true;
        return;
      }
      const r = await call('/api/decisions/answer', body);
      if (r.ok) {
        // What a yes does not do is the server's sentence, never this page's own.
        const pay = !refusal && item.phone?.unlock === true && str(item.payNote) ? ` ${sentence(item.payNote)}` : '';
        said = `Answered #${n} "${str(item.title)}": ${choice}.${pay}`;
        S.drafts.delete(n);
      } else if (r.status === 409 && str(item.draft)) {
        // The server's sentence as it is (the draft changed after it was read, or the item no longer waits); the draft is read again.
        said = sentence(r.error);
        bad = true;
        await openDraft(item, ctx);
      } else {
        said = `#${n} was not answered. ${sentence(r.error)}`;
        bad = true;
      }
    } finally {
      S.busy.delete(n);
      ctx.say?.(said, bad);
      ctx.refresh?.();
      ctx.repaint?.();
    }
  }

  function button(cls, label, fk, onClick) {
    const b = make('button', cls, label);
    b.type = 'button';
    b.dataset.fk = fk;
    b.addEventListener('click', onClick);
    return b;
  }

  // The answers of one row of the phone's Today card, or null when the row has none here (the server did not say how the item is
  // answered on a phone, or this phone is below Full). ctx: { below, say(text, bad), refresh(), repaint(), open(n) }.
  function row(item, ctx = {}) {
    const p = isObj(item) && isObj(item.phone) ? item.phone : null;
    if (!p || ctx.below === true || !Number.isInteger(item.n)) return null;
    const n = item.n;
    const box = make('div', 'pa-row');
    box.dataset.n = String(n);
    box.dataset.mode = str(p.mode);
    const busy = S.busy.has(n);
    const options = (Array.isArray(item.options) ? item.options : []).filter(o => typeof o === 'string' && o);
    const optionButtons = list => {
      const bar = make('div', 'pa-opts');
      list.forEach((o, i) => {
        const b = button(isRefusal(item, o) ? 'ghost small pa-no' : 'small pa-yes', o, `g|ans|${n}|${options.indexOf(o)}`, () => answer(item, o, ctx));
        b.disabled = busy;
        b.setAttribute('aria-label', `Answer ${o} to: ${str(item.title)}`);
        void i;
        bar.append(b);
      });
      return bar;
    };

    if (p.mode === 'refuse') {
      box.append(make('p', 'biz-note pa-note', str(p.why) || str(item.draftNote)));
      box.append(optionButtons(options.filter(o => isRefusal(item, o))));
      return box;
    }
    if (p.mode === 'text') {
      const open = button('ghost small', TEXT.typed, `g|ans|${n}|open`, () => ctx.open?.(n));
      open.setAttribute('aria-label', `${TEXT.typed}: ${str(item.title)}`);
      box.append(make('p', 'biz-note pa-note', TEXT.typedNote), open);
      return box;
    }
    if (p.mode === 'read') {
      const d = S.drafts.get(n);
      if (!d) {
        const open = button('small pa-read', TEXT.read, `g|ans|${n}|read`, () => openDraft(item, ctx));
        open.setAttribute('aria-label', `${TEXT.read}: ${str(item.title)}`);
        box.append(open);
        return box;
      }
      if (d.state === 'loading') {
        box.append(make('p', 'biz-note pa-note', TEXT.reading));
        return box;
      }
      if (d.state === 'error') {
        // The draft cannot be read: only the server's No is offered, as in the pane.
        box.append(make('p', 'biz-note pa-note pa-bad', d.error), optionButtons(options.filter(o => isRefusal(item, o))));
        return box;
      }
      const head = make('p', 'pa-draft-name', d.name);
      const text = make('pre', 'pa-draft', d.text);
      text.tabIndex = 0;
      text.setAttribute('aria-label', `The draft ${d.name}`);
      box.append(head, text);
      if (d.cut) box.append(make('p', 'biz-note pa-note pa-bad', TEXT.cut));
      if (p.unlock === true && !d.cut) box.append(make('p', 'biz-note pa-note', TEXT.unlockNote));
      const bar = optionButtons(d.cut ? options.filter(o => isRefusal(item, o)) : options);
      bar.append(button('biz-quiet pa-close', TEXT.close, `g|ans|${n}|close`, () => { S.drafts.delete(n); ctx.repaint?.(); }));
      box.append(bar);
      return box;
    }
    // 'tap': a thing only the person can do shows where and what the lead needs back, as text; then the options, one tap each.
    if (item.does === true) {
      if (str(item.link)) box.append(make('p', 'biz-note pa-note pa-link', `${TEXT.where}: ${item.link}`));
      if (str(item.needs)) box.append(make('p', 'biz-note pa-note', `${TEXT.needs}: ${item.needs}`));
    }
    if (p.unlock === true) box.append(make('p', 'biz-note pa-note', TEXT.unlockNote));
    box.append(optionButtons(options));
    return box;
  }

  MU.phoneAnswer = {
    row,
    gate,
    // What the rows of this file look like now, for the card's own "did anything change" check.
    sig: () => JSON.stringify([[...S.busy], [...S.drafts].map(([n, d]) => [n, d.state, d.sha256 ?? '', d.error ?? ''])]),
    TEXT,
    // For the tests only: stand-ins for the shell, the clock and the wait.
    _deps: deps => { S.deps = isObj(deps) ? deps : {}; },
    _state: S,
  };
})();
