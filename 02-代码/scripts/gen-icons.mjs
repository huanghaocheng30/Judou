#!/usr/bin/env node
// 生成应用图标（打包必需）：icons/32x32.png、icons/128x128.png、icons/icon.ico。
// 纯 Node 实现（zlib + 手写 PNG/ICO 容器），不引入图像库；幂等，可复跑。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = path.join(root, 'src-tauri', 'icons');

const BRAND = [47, 111, 237]; // #2f6fed
const LEAF = [238, 243, 254];

function drawPixel(x, y, size) {
  const r = size * 0.28;
  const cx = Math.min(x, size - 1 - x);
  const cy = Math.min(y, size - 1 - y);
  // 圆角矩形外透明的品牌蓝底
  if (cx < r && cy < r) {
    const dx = r - cx;
    const dy = r - cy;
    if (dx * dx + dy * dy > r * r) return [0, 0, 0, 0];
  }
  // 两条白色横线（抽象「书页」）
  const lineTop = size * 0.34;
  const lineBottom = size * 0.62;
  const thick = Math.max(1, size * 0.06);
  const left = size * 0.24;
  const right = size * 0.76;
  if (x >= left && x <= right && ((y >= lineTop && y < lineTop + thick) || (y >= lineBottom && y < lineBottom + thick))) {
    return [LEAF[0], LEAF[1], LEAF[2], 255];
  }
  return [BRAND[0], BRAND[1], BRAND[2], 255];
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(size) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = drawPixel(x, y, size);
      const o = y * stride + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 传统 BMP 格式 ICO 条目（Windows 兼容性最好：32bpp XOR + 1bpp AND mask）
function bmpEntry(size) {
  const header = Buffer.alloc(40);
  header.writeInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight = XOR + AND
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeInt32LE(0, 16); // BI_RGB
  header.writeInt32LE(size * size * 4, 20); // biSizeImage

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = drawPixel(x, y, size);
      const o = ((size - 1 - y) * size + x) * 4; // BMP 自底向上，BGRA
      xor[o] = b;
      xor[o + 1] = g;
      xor[o + 2] = r;
      xor[o + 3] = a;
    }
  }
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const andMask = Buffer.alloc(maskRowBytes * size); // 全 0 = 全部不透明
  return Buffer.concat([header, xor, andMask]);
}

function encodeIco(sizes) {
  const entries = sizes.map((size) => bmpEntry(size));
  const dir = Buffer.alloc(6 + 16 * sizes.length);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2); // type = icon
  dir.writeUInt16LE(sizes.length, 4);
  let offset = dir.length;
  sizes.forEach((size, i) => {
    const e = 6 + i * 16;
    dir[e] = size >= 256 ? 0 : size;
    dir[e + 1] = size >= 256 ? 0 : size;
    dir[e + 2] = 0;
    dir[e + 3] = 0;
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(entries[i].length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += entries[i].length;
  });
  return Buffer.concat([dir, ...entries]);
}

fs.mkdirSync(iconsDir, { recursive: true });
const png32 = encodePng(32);
const png128 = encodePng(128);
const ico = encodeIco([32, 256]);
fs.writeFileSync(path.join(iconsDir, '32x32.png'), png32);
fs.writeFileSync(path.join(iconsDir, '128x128.png'), png128);
fs.writeFileSync(path.join(iconsDir, 'icon.ico'), ico);
console.log(`icons 已生成：32x32.png=${png32.length}B 128x128.png=${png128.length}B icon.ico=${ico.length}B`);
