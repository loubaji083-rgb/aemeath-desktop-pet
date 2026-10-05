#!/usr/bin/env node
/**
 * 极简零依赖静态服务器（Node ≥ 18）。
 *
 * 为什么需要它：插件用了原生 ES Module，浏览器在 file:// 下会因为 CORS 拒绝加载模块，
 * 所以必须通过 http:// 访问。
 *
 * 用法：
 *   node tools/serve.mjs                 # 默认 http://127.0.0.1:18340
 *   node tools/serve.mjs --port 8080
 *   node tools/serve.mjs --host 0.0.0.0  # 局域网可访问（注意：同网段的人都能打开）
 *
 * 安全说明：默认只监听 127.0.0.1，不对外暴露；不做目录穿越。
 */

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const WEB = join(ROOT, 'web');

const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  return fallback;
}

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`爱弥斯桌宠 · 静态服务器

用法:
  node tools/serve.mjs [--port 18340] [--host 127.0.0.1]

然后浏览器打开:  http://127.0.0.1:18340/
`);
  process.exit(0);
}

const PORT = Number(argValue('--port', process.env.AEMEATH_PORT || 18340));
const HOST = argValue('--host', '127.0.0.1');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** 把 URL 路径安全地映射到磁盘路径，越界返回 null */
function safeResolve(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const normalized = normalize(p).replace(/^([/\\])+/, '');
  const candidates = [join(WEB, normalized), join(ROOT, normalized)];
  for (const abs of candidates) {
    const full = resolve(abs);
    if (!full.startsWith(ROOT + sep) && full !== ROOT) continue;
    try {
      const st = statSync(full);
      if (st.isDirectory()) continue;
      return full;
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}

const server = createServer((req, res) => {
  const file = safeResolve(req.url || '/');

  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found\n\n提示：桌面宠物入口是 / （web/index.html）。');
    return;
  }

  const ext = extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    // 开发用：禁用缓存，省得改了代码看不到效果
    'Cache-Control': 'no-store, must-revalidate',
    // 允许同源 iframe 嵌入（DSH 插件面板会用）
    'X-Content-Type-Options': 'nosniff',
  });
  createReadStream(file)
    .on('error', () => {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('500 读取失败');
    })
    .pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`爱弥斯桌宠已启动：http://${HOST}:${PORT}/`);
  console.log(`静态根目录: ${WEB}`);
  console.log('按 Ctrl+C 停止。');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。换一个：node tools/serve.mjs --port ${PORT + 1}`);
  } else {
    console.error('服务器错误：', err);
  }
  process.exit(1);
});
