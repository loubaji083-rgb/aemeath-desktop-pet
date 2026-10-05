#!/usr/bin/env node
/**
 * serve-cli.mjs —— 脱离 DSH，用一个极小的原生 HTTP 服务托管 web/（零依赖）
 *
 * 用途：
 *   1. 本地开发时预览桌宠页面，不用每次重启 DSH；
 *   2. 排查「插件已加载但这个 URL 打不开」时，用它区分
 *      「web/ 目录本身有问题」还是「DSH 路由没注册上」——它和 DSH 路由**共用同一个**
 *      createStaticHandler，所以行为一致（路径安全、信任校验、MIME、404/405 都是同一套代码）。
 *
 * 它不是 DSH 的一部分：DSH 里由 plugin/index.js 通过 ctx.webServer.register() 挂载。
 *
 * 用法：
 *   node plugin/serve-cli.mjs                    # 默认 127.0.0.1:8787
 *   node plugin/serve-cli.mjs --port 9000
 *   node plugin/serve-cli.mjs --host 0.0.0.0     # 注意：非回环地址会要求 Host 命中信任列表
 *   node plugin/serve-cli.mjs --web-root ../web
 *   node plugin/serve-cli.mjs --prefix /pet
 *   node plugin/serve-cli.mjs --once             # 只服务一个请求就退出（CI / 冒烟用）
 *   node plugin/serve-cli.mjs --quiet
 *
 * 环境变量：AEMEATH_WEB_ROOT / AEMEATH_PREFIX / AEMEATH_TRUSTED_HOSTS（与插件一致）
 *
 * 退出码：0 正常退出；1 起不来（端口占用、web/ 不存在等）。
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticHandler, resolveWebRoot } from './static-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8787;
export const DEFAULT_PREFIX = '/aemeath';

/** 极简参数解析：--key value / --flag */
export function parseArgs(argv = []) {
  const opts = { flags: new Set(), values: new Map() };
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      opts.values.set(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !String(next).startsWith('--')) {
      opts.values.set(key, String(next));
      i += 1;
    } else {
      opts.flags.add(key);
    }
  }
  return opts;
}

function prefixFrom(opts) {
  const raw = String(opts.values.get('prefix') ?? process.env.AEMEATH_PREFIX ?? DEFAULT_PREFIX).trim();
  if (!raw) return DEFAULT_PREFIX;
  return (raw.startsWith('/') ? raw : `/${raw}`).replace(/\/+$/, '') || DEFAULT_PREFIX;
}

/**
 * 建服务（不 listen），方便测试直接注入。
 *
 * @param {{webRoot?: string, prefix?: string, trustedHosts?: string[], quiet?: boolean}} [options]
 * @returns {{ server: import('node:http').Server, webRoot: string | null, prefix: string }}
 */
export function createServer(options = {}) {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const webRoot = resolveWebRoot(options.webRoot);
  const trustedHosts = options.trustedHosts ?? [];
  const quiet = Boolean(options.quiet);

  if (!webRoot && !quiet) {
    console.warn(
      `[aemeath:serve] 没找到可托管的 web/ 目录（候选：${options.webRoot ?? '未指定'}）。` +
        `请用 --web-root 显式指定，或设置 AEMEATH_WEB_ROOT。`,
    );
  }

  const handler = createStaticHandler({
    webRoot,
    prefix,
    trustedHosts,
    logger: quiet ? null : (line) => console.log(line),
  });

  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      console.warn('[aemeath:serve] 处理请求异常', err);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      try {
        res.end('internal error');
      } catch {
        /* ignore */
      }
    });
  });

  return { server, webRoot, prefix };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.flags.has('help') || opts.flags.has('h')) {
    console.log(
      [
        'node plugin/serve-cli.mjs [--host 127.0.0.1] [--port 8787] [--web-root <路径>]',
        '                            [--prefix /aemeath] [--trusted-hosts a,b] [--once] [--quiet]',
        '',
        '环境变量：AEMEATH_WEB_ROOT / AEMEATH_PREFIX / AEMEATH_TRUSTED_HOSTS',
      ].join('\n'),
    );
    process.exit(0);
  }

  const host = opts.values.get('host') ?? DEFAULT_HOST;
  const port = Number(opts.values.get('port') ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`[aemeath:serve] 端口不合法：${opts.values.get('port')}`);
    process.exit(1);
  }

  const prefix = prefixFrom(opts);
  const trustedHosts = String(opts.values.get('trusted-hosts') ?? process.env.AEMEATH_TRUSTED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const { server, webRoot } = createServer({
    webRoot: opts.values.get('web-root') ?? process.env.AEMEATH_WEB_ROOT,
    prefix,
    trustedHosts,
    quiet: opts.flags.has('quiet'),
  });

  if (!webRoot) {
    console.error(`[aemeath:serve] 起不来：没有可托管的 web/ 目录。用 --web-root 指定后重试。`);
    process.exit(1);
  }

  const once = opts.flags.has('once');
  // --once：只服务第一个请求就关闭。
  // 注意不能把 `server.close()` 挂到 'request' 上 —— 那会在响应还没写完时就关掉连接。
  // 正确做法是等响应 'finish'（或连接关闭）之后再 close。
  if (once) {
    server.once('request', (_req, res) => {
      const done = () => setImmediate(() => server.close(() => process.exit(0)));
      res.once('finish', done);
      res.once('close', done);
    });
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  }).catch((err) => {
    console.error(`[aemeath:serve] 监听 ${host}:${port} 失败：${err.message}`);
    process.exit(1);
  });

  const actual = server.address();
  const shown = typeof actual === 'object' && actual ? actual.port : port;
  console.log(`[aemeath:serve] web/ → ${webRoot}`);
  console.log(`[aemeath:serve] 打开 http://${host}:${shown}${prefix}/`);
  console.log(`[aemeath:serve] 健康检查 http://${host}:${shown}${prefix}/__aemeath_health（由插件提供，本 CLI 不注册）`);

  const shutdown = () => {
    console.log('\n[aemeath:serve] 正在关闭…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main();
}

export { HERE };
