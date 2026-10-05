#!/usr/bin/env node
/**
 * 自检脚本：校验 web/index.html 与 web/js/**、core 的 DOM 契约是否对得上。
 *
 * 检查项：
 *  1. app.js / busy.js 里用到的每个 #id 选择器，index.html 是否真的存在
 *  2. index.html 里每个 data-setting 是否都在 DEFAULTS 白名单里（否则设置项静默失效）
 *  3. index.html 里每个 data-secret 是否都是敏感键
 *  4. 每个 .dock-btn[data-panel] 对应的 #panel-<id> 是否存在
 *  5. 每个 <output id="out-x"> 是否被 app.js 绑定
 *
 * 退出码：0 全部通过 / 1 有问题。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const WEB = join(ROOT, 'web');

function walk(dir, ext) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, ext));
    else if (name.endsWith(ext)) out.push(full);
  }
  return out;
}

const html = readFileSync(join(WEB, 'index.html'), 'utf8');
const problems = [];
const warnings = [];

/* —— 1. 收集 HTML 里的 id / data-* —— */
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const htmlSettings = new Set([...html.matchAll(/data-setting="([^"]+)"/g)].map((m) => m[1]));
const htmlSecrets = new Set([...html.matchAll(/data-secret="([^"]+)"/g)].map((m) => m[1]));
const htmlPanels = new Set([...html.matchAll(/data-panel="([^"]+)"/g)].map((m) => m[1]));

/* —— 2. 收集 JS 里用到的 #id 选择器 —— */
const jsFiles = walk(join(WEB, 'js'), '.js');
const idRefs = new Map(); // id -> Set(file)
for (const file of jsFiles) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/[$]\(\s*['"]#([A-Za-z0-9_-]+)['"]/g)) {
    const id = m[1];
    if (!idRefs.has(id)) idRefs.set(id, new Set());
    idRefs.get(id).add(file.replace(ROOT + '\\', '').replace(ROOT + '/', ''));
  }
  for (const m of src.matchAll(/getElementById\(\s*['"]([A-Za-z0-9_-]+)['"]/g)) {
    const id = m[1];
    if (!idRefs.has(id)) idRefs.set(id, new Set());
    idRefs.get(id).add(file.replace(ROOT + '\\', '').replace(ROOT + '/', ''));
  }
}

for (const [id, files] of idRefs) {
  // panel-<x> 由 busy.js 动态拼出来，单独校验
  if (!htmlIds.has(id)) {
    problems.push(`选择器 #${id} 在 index.html 里不存在（引用自 ${[...files].join(', ')}）`);
  }
}

/* —— 3. 面板与 dock 按钮配对 —— */
for (const panel of htmlPanels) {
  if (!htmlIds.has(`panel-${panel}`)) problems.push(`dock 按钮 data-panel="${panel}" 没有对应的 #panel-${panel}`);
}

/* —— 4. data-setting / data-secret 白名单 —— */
const settingsSrc = readFileSync(join(WEB, 'js', 'core', 'settings.js'), 'utf8');
const defaultsBlock = settingsSrc.slice(
  settingsSrc.indexOf('export const DEFAULTS'),
  settingsSrc.indexOf('/** 普通偏好键'),
);
const defaultKeys = new Set(
  [...defaultsBlock.matchAll(/^\s*'([a-z]+\.[A-Za-z0-9_]+)'\s*:/gm)].map((m) => m[1]),
);
const secretKeys = new Set(
  [...settingsSrc
    .slice(settingsSrc.indexOf('const SECRET_KEYS'), settingsSrc.indexOf('/** 合法键全集'))
    .matchAll(/'([a-z]+\.[A-Za-z0-9_]+)'/g)].map((m) => m[1]),
);

for (const key of htmlSettings) {
  if (!defaultKeys.has(key)) problems.push(`data-setting="${key}" 不在 DEFAULTS 里，控件不会生效`);
}
for (const key of htmlSecrets) {
  if (!secretKeys.has(key)) problems.push(`data-secret="${key}" 不是敏感键（SECRET_KEYS），会被当普通输入处理`);
}
// 反向：DEFAULTS 里有、HTML 完全没有对应控件的键 —— 只提示不算错（可能由代码/AI 使用）
const appSrc = readFileSync(join(WEB, 'js', 'app.js'), 'utf8');
for (const key of defaultKeys) {
  if (!htmlSettings.has(key) && !appSrc.includes(`'${key}'`)) {
    warnings.push(`DEFAULTS 键 "${key}" 既无 HTML 控件也无 app.js 引用`);
  }
}

/* —— 5. output 绑定 —— */
for (const m of html.matchAll(/<output[^>]*\bid="(out-[A-Za-z0-9_-]+)"/g)) {
  if (!appSrc.includes(`'${m[1]}'`)) warnings.push(`<output id="${m[1]}"> 没有被 app.js 绑定`);
}

/* —— 输出 —— */
console.log(`index.html id 数: ${htmlIds.size}`);
console.log(`data-setting: ${htmlSettings.size} / data-secret: ${htmlSecrets.size} / data-panel: ${htmlPanels.size}`);
console.log(`JS 里引用的 #id: ${idRefs.size}`);
console.log(`DEFAULTS 键: ${defaultKeys.size} / SECRET_KEYS: ${secretKeys.size}`);
console.log('');

if (warnings.length) {
  console.log(`⚠️  提示 ${warnings.length} 条：`);
  for (const w of warnings) console.log(`   - ${w}`);
  console.log('');
}

if (problems.length) {
  console.log(`❌ 发现 ${problems.length} 个契约不一致：`);
  for (const p of problems) console.log(`   - ${p}`);
  process.exit(1);
}

console.log('✅ DOM 契约自检通过：所有选择器、设置键、面板配对一致。');
