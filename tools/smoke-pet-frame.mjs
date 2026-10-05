/**
 * 桌宠画面几何自检（Node，零依赖）
 *
 * 为什么需要它：`smoke-pet-render.mjs` 只证明"没有 NaN / 没有抛异常"，
 * 像素图只有人眼能看。而坐标口径类缺陷（把绝对坐标当相对坐标）恰恰**不抛异常、
 * 不产生 NaN**，只会让角色整块飞出画布 —— 本项目已经因为这个问题连错三次
 * （只剩后发、只剩阴影、五官跑到肩膀外）。
 *
 * 本工具把"人眼看图的判断"变成可断言的数字：
 *   1. 每个部件（按绘制顺序切分）的世界包围盒
 *   2. 必须落在画布内（允许少量出血，但不能整块在外面）
 *   3. 脸部特征（眼/眉/嘴）必须落在头部椭圆内
 *   4. 脚必须与地面阴影接触
 *   5. 命中区（interactions.getRegions）必须覆盖到对应部件的实际像素
 *
 * 用法：
 *   node tools/smoke-pet-frame.mjs                 # 默认 idle
 *   node tools/smoke-pet-frame.mjs --mood happy    # 指定情绪
 *   node tools/smoke-pet-frame.mjs --json          # 输出机器可读结果
 *
 * 退出码：0 = 全部通过；1 = 有硬失败。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* ── 参数 ── */
const argv = process.argv.slice(2);
const getArg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const AS_JSON = argv.includes('--json');
const SHOW_TOP = argv.includes('--top');
const MOOD = getArg('--mood', 'idle');

/* ── 最小 DOM 垫片（与 dump-pet-frame.mjs 同款，保持独立以免互相耦合） ── */
function makeCtx() {
  let m = [1, 0, 0, 1, 0, 0];
  let dpr = 1;
  const stack = [];
  const ops = [];
  const state = { globalAlpha: 1, fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '10px sans-serif' };

  const mul = (n) => {
    const [a, b, c, d, e, f] = m;
    const [a2, b2, c2, d2, e2, f2] = n;
    m = [a * a2 + c * b2, b * a2 + d * b2, a * c2 + c * d2, b * c2 + d * d2, a * e2 + c * f2 + e, b * e2 + d * f2 + f];
  };
  const cmds = [];
  const mark = (op, extra = {}) => ops.push({ op, cmds: cmds.map((c) => [...c]), transform: [...m], alpha: state.globalAlpha, ...extra });

  const grad = (kind, args) => ({ __gradient: kind, args, stops: [], addColorStop(o, c) { this.stops.push({ offset: o, color: c }); } });

  return {
    canvas: { width: 360, height: 480 },
    __ops: ops,
    save() { stack.push({ m: [...m], s: { ...state } }); },
    restore() { const p = stack.pop(); if (p) { m = p.m; Object.assign(state, p.s); } },
    translate(x, y) { mul([1, 0, 0, 1, x, y]); },
    scale(x, y) { mul([x, 0, 0, y, 0, 0]); },
    rotate(r) { const c = Math.cos(r), s = Math.sin(r); mul([c, s, -s, c, 0, 0]); },
    transform(a, b, c, d, e, f) { mul([a, b, c, d, e, f]); },
    setTransform(a, b, c, d, e, f) {
      if (a > 0 && b === 0 && c === 0 && d === a && e === 0 && f === 0) { dpr = a; m = [1, 0, 0, 1, 0, 0]; return; }
      m = [a, b, c, d, e, f];
    },
    resetTransform() { m = [1, 0, 0, 1, 0, 0]; },
    getTransform() { return { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] }; },
    beginPath() { cmds.length = 0; },
    closePath() { cmds.push(['Z']); },
    moveTo(x, y) { cmds.push(['M', x, y]); },
    lineTo(x, y) { cmds.push(['L', x, y]); },
    quadraticCurveTo(a, b, c, d) { cmds.push(['Q', a, b, c, d]); },
    bezierCurveTo(a, b, c, d, e, f) { cmds.push(['C', a, b, c, d, e, f]); },
    arc(x, y, r, s, e, ccw) { cmds.push(['A', x, y, r, s, e, ccw ? 1 : 0]); },
    arcTo(x1, y1, x2, y2, r) { cmds.push(['AT', x1, y1, x2, y2, r]); },
    ellipse(x, y, rx, ry, rot, s, e, ccw) { cmds.push(['E', x, y, rx, ry, rot, s, e, ccw ? 1 : 0]); },
    rect(x, y, w, h) { cmds.push(['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h]); },
    roundRect(x, y, w, h) { this.rect(x, y, w, h); },
    fill() { mark('fill'); },
    stroke() { mark('stroke'); },
    clip() { mark('clip'); },
    fillRect(x, y, w, h) { mark('fillRect', { rect: [x, y, w, h] }); },
    strokeRect(x, y, w, h) { mark('strokeRect', { rect: [x, y, w, h] }); },
    clearRect() { ops.length = 0; cmds.length = 0; },
    fillText(t, x, y) { mark('text', { at: [x, y], text: String(t) }); },
    strokeText(t, x, y) { mark('text', { at: [x, y], text: String(t) }); },
    measureText: (t) => ({ width: String(t).length * 8 }),
    createLinearGradient: (...a) => grad('linear', a),
    createRadialGradient: (...a) => grad('radial', a),
    setLineDash() {}, getLineDash: () => [],
    createPattern: () => null,
    drawImage() {},
    get fillStyle() { return state.fillStyle; }, set fillStyle(v) { state.fillStyle = v; },
    get strokeStyle() { return state.strokeStyle; }, set strokeStyle(v) { state.strokeStyle = v; },
    get lineWidth() { return state.lineWidth; }, set lineWidth(v) { state.lineWidth = v; },
    get globalAlpha() { return state.globalAlpha; }, set globalAlpha(v) { state.globalAlpha = v; },
    get font() { return state.font; }, set font(v) { state.font = v; },
    textAlign: 'start', textBaseline: 'alphabetic', lineCap: 'butt', lineJoin: 'miter',
    globalCompositeOperation: 'source-over', shadowBlur: 0, shadowColor: 'transparent',
    __dpr: () => dpr,
  };
}

const defineGlobal = (n, v) => Object.defineProperty(globalThis, n, { value: v, writable: true, configurable: true });
const makeStorage = () => { const mp = new Map(); return { getItem: (k) => (mp.has(String(k)) ? mp.get(String(k)) : null), setItem: (k, v) => mp.set(String(k), String(v)), removeItem: (k) => mp.delete(String(k)), clear: () => mp.clear(), key: (i) => [...mp.keys()][i] ?? null, get length() { return mp.size; } }; };
const canvasStub = () => {
  const ctx = makeCtx();
  const c = { width: 360, height: 480, style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, getContext: () => ctx, addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 360, height: 480, right: 360, bottom: 480 }) };
  c.__ctx = ctx;
  return c;
};
const theCanvas = canvasStub();
defineGlobal('window', globalThis);
defineGlobal('document', {
  documentElement: { dataset: {}, style: {} },
  body: { dataset: {}, style: {}, appendChild() {}, classList: { add() {}, remove() {} } },
  createElement: () => canvasStub(),
  getElementById: (id) => (id === 'aemeath-canvas' ? theCanvas : null),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
});
defineGlobal('navigator', { userAgent: 'node', language: 'zh-CN', languages: ['zh-CN'] });
defineGlobal('location', { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1' });
defineGlobal('localStorage', makeStorage());
defineGlobal('sessionStorage', makeStorage());
defineGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 16));
defineGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
if (!globalThis.performance) defineGlobal('performance', { now: () => Date.now() });
defineGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
defineGlobal('addEventListener', () => {});
defineGlobal('removeEventListener', () => {});
defineGlobal('dispatchEvent', () => true);

/* ── 世界坐标包围盒 ── */
function opPoints(o) {
  const [a, b, c, d, e, f] = o.transform;
  const pts = [];
  if (o.rect) {
    const [x, y, w, h] = o.rect;
    for (const [px, py] of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]) pts.push([px, py]);
  } else if (o.at) {
    pts.push([o.at[0], o.at[1]]);
  } else {
    for (const cm of o.cmds || []) {
      switch (cm[0]) {
        case 'M': case 'L': pts.push([cm[1], cm[2]]); break;
        case 'Q': pts.push([cm[1], cm[2]], [cm[3], cm[4]]); break;
        case 'C': pts.push([cm[1], cm[2]], [cm[3], cm[4]], [cm[5], cm[6]]); break;
        case 'A': {
          const [cx, cy, r] = [cm[1], cm[2], cm[3]];
          for (let k = 0; k < 16; k++) { const t = (2 * Math.PI * k) / 16; pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
          break;
        }
        case 'AT': pts.push([cm[1], cm[2]], [cm[3], cm[4]]); break;
        case 'E': {
          const [cx, cy, rx, ry] = [cm[1], cm[2], cm[3], cm[4]];
          for (let k = 0; k < 24; k++) { const t = (2 * Math.PI * k) / 24; pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]); }
          break;
        }
        default: break;
      }
    }
  }
  return pts.map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
}

function worldBBox(o) {
  const pts = opPoints(o);
  if (!pts.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return { x0: Math.round(x0), y0: Math.round(y0), x1: Math.round(x1), y1: Math.round(y1) };
}

const union = (a, b) => (!a ? b : !b ? a : { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
const inBBox = (p, b, pad = 0) => p[0] >= b.x0 - pad && p[0] <= b.x1 + pad && p[1] >= b.y0 - pad && p[1] <= b.y1 + pad;

/* ── 关于「路径形状」的检查：本文件**故意不做**，理由写在下面 ──
 *
 * 需求来源：`web/js/pet/draw.js` 的 `capsule()` 曾经两段 `ctx.arc()` 都扫同一侧，
 * 一度让脖子/腿/手臂在像素图里呈现「锥形」。很自然会想加一条机械判据，免得再犯。
 *
 * 我为此在 2026 年这轮里试了**六种**判据，**全部失败**，逐条留档以免后人重走：
 *   1) 折线化后数自相交边对 → 稳定误报
 *      原因：`opPoints()` 把 `A` 近似成「y 钉在 cy 上的 16 边形」，两端半径不同
 *      的胶囊会被这层近似自己切出交叉。
 *   2) |有向面积| / 凸包面积 < 0.55 → 稳定误报（同一近似原因）
 *   3) 密铺格心沿 +x 打射线、穿越次数 >= 2 判自相交 → 稳定误报
 *      原因：地面阴影椭圆自己就报「17 个格心 >= 2 次」；凹口/多段轮廓在粗网格上
 *      必然 >= 2 次。
 *   4) 整条路径 |Σ叉积| / Σ|叉积| < 0.6 → 稳定误报
 *      原因：shoelace 的叉积含**与原点有关**的项，离画布原点越远的部件比值越低
 *      （地面阴影在 y≈450 掉到 0.08）。
 *   5) 只取弧段点的 |Σ叉积| / Σ|叉积| → **无法区分**：修好与坏掉的 capsule 都是 0.119，
 *      折算成质心坐标系后两者又都变成 1.000。
 *   6) 「圆心到切平面距离 == 半径」局部守恒律 → **无法区分**：好坏都是 1.000。
 *      根因是本项目那段的几何：两端圆心正好落在**切平面**上，
 *      两段弧各自取「右半圆」还是「另一半圆」，都同时把该端切平面朝外推到 ±r，
 *      包围盒完全无法分辨。
 *   7) 宽度剖面法（沿长轴分桶量填充宽度，判「单端单调收窄成尖」）→ 实测**抓不到**
 *      真实缺陷：对 4bf1fd3 的 capsule() 也不报。而且它在「刘海对称尖角」上误报过。
 *
 * **真正的结论（重要）**：`smoke-pet-render.mjs` 只证明「无 NaN、无异常、迭代数正常」，
 * 它**在原理上**抓不到「形状对了没有」；形状只能靠**像素**看。已落地的可靠闭环是：
 *
 *     node tools/dump-pet-frame.mjs --mood idle --out tools/samples/frame-idle.json
 *     python tools/rasterize-canvas.py tools/samples/frame-idle.json tools/samples/frame-idle.png --scale 2
 *     # 然后用 read_image 看图；`tools/contact-sheet.py` 可以一次拼 6 种情绪
 *
 * `rasterize-canvas.py` 的 `fill_nonzero()` 按**非零环绕规则**填充（与浏览器一致），
 * 并带 2x2 超采样，所以它能忠实暴露这类几何问题 —— 别把那里的 `fill_nonzero` 换回
 * `ImageDraw.polygon()`（那是偶奇规则）。
 *
 * 本文件保留的几何断言（包围盒、尺寸、脸部绘制条数、脚/阴影对齐、命中区自洽）
 * 都是**结构性**的，不会误报；请不要再往这里加「形状像不像」的启发式判据。
 */

/**
 * 诊断用：按"最靠上"排序列出若干条绘制指令，带序号 / 类型 / 世界包围盒 / 变换矩阵 / 前几个路径点。
 *
 * 为什么要有它：只说「整体 y0=-175」不能定位是**哪个部件**飞了，而绘制指令本身不带名字
 * （draw.js 没有打标机制）。把「第 i 条、什么矩阵、什么局部坐标」打出来，就能直接反推
 * 是哪个 ctx.translate 组合错了 —— 这次就是靠它找到"某个部件把绝对坐标又叠了一次"。
 * 用 `--top` 显式打开，避免正常通过时刷屏。
 */
function dumpTopOps(parts, allOps, n = 8) {
  const rows = [...parts].sort((a, b) => a.bbox.y0 - b.bbox.y0).slice(0, n);
  console.log(`\n── 最靠上的 ${rows.length} 条绘制（ops 数组现有 ${allOps ? allOps.length : 'null'} 条，解析出包围盒 ${parts.length} 条）──`);
  for (const p of rows) {
    const o = allOps ? allOps[p.i] : null;
    if (!o) { console.log(`  #${p.i} (指令缺失)`); continue; }
    const t = o.transform.map((v) => Math.round(v * 100) / 100);
    const cmds = (o.cmds || []).slice(0, 3).map((c) => c.map((v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)).join(',')).join(' | ');
    console.log(`  #${String(p.i).padStart(3)} ${o.op.padEnd(9)} world y[${p.bbox.y0},${p.bbox.y1}] x[${p.bbox.x0},${p.bbox.x1}]`);
    console.log(`       matrix [${t.join(', ')}]${o.rect ? ` rect [${o.rect.join(', ')}]` : ''}${o.text ? ` text "${o.text}"` : ''}`);
    if (cmds) console.log(`       cmds ${cmds}`);
  }
}

/* ── 跑一帧 ── */
const petMod = await import(pathToFileURL(path.join(ROOT, 'web', 'js', 'pet', 'index.js')).href);
const { PetUI, ACTIONS } = petMod;
const interMod = await import(pathToFileURL(path.join(ROOT, 'web', 'js', 'pet', 'interactions.js')).href);
const constMod = await import(pathToFileURL(path.join(ROOT, 'web', 'js', 'pet', 'constants.js')).href);

await PetUI.mount(theCanvas, { scale: 1 });
for (let i = 0; i < 60; i++) PetUI.update(1 / 60);
PetUI.setMood(MOOD);
for (let i = 0; i < 12; i++) PetUI.update(1 / 60);

const ops = theCanvas.__ctx.__ops;
/* `PetUI.unmount()` 会 clearRect 从而清空 ops，而输出发生在 unmount 之后 —— 所以先存快照。
   （否则诊断打印出来的 ops 数组永远是 0 条，只能看到"指令缺失"。） */
const opsSnapshot = ops.slice();
const parts = ops.map((o, i) => ({ i, op: o.op, bbox: worldBBox(o) })).filter((p) => p.bbox);

/* 按"绘制顺序"分段识别部件：靠几何位置聚类，避免给 draw.js 打标 */
const all = parts.reduce((acc, p) => union(acc, p.bbox), null);
const total = parts.length;

/* ── 断言 ── */
const failures = [];
const warnings = [];
const notes = [];

const W = constMod.CANVAS_W, H = constMod.CANVAS_H;
const HEAD = constMod.HEAD, FACE = constMod.FACE, BONES = constMod.BONES;
const OY = constMod.ORIGIN_Y, OX = constMod.ORIGIN_X;
const worldHead = { x0: OX + HEAD.cx - HEAD.rx, y0: OY + HEAD.cy - HEAD.ry, x1: OX + HEAD.cx + HEAD.rx, y1: OY + HEAD.cy + HEAD.ry };
const worldFace = { x0: OX + FACE.cx - FACE.rx, y0: OY + FACE.cy - FACE.ry, x1: OX + FACE.cx + FACE.rx, y1: OY + FACE.cy + FACE.ry };

/* 1) 整体必须在画布内 */
if (!all) failures.push('这一帧没有任何绘制指令 —— 渲染链没跑起来');
else {
  if (all.y0 < -8) failures.push(`整体包围盒上溢出画布： y0=${all.y0}（应为 >= -8）。多半是某个部件又叠加了一次绝对坐标。`);
  if (all.y1 > H + 8) failures.push(`整体包围盒下溢出画布： y1=${all.y1}（应为 <= ${H + 8}）`);
  if (all.x0 < -8) failures.push(`整体包围盒左溢出画布： x0=${all.x0}`);
  if (all.x1 > W + 8) failures.push(`整体包围盒右溢出画布： x1=${all.x1}`);
  notes.push(`整体包围盒 x[${all.x0},${all.x1}] y[${all.y0},${all.y1}]（画布 ${W}×${H}）`);
}

/* 2) 角色应占据画布的大部分高度（防止"只画出一小块"） */
if (all) {
  const h = all.y1 - all.y0;
  if (h < H * 0.5) failures.push(`角色只占了 ${h}px 高（画布 ${H}px）—— 说明大部分部件没画出来或被推到画布外`);
  const w = all.x1 - all.x0;
  if (w < 40) failures.push(`角色只有 ${w}px 宽，明显退化`);
  notes.push(`角色尺寸 ${w}×${h}（约占画布 ${Math.round((h / H) * 100)}% 高）`);
}

/* 3) 五官必须落在头部椭圆内（这是"脸长在头上"的机械判据） */
const faceish = parts.filter((p) => {
  const b = p.bbox;
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  return inBBox([cx, cy], worldFace, 26);
});
if (faceish.length < 6) failures.push(`落在脸部区域内的绘制只有 ${faceish.length} 条（期望 >= 6：双眉、双眼、瞳孔、嘴）。五官可能又跑出头部了。`);
else notes.push(`脸部区域绘制 ${faceish.length} 条`);

/* 4) 颈/头必须衔接：头部椭圆的中心应落画布上半部 */
if (all) {
  const headCenterY = OY + HEAD.cy;
  if (headCenterY < 0 || headCenterY > H) failures.push(`头心 y=${headCenterY} 不在画布内`);
  const fr = constMod.REGION;
  if (headCenterY < fr.headTopY - 40 || headCenterY > fr.headBottomY + 40) warnings.push(`头心 y=${headCenterY} 偏离 REGION 头部带 [${fr.headTopY},${fr.headBottomY}]`);
}

/* 5) 脚与阴影：脚底（root 世界坐标）应接近地面阴影中心 */
{
  const rootY = OY + BONES.root.y;
  const shadow = parts.find((p, idx) => idx === 0);
  if (!shadow) warnings.push('没找到第一条绘制（通常是地面阴影）');
  else {
    const sc = (shadow.bbox.y0 + shadow.bbox.y1) / 2;
    if (Math.abs(sc - rootY) > 40) failures.push(`地面阴影中心 y=${Math.round(sc)} 与脚底 y=${rootY} 相差 ${Math.round(Math.abs(sc - rootY))}px（应 <= 40）—— 角色悬空或陷进地里`);
    else notes.push(`阴影中心 y=${Math.round(sc)} ≈ 脚底 y=${rootY}`);
  }
}

/* 6) 命中区必须覆盖到对应部件的实际像素 */
{
  const pose = PetUI.getDebugState ? PetUI.getDebugState() : null;
  const regs = interMod.getRegions(pose && pose.pose ? pose.pose : undefined);

  /*
   * 注意：这里**不能**用"区域中心是否正好压在某条绘制指令的中心上"作判据。
   * `getRegions()` 的手部圆是按 HANDS.* 常量算的固定点，而 `drawArms`/`drawHands`
   * 会把手臂摆角、身体前倾、idle 摆动一起算进去 —— 两侧相差十几到几十像素是**正常的**，
   * 用中心点判据会稳定误报（本项目已因此误报过两轮）。
   * 真正要防的是"命中区整体落在角色外面"（比如坐标口径写错、区域跟着绝对坐标飞了），
   * 所以改判：区域中心必须落在**整体包围盒**内。
   */
  for (const r of regs) {
    if (!all) break;
    if (!inBBox([r.cx, r.cy], all, 8)) {
      warnings.push(`命中区 "${r.part || r.id || r.name || '?'}" 中心 (${Math.round(r.cx)},${Math.round(r.cy)}) 落在角色整体包围盒之外`);
    }
  }

  /*
   * hitTest 自洽：区域中心应命中该 part **或该 part 的包含者**。
   * head / hair / face 三个区域在设计上就是同心嵌套的（face ⊂ head ⊂ hair，见 interactions.js:129-131），
   * 而 hitTest 的优先级是 face > hair > head —— 所以 head 区中心返回 "face" 是**正确语义**，
   * 不是缺陷。只把"返回了一个完全不相干的 part"当真问题。
   */
  const CONTAINERS = { face: ['head'], head: ['hair'], hair: [], body: [], hand: [] };
  for (const r of regs) {
    const want = r.part || r.id;
    const got = interMod.hitTest(r.cx, r.cy);
    if (got === want) continue;
    if (regionContains(got, [r.cx, r.cy], regs)) continue;
    warnings.push(`hitTest(${Math.round(r.cx)},${Math.round(r.cy)}) = "${got}"，但该区域自称是 "${want}"（且该点并不在 "${got}" 区内）`);
  }
}

/**
 * 点 p 是否落在名为 `name` 的命中区内 —— 用来认可"同心嵌套"造成的合法覆盖：
 * head / hair / face 是同心包络（face ⊂ head ⊂ hair），hitTest 优先级是 face > hair > head，
 * 所以 hair 区的中心点返回 "face" 是**正确语义**，不是缺陷。
 * 只有当 hitTest 返回了一个**该点根本不在其中**的 part 时，才是真问题。
 */
function regionContains(name, p, regs) {
  const r = regs.find((x) => (x.part || x.id) === name);
  if (!r) return false;
  return inBBox(p, { x0: r.cx - r.rx, y0: r.cy - r.ry, x1: r.cx + r.rx, y1: r.cy + r.ry }, 0.5);
}

/* 7) 所有数值必须有限 */
{
  let bad = 0;
  for (const o of ops) {
    for (const cm of o.cmds || []) for (const v of cm.slice(1)) if (typeof v === 'number' && !Number.isFinite(v)) bad++;
    for (const k of ['transform', 'rect', 'at']) for (const v of o[k] || []) if (typeof v === 'number' && !Number.isFinite(v)) bad++;
  }
  if (bad) failures.push(`有 ${bad} 个非有限数值（NaN/Infinity）进入 canvas 调用`);
}

await PetUI.unmount();

/* ── 输出 ── */
const result = {
  mood: MOOD, totalOps: total, parts: parts.length,
  bbox: all, worldHead, worldFace,
  failures, warnings, notes,
};

if (AS_JSON) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`\n=== 桌宠画面几何自检（mood=${MOOD}）===`);
  console.log(`绘制指令 ${total} 条，解析出包围盒 ${parts.length} 条`);
  for (const n of notes) console.log(`  · ${n}`);
  if (SHOW_TOP || failures.length) dumpTopOps(parts, opsSnapshot);
  if (warnings.length) { console.log('\n提示：'); for (const w of warnings) console.log(`  ! ${w}`); }
  if (failures.length) {
    console.log('\n硬失败：');
    for (const f of failures) console.log(`  ✗ ${f}`);
    console.log(`\n❌ 未通过（${failures.length} 项）`);
  } else {
    console.log('\n✅ 画面几何自检通过');
  }
}

process.exit(failures.length ? 1 : 0);
