// The pairing window's page (desktop/phones-pair.html). The desktop sends one payload at a time through window.plenumPair.onOffer;
// this script draws the state it names and sends one answer back. It builds every element with createElement and textContent: no
// markup strings, no inline code, no network. The payload's text is the server's and the phone's, so it is only ever shown as text.
// States (desktop/handlers/phones.cjs): loading, offer, no-carrier, needs-build, confirm, allowed, denied, expired, failed3.
// Two modes (payload.mode): 'phone' (a QR to scan) and 'browser' (Add a browser, wave 5: the short addresses to open on the other
// computer, each with Copy, and the 12-character code to type there, which arrives as a picture, never as text).
(() => {
  'use strict';

  const api = window.plenumPair;
  const body = document.getElementById('body');
  const actions = document.getElementById('actions');
  const sub = document.getElementById('sub');
  const pair = document.getElementById('pair');

  // The countdown on the offer. The deadline is set once per offer (its seq), so a re-draw of the same offer (for example after
  // "Link copied") keeps the time that is left.
  let countdownSeq = null;
  let deadline = 0;
  let countdownTimer = null;
  let expiresEl = null;
  // The timer that closes the window on its own after a final state: five seconds after "allowed", two minutes otherwise.
  let autoTimer = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Sends one action to the desktop. Allow and Deny are sent once: the buttons are disabled as soon as one is pressed.
  function send(action, control) {
    if (!api) return;
    if (action === 'allow' || action === 'deny') {
      for (const button of actions.querySelectorAll('button')) button.disabled = true;
      body.setAttribute('aria-busy', 'true');
      if (control) control.textContent = action === 'allow' ? 'Allowing' : 'Denying';
    }
    api.answer(action);
  }

  function button(label, action, kind) {
    const node = el('button', `btn${kind ? ` ${kind}` : ''}`, label);
    node.type = 'button';
    node.addEventListener('click', () => send(action, node));
    return node;
  }

  function stopCountdown() {
    if (countdownTimer !== null) clearInterval(countdownTimer);
    countdownTimer = null;
    expiresEl = null;
  }

  function tick() {
    if (!expiresEl) return;
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    expiresEl.textContent = `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  }

  // Counts down the time left on the offer, shown after the computer's name in the subtitle.
  function startCountdown(seq, seconds, holder) {
    stopCountdown();
    if (seq !== countdownSeq) {
      countdownSeq = seq;
      deadline = Date.now() + seconds * 1000;
    }
    expiresEl = holder;
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  function scheduleClose(ms) {
    if (autoTimer !== null) clearTimeout(autoTimer);
    autoTimer = setTimeout(() => send('done'), ms);
  }

  // The device's name for a sentence: "Will's iPhone", or "The phone" when the phone sent none.
  function deviceName(offer) {
    const name = offer.device && typeof offer.device.name === 'string' ? offer.device.name.trim() : '';
    return name || (offer.mode === 'browser' ? 'The browser' : 'The phone');
  }

  // The window's title follows the mode: Add a phone, or Add a browser.
  const title = document.getElementById('title');
  function heading(offer) {
    const words = offer && offer.mode === 'browser' ? 'Add a browser' : 'Add a phone';
    if (title) title.textContent = words;
    document.title = words;
  }

  // The tier the phone gets if allowed: full, approve or read. Anything else is Full control, as the handler sends it.
  function tierOf(offer) {
    return ['full', 'approve', 'read'].includes(offer.tier) ? offer.tier : 'full';
  }

  // The words under the code for a phone's tier (the phone is given it when it is allowed).
  const TIER_NOTE = {
    full: 'It will have Full control. You can lower that any time under Settings › Phones.',
    approve: 'It will have Approve and watch. You can change that under Settings › Phones.',
    read: 'It will have Read only. You can change that under Settings › Phones.',
  };

  // Shown when a web page is the way a phone pairs: that page is sent without encryption.
  const isWebPage = offer => Boolean(offer.device) && offer.device.app === 'lan-web';

  function subtitle(offer) {
    sub.textContent = `Plenum on ${offer.name || 'this computer'}`;
  }

  function renderOffer(offer) {
    subtitle(offer);
    const hold = el('span', 'expires');
    sub.append(' · ', hold);
    const strip = el('div', 'strip danger');
    strip.setAttribute('role', 'note');
    strip.append(
      el('p', 'strip-title', 'A paired phone is as powerful as this window.'),
      el('p', 'strip-text', 'A paired phone can do everything this window can. Stop on the bar or on the phone ends every run.'),
    );
    body.append(strip);

    if (offer.captureVisible && !offer.qrPng) {
      // Show the code anyway (B-112): on Linux, and wherever the capture check saw this window, the code waits for the person's choice.
      const hidden = el('div', 'qr-hidden', 'Screen capture can see this window on this computer, so the code is hidden. Use Copy link and open the link on your phone, or show the code anyway.');
      const show = button('Show the code anyway', 'show-code');
      show.classList.add('show-code');
      hidden.append(show);
      body.append(hidden);
    } else if (offer.qrPng) {
      const frame = el('div', 'qr-frame');
      const image = document.createElement('img');
      image.className = 'qr';
      image.alt = 'Pairing code. Scan it with the Plenum app, or with your phone camera to open the web app.';
      image.src = offer.qrPng;
      frame.append(image);
      body.append(frame);
      if (offer.captureVisible) {
        body.append(el('p', 'warn', 'Screen capture can see this window, so a screenshot or screen-sharing program running now could read this code until it is used or expires. A phone that has it still needs your Allow here.'));
      }
    } else {
      body.append(el('div', 'qr-hidden', 'The code is not ready. Try a new code.'));
    }

    body.append(el('p', 'lede', "Scan with the Plenum app, or with your phone's camera to open the web app."));
    if (offer.qrKind === 'lan') {
      body.append(el('p', 'note', 'The web page this code opens is sent without encryption on this network. On a network you do not trust, scan the code with the Plenum app instead.'));
    }
    if (offer.tried === true) {
      body.append(el('p', 'warn', 'Another device tried to pair with this computer and was turned away. Only a phone that has this code can pair.'));
    }
    if (offer.left === true) {
      body.append(el('p', 'warn', 'The phone that was waiting left before you answered. Scan the code again.'));
    }

    if (Array.isArray(offer.hints) && offer.hints.length > 0) {
      body.append(el('p', 'hints-title', 'Your phone can reach this computer through:'));
      const list = el('ul', 'hints');
      for (const hint of offer.hints) {
        const item = el('li', hint.on ? 'on' : 'off');
        item.append(el('span', 'dot', hint.on ? '●' : '○'), el('span', 'hint-text', String(hint.label)));
        list.append(item);
      }
      body.append(list);
    }
    body.append(el('p', 'note', 'The link works like the code and leaves the clipboard when the code expires.'));

    const status = el('p', 'status', offer.copied === true ? 'Link copied.' : '');
    status.setAttribute('role', 'status');
    const copy = button('Copy link', 'copy', 'primary');
    actions.append(status, copy, button('Cancel', 'cancel'));
    startCountdown(offer.seq, Number(offer.expiresInS) || 0, hold);
    copy.focus();
  }

  // ----- Add a browser (wave 5): the same states, with an address to open and a code to type instead of a QR -----

  const isBrowser = offer => offer && offer.mode === 'browser';

  // One address with its Copy. The addresses hold no key, so the clipboard keeps them (the desktop copies; this page has no clipboard).
  function addressRow(offer, url, index) {
    const row = el('div', 'address-row');
    const text = el('span', 'address', url);
    const copied = offer.copiedAddress === index;
    const copy = el('button', 'btn small', copied ? 'Copied' : 'Copy');
    copy.type = 'button';
    copy.setAttribute('aria-label', copied ? `Address copied: ${url}` : `Copy the address ${url}`);
    copy.addEventListener('click', () => send(`copy-address-${index}`));
    row.append(text, copy);
    return row;
  }

  function renderBrowserOffer(offer) {
    subtitle(offer);
    const hold = el('span', 'expires');
    sub.append(' · ', hold);
    const strip = el('div', 'strip danger');
    strip.setAttribute('role', 'note');
    strip.append(
      el('p', 'strip-title', 'A paired browser is as powerful as this window.'),
      el('p', 'strip-text', 'A paired browser can do everything this window can. Stop on the bar or in the browser ends every run.'),
    );
    body.append(strip);

    const addresses = Array.isArray(offer.addresses) ? offer.addresses.filter(a => typeof a === 'string' && a) : [];
    const waiting = offer.claimed === true && offer.left !== true;
    if (waiting) {
      body.append(el('p', 'lede waiting', 'The browser has the code. Waiting for it to connect.'));
    } else {
      if (addresses.length > 0) {
        body.append(el('p', 'step', '1. On your other computer, open this address:'));
        body.append(addressRow(offer, addresses[0], 0));
        if (addresses.length > 1) {
          body.append(el('p', 'step-more', 'On this network you can also use:'));
          addresses.slice(1).forEach((url, i) => body.append(addressRow(offer, url, i + 1)));
        }
        if (addresses[0].startsWith('http:')) {
          body.append(el('p', 'note', 'This address is not encrypted. On a network you do not trust, turn on Tailscale and use its address instead.'));
        }
      } else if (offer.qrKind === 'relay') {
        body.append(el('p', 'warn', 'Your relay cannot carry the code. Copy the full link and open it in the browser.'));
      }
      if (addresses.length > 0) {
        body.append(el('p', 'step', '2. Type this code there:'));
        if (offer.captureVisible && !offer.claimPng) {
          const hidden = el('div', 'qr-hidden', 'Screen capture can see this window on this computer, so the code is hidden. Copy the full link instead, or show the code anyway.');
          const show = button('Show the code anyway', 'show-code');
          show.classList.add('show-code');
          hidden.append(show);
          body.append(hidden);
        } else if (offer.claimPng) {
          const frame = el('div', 'claim-frame');
          const image = document.createElement('img');
          image.className = 'claim';
          image.alt = 'The code for the browser. It is shown as a picture so other programs cannot read it.';
          image.src = offer.claimPng;
          frame.append(image);
          body.append(frame);
          if (offer.captureVisible) {
            body.append(el('p', 'warn', 'Screen capture can see this window, so a screenshot or screen-sharing program running now could read this code until it is used or expires. A browser that has it still needs your Allow here.'));
          }
        } else {
          body.append(el('div', 'qr-hidden', 'The code is not ready. Try a new code.'));
        }
      }
    }
    if (offer.tried === true) {
      body.append(el('p', 'warn', 'Another device tried to pair with this computer and was turned away. Only a browser that has this code can pair.'));
    }
    if (offer.left === true) {
      body.append(el('p', 'warn', 'The browser that was waiting left before you answered. Type the code again there.'));
    }
    body.append(el('p', 'step-more', 'Or copy the full link'));
    body.append(el('p', 'note', 'The link works like the code and leaves the clipboard when the code expires.'));

    const status = el('p', 'status', offer.copied === true ? 'Link copied.' : '');
    status.setAttribute('role', 'status');
    const copy = button('Copy link', 'copy');
    const cancel = button('Cancel', 'cancel');
    actions.append(status, copy, cancel);
    startCountdown(offer.seq, Number(offer.expiresInS) || 0, hold);
    (body.querySelector('.address-row .btn') || copy).focus();
  }

  function renderConfirm(offer) {
    subtitle(offer);
    const browser = isBrowser(offer);
    const device = deviceName(offer);
    const platform = isWebPage(offer) ? 'Web page (plain http)' : offer.device?.platform;
    const kind = offer.device ? [platform, offer.device.carrier].filter(Boolean).join(' · ') : '';
    body.append(el('p', 'device-name', `${device} wants to pair`));
    if (kind) body.append(el('p', 'device-kind', kind));
    body.append(el('p', 'code-label', browser ? 'Code in the browser' : 'Code on the phone'));
    const code = typeof offer.code === 'string' && /^\d{6}$/.test(offer.code) ? offer.code : '';
    body.append(el('p', 'code', code ? `${code.slice(0, 3)} ${code.slice(3)}` : '--- ---'));
    body.append(el('p', 'lede', browser ? 'Allow only if the browser shows the same code.' : 'Allow only if the phone shows the same code.'));
    const tier = tierOf(offer);
    body.append(el('p', 'note', `${TIER_NOTE[tier]}${isWebPage(offer) ? ' It came from a web page sent without encryption, so on a network you do not trust, set it to Approve and watch after pairing.' : ''}`));
    if (offer.second === true) {
      body.append(el('p', 'warn', 'Another device also used this code. If you did not expect that, click Deny and start again.'));
    }
    if (offer.tried === true) {
      body.append(el('p', 'warn', `Another device tried to pair with this computer and was turned away. Only a ${browser ? 'browser' : 'phone'} that has this code can pair.`));
    }
    const deny = button('Deny', 'deny');
    const allow = button('Allow', 'allow', 'primary');
    actions.append(deny, allow);
    // Deny has the first focus, so Enter denies.
    deny.focus();
  }

  function renderFinal(offer, text, buttons) {
    subtitle(offer);
    body.append(el('p', 'lede', text));
    for (const [label, action, kind] of buttons) actions.append(button(label, action, kind));
    const first = actions.querySelector('button');
    if (first) first.focus();
  }

  // Draws one payload. Every state starts from an empty window, so nothing from the last state is left behind.
  function render(offer) {
    if (!offer || typeof offer !== 'object') return;
    stopCountdown();
    if (autoTimer !== null) clearTimeout(autoTimer);
    autoTimer = null;
    body.replaceChildren();
    actions.replaceChildren();
    body.removeAttribute('aria-busy');
    pair.dataset.state = typeof offer.state === 'string' ? offer.state : 'loading';
    pair.dataset.mode = isBrowser(offer) ? 'browser' : 'phone';
    heading(offer);
    const browser = isBrowser(offer);

    switch (offer.state) {
      case 'offer':
        if (browser) renderBrowserOffer(offer);
        else renderOffer(offer);
        break;
      case 'no-carrier':
        renderFinal(offer, 'Turn on at least one way first in Settings › Phones: Same network, Tailscale or a relay.', [['Close', 'done']]);
        break;
      case 'needs-build':
        renderFinal(offer, 'Pairing needs a newer build of Plenum. Update Plenum, then try again.', [['Close', 'done']]);
        break;
      case 'confirm':
        renderConfirm(offer);
        break;
      case 'allowed': {
        const tier = tierOf(offer);
        let text;
        if (browser) {
          text = tier === 'full'
            ? `${deviceName(offer)} is added with Full control. You can lower that any time under Settings › Phones.`
            : `${deviceName(offer)} is added with ${tier === 'approve' ? 'Approve and watch' : 'Read only'}. Change it any time under Settings › Phones.`;
        } else {
          text = tier === 'full'
            ? `${deviceName(offer)} is paired. It can now do everything this window can. Remove it any time under Settings › Phones.`
            : `${deviceName(offer)} is paired with ${tier === 'approve' ? 'Approve and watch' : 'Read only'}. Change it any time under Settings › Phones.`;
        }
        renderFinal(offer, text, [['Done', 'done', 'primary']]);
        scheduleClose(5000);
        break;
      }
      case 'denied':
        renderFinal(offer, browser ? `${deviceName(offer)} was not added.` : `${deviceName(offer)} was not paired.`, [['Close', 'done']]);
        scheduleClose(120000);
        break;
      case 'expired':
        renderFinal(offer, browser ? 'The code expired. No browser was added.' : 'The code expired. No phone was paired.', [['New code', 'new-code', 'primary'], ['Close', 'done']]);
        scheduleClose(120000);
        break;
      case 'failed3':
        renderFinal(offer, browser
          ? 'The code was typed wrong five times, so it was stopped. No browser was added.'
          : 'Three tries with this code failed, so it was stopped. No phone was paired.', [['New code', 'new-code', 'primary']]);
        scheduleClose(120000);
        break;
      default:
        subtitle(offer);
        body.append(el('p', 'lede', 'Getting the code ready.'));
    }
  }

  if (!api || typeof api.onOffer !== 'function') {
    sub.textContent = '';
    body.append(el('p', 'lede', 'This window could not start. Close it and try again.'));
    return;
  }
  api.onOffer(render);
})();
