import test from 'node:test';
import assert from 'node:assert/strict';
import { imageZip, MAX_PACKET_BYTES, parsePacket, readPacketResponse, samePacket, updateProgress } from '../chrome-extension/portfolio-packet.mjs';

const cover = {
  filename: 'cover.png',
  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR42mNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==',
};
const item = { id: 'portfolio', title: 'Title', role: 'Role', description: 'Description', skills: ['Excel'], images: [cover] };
const packet = items => JSON.stringify({ version: 1, items });

test('portfolio packet validates fields and media', () => {
  assert.deepEqual(parsePacket(packet([item])).items, [item]);
  assert.throws(() => parsePacket(packet([{ ...item, title: 'x'.repeat(71) }])), /Title/);
  assert.throws(() => parsePacket(packet([{ ...item, skills: Array(6).fill('Excel') }])), /Skills/);
  assert.throws(() => parsePacket(packet([item, item])), /unique/);
  assert.throws(() => parsePacket(packet([{ ...item, images: [{ ...cover, filename: '../cover.png' }] }])), /simple filename/);
  assert.throws(() => parsePacket(packet([{ ...item, images: [{ ...cover, dataUrl: 'https://example.com/image.png' }] }])), /data URL/);
  assert.throws(() => parsePacket(packet([{ ...item, images: [{ ...cover, filename: 'cover.jpg' }] }])), /does not match/);
  assert.throws(() => parsePacket(packet([{ ...item, images: [{ ...cover, filename: 'NUL.sample.png' }] }])), /Windows-compatible/);
});

test('local companion enforces actual bytes when length is absent or understated', async () => {
  const parts = new TextEncoder().encode('{"title":"Péríodo"}');
  const data = new ReadableStream({ start(c) {
    for (const byte of parts) c.enqueue(Uint8Array.of(byte));
    c.close();
  } });
  assert.equal(await readPacketResponse(new Response(data)), '{"title":"Péríodo"}');
  let cancelled = false;
  const over = new ReadableStream({ start(c) {
    c.enqueue(new Uint8Array(MAX_PACKET_BYTES));
    c.enqueue(Uint8Array.of(32));
  }, cancel() { cancelled = true; } });
  await assert.rejects(readPacketResponse(new Response(over, { headers: { 'content-length': '1' } })), /7 MB/);
  assert.equal(cancelled, true);
  await assert.rejects(readPacketResponse(new Response('small', { headers: { 'content-length': String(MAX_PACKET_BYTES + 1) } })), /7 MB/);
});

test('image ZIP contains the original bytes and two directory entries', async () => {
  const other = { ...cover, filename: 'second.png' };
  const zip = Buffer.from(await imageZip([cover, other]).arrayBuffer());
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.equal(zip.readUInt16LE(zip.length - 12), 2);
  const directory = zip.readUInt32LE(zip.length - 6);
  assert.equal(zip.readUInt32LE(directory), 0x02014b50);
  const nameLength = zip.readUInt16LE(26);
  assert.equal(zip.subarray(30, 30 + nameLength).toString(), 'cover.png');
  const raw = Buffer.from(cover.dataUrl.split(',')[1], 'base64');
  assert.deepEqual(zip.subarray(30 + nameLength, 30 + nameLength + raw.length), raw);
  assert.equal(zip.readUInt32LE(directory + 16), zip.readUInt32LE(14));
});

test('refresh retains selection and entered items through reorder and makes edits visible for review', () => {
  const other = { ...item, id: 'other', title: 'Other' };
  const third = { ...item, id: 'third', title: 'Third' };
  const before = parsePacket(packet([item, other, third]));
  const after = parsePacket(packet([{ ...third, description: 'Edited description' }, other]));
  const current = { selected: other.id, entered: [item.id, other.id, third.id] };
  assert.deepEqual(updateProgress(before, after, current), { selected: other.id, entered: [other.id] });
  assert.deepEqual(updateProgress(before, after, { ...current, selected: item.id }),
    { selected: third.id, entered: [other.id] });
});
test('refresh equality ignores field order after Chrome serializes local storage', () => {
  const before = { items: [{ images: [{ dataUrl: cover.dataUrl, filename: cover.filename }], id: item.id, description: item.description, skills: item.skills, title: item.title, role: item.role }] };
  const after = parsePacket(packet([item]));
  assert.equal(samePacket(before, after), true);
  assert.deepEqual(updateProgress(before, after, { selected: item.id, entered: [item.id] }),
    { selected: item.id, entered: [item.id] });
});
