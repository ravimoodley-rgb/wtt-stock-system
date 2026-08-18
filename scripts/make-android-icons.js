'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RES = path.join(__dirname, '..', 'android-wtt', 'android', 'app', 'src', 'main', 'res');

function crc32(buf) {
  const table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let x = i; for (let k = 0; k < 8; k++) x = (x & 1) ? (0xedb88320 ^ (x >>> 1)) : (x >>> 1); t[i] = x >>> 0; }
    return t;
  })();
  let r = 0xffffffff;
  for (let i = 0; i < buf.length; i++) r = (r >>> 8) ^ table[(r ^ buf[i]) & 0xff];
  return (r ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function roundedRectDist(px, py, size, r) {
  const cx = Math.max(r, Math.min(size - r, px));
  const cy = Math.max(r, Math.min(size - r, py));
  return Math.hypot(px - cx, py - cy);
}

const W = [[0.26, 0.70], [0.36, 0.32], [0.50, 0.64], [0.64, 0.32], [0.74, 0.70]];

function renderLauncher(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const stroke = size * 0.11, r = size * 0.22;
  const pts = W.map(([x, y]) => [x * size, y * size]);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const d = roundedRectDist(x + 0.5, y + 0.5, size, r);
    const bgA = Math.max(0, Math.min(1, r - d + 0.5));
    if (bgA <= 0) continue;
    let minD = Infinity;
    for (let k = 0; k < pts.length - 1; k++) minD = Math.min(minD, distToSegment(x + 0.5, y + 0.5, pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]));
    const fgA = Math.max(0, Math.min(1, stroke - minD + 0.5));
    rgba[i] = Math.round(10 * bgA + 255 * fgA * bgA);
    rgba[i + 1] = Math.round(125 * bgA + 255 * fgA * bgA);
    rgba[i + 2] = Math.round(79 * bgA + 255 * fgA * bgA);
    rgba[i + 3] = Math.round(bgA * 255);
  }
  return encodePng(size, rgba);
}

function renderForeground(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = 0.62; // adaptive safe zone
  const cx = size / 2, cy = size / 2;
  const stroke = size * 0.075;
  const pts = W.map(([x, y]) => [cx + (x - 0.5) * size * scale, cy + (y - 0.5) * size * scale]);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let minD = Infinity;
    for (let k = 0; k < pts.length - 1; k++) minD = Math.min(minD, distToSegment(x + 0.5, y + 0.5, pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]));
    const a = Math.max(0, Math.min(1, stroke - minD + 0.5));
    if (a <= 0) continue;
    const i = (y * size + x) * 4;
    rgba[i] = 255; rgba[i + 1] = 255; rgba[i + 2] = 255; rgba[i + 3] = Math.round(a * 255);
  }
  return encodePng(size, rgba);
}

const DENSITIES = {
  'mdpi': { launcher: 48, fg: 108 },
  'hdpi': { launcher: 72, fg: 162 },
  'xhdpi': { launcher: 96, fg: 216 },
  'xxhdpi': { launcher: 144, fg: 324 },
  'xxxhdpi': { launcher: 192, fg: 432 }
};

for (const [density, sizes] of Object.entries(DENSITIES)) {
  const dir = path.join(RES, `mipmap-${density}`);
  fs.writeFileSync(path.join(dir, 'ic_launcher.png'), renderLauncher(sizes.launcher));
  fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), renderLauncher(sizes.launcher));
  fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), renderForeground(sizes.fg));
}
console.log('android launcher icons written');