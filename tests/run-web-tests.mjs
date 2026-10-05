#!/usr/bin/env node
/**
 * run-web-tests.mjs —— 一条命令跑完本仓库全部「浏览器侧」验证（零 npm 依赖）
 *
 * 为什么需要它：
 *   单跑 `node --test` 只能覆盖**单元语义**，抓不到「浏览器里白屏」这类问题——
 *   那类问题发生在模块图链接与顶层副作用阶段，任何 import 得到模块对象的单测都看不见。
 *   所以这里按「从外到内」的顺序跑四道关，前一道失败就不必跑后一道：
 *     1. selfcheck-http      真起静态服务，把 index.html 引到的每个资源都 200 拉一遍
 *     2. selfcheck-modules   真 import 每个模块，核对导出契约与 12 个动作 id
 *     3. smoke-app-import    真加载 app.js（白屏级缺陷的唯一直接证据）
 *     4. node --test         单元语义 + 契约哨兵
 *
 * 用法：
 *   node tests/run-web-tests.mjs            # 全部四关
 *   node tests/run-web-tests.mjs --fast     # 跳过第 1 关（不起服务，CI 里省时间）
 *   node tests/run-web-tests.mjs --only=3   # 只跑第 N 关
 *
 * 退出码：0 = 全绿；1 = 有任一关卡失败。
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const args = process.argv.slice(2);
const FAST = args.includes('--fast');
const ONLY = (() => {
  const hit = args.find((a) => a.startsWith('--only='));
  return hit ? Number(hit.slice('--only='.length)) : null;
})();

const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;

function listTestFiles() {
  const dir = join(ROOT, 'tests');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.test.mjs'))
    .sort()
    .map((f) => join(dir, f));
}

const testFiles = listTestFiles();

const STAGES = [
  {
    n: 1,
    name: '静态托管自检（selfcheck-http）',
    cmd: process.execPath,
    argv: [join(ROOT, 'tools', 'selfcheck-http.mjs')],
    skip: FAST,
    skipReason: '--fast：本关要起真实 HTTP 服务',
  },
  {
    n: 2,
    name: '模块导出契约自检（selfcheck-modules）',
    cmd: process.execPath,
    argv: [join(ROOT, 'tools', 'selfcheck-modules.mjs')],
  },
  {
    n: 3,
    name: 'app.js 加载冒烟（smoke-app-import，白屏级）',
    cmd: process.execPath,
    argv: [join(ROOT, 'tools', 'smoke-app-import.mjs')],
  },
  {
    n: 4,
    name: `单元测试与契约哨兵（node --test，${testFiles.length} 个文件）`,
    cmd: process.execPath,
    argv: ['--test', ...testFiles],
    // node:test 的 TAP 输出要额外复核：全 skip 时退出码也是 0
    verify: (out) => {
      const fail = Number((out.match(/^# fail (\d+)$/m) ?? [])[1] ?? NaN);
      const pass = Number((out.match(/^# pass (\d+)$/m) ?? [])[1] ?? NaN);
      const todo = Number((out.match(/^# todo (\d+)$/m) ?? [])[1] ?? 0);
      // 关键：TAP 里**子测试的 `not ok` 行是缩进的**（两个空格），
      // 用 `^not ok` 会漏掉它们，于是「子测试失败但 # fail 只数顶层」时看起来是绿的。
      // 必须允许前导空白，并且允许 `# TODO <原因>` / `# SKIP <原因>` 后缀。
      const notOkLines = out.match(/^\s*not ok \d+.*$/gm) ?? [];
      const notOk = notOkLines.length;
      const todoNotOk = notOkLines.filter((l) => /#\s*TODO\b/i.test(l)).length;
      const skipNotOk = notOkLines.filter((l) => /#\s*SKIP\b/i.test(l)).length;
      if (!Number.isFinite(fail) || !Number.isFinite(pass)) {
        return { ok: false, why: '找不到 `# fail` / `# pass` 行，TAP 输出可能被截断' };
      }
      if (fail !== 0) return { ok: false, why: `# fail = ${fail}` };
      if (pass < 60) return { ok: false, why: `# pass = ${pass}，明显少于预期（用例被跳过或文件没被加载？）` };
      // `not ok` 只允许来自 todo 哨兵与显式 skip，且必须能被 `# todo` / `# skip` 数解释掉。
      const unexplained = notOk - todoNotOk - skipNotOk;
      if (unexplained > 0) {
        return {
          ok: false,
          why: `${notOk} 条 not ok 里有 ${unexplained} 条既不是 TODO 也不是 SKIP（子测试失败会被 # fail 漏计）`,
        };
      }
      if (todoNotOk !== todo) {
        return { ok: false, why: `not ok 的 TODO 行 ${todoNotOk} 条与 # todo ${todo} 不一致` };
      }
      return { ok: true, note: `pass ${pass} / fail ${fail} / todo ${todo}` };
    },
  },
];

console.log('=== 爱弥斯桌宠 · 浏览器侧验证 ===');
console.log(DIM(`仓库根：${ROOT}`));
console.log(DIM(`测试文件（${testFiles.length}）：${testFiles.map((f) => f.replace(ROOT + '\\', '').replace(ROOT + '/', '')).join(', ')}`));
console.log('');

let failed = 0;
let skipped = 0;

for (const stage of STAGES) {
  if (ONLY !== null && stage.n !== ONLY) continue;
  if (stage.skip) {
    skipped += 1;
    console.log(`— 第 ${stage.n} 关 ${stage.name} → 跳过（${stage.skipReason}）`);
    continue;
  }

  const label = `第 ${stage.n} 关 ${stage.name}`;
  console.log(`▶ ${label}`);

  const res = spawnSync(stage.cmd, stage.argv, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const tail = out.trim().split('\n').slice(-3).map((l) => `    ${l}`).join('\n');

  if (res.error) {
    failed += 1;
    console.log(RED(`✗ ${label} —— spawn 失败：${res.error.message}`));
    continue;
  }

  // node:test 会自己打印 `# fail`，退出码在 Node 22 上可信；这里再复核一次 TAP
  let verdict = { ok: res.status === 0, why: `exit code ${res.status}` };
  if (stage.verify && res.stdout) {
    const v = stage.verify(res.stdout);
    if (v.ok) verdict = { ok: res.status === 0, why: res.status === 0 ? '' : `exit code ${res.status}` };
    else verdict = { ok: false, why: v.why };
    if (v.ok && res.status === 0) verdict.note = v.note;
  }

  if (verdict.ok) {
    console.log(GREEN(`✓ ${label} 通过`) + (verdict.note ? DIM(`（${verdict.note}）`) : ''));
  } else {
    failed += 1;
    console.log(RED(`✗ ${label} 失败：${verdict.why}`));
  }
  if (tail) console.log(tail);
  console.log('');
}

console.log('────────────────────────────────');
if (failed) {
  console.log(RED(`❌ ${failed} 关失败${skipped ? `（另有 ${skipped} 关被跳过）` : ''}`));
  process.exit(1);
}
console.log(GREEN(`✅ 全部通过${skipped ? `（${skipped} 关被 --fast 跳过）` : ''}`));
process.exit(0);
