/**
 * SSE（Server-Sent Events）增量解析器。
 *
 * 为什么不用浏览器内置的 `EventSource`：
 *  - DeepSeek 的 `/chat/completions` 是 POST + JSON body，而 EventSource 只支持 GET；
 *  - 需要复用 AbortController / 超时控制；
 *  - 解析逻辑要能脱离浏览器在 `node:test` 里跑纯函数单测。
 *
 * 兼容性要点（这里每一条都是实际会踩的坑）：
 *  - **分块跨包**：一个事件可能被 TCP 拆成两块，行尾甚至只剩半个 `\r`，必须缓冲到下一块；
 *  - **换行**：`\n`、`\r\n`、以及落单的 `\r`（老式实现）都要当行终止符；
 *  - **冒号后空格**：SSE 规范规定 `data:` 后紧跟的**一个**空格属于分隔符要吃掉，
 *    再往后的空格才是数据本身（`data:  {\"a\":1}` 里第二个空格是数据）；
 *  - **多行 data**：同一事件里多个 `data:` 行按规范用 `\n` 拼接，不能各自成事件；
 *  - **`data: [DONE]`**：OpenAI 兼容流的结束哨兵，不是 JSON，不能拿去 JSON.parse；
 *  - **注释行**：以 `:` 开头的是心跳/注释，直接忽略，不算事件边界；
 *  - **无尾随空行**：有些服务端最后一块不发空行，需要 `flush()` 兜底派发。
 */

/** OpenAI 兼容流的结束哨兵。 */
export const DONE_SENTINEL = '[DONE]';

/** 已知的 SSE 字段名，其余字段按规范忽略。 */
const KNOWN_FIELDS = new Set(['data', 'event', 'id', 'retry']);

/**
 * 把 fetch 读出来的块转成字符串。
 * Uint8Array 走 TextDecoder 的 stream 模式，保证多字节汉字被拆包时不乱码。
 * @param {string|Uint8Array|ArrayBuffer} chunk
 * @param {TextDecoder|null} decoder
 */
function toText(chunk, decoder) {
  if (typeof chunk === 'string') return chunk;
  if (chunk === null || chunk === undefined) return '';
  let bytes = chunk;
  if (chunk instanceof ArrayBuffer) bytes = new Uint8Array(chunk);
  if (decoder && bytes && typeof bytes.length === 'number') {
    return decoder.decode(bytes, { stream: true });
  }
  return String(chunk);
}

/**
 * 增量 SSE 解析器。
 *
 * @example
 * const parser = new SSEParser();
 * for (const ev of parser.feed(chunk)) {
 *   if (ev.done) break;                 // data: [DONE]
 *   const payload = JSON.parse(ev.data);
 * }
 * for (const ev of parser.flush()) { ... }
 */
export class SSEParser {
  /**
   * @param {{ onEvent?: (ev: SSEEvent) => void }} [opts]
   */
  constructor({ onEvent } = {}) {
    /** 尚未成行的残留缓冲（跨包关键） */
    this.buffer = '';
    /** 当前事件累积的字段 */
    this.dataLines = [];
    this.eventName = '';
    this.lastEventId = '';
    this.retry = null;
    this._sawField = false;
    /** 收到过 [DONE] 哨兵 */
    this.done = false;
    /** 已派发的事件数（含哨兵，便于自检） */
    this.eventCount = 0;
    /** 上一次收到的 event id（SSE 规范的 Last-Event-ID 语义） */
    this.lastId = '';
    this._onEvent = typeof onEvent === 'function' ? onEvent : null;
    this._decoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : null;
  }

  /**
   * 喂一块数据，返回本块内**已完整**的事件数组。
   * 不完整的行留在内部缓冲，等下一块；因此可以安全地按任意字节边界切分。
   * @param {string|Uint8Array|ArrayBuffer} chunk
   * @returns {SSEEvent[]}
   */
  feed(chunk) {
    if (this.done) return [];
    const text = toText(chunk, this._decoder);
    if (!text) return [];
    this.buffer += text;
    const out = [];
    const buf = this.buffer;
    let start = 0;
    let i = 0;
    while (i < buf.length) {
      const ch = buf[i];
      if (ch === '\n') {
        this._collect(buf.slice(start, i), out);
        i += 1;
        start = i;
      } else if (ch === '\r') {
        if (i + 1 >= buf.length) {
          // 可能是被拆开的 \r\n，把这一行留给下一块
          break;
        }
        this._collect(buf.slice(start, i), out);
        i += buf[i + 1] === '\n' ? 2 : 1;
        start = i;
      } else {
        i += 1;
      }
      if (this.done) {
        // 收到 [DONE]：丢掉后面的字节，避免把服务端多余的尾部当事件
        this.buffer = '';
        return out;
      }
    }
    this.buffer = buf.slice(start);
    return out;
  }

  /**
   * 流结束时调用：把没有尾随空行的最后一行 / 最后一个待派发事件补上。
   * @returns {SSEEvent[]}
   */
  flush() {
    const out = [];
    if (this.buffer) {
      const rest = this.buffer;
      this.buffer = '';
      // 残留内容可能含多行（极少数服务端不带尾随换行）
      for (const line of rest.split(/\r\n|\r|\n/)) this._collect(line, out);
    }
    const ev = this._dispatch();
    if (ev) out.push(ev);
    return out;
  }

  /** 清空全部状态（复用解析器实例时用）。 */
  reset() {
    this.buffer = '';
    this.dataLines = [];
    this.eventName = '';
    this.lastEventId = '';
    this.retry = null;
    this._sawField = false;
    this.done = false;
    this.eventCount = 0;
    this.lastId = '';
  }

  /** 处理一行：空行 = 派发事件；`:` 开头 = 注释；其余按 `field: value` 拆。 */
  _collect(line, out) {
    if (line === '') {
      const ev = this._dispatch();
      if (ev) out.push(ev);
      return;
    }
    if (line.charCodeAt(0) === 58 /* ':' */) return; // 心跳注释
    const colon = line.indexOf(':');
    let field;
    let value;
    if (colon < 0) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.charCodeAt(0) === 32 /* ' ' */) value = value.slice(1);
    }
    if (!KNOWN_FIELDS.has(field)) return;
    this._sawField = true;
    switch (field) {
      case 'data':
        this.dataLines.push(value);
        break;
      case 'event':
        this.eventName = value;
        break;
      case 'id':
        this.lastEventId = value;
        break;
      case 'retry': {
        const n = Number(value);
        if (Number.isFinite(n)) this.retry = n;
        break;
      }
      default:
        break;
    }
  }

  /** 派发当前累积的事件；没有任何字段时返回 null。 */
  _dispatch() {
    if (!this._sawField) return null;
    const data = this.dataLines.join('\n');
    const ev = {
      event: this.eventName || 'message',
      data,
      id: this.lastEventId,
      retry: this.retry,
      done: data.trim() === DONE_SENTINEL,
    };
    if (this.lastEventId) this.lastId = this.lastEventId;
    this.dataLines = [];
    this.eventName = '';
    // 按 SSE 规范：event 类型派发后清空；id / retry 跨事件保留（断线重连语义）
    this._sawField = false;
    this.eventCount += 1;
    if (ev.done) this.done = true;
    if (this._onEvent) {
      try {
        this._onEvent(ev);
      } catch (err) {
        console.warn('[aemeath:chat] SSE onEvent 回调异常', err);
      }
    }
    return ev;
  }
}

/**
 * 一次性解析整段 SSE 文本（测试与兜底用）。
 * @param {string} text
 * @returns {SSEEvent[]}
 */
export function parseSSEText(text) {
  const parser = new SSEParser();
  return [...parser.feed(text), ...parser.flush()];
}

/**
 * @typedef {object} SSEEvent
 * @property {string} event   事件名，默认 'message'
 * @property {string} data    多行 data 用 \n 拼接后的原始字符串
 * @property {string} id      事件 id
 * @property {number|null} retry
 * @property {boolean} done   是否为 `data: [DONE]` 哨兵
 */

export default SSEParser;
