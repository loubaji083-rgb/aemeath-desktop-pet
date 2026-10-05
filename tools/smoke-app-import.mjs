#!/usr/bin/env node
/**
 * 冒烟：在 Node 里真加载 web/js/app.js
 *
 * 这是本仓库最重要的一条「不会白屏」证据。
 * 因为 app.js 及其整条模块图在**求值阶段**就会暴露两类致命问题：
 *   1. 链接错误：`import { x } from './y.js'` 里 x 不存在
 *      → SyntaxError: does not provide an export named 'x'（页面全白）
 *   2. 顶层副作用：模块顶层直接摸 document/window
 *      → ReferenceError（同样全白）
 * 两类都发生在「任何用户代码跑起来之前」，单元测试和静态检查都容易漏。
 *
 * 用法：node tools/smoke-app-import.mjs
 * 退出码：0 = app.js 整条图加载成功；1 = 失败（附原始错误）
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 与 selfcheck-modules.mjs 同款：存储要像真存储，其余是通用 stub */
function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => map.set(String(k), String(v)),
    removeItem: (k) => map.delete(String(k)),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

function makeStub(name) {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      if (prop === Symbol.toPrimitive) return () => `[stub ${name}]`;
      if (prop === 'toString') return () => `[stub ${name}]`;
      if (prop === 'length' || prop === 'nodeType') return 0;
      return makeStub(`${name}.${String(prop)}`);
    },
    set: () => true,
    apply: () => makeStub(`${name}()`),
  });
}

for (const g of ['window', 'document', 'navigator', 'location', 'matchMedia', 'speechSynthesis', 'SpeechSynthesisUtterance', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'MutationObserver', 'AudioContext', 'MediaRecorder', 'getComputedStyle']) {
  if (!(g in globalThis)) Object.defineProperty(globalThis, g, { value: makeStub(g), writable: true, configurable: true });
}
for (const g of ['localStorage', 'sessionStorage']) {
  if (!(g in globalThis)) Object.defineProperty(globalThis, g, { value: makeStorage(), writable: true, configurable: true });
}
if (!('performance' in globalThis)) globalThis.performance = { now: () => Date.now() };
if (!('crypto' in globalThis)) globalThis.crypto = { randomUUID: () => '00000000-0000-4000-8000-000000000000' };

const target = pathToFileURL(path.join(ROOT, 'web', 'js', 'app.js')).href;

try {
  const mod = await import(target);
  const names = Object.keys(mod);
  console.log(`✅ web/js/app.js 整条模块图加载成功（顶层无副作用）；命名导出 ${names.length} 个: ${names.join(', ') || '（无，app.js 是纯副作用入口）'}`);
  process.exit(0);
} catch (err) {
  console.error('✗ web/js/app.js 加载失败 —— 这在浏览器里就是**白屏**：');
  console.error(`  ${err?.constructor?.name}: ${err?.message}`);
  if (err?.stack) console.error(err.stack.split('\n').slice(1, 5).join('\n'));
  process.exit(1);
}
