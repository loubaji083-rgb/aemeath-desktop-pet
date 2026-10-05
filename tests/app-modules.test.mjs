#!/usr/bin/env node
/**
 * tests/app-modules.test.mjs —— 防「白屏级」回归
 *
 * 为什么单独有这一个文件：
 *   2026-xx 期间出现过一个 release-blocking 缺陷：web/js/app.js 从 core/busy.js
 *   import 了 `$`/`$$`/`el`/`toast`/`formatTime`，而 busy.js 当时结尾只写了
 *   `export { on };`。ES Module 的链接是**求值前的静态检查**，所以后果不是
 *   「某个功能降级」，而是整条模块图加载失败：
 *       SyntaxError: The requested module './core/busy.js' does not provide an export named '$'
 *   浏览器里就是**白屏**。普通单测抓不到它（单测不会去 import app.js）。
 *
 * 本文件的断言有真实防回归价值——它们**确实会**因为上面那个缺陷而失败：
 *   1. `import * as busy` + 检查 `$`/`$$`/`el`/`toast`/`formatTime` 可用
 *      （busy.js 一旦不再从 dom.js 再导出，这一条就抛 SyntaxError → 失败）
 *   2. 真 import web/js/app.js，任何链接错误/顶层副作用都会让这一条失败
 *   3. 三个 tools 自检脚本的退出码（子进程跑，等于 CI 里跑的那三条）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDomStub } from '../tools/dom-stub.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.join(ROOT, p);
const webUrl = (p) => new URL(`../web/${p}`, import.meta.url).href;

installDomStub();

/* ------------------------------------------------------------------ */
/* 1. busy.js 必须把 dom.js 的名字再导出（白屏级哨兵）                    */
/* ------------------------------------------------------------------ */

test('core/busy.js 必须再导出 dom.js 的 $/$$/el/toast/formatTime（否则 app.js 白屏）', async () => {
  const busy = await import(webUrl('js/core/busy.js'));
  const dom = await import(webUrl('js/core/dom.js'));

  for (const name of ['$', '$$', 'el', 'toast', 'formatTime']) {
    assert.equal(
      typeof busy[name],
      'function',
      `busy.js 未再导出 dom.js 的 ${name}()；app.js:16 会因链接错误白屏`,
    );
    assert.equal(busy[name], dom[name], `busy.js 的 ${name} 应当就是 dom.js 里那一个函数（不是另一份实现）`);
  }
  // busy.js 自己的导出也要在
  for (const name of ['on', 'reportError', 'initShell', 'Panels', 'Bubble', 'applyTheme']) {
    assert.ok(name in busy, `busy.js 缺少自己的导出 ${name}`);
  }
});

/* ------------------------------------------------------------------ */
/* 2. app.js 整条模块图必须能加载                                        */
/* ------------------------------------------------------------------ */

test('web/js/app.js 可以 import（模块图无链接错误、顶层无裸 DOM 副作用）', async () => {
  const mod = await import(webUrl('js/app.js'));
  assert.ok(mod && typeof mod === 'object', 'app.js 应当能作为模块被导入');
});

test('app.js 的静态 import 表里每个名字都能在对应模块上解析到', async () => {
  // 直接读源码抽 import 语句，再逐条去真实模块上核对名字是否存在。
  // 这一条比「import app.js 成功」更早定位问题：它给出**缺哪个名字、缺在哪个文件**。
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(rel('web/js/app.js'), 'utf8');
  const re = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
  const checked = [];
  for (const m of src.matchAll(re)) {
    const names = m[1]
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    const target = new URL(spec, new URL(`file://${rel('web/js/app.js').replace(/\\/g, '/')}`)).href;
    const targetPath = fileURLToPath(target);
    assert.ok(existsSync(targetPath), `app.js import 的目标文件不存在：${spec}`);
    const mod = await import(target);
    const missing = names.filter((n) => !(n in mod) && !(n === 'default'));
    assert.deepEqual(
      missing,
      [],
      `app.js 从 ${spec} import 了不存在的导出：${missing.join(', ')}（这在浏览器里是白屏级 SyntaxError）`,
    );
    checked.push(`${spec} → ${names.length} 个名字`);
  }
  // app.js 目前有 4 条相对 import（events/settings/store/busy）；写 >= 4 是防「正则没匹配到任何东西还假装通过」
  assert.ok(
    checked.length >= 4,
    `app.js 至少应有 4 条相对具名 import（events/settings/store/busy），实际识别到 ${checked.length} 条`,
  );
});

/* ------------------------------------------------------------------ */
/* 3. 三个 tools 自检脚本（CI 里跑的就是它们）                            */
/* ------------------------------------------------------------------ */

const TOOLS = ['tools/selfcheck-api.mjs', 'tools/selfcheck-modules.mjs', 'tools/smoke-app-import.mjs'];

for (const tool of TOOLS) {
  test(`${tool} 退出码为 0`, () => {
    assert.ok(existsSync(rel(tool)), `${tool} 不存在`);
    const res = spawnSync(process.execPath, [rel(tool)], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(
      res.status,
      0,
      `${tool} 退出码 ${res.status}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`,
    );
  });
}

test('tools/dom-stub.mjs 是幂等的（重复 install 不会破坏已定义的全局）', () => {
  const first = globalThis.document;
  installDomStub();
  assert.equal(globalThis.document, first, '重复 install 不应替换已有 document');
});
