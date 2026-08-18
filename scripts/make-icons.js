'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public', 'icons');

function crc32(buf) {
  let c = (crc => { for (let i = 0; i < 256; i++) { let x = i; for (let k = 0; k < 8; k++) x = (x & 1) ? (0xedb88320 ^ (x >>> 1)) : (x >>> 1); crc[i] = x >>> 0; } return crc; })(new Uint32Array(256));
  let r = 0xffffffff;
  for (let i = 0; i < buf.length; i++) r = (r >>> 8) ^ c[(r ^ buf[i]) & 0xff];
  return (r ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx, y = ay + t * dy;
  return Math.hypot(px - x, py - y);
}

function roundedRectDist(px, py, size, r) {
  const cx = Math.max(r, Math.min(size - r, px));
  const cy = Math.max(r, Math.min(size - r, py));
  return Math.hypot(px - cx, py - cy);
}

function renderIcon(size, { bg = [10, 125, 79], fg = [255, 255, 255], padding = 0.12, maskable = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const stroke = size * 0.11;
  const pts = [
    [0.26, 0.70], [0.36, 0.32], [0.50, 0.64], [0.64, 0.32], [0.74, 0.70]
  ].map(([x, y]) => [x * size, y * size]);
  const r = size * 0.22;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const d = roundedRectDist(x + 0.5, y + 0.5, size, r);
      const bgA = Math.max(0, Math.min(1, (r - d + 0.5)));
      if (bgA <= 0) continue;
      let minD = Infinity;
      for (let k = 0; k < pts.length - 1; k++) {
        minD = Math.min(minD, distToSegment(x + 0.5, y + 0.5, pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]));
      }
      const fgA = Math.max(0, Math.min(1, (stroke - minD) + 0.5));
      rgba[i] = Math.round(bg[0] * bgA + fg[0] * fgA * bgA);
      rgba[i + 1] = Math.round(bg[1] * bgA + fg[1] * fgA * bgA);
      rgba[i + 2] = Math.round(bg[2] * bgA + fg[2] * fgA * bgA);
      rgba[i + 3] = Math.round(bgA * 255);
    }
  }
  return encodePng(size, rgba);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'icon-192.png'), renderIcon(192));
fs.writeFileSync(path.join(OUT, 'icon-512.png'), renderIcon(512));
fs.writeFileSync(path.join(OUT, 'icon-maskable-512.png'), renderIcon(512, { padding: 0.10, maskable: true }));
console.log('icons written to', OUT);