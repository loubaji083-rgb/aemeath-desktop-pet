#!/usr/bin/env node
/**
 * selfcheck-http.mjs —— 端到端 HTTP 级静态资源自检（零依赖）
 *
 * 为什么需要它：
 *   单元测试只覆盖纯逻辑（settings / events / persona / 训练清单），
 *   但「打开页面白屏」这类事故全部发生在**资源解析层**：
 *     - index.html 引了 `./css/pet.css` 而文件不存在 → 样式全丢（不报错，只是丑）
 *     - `<script type="module" src="./js/app.js">` 下有一条静态 import 链指向不存在的文件
 *       → 整个 ES Module 图加载失败 → 白屏，且浏览器只在控制台给一行 net::ERR_ABORTED
 *   这个脚本把浏览器要做的事在 Node 里重做一遍：起真实的 `tools/serve.mjs`，
 *   把 index.html 的 link/script、以及从 app.js 出发的**整条静态 import 图**全部拉一遍，
 *   任何一条不返回 200 就算失败。
 *
 * 用法：
 *   node tools/selfcheck-http.mjs            # 自检
 *   node tools/selfcheck-http.mjs --verbose  # 打印每一条请求
 *
 * 退出码：0 = 全部 200；1 = 有资源拉取失败；2 = 服务器起不来。
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const VERBOSE = process.argv.includes('--verbose');
const PORT = 18399; // 刻意避开默认 18340，防止和用户手动开的服务器撞端口
const BASE = `http://127.0.0.1:${PORT}`;

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`;

/** 把 `./a/b.js` 相对当前模块路径解析成 web 根下的绝对 URL 路径。 */
function resolveUrl(fromUrlPath, spec) {
  if (/^[a-z]+:/i.test(spec)) return spec; // http(s): / data: 外链，跳过
  if (spec.startsWith('/')) return spec;
  const baseDir = path.posix.dirname(fromUrlPath);
  return path.posix.normalize(path.posix.join(baseDir, spec));
}

/**
 * 抓出 ESM 里的模块说明符（不处理非字面量的动态 import，比如 import(variable)）。
 *
 * 除了静态 import/export-from，**还必须抓到字面量形态的 `import('...')`**：
 *   app.js 是用 `loadModule('pet', () => import('./pet/index.js'), 'PetUI')` 这种
 *   懒加载把四个子模块挂进来的。这条路径写错时，静态 import 图完全正常（页面不白屏），
 *   但 `modules.PetUI` 会静默变成 null —— 桌宠不画、聊天发不出去，而且只打一行 warn。
 *   单测和静态 import 遍历都抓不到它，所以这里必须按字面量收进来。
 */
function extractStaticSpecifiers(source) {
  // 先剥掉块注释与行注释，避免注释里的 `import ... from 'x'` 造成假失败
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const specs = new Set();
  const patterns = [
    /(?:^|\n)\s*import\s+[^'"()]*?\bfrom\s*['"]([^'"]+)['"]/g, // import x from 'y'
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g, // import 'y'
    /(?:^|\n)\s*export\s+[^'"()]*?\bfrom\s*['"]([^'"]+)['"]/g, // export { x } from 'y'
    /(?:^|\n)\s*export\s*\*\s*from\s*['"]([^'"]+)['"]/g, // export * from 'y'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // import('y') —— 字面量动态 import
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(clean)) !== null) specs.add(m[1]);
  }
  return [...specs];
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const failures = [];
const checked = new Set();
/** urlPath -> 已抓到的文本（避免同一个资源为了遍历 import 图再拉一次） */
const bodies = new Map();

async function get(urlPath) {
  const url = `${BASE}${urlPath}`;
  const res = await fetch(url);
  if (VERBOSE) console.log(`  ${res.status === 200 ? GREEN('200') : RED(String(res.status))} ${urlPath}`);
  return res;
}

/**
 * 拉一个资源。**同一个 urlPath 只真正请求一次**，结果（含响应体文本）缓存下来；
 * 重复调用返回缓存里的文本，而不是 null —— 早先这里返回 null，
 * 导致「先遍历 index.html 引用」时把 /js/app.js 标记为已检查，
 * 轮到遍历 import 图时拿到 null 直接 `continue`，**整条 import 图一个都没走**。
 *
 * @returns {Promise<string|null>} 文本；失败返回 null
 */
async function fetchCritical(urlPath, reason) {
  if (bodies.has(urlPath)) return bodies.get(urlPath);
  checked.add(urlPath);
  let res;
  try {
    res = await get(urlPath);
  } catch (err) {
    failures.push({ urlPath, reason, detail: `请求异常: ${err?.message || err}` });
    bodies.set(urlPath, null);
    return null;
  }
  if (res.status !== 200) {
    failures.push({ urlPath, reason, detail: `HTTP ${res.status}` });
    bodies.set(urlPath, null);
    return null;
  }
  const text = await res.text();
  bodies.set(urlPath, text);
  return text;
}

async function main() {
  // 1. 起真实静态服务器（被测对象就是它，不是 mock）
  const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'serve.mjs'), '--port', String(PORT)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOut = '';
  child.stdout.on('data', (d) => (serverOut += d));
  child.stderr.on('data', (d) => (serverOut += d));

  const kill = () => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  };
  process.on('exit', kill);

  // 2. 等端口可用（最多 5 秒）
  let up = false;
  for (let i = 0; i < 50; i += 1) {
    try {
      const r = await fetch(`${BASE}/`);
      if (r.status === 200) {
        up = true;
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) {
    console.error(RED('✗ 服务器 5 秒内未就绪，serve.mjs 输出：'));
    console.error(serverOut.trim());
    kill();
    process.exit(2);
  }

  // 3. index.html
  const html = await fetchCritical('/index.html', '入口页面');
  if (!html) {
    kill();
    report();
    return;
  }

  // 3a. index.html 里引用的 css / js / 图标
  const refs = new Set();
  for (const m of html.matchAll(/<link[^>]+href=["']([^"']+)["']/g)) refs.add(m[1]);
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) refs.add(m[1]);
  for (const m of html.matchAll(/<img[^>]+src=["']([^"']+)["']/g)) refs.add(m[1]);
  for (const spec of refs) {
    if (/^[a-z]+:/i.test(spec)) continue;
    await fetchCritical(resolveUrl('/index.html', spec), 'index.html 引用');
  }

  // 3b. 从 app.js 出发遍历整条静态 import 图（ES Module 图加载失败 = 白屏）
  const queue = [...refs].filter((s) => s.endsWith('.js')).map((s) => resolveUrl('/index.html', s));
  const visited = new Set();
  while (queue.length) {
    const urlPath = queue.shift();
    if (visited.has(urlPath)) continue;
    visited.add(urlPath);
    const source = await fetchCritical(urlPath, 'ES Module import 图');
    if (!source) continue; // 缺文件的模块不再往下走（避免级联噪音）
    for (const spec of extractStaticSpecifiers(source)) {
      const next = resolveUrl(urlPath, spec);
      if (!/^[a-z]+:/i.test(next) && !visited.has(next)) queue.push(next);
    }
  }

  // 4. 正面验证：编码过的目录穿越必须被挡住。
  //    注意 `fetch(BASE + '/../x')` 没有意义——WHATWG URL 会在发出请求前就把 `..` 规范化掉，
  //    测不到服务器。要用**百分号编码**的 `%2e%2e`，让 `..` 原样到达服务器（或到达时被解码）。
  for (const evilPath of ['/%2e%2e/package.json', '/%2e%2e%2fpackage.json', '/..%2fpackage.json', '/%2e%2e/%2e%2e/package.json']) {
    const r = await fetch(`${BASE}${evilPath}`);
    if (r.status === 200) {
      const body = await r.text();
      // 只有在真的把 web/ 之外的文件吐出来时才算穿越成功
      if (body.includes('"name"') && body.includes('aemeath')) {
        failures.push({ urlPath: evilPath, reason: '目录穿越防护', detail: '返回了仓库根的 package.json（200）' });
      } else {
        failures.push({ urlPath: evilPath, reason: '目录穿越防护', detail: '意外返回 200（内容未识别）' });
      }
    }
  }

  // 5. 反面验证：web/ 里的正常资源必须能取到，且 404 要是 404（而不是静默 200 空文件）
  const notFound = await fetch(`${BASE}/js/__definitely_not_here__.js`);
  if (notFound.status === 200) {
    failures.push({ urlPath: '/js/__definitely_not_here__.js', reason: '404 语义', detail: '不存在的资源返回了 200' });
  }

  kill();
  report(visited.size);
}

function report(moduleCount) {
  console.log('');
  console.log(`已请求资源: ${checked.size} 个${moduleCount ? `（ES Module 图内 ${moduleCount} 个）` : ''}`);
  if (failures.length === 0) {
    console.log(GREEN('✅ HTTP 级自检通过：入口、样式、整条 ES Module import 图全部 200，且目录穿越被挡住。'));
    process.exit(0);
  }
  console.log(RED(`✗ HTTP 级自检失败 ${failures.length} 项：`));
  for (const f of failures) console.log(`  - ${RED(f.urlPath)}  [${f.reason}]  ${f.detail}`);
  console.log(YELLOW('提示：这类失败在浏览器里表现为「白屏 + 控制台一行 net::ERR_ABORTED」，单测抓不到。'));
  process.exit(1);
}

await main();
