/**
 * 浏览器内置 speechSynthesis 适配器（默认 TTS 链路）。
 *
 * 特点：
 *  - 零网络、零依赖、开箱即用；语音来自操作系统/浏览器自带引擎；
 *  - 长文本自动分句排队，避免部分浏览器「一次 speak 过长文本会静默中断」的问题；
 *  - rate / pitch / volume / 音色来自 Settings（调用方通过 opts 传入）；
 *  - 通过 onBoundary 与定时估算驱动口型回调 onMouth(0..1)。
 *
 * 红线：本文件不内置任何预训练声线、不做声音克隆、不下载任何音频或权重，
 * 只调用浏览器/系统已有的语音合成能力。
 */

import { createMouthDriver, estimateSpeechMs } from './mouth.js';

export const PROVIDER_ID = 'browser';
export const PROVIDER_NAME = '浏览器内置语音（speechSynthesis）';

/** 句末标点：优先在这些位置切分 */
const SENTENCE_END = '。！？!?；;…\n\r';
/** 次级切分：逗号/顿号/冒号 */
const SOFT_BREAK = '，,、：:';
/** 单个分片最大字符数（保守值，兼容各浏览器对长文本的容忍度） */
export const MAX_CHUNK_CHARS = 110;

function clamp(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 当前环境是否支持 speechSynthesis */
export function isSupported() {
  return (
    typeof globalThis.speechSynthesis !== 'undefined' &&
    typeof globalThis.SpeechSynthesisUtterance === 'function'
  );
}

/**
 * 把长文本切成适合逐条朗读的分片（纯函数，可单测）。
 *
 * 规则：先按句末标点切句；句子仍超长时按次级标点切；再超长则硬切（按码点）。
 *
 * @param {string} text
 * @param {number} [maxLen]
 * @returns {string[]}
 */
export function splitSentences(text, maxLen = MAX_CHUNK_CHARS) {
  const limit = Math.max(20, Number(maxLen) || MAX_CHUNK_CHARS);
  const raw = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return [];

  /** 按给定分隔符集合切分成「带尾巴」的片段 */
  function chopBy(str, breaks) {
    const out = [];
    let buf = '';
    for (const ch of str) {
      buf += ch;
      if (breaks.includes(ch)) {
        if (buf.trim()) out.push(buf.trim());
        buf = '';
      }
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }

  function hardWrap(str) {
    const out = [];
    const chars = Array.from(str);
    for (let i = 0; i < chars.length; i += limit) {
      const piece = chars.slice(i, i + limit).join('').trim();
      if (piece) out.push(piece);
    }
    return out;
  }

  const result = [];
  for (const sentence of chopBy(raw, SENTENCE_END)) {
    if (sentence.length <= limit) {
      result.push(sentence);
      continue;
    }
    for (const clause of chopBy(sentence, SOFT_BREAK)) {
      if (clause.length <= limit) result.push(clause);
      else result.push(...hardWrap(clause));
    }
  }
  return result;
}

/**
 * 选音色（纯函数，可单测）。
 *
 * 优先级：设置里指定的 voiceURI/name 精确匹配 > 与目标语言完全一致 > 同主语言 >
 * 系统默认音色 > 列表第一个。没有任何可用音色时返回 null。
 *
 * @param {Array<{voiceURI?:string,name?:string,lang?:string,localService?:boolean,default?:boolean}>} voices
 * @param {{voiceURI?:string,lang?:string}} [opts]
 */
export function pickVoice(voices, opts = {}) {
  const list = Array.isArray(voices) ? voices.filter(Boolean) : [];
  if (!list.length) return null;

  const wanted = String(opts.voiceURI || '').trim();
  if (wanted) {
    const exact = list.find((v) => v.voiceURI === wanted || v.name === wanted);
    if (exact) return exact;
  }

  const target = String(opts.lang || 'zh-CN').trim().toLowerCase().replace(/_/g, '-');
  const primary = target.split('-')[0] || 'zh';

  let best = null;
  let bestScore = 0;
  for (const v of list) {
    const vl = String(v.lang || '').trim().toLowerCase().replace(/_/g, '-');
    let score = 0;
    if (vl === target) score += 100;
    else if (vl.split('-')[0] === primary) score += 60;
    if (v.localService) score += 5; // 本地引擎不依赖网络，优先
    if (v.default) score += 3;
    if (score > bestScore) {
      bestScore = score;
      best = v;
    }
  }
  if (bestScore >= 60) return best;

  // 没有同语言音色：退回系统默认（可能读不出中文，但至少不静默失败）
  return list.find((v) => v.default) || list[0];
}

/** 归一化调用参数（每次 speak 现读，保证设置改动立即生效） */
function normalizeOptions(config, opts) {
  return {
    voiceURI: opts.voiceURI ?? config.voiceURI ?? '',
    lang: opts.lang || config.lang || 'zh-CN',
    rate: clamp(opts.rate ?? config.rate, 0.1, 10, 1),
    pitch: clamp(opts.pitch ?? config.pitch, 0, 2, 1),
    volume: clamp(opts.volume ?? config.volume, 0, 1, 1),
    maxChunk: opts.maxChunk || MAX_CHUNK_CHARS,
  };
}

function abortError(message = '朗读已被中断') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/**
 * 创建浏览器 TTS 提供方实例。
 *
 * @param {{
 *   onMouth?: (v:number)=>void,
 *   voiceURI?: string, lang?: string,
 *   rate?: number, pitch?: number, volume?: number,
 * }} [config]
 * @returns {{
 *   id: string, name: string, available: boolean, unavailableReason: string,
 *   speak: (text:string, opts?:object)=>Promise<void>,
 *   stop: ()=>void,
 *   listVoices: ()=>Array<object>,
 * }}
 */
export function createBrowserTts(config = {}) {
  let runToken = null; // { cancelled, activeReject, pending }

  function synth() {
    try {
      return globalThis.speechSynthesis || null;
    } catch {
      return null;
    }
  }

  function getVoices() {
    try {
      return synth()?.getVoices?.() || [];
    } catch {
      return [];
    }
  }

  /** 部分浏览器首次 getVoices() 返回空数组，这里挂一次性监听预热 */
  let warmed = false;
  function warmUpVoices() {
    const s = synth();
    if (warmed || !s || typeof s.addEventListener !== 'function') return;
    warmed = true;
    s.addEventListener('voiceschanged', () => {
      /* 仅触发一次枚举，让后续 getVoices() 能拿到列表 */
      getVoices();
    });
  }
  warmUpVoices();

  /**
   * 结算某个 speak 调用的外层 Promise。
   * 注意：pending 挂在 token 上而不是模块级变量 —— 否则「快速连续调用 speak」
   * 时新调用会覆盖旧 pending，导致上一个 Promise 永远悬空。
   */
  function settle(token, err) {
    if (!token || !token.pending) return;
    const p = token.pending;
    token.pending = null;
    if (err) p.reject(err);
    else p.resolve();
  }

  function speakChunk(chunk, opts, token, mouth) {
    return new Promise((resolve, reject) => {
      const Ctor = globalThis.SpeechSynthesisUtterance;
      const utter = new Ctor(chunk);
      const voice = pickVoice(getVoices(), { voiceURI: opts.voiceURI, lang: opts.lang });
      if (voice) {
        utter.voice = voice;
        utter.lang = voice.lang || opts.lang;
      } else {
        utter.lang = opts.lang;
      }
      utter.rate = opts.rate;
      utter.pitch = opts.pitch;
      utter.volume = opts.volume;

      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        if (token.activeReject === reject) token.activeReject = null;
        if (err) reject(err);
        else resolve();
      };

      utter.onstart = () => {
        mouth.start(estimateSpeechMs(chunk, opts.rate));
      };
      utter.onboundary = () => {
        mouth.hint();
      };
      utter.onend = () => {
        mouth.stop();
        if (token.cancelled) finish(abortError());
        else finish(null);
      };
      utter.onerror = (ev) => {
        mouth.stop();
        const code = ev && ev.error ? ev.error : 'unknown';
        if (token.cancelled || code === 'interrupted' || code === 'canceled') {
          finish(abortError());
        } else {
          const err = new Error(`浏览器语音合成失败：${code}`);
          err.code = code;
          finish(err);
        }
      };

      token.activeReject = (err) => finish(err);
      try {
        synth().speak(utter);
      } catch (err) {
        finish(new Error(`无法调用 speechSynthesis.speak：${err?.message || err}`));
      }
    });
  }

  function stop() {
    const token = runToken;
    mouthStopAll();
    try {
      synth()?.cancel();
    } catch {
      /* ignore */
    }
    if (!token) return;
    token.cancelled = true;
    runToken = null;
    const rejectActive = token.activeReject;
    token.activeReject = null;
    if (rejectActive) rejectActive(abortError());
    settle(token, abortError());
  }

  // 每个 speak 调用一个独立口型驱动，便于延迟绑定 PetUI.setMouth
  let activeMouth = null;
  function mouthStopAll() {
    if (activeMouth) {
      activeMouth.stop();
      activeMouth = null;
    }
  }

  async function speak(text, opts = {}) {
    stop(); // 打断上一段，保证同一时刻只有一条语音
    const s = synth();
    if (!s) {
      const err = new Error('当前浏览器不支持 speechSynthesis，请改用外部 HTTP 语音端点');
      err.name = 'NotSupportedError';
      throw err;
    }
    const chunks = splitSentences(text, opts.maxChunk);
    if (!chunks.length) return;

    const o = normalizeOptions(config, opts);
    const token = { cancelled: false, activeReject: null, pending: null };
    const mouth = createMouthDriver(opts.onMouth || config.onMouth || null);
    activeMouth = mouth;
    runToken = token;

    const done = new Promise((resolve, reject) => {
      token.pending = { resolve, reject };
    });

    (async () => {
      try {
        for (let i = 0; i < chunks.length; i += 1) {
          if (token.cancelled) throw abortError();
          await speakChunk(chunks[i], o, token, mouth);
        }
        settle(token, token.cancelled ? abortError() : null);
      } catch (err) {
        settle(token, token.cancelled ? abortError() : err);
      } finally {
        mouth.stop();
        if (activeMouth === mouth) activeMouth = null;
        if (runToken === token) runToken = null;
      }
    })();

    return done;
  }

  const available = isSupported();

  return {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    available,
    unavailableReason: available ? '' : '当前浏览器不支持 speechSynthesis（可改用外部 HTTP 语音端点）',
    speak,
    stop,
    /** 供设置面板列出系统音色（不在契约里，属便利接口） */
    listVoices: getVoices,
  };
}

export default createBrowserTts;
