/**
 * plugin/index.js —— Aemeath 桌宠的 DSH 插件入口（零运行时依赖）
 *
 * ============================================================================
 * 这个插件做了什么（以及**没有**做什么）—— 请连同 plugin/README.md 一起读
 * ============================================================================
 *
 * 已查证并使用的 DSH 真实契约（来源：cordis_inspect_query，platform=host）：
 *
 *  ① Service `webServer`（provider=Service, method=listService, service='webServer'）
 *     - `register(route: WebRoute): () => void`
 *         WebRoute = { kind: 'exact' | 'prefix', path: string,
 *                      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }
 *         重复的 (kind, path) 会 throw —— 属于组合级契约冲突，所以本插件用
 *         `ctx.effect()` 收集 disposer，插件卸载时逐个释放。
 *     - `tapIndex(transform: (html: string) => string): () => void`
 *         原始 HTML 变换，`renderIndex()` 会在结构化注入行之后按注册顺序应用。
 *
 *  ② Event `webserver/index-inject`（provider=Event, method=listEvents,
 *     event='webserver/index-inject'）
 *     - 签名 `'webserver/index-inject'(table: IndexInjection[]): void`
 *     - 描述原文：「Collect the structured index injection table. Emitted on every index
 *       render and every worker boot-payload request; listeners push their current rows,
 *       so a row's data is read fresh at emit time.」
 *     - IndexInjection 的 script 形态：{ kind: 'script', placement: 'head' | 'body', text: string }
 *
 * **能力边界（重要，不要读成「已完美集成」）**：
 *   本插件把仓库的 web/ 目录**作为只读静态站点**挂到 DSH 已监听的 HTTP 服务上，
 *   并在 DSH 页面里注入一个悬浮入口按钮。它**不注册** DSH 原生前端面板/Slot 组件、
 *   不改 DSH 核心、不依赖任何构建产物。DSH 官方的 `dsh.client`（platform: web）
 *   通道需要基于 @deepseek-ai/dsh-client-runtime 等包编译出客户端 bundle，
 *   与本仓库「零构建、原生 ES Module」的硬约束直接冲突，因此**有意不使用**该通道。
 *   本方案在 DSH Web 形态与 Electron 桌面壳两个形态下都能工作（见下方注入
 *   双通道说明），但它呈现的是一个**独立页面**，不是嵌进 DSH 侧边栏的原生面板。
 *
 * ============================================================================
 * 为什么注入要写两条通道（这是本插件最容易踩坑的地方）
 * ============================================================================
 *   - DSH Web 形态：index.html 由宿主渲染，`tapIndex()` 生效。
 *   - DSH Electron 桌面壳：index.html 是从安装包静态 dist 直接读盘的
 *     （dsh-app://app/），**永远不经过宿主的 renderIndex()**，tapIndex 不生效；
 *     桌面端唯一的注入通道是 `webserver/index-inject` 的结构化行，而该表是
 *     **宿主启动时一次性收集**的 —— 所以 apply() 必须立刻注册这一行，
 *     不能把注册推迟到 `inject([...], cb)` 里（服务就绪晚于收集 ⇒ 行永远进不了表）。
 *   因此：**行注册放在 apply() 第一件事**，依赖 webServer 的路由注册放进
 *   `root.inject(['webServer'], cb)` 延迟等待。两条通道各自去重。
 *
 *   - 注入的 script **必须自己建 <script> 标签并吞掉 onerror**，不能用
 *     kind:'script-src'：页面侧解释器对 script-src 是「加载失败即 reject 整个 boot」，
 *     而注入表一旦被缓存就没有刷新路径（插件被关掉后路由已注销 ⇒ 404 ⇒ 应用起不来）。
 */

import path from 'node:path';
import {
  createStaticHandler,
  resolveWebRoot,
  escapeHtml,
  trustRejection,
} from './static-server.mjs';

/** 静态站点挂载点前缀（URL 形态 /aemeath/...） */
export const DEFAULT_PREFIX = '/aemeath';

/** 注入进 DSH 页面的悬浮按钮 id（用于幂等判定） */
export const LAUNCHER_ELEMENT_ID = 'aemeath-launcher';

function prefixOf() {
  const raw = String(process.env.AEMEATH_PREFIX || DEFAULT_PREFIX).trim();
  if (!raw) return DEFAULT_PREFIX;
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withSlash.replace(/\/+$/, '') || DEFAULT_PREFIX;
}

function trustedHostsOf() {
  return String(process.env.AEMEATH_TRUSTED_HOSTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 构造注入到 DSH 页面里的内联脚本（自建 script 标签 + 吞掉 onerror + 幂等）。
 *
 * 为什么入口用 <a href target="_blank"> 而不是 window.open：
 *   - 弹窗拦截器会挡掉「非用户手势」的 window.open；
 *   - 用 <a> 走的是浏览器原生新标签语义，不会被拦，也不占插件额外权限。
 *
 * @param {string} prefix
 * @returns {string}
 */
export function buildInjectText(prefix = DEFAULT_PREFIX) {
  const href = `${prefix}/`;
  const id = LAUNCHER_ELEMENT_ID;
  return (
    '(function(){try{' +
    `if(document.getElementById(${JSON.stringify(id)}))return;` +
    'var d=document.createElement("div");' +
    `d.id=${JSON.stringify(id)};` +
    'd.setAttribute("data-aemeath-launcher","1");' +
    'd.style.cssText="position:fixed;left:14px;bottom:14px;z-index:2147483000;' +
    'display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;' +
    'font:12px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;' +
    'background:rgba(24,24,30,.86);color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.28);' +
    'cursor:pointer;user-select:none";' +
    `var a=document.createElement("a");a.href=${JSON.stringify(href)};a.target="_blank";` +
    'a.rel="noopener";a.style.cssText="color:inherit;text-decoration:none;display:flex;' +
    'align-items:center;gap:6px";a.textContent="Aemeath 桌宠";' +
    'd.appendChild(a);' +
    'd.title="在新标签页打开 Aemeath 桌宠（本插件只做只读静态托管，不是 DSH 原生面板）";' +
    '(document.body||document.documentElement).appendChild(d);' +
    '}catch(e){}})()'
  );
}

/**
 * 构造结构化注入行（供 `webserver/index-inject` 推送）。
 * 用 kind:'html' 而不是 kind:'script'：与 whale-widget 一致，
 * 让宿主自己去插一个纯 DOM 节点，避免依赖页面侧对 script 文本的解释时机。
 *
 * @param {string} prefix
 * @returns {{ kind: 'html', placement: 'body', html: string }}
 */
export function buildInjectRow(prefix = DEFAULT_PREFIX) {
  return {
    kind: 'html',
    placement: 'body',
    html: `<div id="${LAUNCHER_ELEMENT_ID}-row" data-aemeath-launcher="1" style="position:fixed;left:14px;bottom:14px;z-index:2147483000"><a href="${escapeHtml(
      `${prefix}/`,
    )}" target="_blank" rel="noopener" style="display:inline-block;padding:6px 10px;border-radius:999px;font:12px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;background:rgba(24,24,30,.86);color:#fff;text-decoration:none;box-shadow:0 4px 14px rgba(0,0,0,.28)">Aemeath 桌宠</a></div>`,
  };
}

/** 需要注入的两种形态都带上，方便调用方一次性判断是否已存在 */
export function buildInjectRowScript(prefix = DEFAULT_PREFIX) {
  return { kind: 'script', placement: 'body', text: buildInjectText(prefix) };
}

/** 构造降级提示页（web/ 尚未就位，或用户目录不可读时返回，不是崩溃） */
export function buildUnavailablePage(webRoot, prefix) {
  const where = webRoot ? escapeHtml(webRoot) : '（未找到）';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Aemeath 桌宠：静态目录不可用</title>
<style>body{font:14px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:720px;margin:48px auto;padding:0 20px;color:#222}code{background:#f3f3f5;padding:2px 6px;border-radius:4px}h1{font-size:20px}</style>
</head><body>
<h1>Aemeath 桌宠的 <code>web/</code> 目录不可用</h1>
<p>插件已加载并注册了路由 <code>${escapeHtml(prefix)}/</code>，但没能在磁盘上找到可托管的静态目录。</p>
<ul>
  <li>当前解析到的路径：<code>${where}</code></li>
  <li>该路径必须存在且是一个目录，并且至少包含 <code>index.html</code>。</li>
</ul>
<h2>怎么修</h2>
<ol>
  <li>确认你已经 clone 了完整仓库（<code>web/</code> 目录是仓库主体的一部分）。</li>
  <li>如果 <code>web/</code> 不在插件目录的上一级，用环境变量显式指定：<br>
      <code>AEMEATH_WEB_ROOT=/绝对/路径/to/aemeath-desktop-pet/web</code></li>
  <li>重启 DSH 让插件重新加载。</li>
</ol>
<p>本插件是**只读**静态托管：它不会创建、写入或修改 <code>web/</code> 下的任何文件。</p>
</body></html>`;
}

/**
 * 插件主体。按 DSH 插件约定导出 `{ name, apply(ctx) }`。
 */
export const name = 'aemeath-desktop-pet';

/**
 * @param {any} root Cordis 的 root Context（由 DSH 注入）
 */
export function apply(root) {
  const prefix = prefixOf();
  const trustedHosts = trustedHostsOf();
  const webRootCandidate = process.env.AEMEATH_WEB_ROOT;
  const webRoot = resolveWebRoot(webRootCandidate);

  // ──────────────────────────────────────────────────────────────────────
  // ① 立刻注册结构化注入行（必须早于任何服务等待，理由见文件头注释）
  //    这里用 effect() 管理 disposer：插件被禁用/热重载时行会正确撤掉。
  // ──────────────────────────────────────────────────────────────────────
  const injectRow = buildInjectRow(prefix);
  const injectScript = buildInjectRowScript(prefix);

  try {
    root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return;
        const already = table.some(
          (row) =>
            row &&
            ((row.kind === 'html' && typeof row.html === 'string' && row.html.includes(LAUNCHER_ELEMENT_ID)) ||
              (row.kind === 'script' && typeof row.text === 'string' && row.text.includes(LAUNCHER_ELEMENT_ID)) ||
              (row.kind === 'script-src' && typeof row.src === 'string' && row.src.includes(prefix))),
        );
        if (already) return;
        // 同时推两条：宿主 HTML 注入器与桌面壳的内联解释器各自取用得上的那条。
        table.push(injectRow);
        table.push(injectScript);
      } catch (err) {
        try {
          console.warn('[aemeath:plugin] index-inject 行注册失败', err);
        } catch {
          /* ignore */
        }
      }
    });
  } catch (err) {
    console.warn('[aemeath:plugin] 无法订阅 webserver/index-inject（该事件在当前 DSH 版本可能不存在）', err);
  }

  // ──────────────────────────────────────────────────────────────────────
  // ② 依赖 webServer 的部分延迟等待服务就绪
  // ──────────────────────────────────────────────────────────────────────
  root.inject(['webServer'], (ctx) => {
    const disposers = [];

    // tapIndex：DSH Web 形态的原始 HTML 变换通道
    try {
      disposers.push(
        ctx.webServer.tapIndex((html) => {
          try {
            if (typeof html !== 'string') return html;
            if (html.includes(LAUNCHER_ELEMENT_ID)) return html;
            const tag = `<script defer>${buildInjectText(prefix)}</script>`;
            if (html.includes('</body>')) return html.replace('</body>', `${tag}</body>`);
            return html + tag;
          } catch (err) {
            console.warn('[aemeath:plugin] tapIndex 变换失败，已放行原始 HTML', err);
            return html;
          }
        }),
      );
    } catch (err) {
      console.warn('[aemeath:plugin] tapIndex 注册失败（当前 DSH 版本可能不支持）', err);
    }

    // 静态托管：没有 webRoot 时注册一个明确的降级页，而不是静默 404
    const handler = webRoot
      ? createStaticHandler({ webRoot, prefix, trustedHosts })
      : (req, res) => {
          const deny = trustRejection(req, { trustedHosts });
          if (deny !== null) {
            res.writeHead(deny, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('forbidden');
            return;
          }
          res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
          res.end(buildUnavailablePage(null, prefix));
        };

    try {
      disposers.push(ctx.webServer.register({ kind: 'prefix', path: prefix, handler }));
    } catch (err) {
      console.warn(
        `[aemeath:plugin] 路由 ${prefix} 注册失败（可能已被其他插件占用，或 DSH 版本不兼容）`,
        err,
      );
    }

    // 路由存活自检：一条只在插件侧使用的只读探针，便于排查「按钮在但 404」
    try {
      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path: `${prefix}/__aemeath_health`,
          handler: (req, res) => {
            const body = JSON.stringify({
              ok: Boolean(webRoot),
              plugin: name,
              prefix,
              webRoot: webRoot ?? null,
              node: process.version,
            });
            res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-cache',
              'Content-Length': String(Buffer.byteLength(body)),
            });
            res.end(body);
          },
        }),
      );
    } catch (err) {
      console.warn('[aemeath:plugin] 健康检查路由注册失败', err);
    }

    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch (err) {
          console.warn('[aemeath:plugin] 释放路由失败', err);
        }
      }
    });

    if (webRoot) {
      console.info(`[aemeath:plugin] 已挂载静态托管：${prefix}/ → ${path.resolve(webRoot)}`);
    } else {
      console.warn(
        `[aemeath:plugin] 未找到 web/ 静态目录（AEMEATH_WEB_ROOT=${webRootCandidate ?? '未设置'}）。` +
          `已注册 ${prefix}/ 并在其上返回降级说明页；这不是集成成功，请按该页提示配置后重启 DSH。`,
      );
    }
  });
}

export default { name, apply };

/** 供测试与排查使用 */
export const internals = {
  resolveWebRoot,
  createStaticHandler,
  buildInjectText,
  buildInjectRow,
  buildUnavailablePage,
  trustRejection,
};
