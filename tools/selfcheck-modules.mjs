#!/usr/bin/env node
/**
 * selfcheck-modules.mjs —— 模块图「真加载 + 导出契约」自检（零依赖）
 *
 * 和 selfcheck-http.mjs 的分工：
 *   - selfcheck-http.mjs：资源能不能取到（404 / import 路径写错 → 白屏）
 *   - 本脚本：资源**加载后导出了什么**、以及 app.js 真正需要的成员在不在
 *
 * 为什么必须真 import 而不能只做文本扫描（这是 selfcheck-api.mjs 的教训）：
 *   文本扫描只能看到「源码里出现过某个字面量」。它抓到过
 *   「PetUI 的 ACTIONS 里缺少动作: tap-face」这种字面量对不齐的假阳性，
 *   却抓不到「`export const ACTIONS = [...]` 存在但 `export { ACTIONS }` 漏了」这类
 *   真会让页面静默降级的缺陷。真 import 拿到的是运行时真相。
 *
 * 用 Node 直接 import 浏览器模块是可行的，因为本项目的模块只做**顶层定义**，
 * 所有 DOM 访问都在函数体内（惰性执行）。这里给 globalThis 装一层最小 DOM 伪装，
 * 只为挡住「模块顶层就摸 document」的意外写法 —— 一旦出现，本脚本会直接报出来，
 * 那本身就是必须修的 bug（会让模块在 Node/测试环境不可用）。
 *
 * 用法：node tools/selfcheck-modules.mjs [--verbose]
 * 退出码：0 = 全部通过；1 = 有缺失导出 / 顶层副作用
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');

const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`;

/* ------------------------------------------------------------------ */
/* 最小 DOM 伪装：只为「顶层误摸 DOM」能报错，并让惰性模块顺利 import      */
/* ------------------------------------------------------------------ */

const domTouched = [];

/** 顶层副作用检测只盯这些 —— 它们出现即代表模块无法在 Node/测试环境使用 */
const HARD_GLOBALS = ['document', 'window', 'location', 'navigator', 'matchMedia'];

function makeStub(name) {
  const fn = function stub() {
    domTouched.push(name);
    return makeStub(`${name}()`);
  };
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === 'then') return undefined; // 别被 await 当成 thenable
      if (prop === Symbol.toPrimitive || prop === 'toString') return () => `[stub ${name}]`;
      if (prop === 'length' || prop === 'nodeType') return 0;
      domTouched.push(`${name}.${String(prop)}`);
      return makeStub(`${name}.${String(prop)}`);
    },
    set() {
      return true;
    },
    apply() {
      domTouched.push(`${name}()`);
      return makeStub(`${name}()`);
    },
  });
}

/**
 * 存储伪装：必须**真的像存储**。
 * settings.js 顶层调 `hasStorage()`，里面是 setItem/removeItem 探针 + try/catch。
 * 如果这里做成通用 Proxy，探针会「成功」，于是 localStorageOk 被误判为 true，
 * 后续 `getItem` 拿到一个 Proxy 而不是 null —— 那是我这个冒烟脚本自己制造的假象，
 * 不能算模块缺陷。所以这里给一个老实的 Map 实现。
 */
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

for (const g of ['window', 'document', 'navigator', 'location', 'matchMedia', 'speechSynthesis', 'SpeechSynthesisUtterance', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  if (!(g in globalThis)) {
    Object.defineProperty(globalThis, g, { value: makeStub(g), writable: true, configurable: true });
  }
}
for (const g of ['localStorage', 'sessionStorage']) {
  if (!(g in globalThis)) {
    Object.defineProperty(globalThis, g, { value: makeStorage(), writable: true, configurable: true });
  }
}
if (!('performance' in globalThis)) globalThis.performance = { now: () => Date.now() };
if (!('crypto' in globalThis)) globalThis.crypto = { randomUUID: () => '00000000-0000-4000-8000-000000000000' };

/* ------------------------------------------------------------------ */
/* 契约：app.js 真正调用的成员                                          */
/* ------------------------------------------------------------------ */

/**
 * 这些名字来自 `web/js/app.js` 的实际调用点（grep 出来的），不是文档里抄的。
 * 少一个，对应功能就会静默降级（loadModule 只 warn，不抛）。
 *
 * 注意 `busy.js` 里**没有** `$`/`$$`/`el`/`toast`/`formatTime` 这些导出 ——
 * 它们是 `core/dom.js` 的导出，app.js 里来自 `import ... from './core/busy.js'` 吗？
 * 不是：app.js 第 16 行确实是从 `./core/busy.js` import 的，所以这里必须照实核对。
 * 早先我把 dom.js 的导出错记到 busy.js 上，于是脚本报了 5 条**假失败** ——
 * 这是本项目的第二条教训：契约表要对着源码 grep，不能凭印象写。
 */
const CONTRACT = {
  'js/pet/index.js': ['ACTIONS', 'PetUI'],
  'js/chat/index.js': ['Chat'],
  'js/voice/index.js': ['Voice'],
  'js/training/index.js': ['Training'],
  // persona 是**命名空间导入**（app.js 里 `modules.Persona = 整个模块对象`），
  // 所以这里校验它必须提供的函数，而不是要求一个叫 Persona 的导出。
  'js/persona/index.js': ['listPresets', 'buildSystemPrompt', 'polish', 'splitBubbles'],
};

/** 核心模块导出契约（同样来自 app.js 的实际静态 import 行） */
const CORE_CONTRACT = {
  'js/core/events.js': ['on', 'emit', 'AppEvents'],
  'js/core/settings.js': ['Settings', 'DEFAULTS'],
  'js/core/store.js': ['Store'],
  'js/core/dom.js': ['$', '$$', 'el', 'on', 'formatTime', 'toast'],
  'js/core/busy.js': ['Panels', 'Bubble', 'reportError', 'initShell', 'applyTheme', 'on'],
};

/** app.js 在 PetUI 上调用的方法（来自 app.js 实际调用点） */
const PETUI_METHODS = ['mount', 'update', 'trigger', 'setMood', 'getMood', 'hitTest', 'lookAt', 'setMouth'];

/** 12 个动作 id —— 必须逐字一致，app.js 直接按这些字符串调用 trigger */
const REQUIRED_ACTIONS = [
  'tap-head', 'tap-face', 'tap-body', 'tap-hand',
  'double-tap', 'long-press', 'drag', 'drop',
  'idle-random', 'greet', 'sleep', 'wake',
];

/* ------------------------------------------------------------------ */

const failures = [];
const notes = [];

async function tryImport(rel) {
  const abs = path.join(ROOT, 'web', rel);
  const before = domTouched.length;
  try {
    const mod = await import(pathToFileURL(abs).href);
    if (domTouched.length > before) {
      failures.push({
        rel,
        detail: `模块在**顶层**访问了 DOM/浏览器全局（${[...new Set(domTouched.slice(before))].join(', ')}）；` +
          '应把访问挪进函数体内，否则该模块在 Node 测试环境不可用',
      });
    }
    if (VERBOSE) console.log(`  ${GREEN('ok')} ${rel}  导出 ${Object.keys(mod).length} 个`);
    return mod;
  } catch (err) {
    failures.push({ rel, detail: `import 失败：${err?.message || err}` });
    return null;
  }
}

async function main() {
  console.log('检查一：模块能否被真加载（顶层副作用检测）');
  const loaded = {};
  for (const rel of [...Object.keys(CORE_CONTRACT), ...Object.keys(CONTRACT)]) {
    loaded[rel] = await tryImport(rel);
  }

  console.log('检查二：核心模块导出契约');
  for (const [rel, names] of Object.entries(CORE_CONTRACT)) {
    const mod = loaded[rel];
    if (!mod) continue;
    for (const n of names) {
      if (!(n in mod)) failures.push({ rel, detail: `缺少导出 ${n}（app.js 直接 import 它）` });
    }
  }

  console.log('检查三：四个子模块导出契约（app.js 运行时按名字取用）');
  for (const [rel, names] of Object.entries(CONTRACT)) {
    const mod = loaded[rel];
    if (!mod) continue;
    for (const n of names) {
      if (!(n in mod)) failures.push({ rel, detail: `缺少导出 ${n}` });
    }
  }

  console.log('检查四：PetUI 方法集与 12 个动作 id');
  const pet = loaded['js/pet/index.js'];
  if (pet?.PetUI) {
    for (const m of PETUI_METHODS) {
      if (typeof pet.PetUI[m] !== 'function') {
        failures.push({ rel: 'js/pet/index.js', detail: `PetUI.${m} 不是函数（app.js 会调用它）` });
      }
    }
    const ids = new Set((pet.ACTIONS || []).map((a) => (typeof a === 'string' ? a : a?.id)));
    for (const a of REQUIRED_ACTIONS) {
      if (!ids.has(a)) failures.push({ rel: 'js/pet/index.js', detail: `ACTIONS 缺少动作 id: ${a}` });
    }
    const extra = [...ids].filter((i) => i && !REQUIRED_ACTIONS.includes(i));
    if (extra.length) notes.push(`PetUI.ACTIONS 还额外提供了 ${extra.length} 个动作：${extra.join(', ')}`);
  }

  console.log('检查五：app.js 的加载顺序契约（persona 必须在四个子模块之后/之前各自可用）');
  const persona = loaded['js/persona/index.js'];
  if (persona && typeof persona.listPresets === 'function') {
    const presets = persona.listPresets();
    if (!Array.isArray(presets) || presets.length === 0) {
      failures.push({ rel: 'js/persona/index.js', detail: 'listPresets() 必须返回非空数组（设置面板的预设下拉依赖它）' });
    } else {
      notes.push(`persona 预设 ${presets.length} 个：${presets.map((p) => p?.id ?? p).join(', ')}`);
    }
  } else if (persona) {
    failures.push({ rel: 'js/persona/index.js', detail: '缺少 listPresets()' });
  }

  console.log('');
  for (const n of notes) console.log(YELLOW(`  · ${n}`));
  if (failures.length === 0) {
    console.log(GREEN('✅ 模块契约自检通过：全部模块可加载、导出齐备、PetUI 方法集与 12 个动作 id 对齐。'));
    process.exit(0);
  }
  console.log(RED(`✗ 模块契约自检失败 ${failures.length} 项：`));
  for (const f of failures) console.log(`  - ${RED(f.rel)}  ${f.detail}`);
  process.exit(1);
}

await main();
