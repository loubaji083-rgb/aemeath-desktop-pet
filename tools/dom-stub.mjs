#!/usr/bin/env node
/**
 * dom-stub.mjs —— 最小的浏览器环境垫片（零依赖）
 *
 * 为什么需要它：
 *   本仓库的模块都写成「模块顶层只声明、DOM 只在函数内访问」，但仍有一批模块
 *   在**导入期**就会碰到文档环境（pet/index.js 取 canvas、app.js 调 initShell）。
 *   于是在 bare Node 里 `await import()` 这些模块会抛 `ReferenceError: document is not defined`，
 *   自检脚本会把「测不了」误报成「模块有问题」——比没有自检更糟。
 *   这里提供一个**只够用**的垫片：不模拟真实布局，只保证导入与基本调用不抛错。
 *
 * 使用方式（必须在 import 目标模块**之前**调用）：
 *   import { installDomStub } from './dom-stub.mjs';
 *   installDomStub();
 *   const mod = await import('../web/js/app.js');
 *
 * 注意：Node 22 里 navigator / location 是只有 getter 的内置属性，必须用
 *   Object.defineProperty 覆盖，直接赋值会抛 TypeError。
 */

const defined = [];

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  defined.push(name);
}

export function makeCanvas() {
  const ctx = makeCtx2d();
  const canvas = {
    width: 360,
    height: 480,
    style: {},
    dataset: {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    getContext: () => ctx,
    toDataURL: () => 'data:image/png;base64,',
    addEventListener: () => {},
    removeEventListener: () => {},
    setAttribute: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 360, height: 480, right: 360, bottom: 480, x: 0, y: 0 }),
    clientWidth: 360,
    clientHeight: 480,
    parentElement: null,
  };
  ctx.canvas = canvas;
  return canvas;
}

export function makeCtx2d() {
  const noop = () => {};
  const ctx = {
    canvas: null,
    save: noop,
    restore: noop,
    beginPath: noop,
    closePath: noop,
    fill: noop,
    stroke: noop,
    clip: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    arcTo: noop,
    ellipse: noop,
    rect: noop,
    roundRect: noop,
    quadraticCurveTo: noop,
    bezierCurveTo: noop,
    fillRect: noop,
    strokeRect: noop,
    clearRect: noop,
    translate: noop,
    scale: noop,
    rotate: noop,
    transform: noop,
    setTransform: noop,
    resetTransform: noop,
    setLineDash: noop,
    getLineDash: () => [],
    fillText: noop,
    strokeText: noop,
    measureText: (t) => ({ width: String(t ?? '').length * 8 }),
    drawImage: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '16px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    fillStyle: '#000',
    strokeStyle: '#000',
    shadowBlur: 0,
    shadowColor: 'transparent',
    shadowOffsetX: 0,
    shadowOffsetY: 0,
  };
  return ctx;
}

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
    setItem: (k, v) => m.set(String(k), String(v)),
    removeItem: (k) => m.delete(String(k)),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

function makeElement(tag = 'div') {
  if (tag === 'canvas') return makeCanvas();
  const el = {
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    children: [],
    childNodes: [],
    textContent: '',
    innerHTML: '',
    innerText: '',
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    id: '',
    className: '',
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    append: (...cs) => cs.forEach((c) => el.appendChild(c)),
    removeChild: () => {},
    remove: () => {},
    insertBefore: (c) => c,
    setAttribute: () => {},
    getAttribute: () => null,
    removeAttribute: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    focus: () => {},
    blur: () => {},
    click: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 }),
    scrollIntoView: () => {},
    animate: () => ({ finished: Promise.resolve(), cancel: () => {}, onfinish: null }),
    closest: () => null,
  };
  return new Proxy(el, {
    get(target, prop) {
      if (prop in target) return target[prop];
      // 未定义的属性返回空函数更接近浏览器（`el.foo()` 不炸），但保持 undefined 更诚实。
      return undefined;
    },
  });
}

export function installDomStub() {
  if (globalThis.__aemeathDomStubInstalled) return globalThis.__aemeathDomStubInstalled;

  defineGlobal('window', globalThis);
  defineGlobal('document', {
    documentElement: makeElement('html'),
    head: makeElement('head'),
    body: makeElement('body'),
    createElement: (t) => makeElement(t),
    createElementNS: (_ns, t) => makeElement(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    createDocumentFragment: () => makeElement('fragment'),
    getElementById: () => null,
    getElementsByTagName: () => [],
    getElementsByClassName: () => [],
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    hidden: false,
    visibilityState: 'visible',
    readyState: 'complete',
    title: '',
    cookie: '',
  });
  defineGlobal('navigator', { userAgent: 'node', language: 'zh-CN', languages: ['zh-CN'], platform: 'node', maxTouchPoints: 0 });
  defineGlobal('location', { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1', protocol: 'http:', host: '127.0.0.1', pathname: '/', search: '', hash: '' });
  defineGlobal('localStorage', makeStorage());
  defineGlobal('sessionStorage', makeStorage());
  if (!globalThis.performance) defineGlobal('performance', { now: () => Date.now() });
  defineGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(globalThis.performance.now()), 16));
  defineGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
  defineGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }));
  defineGlobal('getComputedStyle', () => ({ getPropertyValue: () => '', length: 0 }));
  if (!globalThis.AudioContext) defineGlobal('AudioContext', undefined);
  if (!globalThis.speechSynthesis) defineGlobal('speechSynthesis', { speak: () => {}, cancel: () => {}, getVoices: () => [], addEventListener: () => {}, removeEventListener: () => {} });

  // pet/index.js 在 mount 里会往 window（= globalThis）上挂 pointer/resize 监听，
  // 而 Node 22 的 globalThis **没有** addEventListener，缺这一角会让 mount() 抛
  // `TypeError: window.addEventListener is not a function`（那是脚手架缺角，不是 pet 缺陷）。
  // 这里做成真实现（记录 + 派发），便于测试断言「mount/unmount 的监听器数量守恒」。
  const listeners = new Map();
  if (typeof globalThis.addEventListener !== 'function') {
    defineGlobal('addEventListener', (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    });
  }
  if (typeof globalThis.removeEventListener !== 'function') {
    defineGlobal('removeEventListener', (type, fn) => {
      listeners.get(type)?.delete(fn);
    });
  }
  if (typeof globalThis.dispatchEvent !== 'function') {
    defineGlobal('dispatchEvent', (ev) => {
      for (const fn of listeners.get(ev?.type) ?? []) fn(ev);
      return true;
    });
  }
  globalThis.__aemeathStubListeners = listeners;

  globalThis.__aemeathDomStubInstalled = { defined: [...defined] };
  return globalThis.__aemeathDomStubInstalled;
}

export default installDomStub;
