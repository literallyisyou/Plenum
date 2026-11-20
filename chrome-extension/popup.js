'use strict';

const endpoint = 'http://127.0.0.1:4317/api/chrome-share/';
const get = id => document.getElementById(id);
const connect = get('connect');
const share = get('share');
const notice = message => { get('status').textContent = message; };
const buttons = Array.from(document.querySelectorAll('button'));
let capability;
let active;
let toolbarWindow;

function publicAddress(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.username = url.password = url.search = url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

function shareTitle(tab, address) {
  const title = tab.title?.trim();
  if (!title) return new URL(address).hostname;
  const url = new URL(tab.url);
  // Chrome frequently uses the address as the title of an untitled document.
  // Its display may omit the scheme or decode the URL components.
  for (const part of [url.search, url.hash, url.username, url.password].filter(Boolean)) {
    let decoded = part;
    try { decoded = decodeURIComponent(part); } catch {}
    if (title.includes(part) || title.includes(decoded)) return address.slice(0, 180);
  }
  return title.slice(0, 180);
}

async function post(operation, data) {
  const headers = { 'content-type': 'application/json' };
  const connection = capability;
  if (connection) headers['x-plenum-chrome'] = connection;
  let response;
  try {
    response = await fetch(endpoint + operation, {
      method: 'POST', headers, body: JSON.stringify(data), credentials: 'omit',
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new Error('Plenum is unavailable. Open the desktop app and try again.');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(result.error ?? 'Plenum could not receive the tab.'), { status: response.status, connection });
  return result;
}

function paint() {
  connect.hidden = Boolean(capability);
  share.hidden = !capability;
  get('portfolio').disabled = !Number.isInteger(toolbarWindow);
  get('tab-title').textContent = active ? active.title : 'Open an HTTP or HTTPS tab to share it.';
  for (const id of ['share-tab', 'share-selection']) get(id).disabled = !active;
}

async function forget(expired) {
  await navigator.locks.request('plenum-chrome-pairing', async () => {
    const saved = await chrome.storage.local.get('capability');
    if (saved.capability !== expired) {
      capability = saved.capability;
      return;
    }
    await chrome.storage.local.remove('capability');
    capability = undefined;
  });
}

async function perform(task) {
  buttons.forEach(button => { button.disabled = true; });
  try {
    await task();
  } catch (error) {
    if (error.status === 401) await forget(error.connection);
    notice(error.message);
  } finally {
    buttons.forEach(button => { button.disabled = false; });
    paint();
  }
}

// This function runs in Chrome's isolated world only after the owner clicks Share selected text.
function selectedPassage(expectedAddress) {
  if (location.href !== expectedAddress) return null;
  const selection = window.getSelection();
  const editors = 'input, textarea, select, [contenteditable], [role="textbox"]';
  const isEditor = node => (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)
    ?.closest(editors);
  if (!selection || selection.isCollapsed || isEditor(selection.anchorNode) || isEditor(selection.focusNode)) return null;
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    const elements = range.commonAncestorContainer.querySelectorAll?.(editors) ?? [];
    for (const element of elements) if (range.intersectsNode(element)) return null;
  }
  const address = new URL(location.href);
  address.username = address.password = address.search = address.hash = '';
  return { url: address.href, text: selection.toString().trim().slice(0, 4000) };
}

async function sendTab(withSelection) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = publicAddress(tab?.url);
  if (!active || tab?.id !== active.id || tab.url !== active.address) throw new Error('The tab changed. Open this menu again.');
  let selection = '';
  if (withSelection) {
    let captured;
    try {
      [captured] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: selectedPassage, args: [active.address] });
    } catch {
      throw new Error('Chrome could not read the selection on this page.');
    }
    if (captured?.result?.url !== url || !captured.result.text) throw new Error('Highlight a passage in the page and try again.');
    selection = captured.result.text;
  }
  await post('share', { url, title: active.title, selection });
  notice('Shared. Review the tab in Plenum before adding it to your chat draft.');
}

connect.addEventListener('submit', event => {
  event.preventDefault();
  const field = get('code');
  const code = field.value.trim().toLowerCase();
  field.value = '';
  void perform(async () => {
    await navigator.locks.request('plenum-chrome-pairing', async () => {
      const result = await post('pair', { code });
      if (!/^[0-9a-f]{64}$/.test(result.capability ?? '')) throw new Error('Plenum did not return a connection.');
      await chrome.storage.local.set({ capability: result.capability });
      capability = result.capability;
    });
    notice('Connected to Plenum.');
  });
});
get('share-tab').addEventListener('click', () => void perform(() => sendTab(false)));
get('share-selection').addEventListener('click', () => void perform(() => sendTab(true)));
get('disconnect').addEventListener('click', () => void perform(async () => {
  const connection = capability;
  try {
    await post('disconnect', {});
  } catch (error) {
    if (error.status !== 401) {
      await forget(connection);
      notice('Connection removed from Chrome. If Plenum is still running, disconnect it there too.');
      return;
    }
  }
  await forget(connection);
  notice('Disconnected.');
}));

get('portfolio').addEventListener('click', () => {
  if (!Number.isInteger(toolbarWindow)) return;
  void chrome.sidePanel.open({ windowId: toolbarWindow }).catch(() => notice('Chrome could not open the portfolio panel.'));
});

void (async () => {
  ({ capability } = await chrome.storage.local.get('capability'));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  toolbarWindow = tab?.windowId;
  const url = publicAddress(tab?.url);
  if (url) active = { id: tab.id, address: tab.url, title: shareTitle(tab, url) };
  paint();
})().catch(() => notice('Chrome could not read the current tab.'));
