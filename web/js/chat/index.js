/**
 * Chat —— 聊天编排层（契约 docs/CONTRACT.md §5）。
 *
 * 职责边界：
 *  - 只做编排：取配置与 Key、拼 system prompt、裁历史、调 DeepSeekClient、后处理语气、发事件；
 *  - 不碰 DOM、不直接操作设置面板（那是 Lead 的 app.js 与 core/* 的事）；
 *  - 所有失败都经 core/busy.js 的 reportError('chat', err, 中文提示) 上报（同时 emit CHAT_ERROR + TOAST），
 *    并且**照契约把 Error 抛给调用方**，不静默失败。
 *
 * 事件约定（与 app.js 对齐，重要）：
 *  - CHAT_SEND  { text }            用户发出了一条消息
 *  - CHAT_DELTA { text }  ← text 是**截至当前的累计全文**（不是本次增量片段），
 *                           因为外壳直接用 textContent 覆盖渲染；增量片段在内部只在拼装时使用。
 *  - CHAT_DONE  { text, usage, aborted }  text 是**语气后处理之后**的最终文本
 *  - CHAT_ERROR { message, detail } （由 reportError 统一发出）
 *  - PET_THINK  { on }              生成中开/关（驱动桌宠的「思考」动画）
 */

import { emit, on, AppEvents } from '../core/events.js';
import { Settings } from '../core/settings.js';
import { reportError, Bubble } from '../core/busy.js';
import { Persona, DEFAULT_PRESET } from '../persona/index.js';
import { DeepSeekClient, DEFAULT_BASE_URL, DEFAULT_MODEL, isAbortError } from './deepseek.js';
import { buildMessages } from './prompt.js';

export { DeepSeekClient, DEFAULT_BASE_URL, DEFAULT_MODEL };
export { buildMessages };

export const VERSION = '1.0.0';

/** 内存里最多保留多少条消息（防长会话内存膨胀，比 chat.historyTurns 宽松）。 */
export const HISTORY_HARD_LIMIT = 200;

/**
 * 把异常翻成一句能直接显示给用户的中文。
 * @param {any} err
 * @returns {string}
 */
export function describeError(err) {
  if (!err) return '聊天时出了点问题，再试一次？';
  if (err.code === 'no-api-key') {
    return '还没有配置 API Key：打开「设置 → 聊天」，填入你的 DeepSeek API Key（只保存在当前标签页会话里）。';
  }
  if (err.code === 'timeout') return `等太久了（${err.message || '请求超时'}），要不要重发一次？`;
  if (err.code === 'network') return '连不上聊天服务：检查一下网络或代理，以及设置里的接口地址。';
  if (err.code === 'busy') return '上一条还在生成中，等它说完或者先点「停止」。';
  if (err.code === 'http-error') return err.message;
  return err.message ? String(err.message) : '聊天时出了点问题，再试一次？';
}

export const Chat = {
  version: VERSION,

  /** @type {Array<{role:string,content:string,ts:number}>} */
  _history: [],
  _controller: null,
  _busy: false,
  _ready: false,
  _moodState: 'idle',
  _opts: {},
  _unsubs: [],

  /**
   * 初始化（幂等，可重复调用；后调用的 opts 会合并覆盖）。
   * @param {object} [opts]
   * @param {DeepSeekClient} [opts.client]     注入客户端（单测用）
   * @param {typeof fetch} [opts.fetchImpl]    注入 fetch（单测用）
   * @param {string} [opts.apiKey]             覆盖 Settings 里的 Key（单测用）
   * @param {string} [opts.preset]             覆盖 chat.personaPreset
   * @param {string} [opts.userName]
   * @param {number} [opts.affection]
   * @param {boolean} [opts.stream]
   * @param {number} [opts.maxChars]           polish 的长度上限
   * @param {string|string[]} [opts.extraRules] 追加到 system prompt 的规则
   * @param {boolean} [opts.bubble]            回复完成后是否冒头顶气泡（默认 true）
   * @param {boolean} [opts.rememberHistory]   覆盖 chat.rememberHistory
   * @returns {typeof Chat}
   */
  init(opts = {}) {
    this._opts = { ...this._opts, ...(opts || {}) };
    if (this._ready) return this;
    this._ready = true;
    // 桌宠点击/互动会让 A 侧发 PET_MOOD，这里跟着更新语气；Settings 只作为兜底
    this._unsubs.push(
      on(AppEvents.PET_MOOD, (payload) => {
        if (payload && typeof payload.mood === 'string' && payload.mood) this._moodState = payload.mood;
      }),
    );
    return this;
  },

  /** 当前是否在等回复。 */
  isBusy() {
    return this._busy;
  },

  /**
   * 读取当前生效配置（opts 覆盖 > Settings > 契约默认值）。
   *
   * Settings.get() 的新口径：**已登记键一律不返回调用方 fallback**（没保存值就给 DEFAULTS），
   * 所以这里不再传第二个参数；只有契约常量（baseUrl/model/preset）用 `??` 兜一层，
   * 防止 key 万一未登记时拿到 undefined。API Key 属敏感键，**只走 getSecret**。
   */
  _config() {
    const o = this._opts || {};
    const preset = o.preset ?? Settings.get('chat.personaPreset') ?? DEFAULT_PRESET;
    return {
      apiKey: o.apiKey ?? Settings.getSecret('chat.apiKey', ''),
      baseUrl: o.baseUrl ?? Settings.get('chat.baseUrl') ?? DEFAULT_BASE_URL,
      model: o.model ?? Settings.get('chat.model') ?? DEFAULT_MODEL,
      temperature: o.temperature ?? Settings.get('chat.temperature'),
      maxTokens: o.maxTokens ?? Settings.get('chat.maxTokens'),
      timeoutMs: o.timeoutMs ?? Settings.get('chat.timeoutMs'),
      stream: o.stream ?? Settings.get('chat.stream'),
      preset,
      userName: o.userName ?? Settings.get('chat.userName'),
      affection: o.affection ?? Settings.get('pet.affection'),
      historyTurns: o.historyTurns ?? Settings.get('chat.historyTurns'),
      rememberHistory: o.rememberHistory ?? Settings.get('chat.rememberHistory'),
      maxChars: o.maxChars,
    };
  },

  /** 当前生效的情绪：PET_MOOD 事件优先，其次设置里的 pet.mood。 */
  _mood() {
    if (this._moodState && this._moodState !== 'idle') return this._moodState;
    return Settings.get('pet.mood') || 'idle';
  },

  _client(cfg) {
    if (this._opts.client) return this._opts.client;
    return new DeepSeekClient({
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      timeoutMs: cfg.timeoutMs,
      fetchImpl: this._opts.fetchImpl || null,
    });
  },

  _push(role, content, ts) {
    this._history.push({ role, content, ts: ts ?? Date.now() });
    if (this._history.length > HISTORY_HARD_LIMIT) {
      this._history.splice(0, this._history.length - HISTORY_HARD_LIMIT);
    }
  },

  /** 回复完成后在桌宠头顶冒一句（A 侧订阅 PET_BUBBLE 渲染）。 */
  _maybeBubble(text) {
    if (!text) return;
    if (this._opts.bubble === false) return;
    try {
      if (Settings.get('pet.showBubble') === false) return;
      const [first] = Persona.splitBubbles(text);
      if (!first) return;
      const ms = Number(Settings.get('pet.bubbleMs'));
      Bubble.say(first, Number.isFinite(ms) && ms > 0 ? ms : 4200);
    } catch (err) {
      console.warn('[aemeath:chat] 气泡发送失败', err);
    }
  },

  /**
   * 发一条用户消息，返回 assistant 全文（已做语气后处理）。
   * 失败时抛 Error（同时已 emit CHAT_ERROR / TOAST）。
   * @param {string} text
   * @returns {Promise<string>}
   */
  async send(text) {
    const userText = typeof text === 'string' ? text.trim() : String(text ?? '').trim();
    if (!userText) {
      const err = new TypeError('[aemeath:chat] send(text) 需要非空文本');
      err.code = 'empty';
      reportError('chat', err, '说点什么再发吧，我这边是空的。');
      throw err;
    }
    if (this._busy) {
      const err = new Error('上一条回复还在生成中');
      err.code = 'busy';
      reportError('chat', err, describeError(err));
      throw err;
    }

    const cfg = this._config();
    emit(AppEvents.CHAT_SEND, { text: userText });

    const apiKey = String(cfg.apiKey ?? '').trim();
    if (!apiKey) {
      const err = new Error('缺少 API Key');
      err.code = 'no-api-key';
      reportError('chat', err, describeError(err));
      throw err;
    }

    const client = this._client({ ...cfg, apiKey });
    const mood = this._mood();
    const history = cfg.rememberHistory ? this._history : [];
    const systemPrompt = Persona.buildSystemPrompt({
      preset: cfg.preset,
      userName: cfg.userName,
      affection: cfg.affection,
      mood,
      extraRules: this._opts.extraRules,
    });
    const messages = buildMessages({
      systemPrompt,
      history,
      userText,
      maxTurns: cfg.historyTurns,
    });

    this._busy = true;
    this._controller = new AbortController();
    emit(AppEvents.PET_THINK, { on: true });

    let fullText = '';
    let usage = null;
    let aborted = false;

    try {
      if (cfg.stream) {
        const res = await client.stream(messages, {
          signal: this._controller.signal,
          onDelta: (delta, full) => {
            fullText = full;
            // 注意：这里发的是**累计全文**，不是增量片段（app.js 直接覆盖渲染）
            emit(AppEvents.CHAT_DELTA, { text: full });
          },
          // reasoning_content 只透传不外发：思考内容不进正文、不进气泡
          onReasoning: () => {},
        });
        fullText = typeof res?.text === 'string' ? res.text : fullText;
        usage = res?.usage ?? null;
        aborted = !!res?.aborted;
      } else {
        const res = await client.complete(messages, { signal: this._controller.signal });
        fullText = typeof res?.text === 'string' ? res.text : '';
        usage = res?.usage ?? null;
        aborted = !!res?.aborted;
        if (fullText) emit(AppEvents.CHAT_DELTA, { text: fullText });
      }
    } catch (err) {
      this._busy = false;
      this._controller = null;
      emit(AppEvents.PET_THINK, { on: false });
      if (isAbortError(err)) {
        // 客户端没把中断吞掉的情况：当作正常中断收尾
        const partial = Persona.polish(fullText, { preset: cfg.preset, mood, maxChars: cfg.maxChars });
        emit(AppEvents.CHAT_DONE, { text: partial, usage, aborted: true });
        return partial;
      }
      reportError('chat', err, describeError(err));
      throw err;
    }

    this._busy = false;
    this._controller = null;
    emit(AppEvents.PET_THINK, { on: false });

    const reply = Persona.polish(fullText, { preset: cfg.preset, mood, maxChars: cfg.maxChars });

    if (cfg.rememberHistory) {
      this._push('user', userText);
      this._push('assistant', reply);
    }

    emit(AppEvents.CHAT_DONE, { text: reply, usage, aborted });
    if (!aborted) this._maybeBubble(reply);
    return reply;
  },

  /** 中断当前请求。没有在生成时返回 false。 */
  abort() {
    if (!this._controller) return false;
    try {
      this._controller.abort();
    } catch (err) {
      console.warn('[aemeath:chat] abort 失败', err);
    }
    return true;
  },

  /** 清空上下文（不影响界面渲染，界面由外壳自己决定要不要清）。 */
  clear() {
    this._history = [];
    return undefined;
  },

  /**
   * 取历史副本，供外壳持久化或渲染。
   * @returns {Array<{role:string,content:string,ts:number}>}
   */
  getHistory() {
    return this._history.map((m) => ({ role: m.role, content: m.content, ts: m.ts }));
  },

  /**
   * 用外部历史覆盖（外壳从 localStorage 恢复时用；不属于契约必需项）。
   * @param {Array<{role:string,content:string,ts?:number}>} list
   */
  setHistory(list) {
    const arr = Array.isArray(list) ? list : [];
    this._history = arr
      .filter((m) => m && typeof m.content === 'string' && m.content.trim() && (m.role === 'user' || m.role === 'assistant'))
      .slice(-HISTORY_HARD_LIMIT)
      .map((m) => ({ role: m.role, content: m.content, ts: Number.isFinite(Number(m.ts)) ? Number(m.ts) : Date.now() }));
    return this._history.length;
  },

  /** 取消 init 里注册的事件订阅（单测/卸载用）。 */
  dispose() {
    for (const off of this._unsubs) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    this._unsubs = [];
    this._ready = false;
    this.abort();
    return undefined;
  },
};

export default Chat;
