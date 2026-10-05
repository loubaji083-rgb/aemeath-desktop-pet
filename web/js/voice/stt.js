/**
 * Web Speech API 语音识别（STT）封装。
 *
 * 重要隐私说明：
 *  - 本模块不采集、不上传、不保存任何录音文件；
 *  - 识别由浏览器 / 操作系统的识别引擎完成，部分浏览器（Chrome）会把它发往厂商服务，
 *    这一行为由浏览器控制，本仓库无法也不做任何拦截；
 *  - 用户的识别结果只以文本形式通过 VOICE_STT_RESULT 事件抛出（interim 也抛，带 final 标记）。
 *
 * 兼容性：Chrome/Edge 走 webkitSpeechRecognition；Firefox 目前不提供，需由调用方降级提示。
 */

import { emit, AppEvents } from '../core/events.js';

/** 识别错误码 → 中文提示 */
export const STT_ERROR_MESSAGES = {
  'not-allowed': '麦克风权限被拒绝：请在浏览器地址栏允许麦克风访问',
  'service-not-allowed': '浏览器拒绝了语音识别服务（通常需要 HTTPS 或 localhost）',
  'no-speech': '没有听到声音，请再说一次',
  'audio-capture': '没有检测到可用的麦克风设备',
  network: '语音识别服务网络异常',
  aborted: '语音识别已中止',
  'language-not-supported': '当前语言不被识别引擎支持',
  'bad-grammar': '识别语法配置有误',
};

export function getSpeechRecognitionCtor() {
  return globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;
}

export function isSupported() {
  return typeof getSpeechRecognitionCtor() === 'function';
}

/**
 * 创建识别引擎。
 *
 * @param {{
 *   lang?: string,
 *   continuous?: boolean,
 *   interim?: boolean,
 *   onError?: (message:string, code:string)=>void,
 *   onEnd?: (reason:string)=>void,
 *   onStateChange?: (listening:boolean)=>void,
 * }} [config]
 * @returns {{
 *   supported: boolean,
 *   start: ()=>boolean,
 *   stop: ()=>void,
 *   isActive: ()=>boolean,
 *   getFinalText: ()=>string,
 *   reset: ()=>void,
 * }}
 */
export function createSttEngine(config = {}) {
  const Ctor = getSpeechRecognitionCtor();
  const supported = typeof Ctor === 'function';
  const lang = config.lang || 'zh-CN';
  const continuous = config.continuous !== false;
  const interim = config.interim !== false;

  let recognition = null;
  let active = false; // 用户意图：是否处于聆听状态
  let restartTimer = null;
  let finalText = '';
  let lastInterim = '';
  let lastErrorCode = '';

  function emitResult(text, final) {
    if (!text) return;
    emit(AppEvents.VOICE_STT_RESULT, { text, final: !!final });
  }

  function build() {
    const rec = new Ctor();
    rec.lang = lang;
    rec.continuous = continuous;
    rec.interimResults = interim;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      lastErrorCode = '';
    };

    rec.onresult = (event) => {
      let interimBuf = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result?.[0]?.transcript ?? '';
        if (result.isFinal) {
          finalText += text;
          lastInterim = '';
          emitResult(text, true);
        } else {
          interimBuf += text;
        }
      }
      if (interimBuf) {
        lastInterim = interimBuf;
        emitResult(interimBuf, false);
      }
      if (typeof config.onInterim === 'function' && interimBuf) {
        config.onInterim(interimBuf);
      }
    };

    rec.onerror = (event) => {
      const code = event?.error || 'unknown';
      lastErrorCode = code;
      // no-speech / aborted 属正常抖动，不当作硬失败上报
      if (code === 'no-speech' || code === 'aborted') return;
      const message = STT_ERROR_MESSAGES[code] || `语音识别失败：${code}`;
      if (typeof config.onError === 'function') config.onError(message, code);
    };

    rec.onend = () => {
      // continuous 模式在浏览器里会被自动结束（静音一段时间），需要自动续接
      if (active && lastErrorCode !== 'not-allowed' && lastErrorCode !== 'service-not-allowed') {
        restartTimer = setTimeout(() => {
          if (!active) return;
          try {
            rec.start();
          } catch (err) {
            // 已经在监听时 start() 会抛 InvalidStateError，忽略即可
            if (!/already started|InvalidState/i.test(String(err?.message || err))) {
              console.warn('[aemeath:voice] 语音识别续接失败', err);
            }
          }
        }, 260);
        return;
      }
      if (typeof config.onEnd === 'function') config.onEnd(lastErrorCode || 'ended');
      if (typeof config.onStateChange === 'function') config.onStateChange(false);
    };

    return rec;
  }

  return {
    supported,

    start() {
      if (!supported) return false;
      if (active) return true;
      finalText = '';
      lastInterim = '';
      lastErrorCode = '';
      try {
        recognition = build();
        active = true;
        recognition.start();
        if (typeof config.onStateChange === 'function') config.onStateChange(true);
        return true;
      } catch (err) {
        active = false;
        const message = `无法启动语音识别：${err?.message || err}`;
        if (typeof config.onError === 'function') config.onError(message, 'start-failed');
        return false;
      }
    },

    stop() {
      active = false;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      const rec = recognition;
      recognition = null;
      if (!rec) return;
      try {
        rec.onend = null;
        rec.stop();
      } catch {
        /* ignore */
      }
      try {
        rec.abort?.();
      } catch {
        /* ignore */
      }
      if (typeof config.onStateChange === 'function') config.onStateChange(false);
      if (typeof config.onEnd === 'function') config.onEnd('stopped');
    },

    isActive() {
      return active;
    },

    /** 本次会话累计的最终识别文本 */
    getFinalText() {
      return finalText;
    },

    /** 当前未定稿的 interim 文本（供 UI 显示灰色预览） */
    getInterimText() {
      return lastInterim;
    },

    reset() {
      finalText = '';
      lastInterim = '';
    },
  };
}

export default createSttEngine;
