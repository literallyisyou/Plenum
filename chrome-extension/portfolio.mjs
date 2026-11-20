import { imageZip, MAX_PACKET_BYTES, parsePacket, readPacketResponse, sameItem, samePacket, updateProgress } from './portfolio-packet.mjs';

const packetKey = 'portfolioPacket';
const progressKey = 'portfolioProgress';
const sourceKey = 'portfolioSource';
const stateKeys = [packetKey, progressKey, sourceKey];
const emptyProgress = () => ({ selected: '', entered: [] });
const find = id => document.getElementById(id);
const packetInput = find('packet');
const localButton = find('local-packet');
const selection = find('item');
const entered = find('entered');
const close = find('close');
const workspace = find('workspace');
let packet;
let linked = false;
let progress = emptyProgress();
let viewedItem;
let pendingMark;

function notice(message, error = false) {
  const status = find('notice');
  status.textContent = message;
  status.classList.toggle('error', error);
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function button(label, action, accessibleName) {
  const element = node('button', label);
  element.type = 'button';
  if (accessibleName) element.setAttribute('aria-label', accessibleName);
  element.addEventListener('click', action);
  return element;
}

async function copy(label, value) {
  try {
    await navigator.clipboard.writeText(value);
    notice(`${label} copied.`);
  } catch {
    notice('Clipboard unavailable. Select and copy the text directly.', true);
  }
}

function field(label, value) {
  const box = node('div', undefined, 'field');
  const row = node('div', undefined, 'row');
  row.append(node('h2', label), button('Copy', () => copy(label, value), `Copy ${label.toLowerCase()}`));
  box.append(row, node('p', value));
  return box;
}

function gallery(item) {
  const container = find('images');
  container.replaceChildren();
  find('gallery').hidden = !item.images.length;
  for (const { filename, dataUrl } of item.images) {
    const figure = node('figure');
    const preview = node('img');
    preview.alt = filename;
    preview.loading = 'lazy';
    preview.src = dataUrl;
    const caption = node('figcaption', filename);
    const save = node('a', 'Save image', 'save');
    save.href = dataUrl;
    save.download = filename;
    caption.append(save);
    figure.append(preview, caption);
    container.append(figure);
  }
}

function render() {
  localButton.textContent = linked ? 'Refresh from Plenum' : 'Load this PC’s Plenum portfolio';
  workspace.hidden = !packet;
  if (!packet) {
    viewedItem = undefined;
    return;
  }
  const { items } = packet;
  // Restore the most recent selection on open, while keeping each open panel
  // on its own item when another window saves its position.
  const current = items.find(item => item.id === viewedItem) ?? items.find(item => item.id === progress.selected) ?? items[0];
  viewedItem = current.id;
  selection.replaceChildren(...items.map(item => {
    const option = node('option', item.title + (progress.entered.includes(item.id) ? ' ✓' : ''));
    option.value = item.id;
    return option;
  }));
  selection.value = current.id;
  entered.checked = pendingMark?.id === current.id ? pendingMark.checked : progress.entered.includes(current.id);
  find('progress').textContent = `${progress.entered.length} of ${items.length} marked as entered`;
  const fields = find('fields');
  fields.replaceChildren(field('Title', current.title));
  if (current.role) fields.append(field('Role', current.role));
  fields.append(field('Description', current.description));
  if (current.skills.length) {
    const skills = node('div', undefined, 'field');
    const list = node('ul');
    for (const skill of current.skills) {
      const row = node('li', skill, 'row');
      row.append(button('Copy', () => copy(skill, skill), `Copy ${skill}`));
      list.append(row);
    }
    skills.append(node('h2', 'Skills'), list);
    fields.append(skills);
  }
  gallery(current);
}

// Each Chrome window can have its own panel. Keep the read, merge and write
// together so a slower window cannot overwrite a newer edit or reopen a packet.
async function changeWorkspace(edit) {
  return navigator.locks.request('plenum-portfolio-workspace', async () => {
    const state = await chrome.storage.local.get(stateKeys);
    const current = state[packetKey] ?? null;
    const changes = await edit(current, state[progressKey] ?? emptyProgress(), state[sourceKey]);
    if (changes && Object.keys(changes).length) await chrome.storage.local.set(changes);
    apply({ [packetKey]: current, [progressKey]: state[progressKey], [sourceKey]: state[sourceKey], ...changes });
  });
}

function apply(changes) {
  if (packetKey in changes) packet = changes[packetKey];
  if (progressKey in changes) progress = changes[progressKey] ?? emptyProgress();
  if (sourceKey in changes) linked = changes[sourceKey] === 'plenum';
  render();
}

async function checkGallery(next) {
  const checked = new Set();
  for (const item of next.items) {
    for (const { filename, dataUrl } of item.images) {
      if (checked.has(dataUrl)) continue;
      const image = new Image();
      image.src = dataUrl;
      try {
        await image.decode();
      } catch {
        throw new Error(`Chrome could not read the gallery image ${filename}.`);
      } finally {
        image.removeAttribute('src');
      }
      checked.add(dataUrl);
    }
  }
}

async function refreshFromPlenum(automatic = false) {
  localButton.disabled = true;
  packetInput.disabled = true;
  close.disabled = true;
  try {
    let message;
    await changeWorkspace(async (current, savedProgress, source) => {
      if (automatic && source !== 'plenum') return;
      let response;
      try {
        response = await fetch(chrome.runtime.getURL('plenum-portfolio.local.json'), { cache: 'no-store' });
      } catch {
        throw new Error('This copy of the extension has no local Plenum packet. Import a packet below.');
      }
      if (!response.ok) throw new Error('This copy of the extension has no local Plenum packet. Import a packet below.');
      const next = parsePacket(await readPacketResponse(response));
      const changes = {};
      if (source !== 'plenum') changes[sourceKey] = 'plenum';
      if (!samePacket(current, next)) {
        await checkGallery(next);
        changes[packetKey] = next;
        changes[progressKey] = updateProgress(current, next, savedProgress);
      }
      message = Object.keys(changes).length ? `Loaded ${next.items.length} portfolio items from Plenum.` : 'Your Plenum portfolio is current.';
      return changes;
    });
    if (message) notice(message);
  } catch (error) {
    notice(error.message + (packet && linked ? ' The last valid packet is still open.' : ''), true);
  } finally {
    localButton.disabled = false;
    packetInput.disabled = false;
    close.disabled = false;
  }
}

localButton.addEventListener('click', () => void refreshFromPlenum());

packetInput.addEventListener('change', async () => {
  const [file] = packetInput.files;
  if (!file) return;
  packetInput.disabled = true;
  close.disabled = true;
  localButton.disabled = true;
  try {
    if (file.size > MAX_PACKET_BYTES) throw new Error('The portfolio packet must be under 7 MB.');
    await changeWorkspace(async (current, savedProgress) => {
      const next = parsePacket(await file.text());
      await checkGallery(next);
      return { [packetKey]: next, [sourceKey]: 'import', [progressKey]: updateProgress(current, next, savedProgress) };
    });
    notice(`Opened ${packet.items.length} portfolio items.`);
  } catch (error) {
    notice(error.message, true);
  } finally {
    packetInput.value = '';
    localButton.disabled = false;
    packetInput.disabled = false;
    close.disabled = false;
  }
});
async function saveProgress(itemId, mark) {
  const shown = packet?.items.find(item => item.id === itemId);
  if (typeof mark === 'boolean') pendingMark = { id: itemId, checked: mark };
  selection.disabled = true;
  entered.disabled = true;
  try {
    await changeWorkspace((current, saved) => {
      const item = current?.items.find(candidate => candidate.id === itemId);
      if (!item || !sameItem(shown, item)) return;
      let ids = saved.entered;
      if (mark === true) ids = [...new Set([...ids, itemId])];
      if (mark === false) ids = ids.filter(id => id !== itemId);
      return { [progressKey]: { selected: itemId, entered: ids } };
    });
  } catch {
    render();
    notice('Chrome could not save your progress.', true);
  } finally {
    pendingMark = undefined;
    entered.checked = progress.entered.includes(selection.value);
    selection.disabled = false;
    entered.disabled = false;
  }
}

selection.addEventListener('change', () => {
  viewedItem = selection.value;
  void saveProgress(viewedItem);
});
entered.addEventListener('change', () => void saveProgress(selection.value, entered.checked));
close.addEventListener('click', async () => {
  try {
    await changeWorkspace(() => ({ [packetKey]: null, [sourceKey]: null, [progressKey]: emptyProgress() }));
    notice('Cleared the packet from this Chrome profile.');
  } catch {
    notice('Chrome could not clear this portfolio packet.', true);
  }
});
find('zip').addEventListener('click', () => {
  const item = packet.items.find(entry => entry.id === selection.value);
  const href = URL.createObjectURL(imageZip(item.images));
  const download = node('a');
  download.download = `${item.id}-images.zip`;
  download.href = href;
  download.click();
  setTimeout(() => URL.revokeObjectURL(href), 5000);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const updated = {};
  if (packetKey in changes) updated[packetKey] = changes[packetKey].newValue;
  if (progressKey in changes) updated[progressKey] = changes[progressKey].newValue;
  if (sourceKey in changes) updated[sourceKey] = changes[sourceKey].newValue;
  if (Object.keys(updated).length) apply(updated);
});
void changeWorkspace(() => null).then(() => {
  if (linked) return refreshFromPlenum(true);
})
  .catch(() => notice('Chrome could not open the saved workspace.', true));
