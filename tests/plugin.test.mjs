#!/usr/bin/env node
/**
 * tests/plugin.test.mjs —— DSH 插件（plugin/**）的契约与安全边界
 *
 * 两块被测对象：
 *   1. plugin/static-server.mjs —— 零依赖静态托管处理器（与 DSH WebRoute.handler 同签名）
 *   2. plugin/index.js         —— Cordis 插件入口 `{ name, apply(root) }`
 *
 * 手法：不依赖任何 npm 包，也不用真起 HTTP 服务——
 *   - 静态托管用「假 req / 记录型 res」直接调用 handler；
 *   - 插件入口用「假 root/ctx」记录 root.on / root.inject / webServer.register / tapIndex
 *     被调用的实参，再回头断言「注册了什么、释放了什么」。
 * 这样测试是同步、确定、可离线跑的，CI 里没有端口冲突风险。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import {
  createStaticHandler,
  resolveWebRoot,
  safeRelativePath,
  resolveInside,
  readStaticFile,
  mimeFor,
  escapeHtml,
  trustRejection,
  MIME_TYPES,
} from '../plugin/static-server.mjs';
import aemeathPlugin, {
  name as pluginName,
  apply,
  DEFAULT_PREFIX,
  LAUNCHER_ELEMENT_ID,
  buildInjectText,
  buildInjectRow,
  buildInjectRowScript,
  buildUnavailablePage,
  internals,
} from '../plugin/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_WEB = path.join(ROOT, 'web');

/** 假 req：只带 handler 真正会读的字段 */
function makeReq({ url = '/aemeath/', method = 'GET', headers = { host: '127.0.0.1:19387' } } = {}) {
  return { url, method, headers };
}

/** 记录型 res：Node http.ServerResponse 的最小子集 */
function makeRes() {
  return {
    statusCode: null,
    headers: null,
    chunks: [],
    ended: false,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers ?? {};
      return this;
    },
    end(body) {
      if (body !== undefined && body !== null) this.chunks.push(body);
      this.ended = true;
      return this;
    },
    get text() {
      return this.chunks
        .map((c) => (Buffer.isBuffer(c) ? c.toString('utf8') : String(c)))
        .join('');
    },
  };
}

/** 假 Cordis root/ctx：记录一切注册行为，并暴露 disposer 供释放测试 */
function makeFakeRoot() {
  const record = {
    events: new Map(),
    injections: [],
    injectedDeps: [],
    routes: [],
    taps: [],
    effects: [],
    disposers: [],
  };
  const root = {
    on(type, fn) {
      if (!record.events.has(type)) record.events.set(type, []);
      record.events.get(type).push(fn);
    },
    inject(deps, cb) {
      record.injectedDeps.push(deps);
      record.injections.push(cb);
    },
  };
  root.__record = record;
  root.__runInject = () => {
    for (const cb of record.injections) {
      const disposers = [];
      const ctx = {
        effect(fn) {
          record.effects.push(fn);
          const d = fn();
          if (typeof d === 'function') disposers.push(d);
          return d;
        },
        webServer: {
          register(route) {
            record.routes.push(route);
            return () => {
              record.disposers.push(`route:${route.kind}:${route.path}`);
            };
          },
          tapIndex(fn) {
            record.taps.push(fn);
            return () => {
              record.disposers.push('tapIndex');
            };
          },
        },
      };
      cb(ctx);
      record.innerDisposers = disposers;
    }
  };
  root.__emitInjectTable = () => {
    const table = [];
    for (const fn of record.events.get('webserver/index-inject') ?? []) fn(table);
    return table;
  };
  return root;
}

/* ================================================================== */
/* A. static-server：路径与 MIME                                        */
/* ================================================================== */

test('safeRelativePath：前缀剥除、query/hash 丢弃、目录请求回落 index.html', () => {
  assert.equal(safeRelativePath('/aemeath/'), 'index.html');
  assert.equal(safeRelativePath('/aemeath'), 'index.html');
  assert.equal(safeRelativePath('/aemeath/js/app.js'), 'js/app.js');
  assert.equal(safeRelativePath('/aemeath/js/app.js?v=2#top'), 'js/app.js');
  assert.equal(safeRelativePath('/aemeath/css'), 'css/index.html', '无扩展名的末段按目录处理');
  assert.equal(safeRelativePath('/aemeath/js/'), 'js/index.html', '尾斜杠按目录处理');
  // 不在挂载点下的请求不接管（否则会抢别的插件的路由）
  for (const u of ['/', '/index.html', '/aemeathx/js/app.js', '/other/aemeath/js']) {
    assert.equal(safeRelativePath(u), null, `${u} 不在挂载点下，应返回 null`);
  }
  assert.equal(safeRelativePath('/aemeath', { prefix: '/pet' }), null);
  assert.equal(safeRelativePath('/pet/js/a.js', { prefix: '/pet' }), 'js/a.js');
});

test('safeRelativePath：目录穿越、空字节、非法编码、盘符一律拒绝（路径安全的红线）', () => {
  for (const bad of [
    '/aemeath/../secret.txt',
    '/aemeath/js/../../secret.txt',
    '/aemeath/%2e%2e/secret.txt',
    '/aemeath/%2e%2e%2fsecret.txt',
    '/aemeath/..%5csecret.txt',
    '/aemeath/js/%2e%2e/%2e%2e/etc/passwd',
    '/aemeath/%00index.html',
    '/aemeath/js/%',
    '/aemeath/C:/Windows/win.ini',
    '/aemeath/\\server\\share\\a.js',
    '//evil.example.com/share/a.js',
    '/aemeath//evil.example.com/a.js',
  ]) {
    assert.equal(safeRelativePath(bad), null, `${bad} 必须被拒（返回 null）`);
  }
  // 正常的点段应被规范化掉而不是被拒
  assert.equal(safeRelativePath('/aemeath/./js/./app.js'), 'js/app.js');
});

test('resolveInside：解析结果必须仍在 webRoot 内，越界返回 null', () => {
  const root = path.join(ROOT, 'web');
  assert.ok(resolveInside(root, 'index.html'));
  assert.equal(resolveInside(root, '../package.json'), null);
  assert.equal(resolveInside(root, 'js/../../package.json'), null);
  assert.equal(resolveInside(root, ''), null);
  assert.equal(resolveInside('', 'index.html'), null);
});

test('mimeFor 覆盖 web/ 里实际会用到的类型，且未知扩展名有安全兜底', () => {
  assert.equal(mimeFor('a.html'), 'text/html; charset=utf-8');
  assert.equal(mimeFor('a.js'), 'text/javascript; charset=utf-8');
  assert.equal(mimeFor('a.mjs'), 'text/javascript; charset=utf-8');
  assert.equal(mimeFor('a.css'), 'text/css; charset=utf-8');
  assert.equal(mimeFor('a.json'), 'application/json; charset=utf-8');
  assert.equal(mimeFor('a.svg'), 'image/svg+xml');
  assert.equal(mimeFor('a.png'), 'image/png');
  assert.equal(mimeFor('a.woff2'), 'font/woff2');
  assert.equal(mimeFor('a.unknownext'), 'application/octet-stream');
  assert.equal(mimeFor('a.A.PNG'), 'image/png', '扩展名判定应大小写不敏感');
  assert.ok(Object.keys(MIME_TYPES).length >= 20, `MIME 表应成规模，实际 ${Object.keys(MIME_TYPES).length} 项`);
});

test('escapeHtml：五种字符全部转义（注入到 Host 页面里的字符串必须安全）', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  assert.equal(escapeHtml('"x" \'y\''), '&quot;x&quot; &#39;y&#39;');
  assert.equal(escapeHtml('&lt;'), '&amp;lt;', '不得二次解码');
});

/* ================================================================== */
/* B. static-server：信任栅栏                                            */
/* ================================================================== */

test('trustRejection：回环 Host 放行；非回环、跨站、异源 Origin 一律 403（fail-closed）', () => {
  const ok = { host: '127.0.0.1:19387' };
  assert.equal(trustRejection({ headers: ok }), null);
  assert.equal(trustRejection({ headers: { host: 'localhost:1' } }), null);
  assert.equal(trustRejection({ headers: { host: '[::1]:1' } }), null);
  assert.equal(trustRejection({ headers: { host: '127.0.0.1:1', 'sec-fetch-site': 'same-origin' } }), null);
  assert.equal(
    trustRejection({ headers: { host: '127.0.0.1:1', origin: 'http://127.0.0.1:1' } }),
    null,
    '同源 Origin 应放行',
  );

  assert.equal(trustRejection({ headers: { host: 'evil.example.com' } }), 403, '非回环 Host 默认拒绝（防 DNS 重绑定）');
  assert.equal(trustRejection({ headers: { host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' } }), 403);
  assert.equal(
    trustRejection({ headers: { host: '127.0.0.1:1', origin: 'http://evil.example.com' } }),
    403,
    '异源 Origin 必须拒绝',
  );
  assert.equal(trustRejection({ headers: { host: '127.0.0.1:1', origin: 'not a url' } }), 403);
  assert.equal(trustRejection({}), 403, '没有 Host 头应拒绝');
  assert.equal(trustRejection(null), 403, '校验器自身出错必须 fail-closed');
  assert.equal(trustRejection(undefined), 403);

  // 显式声明信任的 Host 才放行（部署在反代/局域网时的逃生口）
  assert.equal(trustRejection({ headers: { host: 'pet.lan:8080' } }), 403);
  assert.equal(trustRejection({ headers: { host: 'pet.lan:8080' } }, { trustedHosts: ['pet.lan:8080'] }), null);
  assert.equal(trustRejection({ headers: { host: 'pet.lan:8080' } }, { trustedHosts: ['pet.lan'] }), null);
  assert.equal(trustRejection({ headers: { host: 'pet.lan:8080' } }, { trustedHosts: ['other.lan'] }), 403);
});

/* ================================================================== */
/* C. static-server：真起 handler 跑一遍仓库的 web/                      */
/* ================================================================== */

test('createStaticHandler：托管仓库 web/ 的 index.html 与 css/pet.css，HEAD 无 body', async () => {
  const webRoot = existsSync(path.join(REPO_WEB, 'index.html')) ? REPO_WEB : path.join(ROOT, 'web');
  assert.ok(existsSync(path.join(webRoot, 'index.html')), 'web/index.html 必须存在（否则后面断言没意义）');
  const handler = createStaticHandler({ webRoot, prefix: '/aemeath' });

  const res = makeRes();
  await handler(makeReq({ url: '/aemeath/' }), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /text\/html/);
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff', '必须带 nosniff（防 MIME 嗅探）');
  assert.match(res.text, /<html/i);
  assert.ok(Number(res.headers['Content-Length']) > 0);

  // 真实存在的 CSS
  const cssPath = path.join(webRoot, 'css', 'pet.css');
  if (existsSync(cssPath)) {
    const cssRes = makeRes();
    await handler(makeReq({ url: '/aemeath/css/pet.css' }), cssRes);
    assert.equal(cssRes.statusCode, 200);
    assert.match(cssRes.headers['Content-Type'], /text\/css/);
  }

  // HEAD：有 Content-Length，但没有 body
  const headRes = makeRes();
  await handler(makeReq({ url: '/aemeath/', method: 'HEAD' }), headRes);
  assert.equal(headRes.statusCode, 200);
  assert.ok(Number(headRes.headers['Content-Length']) > 0);
  assert.equal(headRes.text, '', 'HEAD 响应不得有 body');
});

test('createStaticHandler：404 / 405 / 403 / 越界路径的状态码与语义正确', async () => {
  const handler = createStaticHandler({ webRoot: REPO_WEB, prefix: '/aemeath', logger: { warn: () => {} } });

  const notFound = makeRes();
  await handler(makeReq({ url: '/aemeath/definitely-not-here.js' }), notFound);
  assert.equal(notFound.statusCode, 404);
  assert.match(notFound.text, /404/, '404 页面应给出可诊断信息，而不是空响应');

  const method = makeRes();
  await handler(makeReq({ url: '/aemeath/', method: 'POST' }), method);
  assert.equal(method.statusCode, 405);
  assert.equal(method.headers.Allow, 'GET, HEAD');

  const outside = makeRes();
  await handler(makeReq({ url: '/other/' }), outside);
  assert.equal(outside.statusCode, 404, '不在挂载点下的请求应 404（不接管）');

  const traversal = makeRes();
  await handler(makeReq({ url: '/aemeath/../package.json' }), traversal);
  assert.equal(traversal.statusCode, 404, '目录穿越必须被挡（不得读到 web/ 之外的文件）');
  assert.ok(!traversal.text.includes('"name"'), '穿越响应里绝不能出现目录外文件的内容');

  const crossSite = makeRes();
  await handler(makeReq({ url: '/aemeath/', headers: { host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' } }), crossSite);
  assert.equal(crossSite.statusCode, 403);
  assert.equal(crossSite.text, 'forbidden');

  const badHost = makeRes();
  await handler(makeReq({ url: '/aemeath/', headers: { host: 'evil.example.com' } }), badHost);
  assert.equal(badHost.statusCode, 403);
});

test('readStaticFile：返回结构可判定，缺失与越界分别给 404 / 403', async () => {
  const ok = await readStaticFile(REPO_WEB, 'index.html');
  assert.equal(ok.ok, true);
  assert.ok(ok.bytes.length > 0);
  assert.equal(ok.mime, 'text/html; charset=utf-8');

  const missing = await readStaticFile(REPO_WEB, 'nope/nope.js');
  assert.deepEqual({ ok: missing.ok, code: missing.code }, { ok: false, code: 404 });

  const escape = await readStaticFile(REPO_WEB, '../package.json');
  assert.deepEqual({ ok: escape.ok, code: escape.code }, { ok: false, code: 403 });

  const dir = await readStaticFile(REPO_WEB, 'js');
  assert.equal(dir.ok, false, '目录不能被当作文件读出');
});

test('resolveWebRoot：显式候选优先，坏候选/空值都回落到默认 web/', () => {
  assert.equal(resolveWebRoot(REPO_WEB), path.resolve(REPO_WEB));

  // 显式候选不存在 / 传空 —— **都不是**返回 null，而是继续回落到默认 web/：
  // 候选写错不应该让整个插件退化成 503 降级页。
  for (const candidate of [path.join(REPO_WEB, 'definitely-not-a-dir'), '', undefined]) {
    const got = resolveWebRoot(candidate);
    assert.equal(got, path.resolve(REPO_WEB), `候选 ${JSON.stringify(candidate)} 应回落到 web/`);
    assert.ok(existsSync(path.join(got, 'index.html')), '回落到的 web/ 必须含 index.html');
  }

  // 不给候选：从 plugin/ 往上一级找 web/
  const auto = resolveWebRoot(undefined, { moduleDir: path.join(ROOT, 'plugin') });
  assert.ok(auto, '未给候选时应能从 plugin/ 的上一级找到 web/');
  assert.ok(existsSync(path.join(auto, 'index.html')));
});

/* ================================================================== */
/* D. plugin/index.js：注入、路由、释放                                  */
/* ================================================================== */

test('插件导出契约：name / apply / 默认导出 / 注入文本与行形状', () => {
  assert.equal(pluginName, 'aemeath-desktop-pet');
  assert.equal(typeof apply, 'function');
  assert.equal(aemeathPlugin.name, pluginName);
  assert.equal(aemeathPlugin.apply, apply, '默认导出的 apply 必须与具名导出同一个函数');
  assert.equal(DEFAULT_PREFIX, '/aemeath');
  assert.equal(internals.createStaticHandler, createStaticHandler);

  const text = buildInjectText('/aemeath');
  assert.match(text, new RegExp(LAUNCHER_ELEMENT_ID), '注入脚本必须带幂等用的元素 id');
  assert.match(text, /createElement/, '注入脚本自建 DOM 节点，不依赖宿主');
  assert.match(text, /catch/, '注入脚本必须吞掉异常（否则会拖垮页面启动）');
  assert.match(text, /\/aemeath\//, '注入的入口链接应指向挂载点');
  assert.equal(buildInjectText('/pet').includes('/pet/'), true, '前缀可配置');

  const row = buildInjectRow('/aemeath');
  assert.equal(row.kind, 'html');
  assert.equal(row.placement, 'body');
  assert.match(row.html, new RegExp(LAUNCHER_ELEMENT_ID));
  assert.match(row.html, /target="_blank"/, '用 <a target=_blank> 而不是 window.open（避开弹窗拦截）');

  const rowScript = buildInjectRowScript('/aemeath');
  assert.equal(rowScript.kind, 'script');
  assert.equal(rowScript.placement, 'body');
  assert.equal(rowScript.text, buildInjectText('/aemeath'));

  const page = buildUnavailablePage(null, '/aemeath');
  assert.match(page, /<!doctype html>/i);
  assert.match(page, /AEMEATH_WEB_ROOT/, '降级页必须告诉用户怎么修');
  assert.match(buildUnavailablePage('/x/<y>', '/aemeath'), /&lt;y&gt;/, '降级页里的路径必须转义');
});

test('apply() 第一件事就注册 webserver/index-inject，且重复 emit 不叠加行', () => {
  const root = makeFakeRoot();
  apply(root);
  const record = root.__record;

  assert.ok(record.events.has('webserver/index-inject'), '必须订阅注入事件（桌面壳唯一的注入通道）');
  const table = root.__emitInjectTable();
  assert.equal(table.length, 2, '一次 emit 应推入 html 行 + script 行两条');
  assert.ok(table.some((r) => r.kind === 'html' && r.html.includes(LAUNCHER_ELEMENT_ID)));
  assert.ok(table.some((r) => r.kind === 'script' && r.text.includes(LAUNCHER_ELEMENT_ID)));

  // 幂等：宿主每次 render 都会重新 emit，插件不得越推越多
  const again = root.__emitInjectTable();
  assert.equal(again.length, 2, '第二次 emit 不得重复推入（必须按 id 去重）');

  // 已经有人在表里推过同样的行时，插件也不该重复推
  const pre = [
    { kind: 'html', placement: 'body', html: `<div id="${LAUNCHER_ELEMENT_ID}-row"></div>` },
  ];
  for (const fn of record.events.get('webserver/index-inject')) fn(pre);
  assert.equal(pre.length, 1, '表里已有相同 id 的行时不得重复推入');

  // 宿主传进来一个非数组时不得抛错
  assert.doesNotThrow(() => {
    for (const fn of record.events.get('webserver/index-inject')) fn(undefined);
  });
});

test('apply() 用 root.inject([\'webServer\']) 延迟注册，且注册 prefix 路由 + 健康检查 + tapIndex', () => {
  const root = makeFakeRoot();
  apply(root);
  const record = root.__record;
  assert.deepEqual(record.injectedDeps.at(-1), ['webServer'], '必须延迟等待 webServer 服务就绪');
  assert.equal(record.routes.length, 0, '服务还没就绪时不应注册任何路由');

  root.__runInject();
  const routes = record.routes.map((r) => `${r.kind}:${r.path}`);
  assert.ok(routes.includes('prefix:/aemeath'), `应注册 prefix 路由，实际：${routes.join(', ')}`);
  assert.ok(routes.includes('exact:/aemeath/__aemeath_health'), '应注册只读健康检查路由');
  for (const r of record.routes) {
    assert.equal(typeof r.handler, 'function', `路由 ${r.path} 必须有 handler`);
  }
  assert.equal(record.taps.length, 1, '应注册一条 tapIndex（DSH Web 形态的注入通道）');
  assert.equal(record.effects.length, 1, '应通过 ctx.effect 管理释放逻辑');
});

test('tapIndex 变换：幂等、无 </body> 时追加、拿到非字符串时原样放行', () => {
  const root = makeFakeRoot();
  apply(root);
  root.__runInject();
  const tap = root.__record.taps[0];

  const once = tap('<html><body>hi</body></html>');
  assert.match(once, /hi/);
  assert.match(once, new RegExp(LAUNCHER_ELEMENT_ID));
  assert.ok(once.indexOf('</body>') > once.indexOf(LAUNCHER_ELEMENT_ID), '注入的 script 应落在 </body> 之前');
  assert.equal(tap(once), once, '已经注入过的 HTML 不得二次注入（幂等）');

  const noBody = tap('<html>frag</html>');
  assert.match(noBody, new RegExp(LAUNCHER_ELEMENT_ID));
  assert.match(noBody, /frag/);

  assert.equal(tap(null), null, '拿到 null 应原样返回而不是抛错');
  assert.equal(tap(undefined), undefined);
});

test('prefix 路由真的能托管仓库 web/，健康检查返回可解析 JSON', async () => {
  const root = makeFakeRoot();
  apply(root);
  root.__runInject();
  const record = root.__record;
  const prefixRoute = record.routes.find((r) => r.kind === 'prefix');
  assert.ok(prefixRoute, 'prefix 路由必须存在');

  const res = makeRes();
  await prefixRoute.handler(makeReq({ url: '/aemeath/' }), res);
  // 有 web/ 时应 200；实在没有（例如裁剪过的检出）则必须是明确的 503 降级页而不是静默 404
  assert.ok([200, 503].includes(res.statusCode), `status=${res.statusCode}，只允许 200 或 503`);
  if (res.statusCode === 503) assert.match(res.text, /AEMEATH_WEB_ROOT/, '503 必须是可诊断的降级页');
  else assert.match(res.text, /<html/i);

  const health = record.routes.find((r) => r.kind === 'exact');
  const hres = makeRes();
  await health.handler(makeReq({ url: '/aemeath/__aemeath_health' }), hres);
  assert.equal(hres.statusCode, 200);
  const body = JSON.parse(hres.text);
  assert.equal(body.plugin, 'aemeath-desktop-pet');
  assert.equal(body.prefix, '/aemeath');
  assert.equal(typeof body.ok, 'boolean');
  assert.equal(body.node, process.version);
});

test('ctx.effect 释放：所有路由与 tapIndex 都必须被撤掉（插件禁用/热重载不能留垃圾）', () => {
  const root = makeFakeRoot();
  apply(root);
  root.__runInject();
  const record = root.__record;

  const disposeEffect = record.effects[0];
  assert.equal(typeof disposeEffect, 'function');
  const disposer = disposeEffect();
  assert.equal(typeof disposer, 'function', 'ctx.effect 的回调应返回一个释放函数');
  assert.equal(record.disposers.length, 0, '还没调用释放函数前不应有任何释放动作');

  disposer();
  const kinds = record.disposers.map((d) => String(d));
  assert.ok(kinds.some((k) => k.startsWith('route:prefix:')), `prefix 路由应被释放，实际：${kinds.join(', ')}`);
  assert.ok(kinds.some((k) => k.startsWith('route:exact:')), '健康检查路由应被释放');
  assert.ok(kinds.includes('tapIndex'), 'tapIndex 应被释放');
  assert.equal(new Set(kinds).size, kinds.length, '不得重复释放（重复调用 disposer 会出问题）');
});

test('webServer 不可用/注册抛错时，插件必须降级而不是崩掉整个 DSH', () => {
  // 降级路径本身会打 console.warn，测试里临时静音（断言的是「不抛错」，不是日志内容）
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    // 场景 1：当前 DSH 版本没有 webserver/index-inject 事件
    const noEventRoot = {
      on() {
        throw new Error('no such event');
      },
      inject() {},
    };
    assert.doesNotThrow(() => apply(noEventRoot), '订阅失败必须被吞掉（记录 warn 即可）');

    // 场景 2：路由已被别的插件占用（register 抛错）
    const routeConflictRoot = {
      on() {},
      inject(_deps, cb) {
        cb({
          effect() {},
          webServer: {
            register() {
              throw new Error('duplicate route');
            },
            tapIndex() {
              throw new Error('no tapIndex');
            },
          },
        });
      },
    };
    assert.doesNotThrow(() => apply(routeConflictRoot), '注册冲突不得让插件抛出（否则 DSH 起不来）');

    // 场景 3：webServer 服务永远不就绪 —— inject 回调根本不会被调用，不应当有任何副作用
    const neverReady = makeFakeRoot();
    apply(neverReady);
    assert.equal(neverReady.__record.routes.length, 0);
    assert.equal(neverReady.__record.taps.length, 0);
  } finally {
    console.warn = realWarn;
  }
});

test('AEMEATH_PREFIX 环境变量可改挂载点，非法值回落默认前缀', () => {
  const original = process.env.AEMEATH_PREFIX;
  try {
    process.env.AEMEATH_PREFIX = 'pet';
    const root = makeFakeRoot();
    apply(root);
    root.__runInject();
    const paths = root.__record.routes.map((r) => r.path);
    assert.ok(paths.includes('/pet'), `没加前导斜杠的前缀应被补成 /pet，实际：${paths.join(', ')}`);
    assert.ok(paths.includes('/pet/__aemeath_health'));

    process.env.AEMEATH_PREFIX = '/x/';
    const root2 = makeFakeRoot();
    apply(root2);
    root2.__runInject();
    assert.ok(root2.__record.routes.some((r) => r.path === '/x'), '尾斜杠应被剥掉');

    process.env.AEMEATH_PREFIX = '   ';
    const root3 = makeFakeRoot();
    apply(root3);
    root3.__runInject();
    assert.ok(root3.__record.routes.some((r) => r.path === DEFAULT_PREFIX), '空白前缀应回落到默认值');
  } finally {
    if (original === undefined) delete process.env.AEMEATH_PREFIX;
    else process.env.AEMEATH_PREFIX = original;
  }
});
