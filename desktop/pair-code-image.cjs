'use strict';
// The claim code of Add a browser as a picture (wave 5). The pairing window (desktop/phones-pair.js) must never hold the code as text, so
// the main process draws it here: a small fixed bitmap font (5 x 7 cells per symbol), scaled up, black on white, in groups of four
// ("ABCD-EFGH-JKMN"), as a 1-bit greyscale PNG made with zlib and a CRC32 of its own. The PNG has no text chunk, so the code is only in the
// pixels. Nothing here logs. Only the Crockford symbols of a claim code (lib/remote/pairing.mjs CLAIM_ALPHABET) and the dash are drawn.

const zlib = require('node:zlib');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CLAIM = /^[0-9A-HJKMNP-TV-Z]{12}$/;
const GLYPH_W = 5;
const GLYPH_H = 7;
const GAP = 1;
const MARGIN = 2;
const DEFAULT_SCALE = 8;

// Each symbol is seven rows of five cells, the high bit on the left. The zero has a slash, so it is never read as a letter.
const FONT = Object.freeze({
  0: [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  1: [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  2: [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  3: [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
  4: [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  5: [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  6: [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  7: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  8: [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  9: [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  D: [0b11100, 0b10010, 0b10001, 0b10001, 0b10001, 0b10010, 0b11100],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b10101, 0b01010],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  Z: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
  '-': [0b00000, 0b00000, 0b00000, 0b11111, 0b00000, 0b00000, 0b00000],
});

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
  return Buffer.concat([head, data, tail]);
}

// "ABCDEFGHJKMN" -> "ABCD-EFGH-JKMN": the groups the picture shows. Dashes and spaces do not matter when it is typed.
const grouped = code => `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;

// The cells of one line of symbols: a grid of booleans, MARGIN cells of white all round.
function cellsOf(text) {
  const width = MARGIN * 2 + text.length * (GLYPH_W + GAP) - GAP;
  const height = MARGIN * 2 + GLYPH_H;
  const cells = Array.from({ length: height }, () => new Array(width).fill(false));
  [...text].forEach((ch, i) => {
    const rows = FONT[ch];
    if (!rows) throw new Error('That symbol cannot be drawn.');
    const x0 = MARGIN + i * (GLYPH_W + GAP);
    for (let r = 0; r < GLYPH_H; r++) {
      for (let c = 0; c < GLYPH_W; c++) if (rows[r] & (0x10 >> c)) cells[MARGIN + r][x0 + c] = true;
    }
  });
  return { cells, width, height };
}

// The PNG bytes of a claim code. `scale` pixels per cell (2 to 16). Throws on anything that is not a claim code.
function claimPngBytes(code, { scale = DEFAULT_SCALE } = {}) {
  if (typeof code !== 'string' || !CLAIM.test(code)) throw new Error('That is not a claim code.');
  const k = Math.min(16, Math.max(2, Math.floor(Number(scale) || DEFAULT_SCALE)));
  const { cells, width, height } = cellsOf(grouped(code));
  const w = width * k;
  const h = height * k;
  const stride = Math.ceil(w / 8);
  const rows = Buffer.alloc((stride + 1) * h, 0xff);
  for (let y = 0; y < h; y++) {
    const start = y * (stride + 1);
    rows[start] = 0; // filter type: none
    const line = cells[Math.floor(y / k)];
    for (let x = 0; x < w; x++) if (line[Math.floor(x / k)]) rows[start + 1 + (x >> 3)] &= ~(0x80 >> (x & 7));
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 1; // bit depth
  header[9] = 0; // greyscale
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// The PNG as a data URL, which the window's policy allows (img-src data:).
function claimPng(code, options) {
  return `data:image/png;base64,${claimPngBytes(code, options).toString('base64')}`;
}

module.exports = { claimPng, claimPngBytes, crc32, FONT, CLAIM, GLYPH_W, GLYPH_H, GAP, MARGIN, DEFAULT_SCALE, grouped };
