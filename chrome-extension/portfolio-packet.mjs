export const MAX_PACKET_BYTES = 7 * 1024 * 1024;

const imagePattern = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

function field(value, label, max, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new Error(`${label} must contain ${required ? '1' : '0'} to ${max} characters.`);
  }
  return value.trim();
}

function array(value, label, max, min = 0) {
  if (!Array.isArray(value) || value.length > max || value.length < min) {
    throw new Error(`${label} must contain ${min} to ${max} entries.`);
  }
  return value;
}

function imageFile(image, names) {
  const filename = field(image?.filename, 'Image filename', 100);
  const match = typeof image?.dataUrl === 'string' && image.dataUrl.match(imagePattern);
  if (!/^[a-z0-9][a-z0-9._-]*\.(png|jpe?g|webp)$/i.test(filename) || !match) {
    throw new Error('Images must use a simple filename and a PNG, JPEG or WebP data URL.');
  }
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(filename)) {
    throw new Error(`Choose a Windows-compatible image filename instead of ${filename}.`);
  }
  const extension = filename.split('.').at(-1).toLowerCase().replace('jpg', 'jpeg');
  if (extension !== match[1] || match[2].length % 4 !== 0) {
    throw new Error(`Image data does not match the filename ${filename}.`);
  }
  const key = filename.toLowerCase();
  if (names.has(key)) throw new Error(`Duplicate image filename: ${filename}`);
  names.add(key);
  const prefix = atob(match[2].slice(0, 16));
  const signatures = { png: '\x89PNG\r\n\x1a\n', jpeg: '\xff\xd8\xff', webp: 'RIFF' };
  if (!prefix.startsWith(signatures[extension]) || (extension === 'webp' && prefix.slice(8) !== 'WEBP')) {
    throw new Error(`Image data does not match the filename ${filename}.`);
  }
  return { filename, dataUrl: image.dataUrl };
}

export function parsePacket(text) {
  if (typeof text !== 'string' || text.length > MAX_PACKET_BYTES || new TextEncoder().encode(text).length > MAX_PACKET_BYTES) {
    throw new Error('The portfolio packet must be under 7 MB.');
  }
  let packet;
  try { packet = JSON.parse(text); }
  catch { throw new Error('This file is not a valid JSON portfolio packet.'); }
  if (packet?.version !== 1) throw new Error('Choose a Plenum portfolio packet with version 1.');
  const usedIds = new Set();
  const items = array(packet.items, 'Portfolio packet', 30, 1).map((item, i) => {
    try {
      const id = typeof item?.id === 'string' ? item.id : '';
      if (!/^[a-z0-9][a-z0-9-]{0,59}$/i.test(id) || usedIds.has(id)) {
        throw new Error('Use a unique short ID made from letters, digits and hyphens.');
      }
      usedIds.add(id);
      const title = field(item.title, 'Title', 70);
      const role = field(item.role ?? '', 'Role', 100, false);
      const description = field(item.description, 'Description', 600);
      const skills = array(item.skills ?? [], 'Skills', 5).map(skill => field(skill, 'Skill', 70));
      const names = new Set();
      const images = array(item.images ?? [], 'Images', 5).map(image => imageFile(image, names));
      return { id, title, role, description, skills, images };
    } catch (error) {
      throw new Error(`Item ${i + 1}. ${error.message}`);
    }
  });
  return { version: 1, items };
}

// A companion file is read over an extension URL and may have no Content-Length.
// Stop at the same limit as a file chosen in the import dialog.
export async function readPacketResponse(response) {
  const tooLarge = 'The portfolio packet must be under 7 MB.';
  if (Number(response.headers.get('content-length')) > MAX_PACKET_BYTES) {
    await response.body?.cancel();
    throw new Error(tooLarge);
  }
  if (!response.body) throw new Error('The local portfolio packet is empty.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let length = 0;
  const parts = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_PACKET_BYTES) throw new Error(tooLarge);
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
const encoder = new TextEncoder();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipHeader(length, signature) {
  const data = new Uint8Array(length);
  new DataView(data.buffer).setUint32(0, signature, true);
  return [data, new DataView(data.buffer)];
}

// ZIP entries are stored without compression. Image formats already compress their contents.
export function imageZip(images) {
  const entries = [];
  const directory = [];
  let offset = 0;
  let directorySize = 0;
  for (const { filename, dataUrl } of images) {
    const name = encoder.encode(filename);
    const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), ch => ch.charCodeAt(0));
    const crc = crc32(bytes);
    const [local, localView] = zipHeader(30, 0x04034b50);
    localView.setUint16(4, 20, true);
    localView.setUint16(12, 33, true); // January 1, 1980
    localView.setUint32(14, crc, true);
    localView.setUint32(18, bytes.length, true);
    localView.setUint32(22, bytes.length, true);
    localView.setUint16(26, name.length, true);
    entries.push(local, name, bytes);
    const [record, recordView] = zipHeader(46, 0x02014b50);
    recordView.setUint16(4, 20, true);
    recordView.setUint16(6, 20, true);
    recordView.setUint16(14, 33, true);
    recordView.setUint32(16, crc, true);
    recordView.setUint32(20, bytes.length, true);
    recordView.setUint32(24, bytes.length, true);
    recordView.setUint16(28, name.length, true);
    recordView.setUint32(42, offset, true);
    directory.push(record, name);
    offset += local.length + name.length + bytes.length;
    directorySize += record.length + name.length;
  }
  const [end, endView] = zipHeader(22, 0x06054b50);
  endView.setUint16(8, images.length, true);
  endView.setUint16(10, images.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, offset, true);
  return new Blob([...entries, ...directory, end], { type: 'application/zip' });
}

function itemSnapshot(item) {
  return item && JSON.stringify([
    item.id, item.title, item.role, item.description, item.skills,
    item.images.map(image => [image.filename, image.dataUrl]),
  ]);
}

export const sameItem = (first, second) => itemSnapshot(first) === itemSnapshot(second);

export function samePacket(previous, next) {
  return previous?.items.length === next.items.length &&
    next.items.every((item, i) => sameItem(item, previous.items[i]));
}

export function updateProgress(previous, next, progress) {
  const previousItems = new Map(previous?.items.map(item => [item.id, item]));
  const nextItems = new Map(next.items.map(item => [item.id, item]));
  return {
    selected: nextItems.has(progress.selected) ? progress.selected : next.items[0].id,
    entered: progress.entered.filter(id =>
      nextItems.has(id) && sameItem(nextItems.get(id), previousItems.get(id))),
  };
}
