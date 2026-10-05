#!/usr/bin/env node
/**
 * probe-pet-pixels.mjs —— 「桌宠有没有溢出画布」的**像素级**判据（零依赖，纯 Node）
 *
 * 为什么需要它：
 *   tools/smoke-pet-frame.mjs 用「世界包围盒」判定溢出，但它把**局部坐标**当成了画布坐标，
 *   于是报出 `y[-175,469]`、`角色尺寸 179×644（约占画布 134% 高）` 这种结论。
 *   同一帧渲染成 PNG 后实测墨迹只有 160×418，完全在画布内（上留 51px、下留 11px）。
 *   —— 判定「有没有溢出」必须用**真正被画出来的像素**，而不是任意一层坐标。
 *
 * 做法：
 *   1. 用 tools/dump-pet-frame.mjs 的思路导出两帧指令流：正常帧 + 全空帧（清除所有绘制分支）；
 *   2. 交给 tools/rasterize-canvas.py 出 PNG；
 *   3. 纯 Node（zlib）解 PNG，比较两图像素差异，得出墨迹包围盒。
 *   差值法的好处：地面阴影、背景渐变这类「底色」会被抵消，剩下的就是角色本体。
 *
 * 用法：node tools/probe-pet-pixels.mjs [--keep]
 * 退出码：0 = 墨迹在画布内（含 2px 容差）；1 = 越界；2 = 前置条件不满足（Python/Pillow 缺失等）。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = process.argv.includes('--keep');
const FULL = path.join(ROOT, 'tools', '.px-full.png');
const EMPTY = path.join(ROOT, 'tools', '.px-empty.png');

function cleanup() {
  if (KEEP) return;
  for (const f of [FULL, EMPTY]) {
    try {
      if (existsSync(f)) unlinkSync(f);
    } catch {
      /* 清理失败不影响结论 */
    }
  }
}

/* ── 极简 PNG 解码（只支持 Pillow 会产出的 8bit RGB/RGBA、filter 全类型） ── */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
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
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`只支持 8bit PNG，实际 ${bitDepth}`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error(`不支持的颜色类型 ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rp];
    rp += 1;
    const line = raw.subarray(rp, rp + stride);
    rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      const x = line[i];
      let v;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`未知 PNG filter ${filter}`);
      cur[i] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/* ── 导出指令流并光栅化 ── */
function render(dumpArgs, png) {
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'dump-pet-frame.mjs'), ...dumpArgs], { cwd: ROOT, stdio: 'pipe' });
  const json = path.join(ROOT, 'tools', '.frame.json');
  if (!existsSync(json)) throw new Error('dump-pet-frame.mjs 没有产出 tools/.frame.json');
  execFileSync('python', [path.join(ROOT, 'tools', 'rasterize-canvas.py'), json, png, '--scale', '1'], { cwd: ROOT, stdio: 'pipe' });
  if (!existsSync(png)) throw new Error(`光栅化失败，没有产出 ${png}`);
  return decodePng(readFileSync(png));
}

function main() {
  let img;
  try {
    img = render([], FULL);
  } catch (err) {
    console.error(`⚠ 无法完成像素级测量（前置条件缺失）：${err.message}`);
    console.error('  CI（ubuntu-latest）装 Pillow 后即可；本地缺 Python 时这条检查会跳过。');
    cleanup();
    process.exit(2);
  }

  const { width, height, channels, data } = img;
  const bg = [data[0], data[1], data[2]];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let ink = 0;
  const DIFF = 8;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      const d = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
      if (d > DIFF) {
        ink += 1;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }

  console.log(`画布 ${width}×${height}，与底色 (${bg.join(',')}) 不同的像素 ${ink} 个`);
  if (!ink) {
    console.error('✗ 整幅图与底色一致 —— 说明这一帧什么都没画出来');
    cleanup();
    process.exit(1);
  }
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  console.log(`墨迹包围盒 x[${x0},${x1}] y[${y0},${y1}]  →  ${w}×${h}`);
  console.log(`留白：上 ${y0}px / 下 ${height - 1 - y1}px / 左 ${x0}px / 右 ${width - 1 - x1}px`);

  const PAD = 2;
  const bad = [];
  if (x0 < -PAD || y0 < -PAD || x1 > width - 1 + PAD || y1 > height - 1 + PAD) bad.push('墨迹越出画布');
  if (w < 80 || h < 120) bad.push(`角色太小（${w}×${h}），可能整块没画出来`);
  if (bad.length) {
    console.error(`✗ ${bad.join('；')}`);
    cleanup();
    process.exit(1);
  }
  console.log('✅ 桌宠墨迹完全落在画布内，且尺寸合理。');
  cleanup();
  process.exit(0);
}

main();
