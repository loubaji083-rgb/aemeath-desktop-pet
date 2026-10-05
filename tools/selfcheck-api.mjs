#!/usr/bin/env node
/**
 * 自检脚本：用**真实 import** 校验「app.js 实际调用到的模块 API」与「各模块实际导出的成员」是否一致。
 *
 * 为什么需要它：四个模块由不同人并行开发，最容易出的问题不是逻辑错，而是
 * 「A 以为 B 导出了 send()，B 实际导出的是 chat()」这类接口错配——浏览器里
 * 只会表现成一句 undefined is not a function，很难定位。
 *
 * 为什么是「真实 import」而不是「正则扫源码」：
 *   本脚本 v1 用正则从源码里抽 `export {...}` 名字，结果把
 *   `export { $, $$, el, on, formatTime, toast } from './dom.js';`
 *   这行里的**再导出名字**记成了本模块自己的导出，于是报出 5 条假失败
 *   （$ / $$ / el / toast / formatTime 被记成 busy.js 的导出）。
 *   假阳性比没有自检更糟：它会让人开始忽略自检输出。所以结论一律以真实 import 为准。
 *   —— 顺带说明：`export ... from` 的再导出在**运行时**确实是本模块的导出，
 *      但本脚本关心的是「谁定义了它」，v1 的错在于把定义方和转发方混为一谈。
 *
 * 模块能否在 bare Node 下 import：这批模块都写成「模块顶层只声明、DOM 只在函数内访问」，
 *   实测 pet / chat / persona / voice / training / core 全部可在 Node 下 import（Node 22.23.2）。
 *
 * 退出码：0 全部匹配 / 1 有缺失导出。
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDomStub } from './dom-stub.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const WEB = join(ROOT, 'web');

/* 先装 DOM 垫片：pet/chat/voice 与 app.js 在导入期会碰文档环境 */
installDomStub();

/* —— app.js 期望的 API（由 app.js 里实际调用的成员反推；与 docs/CONTRACT.md §4–§7 对齐） —— */
const EXPECTED = {
  PetUI: {
    path: 'js/pet/index.js',
    members: [
      'mount',
      'update',
      'unmount',
      'trigger',
      'setMood',
      'getMood',
      'hitTest',
      'lookAt',
      'setMouth',
      'attachLive2D',
      'getDebugState',
    ],
    actions: [
      'tap-head',
      'tap-face',
      'tap-body',
      'tap-hand',
      'double-tap',
      'long-press',
      'drag',
      'drop',
      'idle-random',
      'greet',
      'sleep',
      'wake',
    ],
  },
  Chat: {
    path: 'js/chat/index.js',
    members: ['send', 'abort', 'clear', 'getHistory', 'init'],
    optional: ['listPresets'],
  },
  Voice: {
    path: 'js/voice/index.js',
    members: [
      'init',
      'speak',
      'stop',
      'startListening',
      'stopListening',
      'isSpeaking',
      'isListening',
      'selfTest',
      'registerProvider',
      'listProviders',
    ],
  },
  Training: {
    path: 'js/training/index.js',
    members: [
      'validateManifest',
      'createManifestTemplate',
      'probeAudio',
      'submitJob',
      'pollJob',
      'exportRecipe',
    ],
  },
  Persona: {
    path: 'js/persona/index.js',
    members: ['buildSystemPrompt', 'polish', 'splitBubbles', 'listPresets'],
  },
};

/* core 模块的导出也一并核对：app.js 与各模块都直接 import 它们 */
const CORE_EXPECTED = {
  EventBus: { path: 'js/core/events.js', members: ['on', 'once', 'emit', 'off', 'AppEvents'] },
  Settings: {
    path: 'js/core/settings.js',
    members: ['Settings', 'DEFAULTS', 'NS_PREFS', 'NS_SECRET'],
  },
  Storage: { path: 'js/core/store.js', members: [] },
  Dom: {
    path: 'js/core/dom.js',
    members: ['$', '$$', 'el', 'on', 'clamp', 'escapeHtml', 'formatTime', 'toast', 'debounce', 'throttleRaf'],
  },
  Busy: {
    path: 'js/core/busy.js',
    // 关注点：busy.js 必须把 dom.js 的这几个名字**再导出**，否则 app.js 的白屏级
    // SyntaxError（does not provide an export named '$'）会复发。见 smoke-app-import.mjs。
    members: ['$', '$$', 'el', 'on', 'formatTime', 'toast', 'reportError', 'initShell', 'Panels', 'Bubble', 'applyTheme'],
  },
};

const problems = [];
const report = [];

async function loadModule(relPath, label) {
  const full = join(WEB, relPath);
  if (!existsSync(full)) {
    problems.push(`${label}: 文件缺失 → web/${relPath}`);
    report.push(`  ✗ ${label.padEnd(9)} 文件不存在（web/${relPath}）`);
    return null;
  }
  try {
    return await import(new URL(`../web/${relPath}`, import.meta.url).href);
  } catch (err) {
    problems.push(`${label}: import 失败 → web/${relPath}：${err.constructor.name}: ${err.message}`);
    report.push(`  ✗ ${label.padEnd(9)} import 失败：${err.message}`);
    return null;
  }
}

/**
 * 判断某个成员是否真的可用。
 * 模块的公开面有几种合法形态，必须都认，否则会把「聚合对象导出」误报成「缺导出」：
 *   1) 具名导出          —— `export function send()` / `export const Chat = {...}`
 *   2) 默认导出对象      —— `export default Voice`
 *   3) 聚合对象具名导出  —— `export const PetUI = { mount, ... }`，调法是 `PetUI.mount()`
 * 只看 `Object.keys(mod)` 会把 2) 和 3) 全判成缺失（v2 初版就踩了这个坑：6 个模块里 3 个假失败）。
 */
function hasMember(mod, name) {
  if (mod == null) return false;
  if (Object.prototype.hasOwnProperty.call(mod, name)) return true;
  const def = mod.default;
  if (def != null) {
    if (typeof def === 'function' && typeof def[name] !== 'undefined') return true;
    if (typeof def === 'object' && Object.prototype.hasOwnProperty.call(def, name)) return true;
  }
  for (const container of ['PetUI', 'Chat', 'Voice', 'Training', 'Persona']) {
    const obj = mod[container];
    if (obj != null && (typeof obj === 'object' || typeof obj === 'function') && typeof obj[name] !== 'undefined') return true;
  }
  return false;
}

for (const [modName, spec] of Object.entries({ ...CORE_EXPECTED, ...EXPECTED })) {
  const mod = await loadModule(spec.path, modName);
  if (!mod) continue;

  const missing = spec.members.filter((m) => !hasMember(mod, m));
  const optMissing = (spec.optional ?? []).filter((m) => !hasMember(mod, m));

  if (missing.length) {
    problems.push(`${modName} 缺少导出: ${missing.join(', ')}（web/${spec.path}）`);
    report.push(`  ✗ ${modName.padEnd(9)} 缺: ${missing.join(', ')}`);
  } else if (spec.members.length) {
    report.push(`  ✓ ${modName.padEnd(9)} ${spec.members.length} 个必需导出齐全`);
  }
  if (optMissing.length) report.push(`  · ${modName.padEnd(9)} 可选未导出（app.js 有回落）: ${optMissing.join(', ')}`);

  // PetUI 的 12 个动作：直接读真实运行时对象，不再扫源码字符串
  if (spec.actions) {
    const actions = mod.PetUI?.ACTIONS ?? mod.ACTIONS ?? mod.default?.ACTIONS ?? null;
    if (!actions) {
      problems.push('PetUI.ACTIONS 不存在（pet/index.js 必须导出 ACTIONS）');
      report.push('  ✗ ACTIONS   未导出');
    } else {
      const ids = Array.isArray(actions) ? actions.map((a) => (typeof a === 'string' ? a : a?.id)) : Object.keys(actions);
      const missingActs = spec.actions.filter((a) => !ids.includes(a));
      const extra = ids.filter((id) => !spec.actions.includes(id));
      if (missingActs.length) {
        problems.push(`PetUI 的 ACTIONS 里缺少动作: ${missingActs.join(', ')}`);
        report.push(`  ✗ ACTIONS   缺: ${missingActs.join(', ')}`);
      } else if (extra.length) {
        problems.push(`PetUI 的 ACTIONS 多出契约外动作: ${extra.join(', ')}`);
        report.push(`  ✗ ACTIONS   多: ${extra.join(', ')}`);
      } else {
        report.push(`  ✓ ACTIONS   ${spec.actions.length} 个动作齐全且无多余（运行时实测）`);
      }
    }
  }
}

/* —— 单独确认 app.js 的模块图能链接（白屏级缺陷的直接证据；实际启动流程由 smoke-app-import.mjs 负责） —— */
const appMod = await loadModule('js/app.js', 'app.js');
if (appMod === null) {
  report.push('  ✗ app.js   无法 import（白屏级缺陷，见 tools/smoke-app-import.mjs）');
} else {
  report.push('  ✓ app.js   模块图可链接（无 does not provide an export named 之类链接错误）');
}

console.log('=== 模块导出契约自检（基于真实 import） ===');
console.log(report.join('\n'));
console.log('');

if (problems.length) {
  console.log(`❌ 发现 ${problems.length} 个接口不一致：`);
  for (const p of problems) console.log(`   - ${p}`);
  process.exit(1);
}
console.log('✅ 模块导出契约自检通过。');
