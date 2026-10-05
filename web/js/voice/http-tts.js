/**
 * 可选的外部 HTTP TTS 适配器（三种形态）。
 *
 *   - 'http-openai'   ：OpenAI 兼容的 POST {endpoint}/v1/audio/speech
 *   - 'http-gptsovits'：GPT-SoVITS 服务端 POST {endpoint}/tts（endpoint 已含 /tts 或 /inference 时原样使用）
 *   - 'http-edge'     ：Edge-TTS 风格的 POST {endpoint}
 *
 * 统一工厂签名（契约 §6）：
 *   (config) => { id, name, available, unavailableReason, async speak(text, opts), stop() }
 *
 * config：{ endpoint, apiKey, model, voice, lang, format, timeoutMs, fetchImpl, onMouth, onAudio }
 *
 * 红线与边界：
 *  - 本文件不做任何声音克隆推理；它只把**文本**POST 给用户自己部署/自己配置的服务端。
 *  - 不内置任何预训练声线、不下载任何模型权重、不爬取任何音频。
 *  - 'http-gptsovits' 的 ref_audio_path 是**用户自己服务端上的路径**，由用户负责其授权。
 *  - 端点未配置时 available=false，speak() 会抛出带 reason='no-endpoint' 的明确错误（不静默失败）。
 */

import { createMouthDriver, estimateSpeechMs } from './mouth.js';

export const HTTP_KINDS = Object.freeze({
  OPENAI: 'http-openai',
  GPTSOVITS: 'http-gptsovits',
  EDGE: 'http-edge',
});

const KIND_META = {
  [HTTP_KINDS.OPENAI]: { name: 'OpenAI 兼容语音端点（/v1/audio/speech）', defaultPath: '/v1/audio/speech' },
  [HTTP_KINDS.GPTSOVITS]: { name: 'GPT-SoVITS 服务端（/tts）', defaultPath: '/tts' },
  [HTTP_KINDS.EDGE]: { name: 'Edge-TTS 风格端点', defaultPath: '' },
};

function clamp(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function abortError(message = '朗读已被中断') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function configError(message, reason) {
  const err = new Error(message);
  err.name = 'ConfigError';
  if (reason) err.reason = reason;
  return err;
}

/** 'zh-CN' -> 'zh'，其余保持原样 */
export function toShortLang(lang) {
  const s = String(lang || 'zh-CN').trim();
  return s.split(/[-_]/)[0] || 'zh';
}

/**
 * 计算最终请求 URL（纯函数，可单测）。
 * 规则：端点为空返回 ''；已经带目标路径就不重复拼接；端点以 /v1 结尾时补 /audio/speech。
 */
export function resolveSpeechUrl(kind, endpoint) {
  const base = String(endpoint || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (kind === HTTP_KINDS.OPENAI) {
    if (/\/v1\/audio\/speech$/i.test(base)) return base;
    if (/\/v1$/i.test(base)) return `${base}/audio/speech`;
    return `${base}${KIND_META[kind].defaultPath}`;
  }
  if (kind === HTTP_KINDS.GPTSOVITS) {
    if (/\/(tts|inference)$/i.test(base)) return base;
    return `${base}${KIND_META[kind].defaultPath}`;
  }
  return base;
}

/** 构造请求体（纯函数，可单测）。缺少必要配置时抛 ConfigError。 */
export function buildRequestBody(kind, text, config = {}, opts = {}) {
  const rate = clamp(opts.rate ?? config.rate, 0.25, 4, 1);
  const pitch = clamp(opts.pitch ?? config.pitch, 0.5, 2, 1);
  const lang = config.lang || opts.lang || 'zh-CN';

  if (kind === HTTP_KINDS.OPENAI) {
    return {
      model: config.model || 'tts-1',
      input: text,
      voice: config.voice || 'alloy',
      response_format: config.format || 'mp3',
      speed: rate,
    };
  }

  if (kind === HTTP_KINDS.GPTSOVITS) {
    if (!config.voice) {
      throw configError(
        '未配置服务端参考音频路径（voice.ttsVoice）：GPT-SoVITS 需要一个你自己服务端上的 ref_audio_path，且必须是你本人声音或已获得书面授权的声音',
        'missing-voice',
      );
    }
    return {
      text,
      text_lang: toShortLang(lang),
      ref_audio_path: config.voice,
      prompt_text: config.promptText || '',
      prompt_lang: toShortLang(config.promptLang || lang),
      media_type: config.format || 'wav',
      streaming_mode: false,
      speed_factor: clamp(rate, 0.5, 2, 1),
    };
  }

  if (kind === HTTP_KINDS.EDGE) {
    if (!config.voice) {
      throw configError(
        '未配置音色 ID（voice.ttsVoice）：Edge-TTS 风格端点需要一个服务端音色标识，请填写你所用服务支持的 voice id',
        'missing-voice',
      );
    }
    const ratePercent = Math.round((clamp(rate, 0.5, 3, 1) - 1) * 100);
    const pitchHz = Math.round((pitch - 1) * 50);
    return {
      text,
      voice: config.voice,
      rate: `${ratePercent >= 0 ? '+' : ''}${ratePercent}%`,
      pitch: `${pitchHz >= 0 ? '+' : ''}${pitchHz}Hz`,
      volume: `${Math.round((clamp(opts.volume ?? config.volume, 0, 1, 1) - 1) * 100)}%`,
    };
  }

  throw configError(`未知的 HTTP 语音类型：${kind}`, 'unknown-kind');
}

/** 从 JSON 响应里找 base64 音频字段 */
function pickBase64Audio(data) {
  if (!data || typeof data !== 'object') return '';
  const candidates = [data.audio, data.audio_base64, data.audioContent, data.data, data.result];
  for (const item of candidates) {
    if (typeof item === 'string' && item.length > 64) return item;
    if (item && typeof item === 'object' && typeof item.data === 'string' && item.data.length > 64) {
      return item.data;
    }
  }
  return '';
}

/** base64（含 data URL 前缀）转 Blob */
export function base64ToBlob(b64, mime = 'audio/wav') {
  let raw = String(b64 || '').trim();
  let type = mime;
  const m = /^data:([^;,]+)?(;base64)?,/.exec(raw);
  if (m) {
    if (m[1]) type = m[1];
    raw = raw.slice(m[0].length);
  }
  const binary = globalThis.atob ? globalThis.atob(raw) : Buffer.from(raw, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** 把响应体解析成音频 Blob */
async function extractAudioBlob(res) {
  const contentType = String(res.headers?.get?.('content-type') || '').toLowerCase();
  if (contentType.includes('json')) {
    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      throw new Error(`语音端点返回了无法解析的 JSON：${err?.message || err}`);
    }
    const b64 = pickBase64Audio(data);
    if (!b64) {
      throw new Error('语音端点返回了 JSON，但未找到音频字段（audio / audio_base64 / audioContent / data）');
    }
    return base64ToBlob(b64, data?.format === 'mp3' ? 'audio/mpeg' : 'audio/wav');
  }
  const buf = await res.arrayBuffer();
  if (!buf || buf.byteLength === 0) throw new Error('语音端点返回了空响应');
  return new Blob([buf], { type: contentType || 'audio/mpeg' });
}

/**
 * 创建 HTTP TTS 提供方实例。
 *
 * @param {'http-openai'|'http-gptsovits'|'http-edge'} kind
 * @param {object} [config]
 */
export function createHttpTts(kind, config = {}) {
  const meta = KIND_META[kind] || { name: `HTTP 语音端点（${kind}）`, defaultPath: '' };
  let current = null; // { token, mouth, audio, url, finishPlayback, reject }

  const endpoint = String(config.endpoint || '').trim();
  const available = endpoint.length > 0;

  function stop() {
    const record = current;
    if (!record) return;
    current = null;
    record.token.cancelled = true;
    try {
      if (record.audio) {
        record.audio.onended = null;
        record.audio.onerror = null;
        record.audio.pause();
        record.audio.src = '';
      }
    } catch {
      /* ignore */
    }
    if (record.url) {
      try {
        URL.revokeObjectURL(record.url);
      } catch {
        /* ignore */
      }
      record.url = null;
    }
    record.mouth.stop();
    if (typeof record.finishPlayback === 'function') record.finishPlayback();
    if (typeof record.reject === 'function') record.reject(abortError());
    record.finishPlayback = null;
    record.reject = null;
  }

  async function request(url, text, opts) {
    const fetchImpl = config.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error('当前环境没有可用的 fetch，无法调用外部语音端点');
    }
    const body = buildRequestBody(kind, text, config, opts);
    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

    const timeoutMs = clamp(config.timeoutMs, 1000, 120000, 30000);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      });
      if (!res || res.ok !== true) {
        let snippet = '';
        try {
          snippet = String(await res.text()).slice(0, 300);
        } catch {
          /* ignore */
        }
        const status = res ? `${res.status} ${res.statusText || ''}`.trim() : '无响应';
        throw new Error(`语音端点返回 ${status}${snippet ? `：${snippet}` : ''}`);
      }
      return res;
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new Error(`语音端点请求超时（${timeoutMs}ms）`);
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function play(blob, { estMs, volume, token, mouth, record }) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      record.audio = audio;
      record.url = url;
      audio.volume = clamp(volume, 0, 1, 1);

      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        audio.onended = null;
        audio.onerror = null;
        audio.ontimeupdate = null;
        try {
          audio.pause();
        } catch {
          /* ignore */
        }
        if (err) reject(err);
        else resolve();
      };
      record.finishPlayback = () => finish(abortError());

      audio.onended = () => finish(null);
      audio.onerror = () => finish(new Error('音频播放失败：端点返回的音频格式可能不被当前浏览器支持'));
      audio.ontimeupdate = () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          mouth.setTotal(audio.duration * 1000);
        }
      };

      mouth.start(estMs);
      const p = audio.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          if (token.cancelled) finish(abortError());
        }).catch((err) => {
          finish(new Error(`浏览器拒绝了音频自动播放（需要先与页面交互）：${err?.message || err}`));
        });
      }
    });
  }

  async function speak(text, opts = {}) {
    stop();
    const content = String(text ?? '').trim();
    if (!content) return;

    const url = resolveSpeechUrl(kind, config.endpoint);
    if (!url) {
      throw configError(
        '未配置语音端点（设置 → 语音 → 端点）。本仓库不内置任何声线，请填写你自己部署或已获授权的服务地址',
        'no-endpoint',
      );
    }

    const token = { cancelled: false };
    const mouth = createMouthDriver(opts.onMouth || config.onMouth || null);
    const record = { token, mouth, audio: null, url: null, finishPlayback: null, reject: null };
    current = record;

    return new Promise((resolve, reject) => {
      record.reject = reject;
      (async () => {
        try {
          const res = await request(url, content, opts);
          if (token.cancelled) throw abortError();
          const blob = await extractAudioBlob(res);
          if (token.cancelled) throw abortError();
          if (typeof config.onAudio === 'function') {
            try {
              config.onAudio(blob, { kind, text: content });
            } catch (err) {
              console.warn('[aemeath:voice] onAudio 回调异常', err);
            }
          }
          await play(blob, {
            estMs: estimateSpeechMs(content, opts.rate ?? config.rate),
            volume: opts.volume ?? config.volume,
            token,
            mouth,
            record,
          });
          if (token.cancelled) throw abortError();
          resolve();
        } catch (err) {
          reject(token.cancelled ? abortError() : err);
        } finally {
          mouth.stop();
          if (record.url) {
            try {
              URL.revokeObjectURL(record.url);
            } catch {
              /* ignore */
            }
            record.url = null;
          }
          if (current === record) current = null;
        }
      })();
    });
  }

  return {
    id: kind,
    name: meta.name,
    available,
    unavailableReason: available
      ? ''
      : '未配置语音端点：请在设置里填写 voice.ttsEndpoint（本仓库不内置任何声线）',
    speak,
    stop,
  };
}

export const createOpenAiTts = (config) => createHttpTts(HTTP_KINDS.OPENAI, config);
export const createGptSoVitsTts = (config) => createHttpTts(HTTP_KINDS.GPTSOVITS, config);
export const createEdgeTts = (config) => createHttpTts(HTTP_KINDS.EDGE, config);

export default createHttpTts;
