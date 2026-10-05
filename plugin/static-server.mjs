/**
 * plugin/static-server.mjs —— 零依赖静态文件处理器
 *
 * 设计目标：同一份逻辑被三处复用，保证行为完全一致。
 *   1. plugin/index.js   —— 注册到 DSH 的 ctx.webServer（kind: 'prefix'）
 *   2. plugin/serve-cli.mjs —— 在不启动 DSH 时单独起一个本地静态服务（降级方案）
 *   3. tests/plugin.test.mjs —— 直接单测纯函数与处理器
 *
 * 安全边界（本文件是唯一的路径判定实现，不要在别处重复实现）：
 *   - 只允许读取 webRoot 之内的文件；URL 里的 `..`、绝对路径、盘符、UNC、
 *     空字节、编码后的 `%2e%2e` 全部在 decodeURIComponent 之后统一交给
 *     path.resolve + 前缀判定，越界一律 404，不泄漏服务器路径。
 *   - 只按扩展名白名单给 Content-Type；未知扩展名一律 application/octet-stream，
 *     不给 text/html（避免把 .md/.json 之类当可执行上下文）。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 扩展名 → Content-Type。刻意保守：不在表里的走 octet-stream。 */
export const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
});

/**
 * 按扩展名取 Content-Type。大小写不敏感；未收录返回 octet-stream。
 * @param {string} filePath
 * @returns {string}
 */
export function mimeFor(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * 定位本仓库的 web/ 静态根目录。
 *
 * 优先级：
 *   1. 显式传入的 candidate（插件配置 / CLI --root）
 *   2. 环境变量 AEMEATH_WEB_ROOT
 *   3. 本文件所在目录的上一级（即仓库根）下的 web/
 *
 * 只做「存在且是目录」的判定，不做任何创建动作。
 * @param {string} [candidate]
 * @param {{ existsSync?: (p: string) => boolean, moduleDir?: string }} [opts]
 * @returns {string | null} 绝对路径；找不到返回 null（调用方负责降级提示，不抛错）
 */
export function resolveWebRoot(candidate, opts = {}) {
  const existsSync = opts.existsSync ?? fs.existsSync;
  const moduleDir = opts.moduleDir ?? path.dirname(fileURLToPath(import.meta.url));

  const tryOne = (p) => {
    if (!p) return null;
    try {
      const abs = path.resolve(String(p));
      return existsSync(abs) ? abs : null;
    } catch {
      return null;
    }
  };

  return (
    tryOne(candidate) ||
    tryOne(process.env.AEMEATH_WEB_ROOT) ||
    tryOne(path.join(moduleDir, '..', 'web'))
  );
}

/**
 * 把请求 URL 解析成「相对 webRoot 的安全相对路径」。
 * 越界 / 畸形 / 空字节 一律返回 null。
 *
 * @param {string} requestUrl 形如 '/aemeath/js/app.js?x=1'
 * @param {{ prefix?: string, indexFile?: string }} [opts]
 * @returns {string | null} 形如 'js/app.js'；目录请求返回 indexFile
 */
export function safeRelativePath(requestUrl, opts = {}) {
  const prefix = opts.prefix ?? '/aemeath';
  const indexFile = opts.indexFile ?? 'index.html';
  let raw = String(requestUrl ?? '');

  // 去掉 query / hash
  const hashAt = raw.indexOf('#');
  if (hashAt >= 0) raw = raw.slice(0, hashAt);
  const qAt = raw.indexOf('?');
  if (qAt >= 0) raw = raw.slice(0, qAt);

  if (raw.includes('\0')) return null; // 空字节截断攻击

  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null; // 非法百分号编码
  }
  // decode 之后再查一次：%00 现在会变成真正的空字节
  if (decoded.includes('\0')) return null;
  // 反斜杠在 Windows 上也是分隔符，统一成正斜杠再判定
  decoded = decoded.replace(/\\/g, '/');

  // 协议相对形态 `//host/share/...` 在浏览器里会被当成另一个 origin，不接管
  if (decoded.startsWith('//')) return null;

  // 剥掉挂载前缀（前缀本身与 '/aemeath/' 两种写法都要认）
  if (decoded === prefix || decoded === `${prefix}/`) return indexFile;
  if (decoded.startsWith(`${prefix}/`)) decoded = decoded.slice(prefix.length + 1);
  else return null; // 不在挂载点下（例如 /aemeathx/...），不接管

  // 剥完前缀仍然以分隔符开头 ⇒ 原始输入是 `//host` 或 `\\host\share`（UNC / 协议相对）。
  // 这类路径在 Windows 上会被解析成别的卷或网络位置，**不是**挂在 webRoot 下的相对路径；
  // 即便后面的 segments 拼接恰好被约束在 webRoot 内，也不该接受这种输入形态。
  // 实例：'/aemeath/\\server\\share\\a.js' → decode 后含反斜杠 → 归一化 → '/aemeath//server/...'
  //       → 剥前缀得到 '//server/...' → 必须拒。
  if (decoded.startsWith('/')) return null;

  const segments = decoded.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) return null; // 目录穿越
  if (segments.length === 0) return indexFile;
  // 盘符 / UNC 之类混进来也直接拒
  if (segments.some((s) => /^[A-Za-z]:$/.test(s))) return null;

  // 以 '/' 结尾视为目录请求
  if (decoded.endsWith('/')) return [...segments, indexFile].join('/');
  // 无扩展名的末段也按目录处理，方便 /aemeath 与 /aemeath/js 这类写法
  const last = segments[segments.length - 1];
  if (!last.includes('.')) return [...segments, indexFile].join('/');

  return segments.join('/');
}

/**
 * 在 webRoot 内解析出绝对路径，并二次确认仍在 webRoot 内。
 * @returns {string | null}
 */
export function resolveInside(webRoot, relativePath) {
  if (!webRoot || !relativePath) return null;
  const rootAbs = path.resolve(webRoot);
  const target = path.resolve(rootAbs, relativePath);
  const rel = path.relative(rootAbs, target);
  if (rel === '' ) return target; // 就是 root 本身（调用方会再加 index）
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

/**
 * 读取一个静态文件。
 * @returns {Promise<{ ok: true, bytes: Buffer, mime: string, path: string }
 *                 | { ok: false, code: 404 | 403 | 500, reason: string }>}
 */
export async function readStaticFile(webRoot, relativePath) {
  const abs = resolveInside(webRoot, relativePath);
  if (!abs) return { ok: false, code: 403, reason: 'path-outside-web-root' };
  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    return { ok: false, code: 404, reason: 'not-found' };
  }
  if (stat.isDirectory()) return { ok: false, code: 404, reason: 'is-directory' };
  try {
    const bytes = await fsp.readFile(abs);
    return { ok: true, bytes, mime: mimeFor(abs), path: abs };
  } catch (err) {
    return { ok: false, code: 500, reason: `read-failed: ${err?.code || err?.message || 'unknown'}` };
  }
}

/** 极小的 HTML 转义，用于错误页与降级页（不引入任何模板依赖） */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 默认的「信任栅栏」：只允许回环 Host，且拒绝跨站标记 / 非同源 Origin。
 *
 * 为什么需要它：DSH 的 webServer 路由对**同机任意进程**都是可达的；本插件只读静态文件，
 * 攻击面很小，但把 web/ 暴露给任意 Host 头（DNS 重绑定）没有意义，所以默认收紧。
 * 返回 null = 放行；返回状态码 = 拒绝。校验器自身出错按拒绝处理（fail-closed）。
 *
 * 注意：这是插件自带的**轻量**校验，不能替代 DSH 的 connection.requestRejection；
 * 若部署在非回环地址（反代/局域网），用 AEMEATH_TRUSTED_HOSTS 显式声明。
 *
 * @param {{ headers?: Record<string, any> }} req
 * @param {{ trustedHosts?: string[] }} [opts]
 * @returns {number | null}
 */
export function trustRejection(req, opts = {}) {
  try {
    const headers = (req && req.headers) || {};
    let hostUrl;
    try {
      hostUrl = new URL(`http://${String(headers.host || '')}`);
    } catch {
      return 403;
    }
    const hostname = hostUrl.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
    const authority = hostUrl.host.toLowerCase();

    const isLoopback = (() => {
      if (!hostname) return false;
      if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
      if (hostname === '::1') return true;
      const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
      if (!m) return false;
      return Number(m[1]) === 127 && [m[2], m[3], m[4]].every((x) => Number(x) <= 255);
    })();

    if (!isLoopback) {
      const trusted = (opts.trustedHosts ?? []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
      const listed = trusted.some((e) => (e.includes(':') ? e === authority : e === hostname));
      if (!listed) return 403;
    }

    const site = String(headers['sec-fetch-site'] || '').toLowerCase();
    if (site === 'cross-site') return 403;

    const origin = headers.origin;
    if (typeof origin === 'string' && origin && origin !== 'null') {
      let originUrl;
      try {
        originUrl = new URL(origin);
      } catch {
        return 403;
      }
      if (originUrl.host.toLowerCase() !== authority) return 403;
    }
    return null;
  } catch {
    return 403;
  }
}

/**
 * 构造一个 Node http 风格 handler：(req, res) => Promise<void>
 *
 * 与 DSH 的 WebRoute.handler 完全同签名（IncomingMessage / ServerResponse），
 * 因此可以同时喂给 ctx.webServer.register() 和 node:http.createServer()。
 *
 * @param {{
 *   webRoot: string,
 *   prefix?: string,
 *   indexFile?: string,
 *   trustedHosts?: string[],
 *   logger?: { warn: (...a: any[]) => void },
 * }} config
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createStaticHandler(config) {
  const webRoot = config.webRoot;
  const prefix = config.prefix ?? '/aemeath';
  const indexFile = config.indexFile ?? 'index.html';
  const trustedHosts = config.trustedHosts ?? [];
  const logger = config.logger ?? console;
  const cacheControl = 'no-cache';

  const send = (res, code, headers, body) => {
    try {
      res.writeHead(code, headers);
      res.end(body);
    } catch (err) {
      try {
        logger.warn('[aemeath:plugin] 响应写入失败', err);
      } catch {
        /* ignore */
      }
    }
  };

  return async function staticHandler(req, res) {
    const deny = trustRejection(req, { trustedHosts });
    if (deny !== null) {
      send(res, deny, { 'Content-Type': 'text/plain; charset=utf-8' }, 'forbidden');
      return;
    }

    const method = String((req && req.method) || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      send(res, 405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }, 'method not allowed');
      return;
    }

    const rel = safeRelativePath(req && req.url, { prefix, indexFile });
    if (rel === null) {
      send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'not found');
      return;
    }

    const result = await readStaticFile(webRoot, rel);
    if (!result.ok) {
      if (result.code === 404) {
        send(
          res,
          404,
          { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
          `<!doctype html><meta charset="utf-8"><title>404</title><p>找不到 <code>${escapeHtml(rel)}</code>。</p><p>若这是首次运行，请确认仓库的 <code>web/</code> 目录已就位（本插件只做只读静态托管）。</p>`,
        );
        return;
      }
      logger.warn('[aemeath:plugin] 静态文件读取失败', rel, result.reason);
      send(res, result.code, { 'Content-Type': 'text/plain; charset=utf-8' }, 'error');
      return;
    }

    const headers = {
      'Content-Type': result.mime,
      'Content-Length': String(result.bytes.length),
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
    };
    if (method === 'HEAD') {
      send(res, 200, headers, '');
      return;
    }
    send(res, 200, headers, result.bytes);
  };
}
