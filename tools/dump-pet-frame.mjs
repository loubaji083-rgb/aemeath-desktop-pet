#!/usr/bin/env node
/**
 * dump-pet-frame.mjs —— 把桌宠某一帧的真实 Canvas 指令流 dump 成 JSON
 *
 * 目的：**真的看一眼它长什么样**。
 *   前面的 smoke-pet-render.mjs 只能证明「没有 NaN、没抛异常」，
 *   但证明不了「脸没画到画布外」「两只眼睛叠在一起」「头发盖住整张脸」。
 *   这类问题只有把指令流画成图才看得出来。
 *
 * 做法：用一个全记录型 2D context 跑真实的 PetUI.mount / update，
 *   把每条路径指令连同**当时的变换矩阵**写进 JSON；
 *   再由 tools/rasterize-canvas.py（Pillow）回放成 PNG。
 *
 * 用法：
 *   node tools/dump-pet-frame.mjs [--mood idle] [--action tap-head] [--frames 45] [--out frame.json]
 *
 * 默认输出到 tools/samples/frame-<mood>.json（**不是隐藏名**）：这个目录里的帧
 * 是「形象应该长什么样」的基准样本，会随仓库一起提交，方便你对照自己的改动。
 * 回放成 PNG：
 *   python tools/rasterize-canvas.py tools/samples/frame-idle.json tools/samples/frame-idle.png --scale 2
 *
 * 退出码：0 = dump 成功（不代表画面好看，好看要看图）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}
const MOOD = arg('mood', 'idle');
const ACTION = arg('action', '');
const FRAMES = Number(arg('frames', 45));
const OUT = arg('out', path.join(ROOT, 'tools', 'samples', `frame-${MOOD}.json`));

/* ------------------------------------------------------------------ */
/* 记录型 context                                                       */
/* ------------------------------------------------------------------ */

const ops = [];
let cur = null; // 当前路径

/** 2D 仿射矩阵 [a,b,c,d,e,f] 乘法：返回 x·y */
function mulMat(x, y) {
  const [a, b, c, d, e, f] = x;
  const [a2, b2, c2, d2, e2, f2] = y;
  return [
    a * a2 + c * b2,
    b * a2 + d * b2,
    a * c2 + c * d2,
    b * c2 + d * d2,
    a * e2 + c * f2 + e,
    b * e2 + d * f2 + f,
  ];
}

/** 2D 仿射矩阵求逆（不可逆时回退单位矩阵） */
function invMat(m) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return [1, 0, 0, 1, 0, 0];
  return [
    d / det,
    -b / det,
    -c / det,
    a / det,
    (c * f - d * e) / det,
    (b * e - a * f) / det,
  ];
}

/**
 * 渐变桩。**必须实现 addColorStop** —— draw.js:118 就是 `g.addColorStop(0, 'rgba(...)')`。
 * 同时把 stop 记下来，让 Python 侧能用真实颜色而不是瞎猜的近似色。
 */
function makeGradient(kind, args) {
  const stops = [];
  return {
    __gradient: kind,
    args,
    stops,
    addColorStop(offset, color) {
      stops.push({ offset, color });
    },
  };
}

function makeCtx() {
  // 变换矩阵 [a,b,c,d,e,f]，与 canvas 的 setTransform 语义一致
  let m = [1, 0, 0, 1, 0, 0];
  let dpr = 1;
  const stack = [];

  const mul = (n) => {
    // 新矩阵 = 当前矩阵 × n
    const [a, b, c, d, e, f] = m;
    const [a2, b2, c2, d2, e2, f2] = n;
    m = [
      a * a2 + c * b2,
      b * a2 + d * b2,
      a * c2 + c * d2,
      b * c2 + d * d2,
      a * e2 + c * f2 + e,
      b * e2 + d * f2 + f,
    ];
  };

  const state = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    globalAlpha: 1,
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
  };

  const t = {
    canvas: { width: 360, height: 480 },
    /*
     * `save`/`restore` 必须**落成 op**，不能只在垫片内部改矩阵。
     *
     * 原因（踩过的坑）：`clip()` 记进 ops 后，回放端需要知道这个裁剪**什么时候失效**。
     * 而 clip 的作用域是由 save/restore 配对的 —— 如果 dump 只记录矩阵、不记录配对，
     * 回放端就只能让第一个 clip 永久生效：`drawBackHair`（帧里第 1 个 clip，矩形约
     * x[99,261] y[52,310]）之后的**所有绘制都会被裁掉**，于是 PNG 里身体下半身、腿、鞋
     * 全部消失 —— 看图的人会误判成"角色没画腿"。本项目已经因此误诊过一轮。
     */
    save() {
      ops.push({ op: 'save', transform: [...m] });
      stack.push({ m: [...m], s: { ...state } });
    },
    restore() {
      ops.push({ op: 'restore', transform: [...m] });
      const p = stack.pop();
      if (p) {
        m = p.m;
        Object.assign(state, p.s);
      }
    },
    translate(x, y) {
      mul([1, 0, 0, 1, x, y]);
    },
    scale(x, y) {
      mul([x, 0, 0, y, 0, 0]);
    },
    rotate(r) {
      const c = Math.cos(r);
      const s = Math.sin(r);
      mul([c, s, -s, c, 0, 0]);
    },
    transform(a, b, c, d, e, f) {
      mul([a, b, c, d, e, f]);
    },
    /**
     * setTransform 是**绝对赋值**，不是相乘 —— 但记录时不能照抄实参。
     *
     * 记的是「相对于上一条指令的坐标系」的变换，推导：
     *   - `m` 的含义是「逻辑坐标 → 最终绘制坐标」的矩阵（回放端会拿它套每个点）
     *   - `setTransform(g)` 让设备变换变成 g。设调用前设备变换是 m_old，
     *     则新的逻辑→设备矩阵 m_new 满足 m_new · m_old⁻¹ = g，即 m_new = g · m_old
     *     （因为回放端是从单位矩阵起步的，它只知道 m_new 这一个数）
     *
     * 实际影响：渲染端每帧开头都调 `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`。
     * 若照实参存成 (dpr,0,0,dpr,0,0)，后续每个 translate 都会被回放端**再乘一次**，
     * 整只桌宠被推离画布（我第一版渲染出来只剩一个地面阴影，就是踩了这个坑）。
     * 用上面的公式，dpr 基准正好被约掉：m_new = g·m_old⁻¹·m_old = g，
     * 所以纯缩放基准这一支可以直接写单位矩阵。
     */
    setTransform(a, b, c, d, e, f) {
      if (!Number.isFinite(a)) {
        m = [1, 0, 0, 1, 0, 0];
        return;
      }
      const g = [a, b, c, d, e, f];
      if (a > 0 && b === 0 && c === 0 && d === a) {
        // 纯缩放基准（典型：setTransform(dpr, 0, 0, dpr, 0, 0)）→ 归一化为单位矩阵
        dpr = a;
        m = [1, 0, 0, 1, 0, 0];
        return;
      }
      // 一般情形：m_new = g · m⁻¹ 是与坐标系无关的写法；这里退一步用 m_old 的逆前乘
      m = mulMat(g, invMat(m));
    },
    resetTransform() {
      m = [1, 0, 0, 1, 0, 0];
    },
    getTransform() {
      return { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] };
    },
    beginPath() {
      cur = { cmds: [], fill: null, stroke: null, width: 1, alpha: 1, clip: false };
    },
    closePath() {
      cur?.cmds.push(['Z']);
    },
    moveTo(x, y) {
      cur?.cmds.push(['M', x, y]);
    },
    lineTo(x, y) {
      cur?.cmds.push(['L', x, y]);
    },
    quadraticCurveTo(cx, cy, x, y) {
      cur?.cmds.push(['Q', cx, cy, x, y]);
    },
    bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
      cur?.cmds.push(['C', c1x, c1y, c2x, c2y, x, y]);
    },
    arc(x, y, r, a0, a1, ccw) {
      if (process.env.AEMEATH_TRACE_ARC) console.error('ARC', JSON.stringify({ x, y, r, a0, a1, ccw }));
      cur?.cmds.push(['A', x, y, r, a0, a1, ccw ? 1 : 0]);
    },
    arcTo(x1, y1, x2, y2, r) {
      cur?.cmds.push(['AT', x1, y1, x2, y2, r]);
    },
    ellipse(x, y, rx, ry, rot, a0, a1, ccw) {
      cur?.cmds.push(['E', x, y, rx, ry, rot, a0, a1, ccw ? 1 : 0]);
    },
    rect(x, y, w, h) {
      cur?.cmds.push(['R', x, y, w, h]);
    },
    roundRect(x, y, w, h, r) {
      cur?.cmds.push(['RR', x, y, w, h, Array.isArray(r) ? r[0] : r]);
    },
    fill() {
      if (!cur) return;
      ops.push({
        op: 'fill',
        cmds: cur.cmds,
        style: typeof state.fillStyle === 'string' ? state.fillStyle : state.fillStyle,
        transform: [...m],
        alpha: state.globalAlpha,
      });
    },
    stroke() {
      if (!cur) return;
      ops.push({
        op: 'stroke',
        cmds: cur.cmds,
        style: state.strokeStyle,
        width: state.lineWidth,
        transform: [...m],
        alpha: state.globalAlpha,
      });
    },
    clip() {
      if (!cur) return;
      ops.push({ op: 'clip', cmds: cur.cmds, transform: [...m] });
    },
    fillRect(x, y, w, h) {
      ops.push({ op: 'fillRect', rect: [x, y, w, h], style: state.fillStyle, transform: [...m], alpha: state.globalAlpha });
    },
    strokeRect(x, y, w, h) {
      ops.push({ op: 'strokeRect', rect: [x, y, w, h], style: state.strokeStyle, width: state.lineWidth, transform: [...m], alpha: state.globalAlpha });
    },
    clearRect(x, y, w, h) {
      // 每帧开头都是「清空整个画布」。利用这个信号只保留**最后一帧**的指令：
      // 否则 ops 里会堆着几十帧重叠的画面，回放出来是一团糊的残影，看不出真实长相。
      if (x <= 0 && y <= 0 && w >= 360 && h >= 480) ops.length = 0;
      ops.push({ op: 'clearRect', rect: [x, y, w, h] });
    },
    createLinearGradient(...a) {
      return makeGradient('linear', a);
    },
    createRadialGradient(...a) {
      return makeGradient('radial', a);
    },
    measureText: (s) => ({ width: String(s).length * 6 }),
    fillText(text, x, y) {
      ops.push({ op: 'text', text: String(text), at: [x, y], style: state.fillStyle, font: state.font, transform: [...m], alpha: state.globalAlpha });
    },
    setLineDash() {},
    getLineDash: () => [],
    drawImage() {},
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(0, w * h * 4)), width: w, height: h }),
    putImageData() {},
    isPointInPath: () => false,
  };

  // 可变样式属性要能读写
  return new Proxy(t, {
    get(target, p) {
      if (p in state) return state[p];
      if (p in target) return target[p];
      return () => {};
    },
    set(target, p, v) {
      if (p in state) {
        state[p] = v;
        return true;
      }
      target[p] = v;
      return true;
    },
  });
}

/* ------------------------------------------------------------------ */
/* 最小 DOM 环境                                                        */
/* ------------------------------------------------------------------ */

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}

function makeCanvas() {
  const ctx = makeCtx();
  return {
    width: 360,
    height: 480,
    style: {},
    dataset: {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 360, height: 480, right: 360, bottom: 480 }),
    addEventListener: () => {},
    removeEventListener: () => {},
    setAttribute: () => {},
    getAttribute: () => null,
  };
}

function makeStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null), setItem: (k, v) => map.set(String(k), String(v)), removeItem: (k) => map.delete(String(k)), clear: () => map.clear(), key: (i) => [...map.keys()][i] ?? null, get length() { return map.size; } };
}

defineGlobal('window', globalThis);
defineGlobal('document', {
  documentElement: { dataset: {}, style: {} },
  body: { dataset: {}, style: {}, appendChild: () => {}, classList: { add: () => {}, remove: () => {} } },
  createElement: () => ({ style: {}, dataset: {}, classList: { add: () => {}, remove: () => {} }, appendChild: () => {}, setAttribute: () => {}, addEventListener: () => {}, getContext: () => makeCtx(), width: 0, height: 0 }),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
});
defineGlobal('navigator', { userAgent: 'node', language: 'zh-CN', languages: ['zh-CN'] });
defineGlobal('location', { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1' });
defineGlobal('localStorage', makeStorage());
defineGlobal('sessionStorage', makeStorage());
defineGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 16));
defineGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
if (!globalThis.performance) defineGlobal('performance', { now: () => Date.now() });
defineGlobal('addEventListener', () => {});
defineGlobal('removeEventListener', () => {});
defineGlobal('dispatchEvent', () => true);

/* ------------------------------------------------------------------ */

const petMod = await import(pathToFileURL(path.join(ROOT, 'web', 'js', 'pet', 'index.js')).href);
const { PetUI } = petMod;

const canvas = makeCanvas();
PetUI.mount(canvas, { scale: 1 });
PetUI.setMood(MOOD);

// 先跑若干帧让它进入稳定姿态（弹簧收敛）
for (let i = 0; i < 60; i += 1) PetUI.update(1 / 60);

// 清空：只保留「稳定姿态 + 可选动作进行中」的指令
ops.length = 0;

let actionResult = null;
if (ACTION) {
  actionResult = await PetUI.trigger(ACTION);
}

// 动作进行到中段（动作最有表现力的时刻），再 dump
const half = Math.max(1, Math.round(FRAMES / 2));
for (let i = 0; i < half; i += 1) PetUI.update(1 / 60);
const midOps = ops.length;
for (let i = half; i < FRAMES; i += 1) PetUI.update(1 / 60);

const payload = {
  mood: MOOD,
  action: ACTION,
  actionResult,
  frames: FRAMES,
  midOpIndex: midOps,
  canvas: { width: 360, height: 480 },
  ops,
};
fs.writeFileSync(OUT, JSON.stringify(payload));
console.log(`mood=${MOOD} action=${ACTION || '(none)'} result=${JSON.stringify(actionResult)} frames=${FRAMES} ops=${ops.length} midOpIndex=${midOps}`);
console.log(`已写出 ${OUT}`);
