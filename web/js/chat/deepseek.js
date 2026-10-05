/**
 * DeepSeek（OpenAI 兼容）聊天客户端。
 *
 * 设计约束（见 docs/CONTRACT.md §5）：
 *  - 零依赖，只用 `fetch` + `AbortController`；`fetchImpl` 可注入，方便 `node:test` 用 mock 断言请求体；
 *  - **API Key 一律由调用方传入**（Chat 从 `Settings.getSecret('chat.apiKey')` 取），
 *    本文件不读任何全局配置、不硬编码任何 `sk-` 开头的字符串、也不把 Key 写进日志或错误信息；
 *  - 流式解析交给 `./sse.js`，这里只负责 HTTP、增量拼装与错误归类；
 *  - `reasoning_content`（思考内容）是被**优雅忽略**的：可以透出给 `onReasoning`，但绝不混进正文。
 */

import { SSEParser } from './sse.js';

export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_MODEL = 'deepseek-chat';
export const DEFAULT_TEMPERATURE = 1.3;
export const DEFAULT_MAX_TOKENS = 1024;
export const DEFAULT_TIMEOUT_MS = 60000;

/** 统一错误类型：带 `code` / `status`，方便上层做中文提示与分支。 */
export class DeepSeekError extends Error {
  /**
   * @param {string} message 面向用户的中文信息（不含 Key 等敏感内容）
   * @param {{ code?: string, status?: number, detail?: string, type?: string }} [info]
   */
  constructor(message, { code = 'deepseek-error', status = 0, detail = '', type = '' } = {}) {
    super(message);
    this.name = 'DeepSeekError';
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.type = type;
  }
}

/**
 * 把用户填的 baseUrl 归一化：
 * 允许直接粘贴 `https://api.deepseek.com/chat/completions` 这种完整地址，也能容忍尾部斜杠。
 * @param {string} baseUrl
 * @returns {string}
 */
export function normalizeBaseUrl(baseUrl) {
  let raw = String(baseUrl ?? '').trim();
  if (!raw) return DEFAULT_BASE_URL;
  raw = raw.replace(/\/+$/, '');
  raw = raw.replace(/\/chat\/completions$/i, '');
  return raw || DEFAULT_BASE_URL;
}

/** 把 HTTP 状态码翻成能直接给用户看的中文。 */
export function friendlyHttpMessage(status, apiMessage = '') {
  const extra = apiMessage ? `（服务端说：${apiMessage}）` : '';
  switch (status) {
    case 400:
      return `请求格式有问题（400）${extra}`;
    case 401:
      return 'API Key 无效或未被授权（401）。请到「设置 → 聊天」里检查 DeepSeek API Key 是否填对、是否已过期。';
    case 402:
      return `账户余额不足（402）${extra}`;
    case 403:
      return `这个 Key 没有访问该模型的权限（403）${extra}`;
    case 404:
      return `接口地址不存在（404）${extra}。请检查 chat.baseUrl 是否为 https://api.deepseek.com`;
    case 422:
      return `请求参数不被接受（422）${extra}`;
    case 429:
      return '请求太频繁或额度用完了（429），缓一会儿再试。';
    case 500:
    case 502:
    case 503:
    case 504:
      return `聊天服务暂时不可用（${status}），稍后再试。`;
    default:
      return status ? `请求失败（${status}）${extra}` : `请求失败${extra}`;
  }
}

/** 安全 JSON.parse，失败返回 null（服务端偶尔会插入心跳或非 JSON 块）。 */
export function safeJsonParse(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t || t.startsWith(':')) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** delta.content 可能是字符串，也可能是分片数组（部分兼容层这么发）。 */
function readText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .join('');
  }
  return '';
}

/** 只有 AbortError 才被当作「用户中断/超时」，其他异常都是真错误。 */
export function isAbortError(err) {
  if (!err) return false;
  return err.name === 'AbortError' || err.code === 'ABORT_ERR' || err.code === 20;
}

/**
 * 依次吐出响应体里的 SSE 事件。
 * 兼容三种 `res.body`：
 *  1. 浏览器 `ReadableStream`（getReader）
 *  2. Node `Readable` / 任意 async iterable
 *  3. 都没有（mock 或非流式响应）→ 读整段 `text()`，必要时按单个 JSON 处理
 */
async function* iterateSSE(res, parser) {
  const body = res && res.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const ev of parser.feed(value)) yield ev;
        if (parser.done) return;
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* 已结束或已释放，忽略 */
      }
    }
  } else if (body && typeof body[Symbol.asyncIterator] === 'function') {
    for await (const value of body) {
      for (const ev of parser.feed(value)) yield ev;
      if (parser.done) return;
    }
  } else {
    const raw = typeof res?.text === 'function' ? await res.text() : '';
    const events = [...parser.feed(raw), ...parser.flush()];
    if (events.length === 0 && raw.trim().startsWith('{')) {
      // 上游忽略 stream 参数，直接回了一个完整 JSON
      yield { event: 'message', data: raw.trim(), id: '', retry: null, done: false };
      return;
    }
    for (const ev of events) yield ev;
    return;
  }
  // 正常自然结束：补上没有尾随空行的最后一行
  for (const ev of parser.flush()) yield ev;
}

export class DeepSeekClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.apiKey]      必填（Chat 从 Settings.getSecret 取）
   * @param {string} [opts.baseUrl]
   * @param {string} [opts.model]
   * @param {number} [opts.temperature]
   * @param {number} [opts.maxTokens]
   * @param {number} [opts.timeoutMs]
   * @param {typeof fetch} [opts.fetchImpl] 注入 mock 用
   * @param {Record<string,string>} [opts.extraHeaders]
   */
  constructor({
    apiKey = '',
    baseUrl = DEFAULT_BASE_URL,
    model = DEFAULT_MODEL,
    temperature = DEFAULT_TEMPERATURE,
    maxTokens = DEFAULT_MAX_TOKENS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = null,
    extraHeaders = null,
  } = {}) {
    this.apiKey = String(apiKey ?? '');
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.model = model || DEFAULT_MODEL;
    this.temperature = Number.isFinite(Number(temperature)) ? Number(temperature) : DEFAULT_TEMPERATURE;
    this.maxTokens = Number.isFinite(Number(maxTokens)) ? Number(maxTokens) : DEFAULT_MAX_TOKENS;
    this.timeoutMs = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
    this.fetchImpl = fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
    this.extraHeaders = extraHeaders && typeof extraHeaders === 'object' ? { ...extraHeaders } : {};
  }

  get endpoint() {
    return `${this.baseUrl}/chat/completions`;
  }

  hasApiKey() {
    return this.apiKey.trim().length > 0;
  }

  /** 请求头。Key 只在这里出现，且不会被写进日志。 */
  buildHeaders() {
    return {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream, application/json',
      Authorization: `Bearer ${this.apiKey}`,
      ...this.extraHeaders,
    };
  }

  /**
   * 构造请求体（纯函数式，单测直接断言它）。
   * @param {Array<{role:string,content:string}>} messages
   * @param {{ stream?: boolean, model?: string, temperature?: number, maxTokens?: number, responseFormat?: object }} [opts]
   */
  buildRequestBody(messages, { stream = true, model, temperature, maxTokens, responseFormat } = {}) {
    const list = Array.isArray(messages) ? messages : [];
    const body = {
      model: model || this.model,
      messages: list.map((m) => ({
        role: String(m?.role ?? 'user'),
        content: typeof m?.content === 'string' ? m.content : String(m?.content ?? ''),
      })),
      stream: !!stream,
      temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : this.temperature,
      max_tokens: Number.isFinite(Number(maxTokens)) ? Number(maxTokens) : this.maxTokens,
    };
    if (responseFormat) body.response_format = responseFormat;
    return body;
  }

  _resolveFetch() {
    const impl = this.fetchImpl;
    if (typeof impl !== 'function') {
      throw new DeepSeekError('当前环境没有可用的 fetch，无法发起请求。', { code: 'no-fetch' });
    }
    return impl;
  }

  /**
   * 把外部 signal 与超时合并成一个内部 signal。
   * 外部中断 → 视为 aborted（不是错误）；超时 → 抛 code==='timeout'。
   */
  _linkSignals(externalSignal) {
    const controller = new AbortController();
    let timedOut = false;
    let timer = null;
    const onExternalAbort = () => {
      try {
        controller.abort(externalSignal?.reason);
      } catch {
        controller.abort();
      }
    };
    if (externalSignal) {
      if (externalSignal.aborted) onExternalAbort();
      else externalSignal.addEventListener?.('abort', onExternalAbort, { once: true });
    }
    if (this.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          controller.abort(new DeepSeekError(`请求超时（${this.timeoutMs}ms）`, { code: 'timeout' }));
        } catch {
          controller.abort();
        }
      }, this.timeoutMs);
      // Node 下别让计时器拖住进程退出
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
    return {
      signal: controller.signal,
      didTimeout: () => timedOut,
      cleanup() {
        clearTimeout(timer);
        externalSignal?.removeEventListener?.('abort', onExternalAbort);
      },
    };
  }

  _requireKey() {
    if (!this.hasApiKey()) {
      throw new DeepSeekError(
        '还没有配置 API Key。请到「设置 → 聊天」填入你的 DeepSeek API Key（只保存在本标签页会话中）。',
        { code: 'no-api-key' },
      );
    }
  }

  /** 读错误响应体，尽量拿到服务端的 message。 */
  async _readErrorBody(res) {
    try {
      const raw = typeof res.text === 'function' ? await res.text() : '';
      const parsed = safeJsonParse(raw);
      return {
        message: parsed?.error?.message || parsed?.message || raw.slice(0, 300),
        type: parsed?.error?.type || '',
        raw: raw.slice(0, 1000),
      };
    } catch {
      return { message: '', type: '', raw: '' };
    }
  }

  /**
   * 流式对话。
   * @param {Array<{role:string,content:string}>} messages
   * @param {{ onDelta?: (delta:string, full:string)=>void, onReasoning?: (delta:string, full:string)=>void, signal?: AbortSignal }} [opts]
   * @returns {Promise<{ text:string, usage:object|null, aborted:boolean, finishReason:string, reasoningContent:string }>}
   */
  async stream(messages, { onDelta, onReasoning, signal } = {}) {
    this._requireKey();
    const fetchImpl = this._resolveFetch();
    const link = this._linkSignals(signal);
    const parser = new SSEParser();
    let fullText = '';
    let reasoning = '';
    let usage = null;
    let finishReason = '';
    const emitDelta = typeof onDelta === 'function' ? onDelta : null;
    const emitReasoning = typeof onReasoning === 'function' ? onReasoning : null;

    const handleEvent = (ev) => {
      const payload = safeJsonParse(ev.data);
      if (!payload) {
        // 不是 JSON 就丢掉，不打断整条流
        console.warn('[aemeath:chat] 忽略无法解析的 SSE 数据块:', String(ev.data).slice(0, 120));
        return;
      }
      if (payload.error) {
        const message = payload.error.message || '流式响应中途返回错误';
        throw new DeepSeekError(friendlyHttpMessage(Number(payload.error.status) || 0, message), {
          code: 'stream-error',
          status: Number(payload.error.status) || 0,
          type: payload.error.type || '',
          detail: message,
        });
      }
      if (payload.usage) usage = payload.usage;
      const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
      if (!choice) return;
      const delta = choice.delta || choice.message || null;
      if (delta) {
        // 思考内容单独累加，绝不混进正文（DeepSeek reasoner 会发这个字段）
        const think = readText(delta.reasoning_content) || readText(delta.reasoning);
        if (think) {
          reasoning += think;
          if (emitReasoning) emitReasoning(think, reasoning);
        }
        const piece = readText(delta.content);
        if (piece) {
          fullText += piece;
          if (emitDelta) emitDelta(piece, fullText);
        }
      }
      if (choice.finish_reason) finishReason = String(choice.finish_reason);
    };

    const finish = (aborted) => ({
      text: fullText,
      usage,
      aborted,
      finishReason,
      reasoningContent: reasoning,
    });

    try {
      const res = await fetchImpl(this.endpoint, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(this.buildRequestBody(messages, { stream: true })),
        signal: link.signal,
      });
      if (!res || typeof res.ok !== 'boolean') {
        throw new DeepSeekError('聊天服务返回了无法识别的响应。', { code: 'bad-response' });
      }
      if (!res.ok) {
        const info = await this._readErrorBody(res);
        throw new DeepSeekError(friendlyHttpMessage(res.status, info.message), {
          code: 'http-error',
          status: res.status,
          type: info.type,
          detail: info.raw,
        });
      }
      for await (const ev of iterateSSE(res, parser)) {
        if (ev.done) break;
        handleEvent(ev);
      }
      return finish(false);
    } catch (err) {
      if (link.didTimeout()) {
        throw new DeepSeekError(`请求超时（超过 ${this.timeoutMs}ms 没有完成）。`, {
          code: 'timeout',
          detail: String(err?.message || err || ''),
        });
      }
      if (isAbortError(err) || link.signal.aborted) {
        // 用户主动中断：已经吐出来的字保留，不算失败
        return finish(true);
      }
      throw this._wrap(err);
    } finally {
      link.cleanup();
    }
  }

  /**
   * 非流式对话（`chat.stream=false` 时用）。
   * @returns {Promise<{ text:string, usage:object|null, aborted:boolean, finishReason:string, raw:any }>}
   */
  async complete(messages, { signal } = {}) {
    this._requireKey();
    const fetchImpl = this._resolveFetch();
    const link = this._linkSignals(signal);
    try {
      const res = await fetchImpl(this.endpoint, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(this.buildRequestBody(messages, { stream: false })),
        signal: link.signal,
      });
      if (!res || typeof res.ok !== 'boolean') {
        throw new DeepSeekError('聊天服务返回了无法识别的响应。', { code: 'bad-response' });
      }
      if (!res.ok) {
        const info = await this._readErrorBody(res);
        throw new DeepSeekError(friendlyHttpMessage(res.status, info.message), {
          code: 'http-error',
          status: res.status,
          type: info.type,
          detail: info.raw,
        });
      }
      const data = typeof res.json === 'function' ? await res.json() : safeJsonParse(await res.text());
      const choice = data?.choices?.[0] || null;
      return {
        text: readText(choice?.message?.content),
        usage: data?.usage ?? null,
        aborted: false,
        finishReason: choice?.finish_reason ? String(choice.finish_reason) : '',
        raw: data,
      };
    } catch (err) {
      if (link.didTimeout()) {
        throw new DeepSeekError(`请求超时（超过 ${this.timeoutMs}ms 没有完成）。`, { code: 'timeout' });
      }
      if (isAbortError(err) || link.signal.aborted) {
        return { text: '', usage: null, aborted: true, finishReason: '', raw: null };
      }
      throw this._wrap(err);
    } finally {
      link.cleanup();
    }
  }

  /** 非 DeepSeekError 的异常（网络失败等）统一包一层，方便上层给中文提示。 */
  _wrap(err) {
    if (err instanceof DeepSeekError) return err;
    const detail = String(err?.message || err || '');
    if (err instanceof TypeError || /fetch failed|network|ENOTFOUND|ECONNREFUSED|Failed to fetch/i.test(detail)) {
      return new DeepSeekError('连不上聊天服务：请检查网络/代理，以及 chat.baseUrl 是否写对了。', {
        code: 'network',
        detail,
      });
    }
    return new DeepSeekError(`聊天请求失败：${detail || '未知错误'}`, { code: 'unknown', detail });
  }
}

export default DeepSeekClient;
