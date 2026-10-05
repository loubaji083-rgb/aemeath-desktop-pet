/**
 * tests/serve-cli.test.mjs —— plugin/serve-cli.mjs 的参数解析与真起服务
 *
 * 为什么值得测：
 *   serve-cli.mjs 与 DSH 路由共用同一个 createStaticHandler，是排查「按钮在但 404」
 *   的第一件工具。它最典型的坏法不是逻辑错，而是**参数解析悄悄吃掉值**——
 *   例如 `--port 8791` 里的 8791 被当成位置参数丢掉，服务起在默认端口上，
 *   于是人以为「端口改了但没生效」。所以这里对 parseArgs 做逐项断言。
 *
 * 起真服务的那条用临时端口 + 立即关闭，不依赖外部网络，也不会有端口冲突以外的假设。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, createServer, DEFAULT_HOST, DEFAULT_PORT, DEFAULT_PREFIX } from '../plugin/serve-cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');

test('parseArgs：`--key value` 不吃掉值，`--flag` 不偷下一个选项', () => {
  const a = parseArgs(['--port', '9000', '--web-root', '../web', '--once']);
  assert.equal(a.values.get('port'), '9000', '--port 的值不能被丢掉');
  assert.equal(a.values.get('web-root'), '../web');
  assert.ok(a.flags.has('once'));
  assert.equal(a.flags.has('port'), false, '带值的选项不应同时进 flags');

  const b = parseArgs(['--quiet', '--port', '1']);
  assert.ok(b.flags.has('quiet'), '--quiet 后面紧跟另一个选项时，不能把 --port 当成它的值');
  assert.equal(b.values.get('port'), '1');
});

test('parseArgs：`--key=value` 与无值选项都能解析', () => {
  const a = parseArgs(['--port=9001', '--once', '--prefix=/pet']);
  assert.equal(a.values.get('port'), '9001');
  assert.equal(a.values.get('prefix'), '/pet');
  assert.ok(a.flags.has('once'));
  assert.equal(parseArgs([]).values.size, 0);
  assert.equal(parseArgs([]).flags.size, 0);
});

test('默认值与导出契约', () => {
  assert.equal(DEFAULT_HOST, '127.0.0.1', '默认必须绑回环，不能默认对外暴露');
  assert.equal(DEFAULT_PORT, 8787);
  assert.equal(DEFAULT_PREFIX, '/aemeath');
  assert.equal(typeof createServer, 'function');
});

test('createServer：webRoot 解析不出时也不抛错，而是安静地返回降级服务', () => {
  const realWarn = console.warn;
  const realEnv = process.env.AEMEATH_WEB_ROOT;
  console.warn = () => {};
  try {
    // 候选路径不存在**不会**让 resolveWebRoot 返回 null（它会回落到插件上一级的 web/），
    // 所以这里要断言的不是「一定为 null」，而是「无论解析成功与否都不抛错」——
    // 若 webRoot 解析失败，handler 仍然必须是一个可用的 (req,res) 函数。
    process.env.AEMEATH_WEB_ROOT = path.join(ROOT, 'no-such-dir-anywhere');
    const { server, webRoot, prefix } = createServer({ webRoot: null, prefix: '/aemeath' });
    assert.equal(prefix, '/aemeath');
    assert.ok(webRoot === null || typeof webRoot === 'string', 'webRoot 要么是绝对路径，要么是 null');
    if (webRoot !== null) assert.ok(existsSync(path.join(webRoot, 'index.html')), '解析出来的 web/ 必须真的有 index.html');
    assert.equal(typeof server.close, 'function');
    server.close();
  } finally {
    console.warn = realWarn;
    if (realEnv === undefined) delete process.env.AEMEATH_WEB_ROOT;
    else process.env.AEMEATH_WEB_ROOT = realEnv;
  }
});

test('createServer：真起服务后能托管 index.html，且请求完就干净关闭', async () => {
  const { server, webRoot, prefix } = createServer({ webRoot: WEB, quiet: true });
  assert.equal(webRoot, path.resolve(WEB));
  assert.equal(prefix, DEFAULT_PREFIX);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const port = server.address().port;
    const res = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}${prefix}/`, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
    });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] ?? '', /text\/html/);
    assert.match(res.body, /<html|<!doctype/i, 'index.html 必须是 HTML');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');

    // 越界请求必须是 4xx，而不是把仓库根的文件吐出来
    const bad = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}${prefix}/../package.json`, (r) => {
        r.resume();
        r.on('end', () => resolve(r.statusCode));
      });
      req.on('error', reject);
    });
    assert.ok(bad === 403 || bad === 404, `穿越请求应被拒，实际 ${bad}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
