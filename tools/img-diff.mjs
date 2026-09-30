/**
 * 截图差异量化工具（仅用于本地自测）。
 *
 * 为什么需要它：样式类改动常常「肉眼看不出来但确实改了」（比如底色阶梯只挪了 1~2 个色阶，
 * 或者只影响 :hover 的投影）。这时候需要两件事：
 *   1. 证明「该变的变了」—— 有的主题必须给出非零差异，否则说明变量没生效；
 *   2. 证明「不该变的没变」—— 比如默认主题必须逐像素一致。
 * 这两件事都没法靠看一眼截图完成。
 *
 * 实现上刻意零依赖：沙盒里 pip 装不上 Pillow，npm 装包要走镜像，都不稳定；
 * Node 自带 zlib，手写一个 PNG 解码器（8bit / 非隔行 / 灰阶|RGB|RGBA|调色板）就够用了。
 * Chrome 截图固定是 8bit RGBA，这条路径覆盖得住。
 *
 * 用法：
 *   node tools/img-diff.mjs <a.png> <b.png>            —— 打印整体差异 + 最大差异块
 *   node tools/img-diff.mjs <a.png> <b.png> --diff <out.png>  —— 额外落一张差异热力图
 *   node tools/img-diff.mjs <a.png> <b.png> --region x0,y0,x1,y1  —— 只统计这块矩形（可叠加 --diff）
 *   node tools/img-diff.mjs <a.png> --sample x,y,x,y   —— 只采样若干点（逗号分隔的坐标对）
 *
 * 为什么需要 --region：页面上总有「注定不稳定」的区域 —— 比如登录页英雄终端里的
 * 打字动画是 JS setInterval 驱动的，animation-play-state 关不掉它。整图算差异时
 * 那几个字会把 MEAN_DELTA 抬上去，掩盖真正要度量的那条渐暗带。裁掉它才是干净分母。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 解出 PNG 的 IHDR、像素数据（统一展开成 RGB，忽略 alpha 的透明混合，截图没有透明区）。 */
function decodePng(path) {
  const buf = readFileSync(path);
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error(`不是 PNG: ${path}`);

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }

  if (bitDepth !== 8) throw new Error(`只支持 8bit，实际 ${bitDepth}`);
  if (interlace !== 0) throw new Error('不支持隔行 PNG');

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`不支持的颜色类型 ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 3);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);

  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    raw.copy(cur, 0, rp, rp + stride);
    rp += stride;
    // 反滤波：PNG 的五种行滤波（None / Sub / Up / Average / Paeth）
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = cur[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      let r;
      let g;
      let bl;
      if (colorType === 0 || colorType === 4) {
        r = g = bl = cur[x * channels];
      } else if (colorType === 3) {
        const idx = cur[x] * 3;
        r = palette[idx];
        g = palette[idx + 1];
        bl = palette[idx + 2];
      } else {
        r = cur[x * channels];
        g = cur[x * channels + 1];
        bl = cur[x * channels + 2];
      }
      const o = (y * width + x) * 3;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = bl;
    }
    cur.copy(prev);
  }

  return { width, height, data: out };
}

function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    let c = 0xffffffff;
    for (const byte of body) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const [a, b, ...rest] = process.argv.slice(2);
if (!a) {
  console.error('usage: node tools/img-diff.mjs <a.png> <b.png> [--diff out.png] | <a.png> --sample x,y,x,y');
  process.exit(2);
}

if (b === '--sample') {
  const img = decodePng(a);
  const coords = (rest[0] || '').split(',').map(Number);
  const lines = [`SIZE=${img.width}x${img.height}`];
  for (let i = 0; i + 1 < coords.length; i += 2) {
    const x = coords[i];
    const y = coords[i + 1];
    const o = (y * img.width + x) * 3;
    lines.push(`(${x},${y})=${img.data[o]},${img.data[o + 1]},${img.data[o + 2]}`);
  }
  console.log(lines.join('  '));
  process.exit(0);
}

const A = decodePng(a);
const B = decodePng(b);
if (A.width !== B.width || A.height !== B.height) {
  console.log(`SIZE_MISMATCH ${A.width}x${A.height} vs ${B.width}x${B.height}`);
  process.exit(1);
}

const regionIdx = rest.indexOf('--region');
let rx0 = 0;
let ry0 = 0;
let rx1 = A.width;
let ry1 = A.height;
let regionLabel = 'FULL';
if (regionIdx >= 0 && rest[regionIdx + 1]) {
  const [a1, b1, c1, d1] = rest[regionIdx + 1].split(',').map(Number);
  rx0 = Math.max(0, a1);
  ry0 = Math.max(0, b1);
  rx1 = Math.min(A.width, c1);
  ry1 = Math.min(A.height, d1);
  regionLabel = `${rx0},${ry0},${rx1},${ry1}`;
}

let changed = 0;
let sum = 0;
let maxDelta = 0;
let maxX = 0;
let maxY = 0;
const heat = Buffer.alloc(A.width * A.height * 3);
for (let y = 0; y < A.height; y++) {
  for (let x = 0; x < A.width; x++) {
    const i = (y * A.width + x) * 3;
    const d = Math.max(
      Math.abs(A.data[i] - B.data[i]),
      Math.abs(A.data[i + 1] - B.data[i + 1]),
      Math.abs(A.data[i + 2] - B.data[i + 2]),
    );
    // 热力图永远铺满全图（能看出「哪里不平」），但统计只算 region 内的像素
    const v = Math.min(255, d * 6);
    heat[i] = v;
    heat[i + 1] = v;
    heat[i + 2] = v;
    if (x < rx0 || x >= rx1 || y < ry0 || y >= ry1) continue;
    sum += d;
    if (d > 0) changed++;
    if (d > maxDelta) {
      maxDelta = d;
      maxX = x;
      maxY = y;
    }
  }
}

const total = (rx1 - rx0) * (ry1 - ry0);
console.log(`SIZE=${A.width}x${A.height}  REGION=${regionLabel}`);
console.log(`CHANGED_PCT=${((changed / total) * 100).toFixed(3)}  MEAN_DELTA=${(sum / total).toFixed(3)}  MAX_DELTA=${maxDelta}@(${maxX},${maxY})`);
// maxDelta 为 0 时不要打印采样点：那时 maxX/maxY 从未被赋值，(0,0) 会误导成「这里差很多」
if (maxDelta > 0) {
  const o = (maxY * A.width + maxX) * 3;
  console.log(`SAMPLE_A @(${maxX},${maxY})=${A.data[o]},${A.data[o + 1]},${A.data[o + 2]}  SAMPLE_B=${B.data[o]},${B.data[o + 1]},${B.data[o + 2]}`);
}

const diffIdx = rest.indexOf('--diff');
if (diffIdx >= 0 && rest[diffIdx + 1]) {
  writeFileSync(rest[diffIdx + 1], encodePng(A.width, A.height, heat));
  console.log(`DIFF_IMG=${rest[diffIdx + 1]}`);
}
