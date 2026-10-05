#!/usr/bin/env node
/**
 * smoke-pet-render.mjs —— 在 Node 里真跑一遍 Canvas 渲染管线（零依赖）
 *
 * 为什么需要它：
 *   pet/rig.js 里全是弹簧/缓动的浮点运算，最容易出的不是异常而是**静默的错误值**：
 *   某个旋钮初值 NaN → 之后每一帧都是 NaN → canvas 的 fill() 收到 NaN 会被
 *   浏览器**静默忽略**（不抛错、不打日志），结果是「桌宠只剩一半」或「整个不画」。
 *   这类问题单测抓不到（没人会去断言 rig 内部字段），浏览器控制台也不报。
 *   所以这里用一个记录型 2D context 把整条管线跑起来，**逐帧检查所有数值参数是否有限**。
 *
 * 覆盖：mount → 连续 update（含 >0.5 的毫秒误传兼容层）→ setMood → 12 个动作 trigger
 *       → hitTest 六个区域 → lookAt → setMouth 0/0.5/1 → unmount
 *
 * 用法：node tools/smoke-pet-render.mjs [--verbose]
 * 退出码：0 = 通过；1 = 有 NaN/Infinity 参数、异常、或动作没触发
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');

const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`;

const failures = [];
const notes = [];

/* ------------------------------------------------------------------ */
/* 记录型 2D context：所有数值参数都过一遍有限性检查                      */
/* ------------------------------------------------------------------ */

const NUMERIC_METHODS = [
  'moveTo', 'lineTo', 'bezierCurveTo', 'quadraticCurveTo', 'arc', 'arcTo', 'ellipse',
  'rect', 'roundRect', 'fillRect', 'strokeRect', 'clearRect', 'translate', 'scale',
  'rotate', 'setTransform', 'transform', 'createLinearGradient', 'createRadialGradient',
  'fillText', 'strokeText', 'drawImage', 'setLineDash', 'clip',
];

let opCount = 0;
let badParam = null;

function checkFinite(name, args) {
  opCount += 1;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (typeof a === 'number' && !Number.isFinite(a)) {
      if (!badParam) badParam = { name, index: i, value: a, args: args.map(String) };
    }
  }
}

function makeGradient() {
  return { addColorStop: () => {} };
}

function makeCtx() {
  const target = {
    canvas: { width: 360, height: 480 },
    // 可变样式属性
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    globalAlpha: 1, globalCompositeOperation: 'source-over', font: '10px sans-serif',
    textAlign: 'start', textBaseline: 'alphabetic', shadowBlur: 0, shadowColor: '#000',
    shadowOffsetX: 0, shadowOffsetY: 0, filter: 'none', imageSmoothingEnabled: true,
    miterLimit: 10, lineDashOffset: 0,
    createLinearGradient: (...a) => (checkFinite('createLinearGradient', a), makeGradient()),
    createRadialGradient: (...a) => (checkFinite('createRadialGradient', a), makeGradient()),
    createPattern: () => null,
    measureText: (t) => (checkFinite('measureText', [String(t).length * 6]), { width: String(t).length * 6 }),
    getImageData: (x, y, w, h) => (checkFinite('getImageData', [x, y, w, h]), { data: new Uint8ClampedArray(Math.max(0, w * h * 4)), width: w, height: h }),
    putImageData: (...a) => checkFinite('putImageData', [a[1], a[2]]),
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    closePath: () => {},
    fill: () => {},
    stroke: () => {},
    clip: () => {},
    resetTransform: () => {},
    isPointInPath: () => false,
    setLineDash: (a) => checkFinite('setLineDash', Array.isArray(a) ? a : []),
    getLineDash: () => [],
  };

  // 把每个数值方法都包一层检查
  for (const m of NUMERIC_METHODS) {
    if (!(m in target) || typeof target[m] !== 'function') {
      target[m] = (...args) => checkFinite(m, args);
    } else {
      const orig = target[m];
      target[m] = (...args) => {
        checkFinite(m, args);
        return orig(...args);
      };
    }
  }

  return new Proxy(target, {
    get(t, p) {
      if (p in t) return t[p];
      if (typeof p === 'string' && /^[a-z]/.test(p)) {
        // 未知方法：当成空操作，并记录（便于发现 API 拼写错误）
        notes.push(`canvas 上被调用了未知成员: ${p}`);
        return () => {};
      }
      return undefined;
    },
    set(t, p, v) {
      if (typeof v === 'number' && !Number.isFinite(v)) {
        if (!badParam) badParam = { name: `set ${String(p)}`, index: 0, value: v, args: [String(v)] };
      }
      t[p] = v;
      return true;
    },
  });
}

/* ------------------------------------------------------------------ */
/* 最小 DOM 伪装（pet/index.js 会 mount 到 canvas 上）                   */
/* ------------------------------------------------------------------ */

function makeCanvas() {
  return {
    width: 360,
    height: 480,
    style: {},
    dataset: {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    getContext: () => makeCtx(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 360, height: 480, right: 360, bottom: 480 }),
    addEventListener: () => {},
    removeEventListener: () => {},
    setAttribute: () => {},
    getAttribute: () => null,
    appendChild: () => {},
    removeChild: () => {},
    clientWidth: 360,
    clientHeight: 480,
    parentElement: null,
  };
}

/**
 * Node 22 里 `globalThis.navigator` / `location` 是**只有 getter** 的内置属性，
 * 直接赋值会抛 `TypeError: Cannot set property navigator of #<Object> which has only a getter`。
 * 必须用 defineProperty 覆盖。
 */
function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}

defineGlobal('window', globalThis);
defineGlobal('document', {
  documentElement: { dataset: {}, style: {} },
  body: { dataset: {}, style: {}, appendChild: () => {}, classList: { add: () => {}, remove: () => {} } },
  createElement: (t) => (t === 'canvas' ? makeCanvas() : { style: {}, dataset: {}, classList: { add: () => {}, remove: () => {} }, appendChild: () => {}, setAttribute: () => {}, addEventListener: () => {} }),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
});
defineGlobal('navigator', { userAgent: 'node', language: 'zh-CN', languages: ['zh-CN'] });
defineGlobal('location', { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1' });
const storage = (() => {
  const m = new Map();
  return { getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null), setItem: (k, v) => m.set(String(k), String(v)), removeItem: (k) => m.delete(String(k)), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
})();
globalThis.localStorage = storage;
globalThis.sessionStorage = (() => {
  const m = new Map();
  return { getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null), setItem: (k, v) => m.set(String(k), String(v)), removeItem: (k) => m.delete(String(k)), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
})();
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
if (!globalThis.performance) globalThis.performance = { now: () => Date.now() };

/* ------------------------------------------------------------------ */

async function main() {
  const petMod = await import(pathToFileURL(path.join(ROOT, 'web', 'js', 'pet', 'index.js')).href);
  const { PetUI, ACTIONS } = petMod;
  if (!PetUI) {
    console.error(RED('✗ pet/index.js 没有导出 PetUI'));
    process.exit(1);
  }

  const canvas = makeCanvas();

  // pet/index.js 在 mount 里会往 window 上挂 pointer/resize 监听。
  // `defineGlobal('window', globalThis)` 之后，window 就是 Node 的真实 globalThis ——
  // 它在 Node 22 里**没有** addEventListener，所以必须在这里补一个最小实现，
  // 否则 mount() 直接抛 TypeError。这不是 pet 模块的缺陷，是冒烟脚手架自己缺了一角。
  if (typeof globalThis.addEventListener !== 'function') {
    const listeners = new Map();
    defineGlobal('addEventListener', (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    });
    defineGlobal('removeEventListener', (type, fn) => {
      listeners.get(type)?.delete(fn);
    });
    defineGlobal('dispatchEvent', (ev) => {
      for (const fn of listeners.get(ev?.type) ?? []) {
        try {
          fn(ev);
        } catch (err) {
          failures.push(`window 事件监听器（${ev?.type}）抛错: ${err?.message || err}`);
        }
      }
      return true;
    });
  }

  // 1. mount
  try {
    PetUI.mount(canvas, { scale: 1 });
  } catch (err) {
    failures.push(`mount() 抛错: ${err?.message || err}`);
  }

  // 2. 连续 120 帧：先用秒（canonical），再用一次毫秒误传验证兼容层
  try {
    for (let i = 0; i < 120; i += 1) PetUI.update(1 / 60);
    const beforeMs = opCount;
    for (let i = 0; i < 30; i += 1) PetUI.update(16.7); // 误传毫秒
    if (opCount === beforeMs) notes.push('毫秒误传后没有任何绘制操作（可能被 clamp 成 0 后彻底静止）');
  } catch (err) {
    failures.push(`update() 抛错: ${err?.message || err}`);
  }

  // 3. 情绪 —— 合法心情清单**从 moods.js 读**，不要凭印象写（我一开始写了 'curious'，
  //    真实表里叫 'surprised'，模块会 warn「未知情绪，忽略」，于是这条检查在骗自己）。
  const moodsMod = await import(pathToFileURL(path.join(ROOT, 'web', 'js', 'pet', 'moods.js')).href);
  const MOODS = (moodsMod.MOODS || Object.keys(moodsMod.MOOD_TABLE || {})).map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
  if (MOODS.length === 0) failures.push('moods.js 没有导出可枚举的心情清单（MOODS / MOOD_TABLE）');
  notes.push(`合法心情 ${MOODS.length} 个: ${MOODS.join(', ')}`);
  for (const m of MOODS) {
    try {
      PetUI.setMood(m);
      for (let i = 0; i < 10; i += 1) PetUI.update(1 / 60);
      const got = typeof PetUI.getMood === 'function' ? PetUI.getMood() : null;
      if (got && got !== m) notes.push(`setMood('${m}') 之后 getMood() 返回 '${got}'（该情绪被映射到别的值）`);
    } catch (err) {
      failures.push(`setMood('${m}') 抛错: ${err?.message || err}`);
    }
  }
  PetUI.setMood(moodsMod.FALLBACK_MOOD || 'idle');

  // 4. 12 个动作：每个都要返回 true 并且真的改变画面
  for (const a of ACTIONS.map((x) => (typeof x === 'string' ? x : x?.id)).filter(Boolean)) {
    const before = opCount;
    let ret;
    try {
      ret = await PetUI.trigger(a);
    } catch (err) {
      failures.push(`trigger('${a}') 抛错: ${err?.message || err}`);
      continue;
    }
    for (let i = 0; i < 20; i += 1) PetUI.update(1 / 60);
    if (ret !== true) failures.push(`trigger('${a}') 返回 ${JSON.stringify(ret)}，期望 true`);
    if (opCount === before) failures.push(`trigger('${a}') 之后 20 帧内没有任何绘制操作`);
    if (VERBOSE) console.log(`  ${GREEN('ok')} trigger(${a}) -> ${ret}`);
  }

  // 5. hitTest：六个区域
  const REGIONS = ['head', 'face', 'body', 'hand', 'hair', 'none'];
  const hits = new Set();
  for (let y = 0; y < 480; y += 8) {
    for (let x = 0; x < 360; x += 8) {
      let r;
      try {
        r = PetUI.hitTest(x, y);
      } catch (err) {
        failures.push(`hitTest(${x},${y}) 抛错: ${err?.message || err}`);
        y = 1e9;
        break;
      }
      hits.add(r);
      if (r && !REGIONS.includes(r)) failures.push(`hitTest(${x},${y}) 返回未知区域 '${r}'`);
    }
  }
  if (!hits.has('head')) failures.push('hitTest 在整个画布上都没命中 head —— 摸头动作将永远无法触发');
  notes.push(`hitTest 覆盖到的区域: ${[...hits].filter(Boolean).sort().join(', ')}`);

  // 6. lookAt：四角 + 越界，不应抛错，也不应产生 NaN
  for (const [x, y] of [[0, 0], [360, 0], [0, 480], [360, 480], [-999, -999], [9999, 9999], [NaN, NaN]]) {
    try {
      PetUI.lookAt(x, y);
      for (let i = 0; i < 5; i += 1) PetUI.update(1 / 60);
    } catch (err) {
      failures.push(`lookAt(${x},${y}) 抛错: ${err?.message || err}`);
    }
  }

  // 7. setMouth：口型边界
  for (const v of [0, 0.25, 0.5, 0.75, 1, -1, 2, NaN]) {
    try {
      PetUI.setMouth(v);
      for (let i = 0; i < 5; i += 1) PetUI.update(1 / 60);
    } catch (err) {
      failures.push(`setMouth(${v}) 抛错: ${err?.message || err}`);
    }
  }

  // 8. 调试状态可序列化（文档承诺 getDebugState() -> object 可序列化）
  try {
    const st = PetUI.getDebugState?.();
    if (st !== undefined) JSON.stringify(st);
  } catch (err) {
    failures.push(`getDebugState() 不可序列化: ${err?.message || err}`);
  }

  // 9. unmount 幂等
  try {
    PetUI.unmount();
    PetUI.unmount();
  } catch (err) {
    failures.push(`unmount() 抛错或非幂等: ${err?.message || err}`);
  }

  /* ---- 结果 ---- */
  console.log('');
  console.log(`绘制操作总数: ${opCount}`);
  for (const n of notes) console.log(YELLOW(`  · ${n}`));
  if (badParam) {
    console.log(RED(`✗ canvas 收到非有限数值: ${badParam.name}(...) 第 ${badParam.index} 个参数 = ${badParam.value}`));
    console.log(RED(`  实参: ${badParam.args.join(', ')}`));
    failures.push(`canvas 收到非有限数值（${badParam.name} 参数 #${badParam.index} = ${badParam.value}）`);
  }
  if (failures.length === 0) {
    console.log(GREEN('✅ 渲染冒烟通过：mount/update/情绪/12 动作/hitTest/lookAt/setMouth/unmount 全部无异常，且没有 NaN/Infinity 进入 canvas。'));
    process.exit(0);
  }
  console.log(RED(`✗ 渲染冒烟失败 ${failures.length} 项：`));
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

await main();
