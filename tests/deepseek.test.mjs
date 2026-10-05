/**
 * tests/deepseek.test.mjs —— DeepSeek 客户端测试（docs/CONTRACT.md §5）
 *
 * 被测对象：web/js/chat/deepseek.js（B 交付，只读）。
 *
 * 关键约束（本文件不违反）：
 *  - **不发任何真实网络请求**：所有请求都走注入的 `fetchImpl` mock。
 *  - 断言的是「请求体构造 / SSE 解析 / 错误分类」这些纯逻辑，而不是上游服务质量。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import DeepSeekClient, {
  DeepSeekError,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_TEMPERATURE,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  normalizeBaseUrl,
  friendlyHttpMessage,
  safeJsonParse,
  isAbortError,
} from '../web/js/chat/deepseek.js';
import { DEFAULT_PRESET } from '../web/js/persona/index.js';

const encoder = new TextEncoder();

function sseResponse(chunks, { status = 200 } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

function jsonResponse(obj, { status = 200 } = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 记录调用参数的 fetch mock */
function recordingFetch(responder) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return responder(url, init, calls.length);
  };
  impl.calls = calls;
  return impl;
}

test('常量与默认真实值来自契约 §5（值本身被断言，不是只断言"存在"）', () => {
  assert.equal(DEFAULT_BASE_URL, 'https://api.deepseek.com');
  assert.equal(DEFAULT_MODEL, 'deepseek-chat');
  assert.equal(typeof DEFAULT_TEMPERATURE, 'number');
  assert.equal(typeof DEFAULT_MAX_TOKENS, 'number');
  assert.equal(typeof DEFAULT_TIMEOUT_MS, 'number');
  assert.ok(DEFAULT_MAX_TOKENS > 0 && DEFAULT_MAX_TOKENS <= 8192, `maxTokens 应在合理区间，实际 ${DEFAULT_MAX_TOKENS}`);
  assert.ok(DEFAULT_TIMEOUT_MS >= 1000, `超时不应短于 1s，实际 ${DEFAULT_TIMEOUT_MS}`);
  assert.equal(DEFAULT_PRESET, 'lively-companion', '契约 §5 规定默认人设 id');
});

test('undefined 配置下构造函数不抛错，且 endpoint/headers 形态正确', () => {
  const c = new DeepSeekClient();
  assert.equal(c.baseUrl, DEFAULT_BASE_URL);
  assert.equal(c.model, DEFAULT_MODEL);
  assert.equal(c.temperature, DEFAULT_TEMPERATURE);
  assert.equal(c.maxTokens, DEFAULT_MAX_TOKENS);
  assert.equal(c.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(c.endpoint, `${DEFAULT_BASE_URL}/chat/completions`);
  assert.equal(c.hasApiKey(), false, '未配置 Key 时 hasApiKey 必须为 false');
  const h = c.buildHeaders();
  assert.equal(h['Content-Type'], 'application/json');
  assert.equal(h.Authorization, 'Bearer ');
  assert.equal(c.apiKey, '', 'apiKey 默认必须是空串（不得硬编码 sk- 形式密钥）');
});

test('normalizeBaseUrl()：去尾斜杠 / 剥离重复的 /chat/completions / 空值回落默认', () => {
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com');
  assert.equal(normalizeBaseUrl('https://api.deepseek.com////'), 'https://api.deepseek.com');
  assert.equal(
    normalizeBaseUrl('https://api.deepseek.com/chat/completions'),
    'https://api.deepseek.com',
    '用户误填完整 endpoint 时不得拼出 /chat/completions/chat/completions',
  );
  assert.equal(normalizeBaseUrl('  '), DEFAULT_BASE_URL);
  assert.equal(normalizeBaseUrl(undefined), DEFAULT_BASE_URL);
  assert.equal(normalizeBaseUrl(null), DEFAULT_BASE_URL);
  assert.equal(
    new DeepSeekClient({ baseUrl: 'http://127.0.0.1:8080/chat/completions/' }).endpoint,
    'http://127.0.0.1:8080/chat/completions',
  );
});

test('buildRequestBody()：OpenAI 兼容字段齐全，defaults 生效，response_format 仅在给出时出现', () => {
  const c = new DeepSeekClient({ apiKey: 'sk-test', model: 'deepseek-reasoner', temperature: 0.5, maxTokens: 256 });
  const body = c.buildRequestBody([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]);

  // 深度断言：键集合完全确定，不多不漏
  assert.deepEqual(
    Object.keys(body).sort(),
    ['max_tokens', 'messages', 'model', 'stream', 'temperature'],
    `不期望的请求体键：${JSON.stringify(Object.keys(body))}`,
  );
  assert.equal(body.model, 'deepseek-reasoner');
  assert.equal(body.stream, true, '默认应走流式');
  assert.equal(body.temperature, 0.5);
  assert.equal(body.max_tokens, 256);
  assert.deepEqual(body.messages, [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]);

  // 逐项覆盖：stream / model / temperature / maxTokens / responseFormat
  const off = c.buildRequestBody([{ role: 'user', content: 'x' }], {
    stream: false,
    model: 'deepseek-chat',
    temperature: 1.25,
    maxTokens: 64,
    responseFormat: { type: 'json_object' },
  });
  assert.equal(off.stream, false);
  assert.equal(off.model, 'deepseek-chat');
  assert.equal(off.temperature, 1.25);
  assert.equal(off.max_tokens, 64);
  assert.deepEqual(off.response_format, { type: 'json_object' });

  // 脏入参：不得把 NaN / 非字符串写进请求体
  const dirty = c.buildRequestBody([
    { role: 'user', content: 42 },
    { content: 'no-role' },
    null,
    undefined,
  ], { temperature: NaN, maxTokens: 'abc' });
  assert.equal(dirty.temperature, 0.5, 'NaN 温度应回落实例值');
  assert.equal(dirty.max_tokens, 256, '非数字 maxTokens 应回落实例值');
  assert.equal(dirty.messages.length, 4, '消息数组长度应保持');
  assert.equal(dirty.messages[0].content, '42', '非字符串 content 应被转成字符串而不是原样塞进去');
  assert.equal(dirty.messages[1].role, 'user', '缺 role 时应回落 user');
  assert.equal(dirty.messages[2].role, 'user', 'null 元素不应抛异常');
  assert.equal(dirty.messages[2].content, '', 'null 元素 content 应为空串');
});

test('未配置 API Key 时 stream()/complete() 直接抛 no-api-key，绝不发请求', async () => {
  let called = 0;
  const impl = async () => {
    called += 1;
    return jsonResponse({});
  };
  const c = new DeepSeekClient({ apiKey: '', fetchImpl: impl });
  await assert.rejects(() => c.stream([{ role: 'user', content: 'hi' }]), (err) => {
    assert.ok(err instanceof DeepSeekError, '应为 DeepSeekError');
    assert.equal(err.code, 'no-api-key');
    assert.match(err.message, /API Key/i);
    return true;
  });
  await assert.rejects(() => c.complete([{ role: 'user', content: 'hi' }]), (err) => err.code === 'no-api-key');
  assert.equal(called, 0, '缺 Key 时一个请求都不该发出去');
});

test('stream()：请求形态 + SSE 增量拼接 + usage/finishReason 采集', async () => {
  const impl = recordingFetch(() =>
    sseResponse([
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    ]),
  );
  const c = new DeepSeekClient({ apiKey: 'sk-test', fetchImpl: impl, model: 'deepseek-chat', temperature: 1, maxTokens: 128 });

  const deltas = [];
  const res = await c.stream([{ role: 'user', content: 'hi' }], { onDelta: (d, full) => deltas.push([d, full]) });

  assert.equal(impl.calls.length, 1, '每次 stream 只应发一个请求');
  const call = impl.calls[0];
  assert.equal(call.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer sk-test');
  assert.equal(call.body.model, 'deepseek-chat');
  assert.equal(call.body.temperature, 1);
  assert.equal(call.body.max_tokens, 128);
  assert.equal(call.body.stream, true);
  assert.ok(call.init.signal, '必须把内部 signal 传给 fetch（否则超时/中断失效）');

  assert.deepEqual(deltas, [['你', '你'], ['好', '你好']], 'onDelta 应给出 (增量, 累计)');
  assert.equal(res.text, '你好');
  assert.equal(res.aborted, false);
  assert.equal(res.finishReason, 'stop');
  assert.deepEqual(res.usage, { prompt_tokens: 3, completion_tokens: 2 });
});

test('stream()：reasoning_content 与正文分离累加，互不污染', async () => {
  const impl = recordingFetch(() =>
    sseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"想一下"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"答案"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning":"再想"}}]}\n\n',
      'data: [DONE]\n\n',
    ]),
  );
  const c = new DeepSeekClient({ apiKey: 'sk-test', fetchImpl: impl });
  const thinks = [];
  const res = await c.stream([{ role: 'user', content: 'q' }], { onReasoning: (d, full) => thinks.push([d, full]) });

  assert.equal(res.text, '答案', '正文不得包含思考内容');
  assert.equal(res.reasoningContent, '想一下再想', 'reasoning_content 与 reasoning 两种字段都要收');
  assert.deepEqual(thinks, [['想一下', '想一下'], ['再想', '想一下再想']]);
});

test('stream()：非 JSON 心跳块被忽略而不是打断整条流；分片跨 chunk 仍能拼回事件', async () => {
  const impl = recordingFetch(() =>
    sseResponse([
      ': keep-alive\n\n',
      'data: not-json-at-all\n\n',
      // 注意：jsonPayload 必须与单块发送时逐字节相同，否则测的就不是「拆包」而是另一个 JSON
      'data: {"choices":[{"delta":{"content":"A',
      'B"}}]}\n\n',
      'data: [DONE]\n\n',
    ]),
  );
  const c = new DeepSeekClient({ apiKey: 'sk-test', fetchImpl: impl });
  const res = await c.stream([{ role: 'user', content: 'q' }]);
  assert.equal(res.text, 'AB', '被切成两半的 JSON 必须能拼回并解析（说明 \'A\'+\'B\' 在同一 content 里）');
  assert.equal(res.aborted, false);
  assert.equal(res.finishReason, '', '没有 finish_reason 的流不应伪造一个');
});

test('stream()：HTTP 401 抛可展示的 DeepSeekError，且消息里不得回显 API Key', async () => {
  const impl = recordingFetch(() =>
    jsonResponse({ error: { message: 'Authentication Fails', type: 'authentication_error' } }, { status: 401 }),
  );
  const c = new DeepSeekClient({ apiKey: 'sk-super-secret-value', fetchImpl: impl });
  await assert.rejects(() => c.stream([{ role: 'user', content: 'hi' }]), (err) => {
    assert.ok(err instanceof DeepSeekError);
    assert.equal(err.code, 'http-error');
    assert.equal(err.status, 401);
    assert.equal(err.type, 'authentication_error');
    assert.match(err.message, /401/);
    assert.match(err.message, /API Key/i);
    assert.ok(!err.message.includes('sk-super-secret-value'), '错误消息绝不能带出 Key 明文');
    assert.ok(!String(err.detail).includes('sk-super-secret-value'), 'detail 也不能带出 Key');
    return true;
  });
});

test('stream()：流中途 error 事件 → code=stream-error；用户 abort → aborted=true 且保留已吐出的字', async () => {
  const midStreamErr = recordingFetch(() =>
    sseResponse([
      'data: {"choices":[{"delta":{"content":"半"}}]}\n\n',
      'data: {"error":{"message":"boom","type":"server_error","status":500}}\n\n',
    ]),
  );
  const c1 = new DeepSeekClient({ apiKey: 'sk-test', fetchImpl: midStreamErr });
  await assert.rejects(() => c1.stream([{ role: 'user', content: 'hi' }]), (err) => {
    assert.ok(err instanceof DeepSeekError);
    assert.equal(err.code, 'stream-error');
    assert.equal(err.status, 500, 'error 事件里的 status 必须被带出来');
    assert.equal(err.type, 'server_error', 'error 事件里的 type 必须被带出来');
    // 设计取舍（已核实，非缺陷）：面向用户的 message 走 friendlyHttpMessage 生成中文，
    // 上游原文不直接回显，而是放在 detail 里（chat/index.js:41-48 只展示 err.message）。
    assert.match(err.message, /500/, '用户可见文案必须带状态码');
    assert.equal(err.detail, 'boom', '上游原报文必须保留在 detail 里，不能被丢弃');
    return true;
  });

  const ac = new AbortController();
  const impl = recordingFetch(async () => {
    ac.abort();
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  });
  const c2 = new DeepSeekClient({ apiKey: 'sk-test', fetchImpl: impl });
  const deltas = [];
  const res = await c2.stream([{ role: 'user', content: 'hi' }], { signal: ac.signal, onDelta: (d) => deltas.push(d) });
  assert.equal(res.aborted, true, '用户中断不应被当成失败抛出');
  assert.equal(res.text, '');
  assert.deepEqual(deltas, []);
});

test('complete()：非流式 JSON 解析出 text/usage/finishReason；stream:false 进请求体', async () => {
  const impl = recordingFetch(() =>
    jsonResponse({
      choices: [{ message: { content: '完整回答' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 9, completion_tokens: 4 },
    }),
  );
  const c = new DeepSeekClient({ apiKey: 'sk-test', fetchImpl: impl });
  const res = await c.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(impl.calls[0].body.stream, false, 'complete() 必须发 stream:false');
  assert.equal(res.text, '完整回答');
  assert.equal(res.aborted, false);
  assert.equal(res.finishReason, 'stop');
  assert.deepEqual(res.usage, { prompt_tokens: 9, completion_tokens: 4 });
});

test('纯函数兜底：safeJsonParse / isAbortError / friendlyHttpMessage', () => {
  assert.deepEqual(safeJsonParse('{"a":1}'), { a: 1 });
  assert.equal(safeJsonParse('not json'), null);
  assert.equal(safeJsonParse(''), null);
  assert.equal(safeJsonParse('   '), null);
  assert.equal(safeJsonParse(': heartbeat'), null);
  assert.equal(safeJsonParse(undefined), null);

  assert.equal(isAbortError(null), false);
  assert.equal(isAbortError(new Error('x')), false);
  const abortErr = new Error('x');
  abortErr.name = 'AbortError';
  assert.equal(isAbortError(abortErr), true);
  assert.equal(isAbortError({ code: 'ABORT_ERR' }), true);

  assert.match(friendlyHttpMessage(401), /API Key/i);
  assert.match(friendlyHttpMessage(429), /429/);
  assert.match(friendlyHttpMessage(503), /503/);
  assert.match(friendlyHttpMessage(400, 'bad field'), /bad field/, '应该把服务端消息带给用户');
  assert.equal(typeof friendlyHttpMessage(0), 'string');
});

test('DeepSeekClient 同时提供具名导出与默认导出（app.js 用默认导出）', async () => {
  const mod = await import('../web/js/chat/deepseek.js');
  assert.equal(mod.default, DeepSeekClient, '默认导出应与具名导出是同一个类');
  assert.equal(typeof DeepSeekClient, 'function', '默认导出应是类本身');
  const c = new DeepSeekClient();
  for (const m of ['stream', 'complete', 'buildRequestBody', 'buildHeaders', 'hasApiKey']) {
    assert.equal(typeof c[m], 'function', `契约 §5 要求方法 ${m}()`);
  }
});
