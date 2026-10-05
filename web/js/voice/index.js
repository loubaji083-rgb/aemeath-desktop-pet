/**
 * Voice —— 语音门面（契约 §6）。
 *
 * 默认链路：浏览器内置 speechSynthesis（零网络、零依赖、开箱即用）。
 * 可选链路：用户**自配**的外部 HTTP TTS 端点（OpenAI 兼容 / GPT-SoVITS / Edge-TTS 风格）。
 *
 * 红线（与 docs/CONTRACT.md §0 一致，务必保持）：
 *  - 本仓库不内置任何预训练声线，不做声音克隆，不包含任何第三方音频；
 *  - 所有语音要么来自用户操作系统/浏览器自带的 TTS 引擎，要么来自用户自己部署并负责授权的服务端；
 *  - STT 只产出文本，不保存录音。
 *
 * 事件（契约 §3）：VOICE_TTS_START / VOICE_TTS_END / VOICE_STT_RESULT / VOICE_STATE，
 * 另外代桌宠发 PET_SPEAK_START / PET_SPEAK_END / PET_LISTEN_START / PET_LISTEN_END。
 */

import { emit, AppEvents } from '../core/events.js';
import { Settings } from '../core/settings.js';
import {
  createBrowserTts,
  isSupported as browserTtsSupported,
  pickVoice,
  splitSentences,
  PROVIDER_ID as BROWSER_ID,
  PROVIDER_NAME as BROWSER_NAME,
} from './browser-tts.js';
import { createHttpTts, HTTP_KINDS } from './http-tts.js';
import { createSttEngine, isSupported as sttSupported } from './stt.js';

export const DEFAULT_TTS_PROVIDER = 'browser';
export const VERSION = '1.0.0';

/** 提供方注册表：id -> { id, name, factory } */
const registry = new Map();

function register(id, name, factory) {
  registry.set(id, { id, name, factory });
}

register(BROWSER_ID, BROWSER_NAME, (config) => createBrowserTts(config));
register(HTTP_KINDS.OPENAI, 'OpenAI 兼容语音端点（需自配端点）', (config) =>
  createHttpTts(HTTP_KINDS.OPENAI, config),
);
register(HTTP_KINDS.GPTSOVITS, 'GPT-SoVITS 服务端（需自配端点）', (config) =>
  createHttpTts(HTTP_KINDS.GPTSOVITS, config),
);
register(HTTP_KINDS.EDGE, 'Edge-TTS 风格端点（需自配端点）', (config) => createHttpTts(HTTP_KINDS.EDGE, config));

/** 运行期状态 */
const state = {
  speaking: false,
  listening: false,
};

let onMouth = null; // 供 PetUI.setMouth 使用
let fetchImpl = null;
let timeoutMs = 30000;
let activeProvider = null; // 最近一次 speak 使用的实例（stop 必须打到同一个实例）
let currentToken = null; // { cancelled, provider }
let stt = null;
let cache = { id: '', sig: '', instance: null };

function clamp(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function emitState() {
  emit(AppEvents.VOICE_STATE, { speaking: state.speaking, listening: state.listening });
}

function setSpeaking(value) {
  if (state.speaking === value) return;
  state.speaking = value;
  emitState();
}

function setListening(value) {
  if (state.listening === value) return;
  state.listening = value;
  emitState();
}

function callMouth(value) {
  if (typeof onMouth !== 'function') return;
  try {
    onMouth(value);
  } catch (err) {
    console.warn('[aemeath:voice] onMouth 回调异常', err);
  }
}

function abortError(message = '朗读已被中断') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/** 从 Settings 组装提供方配置（每次 speak 现读，保证设置改动即时生效） */
function buildConfig() {
  return {
    endpoint: Settings.get('voice.ttsEndpoint', ''),
    apiKey: Settings.getSecret('voice.ttsApiKey', ''),
    model: Settings.get('voice.ttsModel', ''),
    voice: Settings.get('voice.ttsVoice', ''),
    voiceURI: Settings.get('voice.browserVoiceURI', ''),
    lang: Settings.get('voice.sttLang', 'zh-CN'),
    rate: clamp(Settings.get('voice.rate', 1), 0.1, 10, 1),
    pitch: clamp(Settings.get('voice.pitch', 1), 0, 2, 1),
    volume: clamp(Settings.get('voice.volume', 1), 0, 1, 1),
    timeoutMs,
    fetchImpl: fetchImpl || undefined,
  };
}

function currentProviderId() {
  const id = Settings.get('voice.ttsProvider', DEFAULT_TTS_PROVIDER) || DEFAULT_TTS_PROVIDER;
  return registry.has(id) ? id : DEFAULT_TTS_PROVIDER;
}

/** 解析当前生效的提供方实例；配置签名变化时重建 */
function resolveProvider(options = {}) {
  const id = currentProviderId();
  const entry = registry.get(id);
  if (!entry) return null;

  const config = buildConfig();
  const sig = JSON.stringify({
    id,
    endpoint: config.endpoint,
    apiKey: config.apiKey ? '***' : '',
    model: config.model,
    voice: config.voice,
    voiceURI: config.voiceURI,
    lang: config.lang,
    rate: config.rate,
    pitch: config.pitch,
    volume: config.volume,
  });

  if (!options.force && cache.id === id && cache.sig === sig && cache.instance) return cache.instance;

  const instance = entry.factory(config);
  if (!instance.id) instance.id = id;
  if (!instance.name) instance.name = entry.name;
  cache = { id, sig, instance };
  return instance;
}

/** 统一失败出口（契约 §8）：非中断错误 → console.warn + TOAST + CHAT_ERROR；中断错误 → 按契约 reject */
function reportFailure(err, rethrow, scopeText) {
  if (err && err.name === 'AbortError') throw err;
  const message = (err && err.message) || String(err);
  console.warn(`[aemeath:voice] ${scopeText}`, err);
  emit(AppEvents.TOAST, { text: `[语音] ${message}`, kind: 'error', ms: 4200 });
  emit(AppEvents.CHAT_ERROR, { message, detail: String(err?.stack || '') });
  if (rethrow) throw err;
  return undefined;
}

export const Voice = {
  version: VERSION,

  /**
   * 初始化（可重复调用，幂等）。
   * @param {{ onMouth?: (v:number)=>void, fetchImpl?: Function, timeoutMs?: number, provider?: string }} [opts]
   */
  init(opts = {}) {
    if (typeof opts.onMouth === 'function') onMouth = opts.onMouth;
    if (typeof opts.fetchImpl === 'function') fetchImpl = opts.fetchImpl;
    if (Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0) {
      timeoutMs = Number(opts.timeoutMs);
    }
    if (opts.provider && registry.has(opts.provider)) {
      Settings.set('voice.ttsProvider', opts.provider);
    }
    // 预热系统音色列表（部分浏览器首次 getVoices() 为空）
    try {
      resolveProvider();
    } catch (err) {
      console.warn('[aemeath:voice] 提供方初始化失败', err);
    }
    return Voice;
  },

  /**
   * 朗读文本。
   * - 成功：resolve(undefined)
   * - 被 stop()/新的 speak() 打断：reject 一个 name === 'AbortError' 的 Error（契约要求）
   * - 其它失败（端点未配置、网络错误等）：默认 emit TOAST + CHAT_ERROR 后 resolve；
   *   传 { rethrow: true } 则改为 reject，方便调用方自行处理。
   *
   * @param {string} text
   * @param {{ rethrow?: boolean }} [options]
   * @returns {Promise<void>}
   */
  async speak(text, { rethrow = false } = {}) {
    const content = String(text ?? '').trim();
    if (!content) return undefined;

    Voice.stop(); // 打断上一段

    let provider = null;
    const providerId = currentProviderId();
    try {
      provider = resolveProvider();
    } catch (err) {
      provider = null;
    }

    if (!provider) {
      return reportFailure(new Error(`语音提供方「${providerId}」未注册`), rethrow, '提供方不可用');
    }
    if (!provider.available) {
      const reason =
        provider.unavailableReason || `语音提供方「${providerId}」当前不可用（多为端点未配置）`;
      const err = new Error(reason);
      err.name = 'ConfigError';
      err.reason = 'unavailable';
      return reportFailure(err, rethrow, '提供方不可用');
    }

    const token = { cancelled: false, provider: providerId };
    currentToken = token;
    activeProvider = provider;

    setSpeaking(true);
    emit(AppEvents.VOICE_TTS_START, { text: content, provider: providerId });
    emit(AppEvents.PET_SPEAK_START, { text: content });

    let reason = 'completed';
    try {
      await provider.speak(content, { ...buildConfig(), onMouth });
      if (token.cancelled) throw abortError();
      return undefined;
    } catch (err) {
      reason = err && err.name === 'AbortError' ? 'aborted' : 'error';
      return reportFailure(err, rethrow, '朗读失败');
    } finally {
      if (currentToken === token) currentToken = null;
      setSpeaking(false);
      emit(AppEvents.VOICE_TTS_END, { provider: providerId, reason });
      emit(AppEvents.PET_SPEAK_END, { text: content });
      callMouth(0);
    }
  },

  /** 停止朗读并打断当前 Promise（会 reject AbortError） */
  stop() {
    const token = currentToken;
    if (token) token.cancelled = true;
    currentToken = null;
    const provider = activeProvider;
    if (provider && typeof provider.stop === 'function') {
      try {
        provider.stop();
      } catch (err) {
        console.warn('[aemeath:voice] 停止朗读失败', err);
      }
    }
    setSpeaking(false);
    callMouth(0);
  },

  /**
   * 开始持续识别。识别结果通过 VOICE_STT_RESULT { text, final } 抛出。
   * @returns {Promise<boolean>} 是否成功进入聆听状态（不支持时返回 false 并给出提示）
   */
  async startListening() {
    if (state.listening) return true;

    if (!sttSupported()) {
      const message = '当前浏览器不支持 Web Speech 识别（Firefox 暂不提供），可改用键盘输入';
      console.warn('[aemeath:voice] ' + message);
      emit(AppEvents.TOAST, { text: `[语音] ${message}`, kind: 'warn', ms: 4200 });
      return false;
    }

    if (stt) {
      stt.stop();
      stt = null;
    }

    stt = createSttEngine({
      lang: Settings.get('voice.sttLang', 'zh-CN'),
      continuous: Settings.get('voice.sttContinuous', true),
      interim: true,
      onError: (message, code) => {
        console.warn(`[aemeath:voice] STT 错误(${code})`, message);
        emit(AppEvents.TOAST, { text: `[语音] ${message}`, kind: 'warn', ms: 4200 });
      },
      onStateChange: (listening) => {
        if (!listening) {
          setListening(false);
          emit(AppEvents.PET_LISTEN_END, {});
        }
      },
    });

    const ok = stt.start();
    if (!ok) {
      stt = null;
      return false;
    }
    setListening(true);
    emit(AppEvents.PET_LISTEN_START, {});
    return true;
  },

  /** 停止识别 */
  stopListening() {
    const engine = stt;
    stt = null;
    if (engine) {
      try {
        engine.stop();
      } catch (err) {
        console.warn('[aemeath:voice] 停止识别失败', err);
      }
    }
    if (state.listening) {
      setListening(false);
      emit(AppEvents.PET_LISTEN_END, {});
    }
  },

  isSpeaking() {
    return state.speaking;
  },

  isListening() {
    return state.listening;
  },

  /** 本次会话累计的最终识别文本（便利接口） */
  getLastTranscript() {
    return stt?.getFinalText?.() || '';
  },

  /**
   * 注册/覆盖一个 TTS 提供方。
   * @param {string} id
   * @param {(config:object)=>{id?:string,name?:string,available:boolean,unavailableReason?:string,speak:Function,stop:Function}} factory
   */
  registerProvider(id, factory) {
    if (typeof id !== 'string' || !id.trim()) throw new TypeError('[aemeath:voice] registerProvider: id 必须是非空字符串');
    if (typeof factory !== 'function') throw new TypeError('[aemeath:voice] registerProvider: factory 必须是函数');
    if (registry.has(id)) console.warn(`[aemeath:voice] 覆盖已注册的语音提供方：${id}`);
    const name = factory.name || `自定义语音提供方（${id}）`;
    register(id, name, factory);
    cache = { id: '', sig: '', instance: null };
    return true;
  },

  /** @returns {Array<{id:string,name:string,available:boolean,detail:string}>} */
  listProviders() {
    const out = [];
    for (const entry of registry.values()) {
      let available = false;
      let detail = '';
      try {
        const instance = entry.factory(buildConfig());
        available = !!instance.available;
        detail = instance.unavailableReason || '';
      } catch (err) {
        detail = `实例化失败：${err?.message || err}`;
      }
      out.push({ id: entry.id, name: entry.name, available, detail });
    }
    return out;
  },

  /** 列出系统音色（仅浏览器内置链路；其它链路返回空数组） */
  listBrowserVoices() {
    if (currentProviderId() !== BROWSER_ID) return [];
    try {
      return resolveProvider()?.listVoices?.() || [];
    } catch {
      return [];
    }
  },

  /**
   * 当前生效链路的自检。
   * @param {{ probe?: boolean }} [opts] probe=true 时会真的向 HTTP 端点发一条极短请求（会占用额度）
   * @returns {Promise<{ok:boolean, provider:string, detail:string}>}
   */
  async selfTest(opts = {}) {
    const id = currentProviderId();
    const entry = registry.get(id);
    if (!entry) {
      return { ok: false, provider: id, detail: `语音提供方「${id}」未注册` };
    }

    let instance = null;
    try {
      instance = resolveProvider({ force: true });
    } catch (err) {
      return { ok: false, provider: id, detail: `实例化失败：${err?.message || err}` };
    }

    if (id === BROWSER_ID) {
      if (!browserTtsSupported()) {
        return { ok: false, provider: id, detail: '当前浏览器不支持 speechSynthesis（可改用外部 HTTP 端点）' };
      }
      const voices = instance?.listVoices?.() || [];
      if (!voices.length) {
        return {
          ok: true,
          provider: id,
          detail: 'speechSynthesis 可用，但音色列表尚未加载（切换页面或稍候会触发 voiceschanged）',
        };
      }
      const chosen = pickVoice(voices, {
        voiceURI: Settings.get('voice.browserVoiceURI', ''),
        lang: Settings.get('voice.sttLang', 'zh-CN'),
      });
      return {
        ok: true,
        provider: id,
        detail: `speechSynthesis 可用，系统共 ${voices.length} 个音色，将使用「${chosen?.name || '系统默认'}」`,
      };
    }

    if (!instance || !instance.available) {
      return { ok: false, provider: id, detail: instance?.unavailableReason || '端点未配置' };
    }
    const endpoint = Settings.get('voice.ttsEndpoint', '');
    if (!opts.probe) {
      return {
        ok: true,
        provider: id,
        detail: `已配置端点 ${endpoint}（未发起网络请求；selfTest({ probe: true }) 可实测，会占用少量额度）`,
      };
    }
    try {
      await instance.speak('测试', { ...buildConfig(), onMouth: null });
      return { ok: true, provider: id, detail: `端点实测成功：${endpoint}` };
    } catch (err) {
      return { ok: false, provider: id, detail: `端点实测失败：${err?.message || err}` };
    }
  },
};

/** 设置变更时清掉提供方缓存，下一次 speak 重建 */
Settings.onChange(({ key }) => {
  if (typeof key === 'string' && key.startsWith('voice.')) {
    cache = { id: '', sig: '', instance: null };
  }
});

export { splitSentences, pickVoice, HTTP_KINDS, sttSupported, browserTtsSupported };
export default Voice;
