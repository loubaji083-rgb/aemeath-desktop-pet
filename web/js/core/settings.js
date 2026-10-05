/**
 * 设置与持久化。
 *
 * 安全设计（重要）：
 *  - 普通偏好写 localStorage（键前缀 aemeath.prefs.）
 *  - API Key 等敏感值 **只**走 sessionStorage（键前缀 aemeath.secret.），
 *    标签页关闭即失效；默认不落盘到 localStorage。
 *    想彻底不落盘可在设置面板勾选「仅本次会话内存保存」（见 SECRET_MEMORY_ONLY）。
 */

import { emit, AppEvents } from './events.js';

export const NS_PREFS = 'aemeath.prefs.';
export const NS_SECRET = 'aemeath.secret.';

/** 设置项默认值。键名即 DOM 上的 data-setting 值。 */
export const DEFAULTS = {
  // —— 桌宠 ——
  'pet.scale': 1,
  'pet.showBubble': true,
  'pet.bubbleMs': 4200,
  'pet.followCursor': true,
  'pet.reducedMotion': false,
  'pet.mood': 'idle',
  'pet.affection': 0,

  // —— 聊天 ——
  'chat.baseUrl': 'https://api.deepseek.com',
  'chat.model': 'deepseek-chat',
  'chat.temperature': 1.3,
  'chat.maxTokens': 1024,
  'chat.stream': true,
  'chat.timeoutMs': 60000,
  'chat.personaPreset': 'lively-companion',
  'chat.userName': '你',
  'chat.rememberHistory': true,
  'chat.historyTurns': 20,
  'chat.autoSpeak': false,

  // —— 语音 ——
  'voice.enabled': true,
  'voice.ttsProvider': 'browser',
  'voice.browserVoiceURI': '',
  'voice.rate': 1.05,
  'voice.pitch': 1.35,
  'voice.volume': 1,
  'voice.sttLang': 'zh-CN',
  'voice.sttContinuous': true,
  'voice.ttsEndpoint': '',
  // 注意：voice.ttsApiKey / chat.apiKey / train.apiKey 这三个敏感键**故意不写在这里**，
  // 它们由下面的 SECRET_KEYS 单独管辖（走 sessionStorage，且绝不出现在 all() 里）。
  'voice.ttsModel': '',
  'voice.ttsVoice': '',
  'voice.autoListenAfterReply': false,

  // —— 声音训练（工具链，仓库不含任何权重） ——
  'train.endpoint': '',
  'train.queueEndpoint': '',
  'train.acknowledgeOwnership': false,
  'train.minClipSeconds': 3,
  'train.maxClipSeconds': 15,
  'train.targetSampleRate': 22050,

  // —— 界面 ——
  'ui.theme': 'auto',
  'ui.compact': false,
  'ui.language': 'zh-CN',
};

/** 普通偏好键（防脏数据，只允许这些键被 set） */
const ALLOWED_KEYS = new Set(Object.keys(DEFAULTS));

/**
 * 需要走 sessionStorage 的键（apiKey 类）。
 *
 * 注意（历史缺陷，已修）：这些键**故意不放进 DEFAULTS**，因此它们不在 ALLOWED_KEYS 里。
 * 读写两端的白名单必须都先放行 SECRET_KEYS，否则会出现「set 成功、get 返回 fallback」
 * 的静默失败（旧实现 get() 只认 ALLOWED_KEYS，导致 Settings.get('chat.apiKey') === undefined）。
 */
const SECRET_KEYS = new Set(['voice.ttsApiKey', 'chat.apiKey', 'train.apiKey']);

/** 合法键全集 = 偏好键 ∪ 敏感键；get/set 一律以此为白名单 */
const KNOWN_KEYS = new Set([...ALLOWED_KEYS, ...SECRET_KEYS]);

/**
 * 取某键的默认值。敏感键没有持久化默认值（一律空串，避免误填）。
 * @param {string} key
 */
function defaultFor(key) {
  if (SECRET_KEYS.has(key)) return '';
  return DEFAULTS[key];
}

/** 内存缓存：即使 sessionStorage 也不写 */
const memoryOnlySecrets = new Set();
const memorySecrets = new Map();

/**
 * 「调用方没传 fallback」的哨兵。
 *
 * 为什么不能用 `fallback ?? defaultFor(key)`：`??` 无法区分
 * 「没传 fallback」和「传了一个非 nullish 的 fallback」，于是
 * `get('chat.apiKey', '__MISSING__')` 会返回哨兵而不是文档承诺的空串——
 * 调用方就可能把兜底字符串当成用户填的真实 Key 发出去（静默失败）。
 */
const NO_FALLBACK = Symbol('aemeath.noFallback');

/**
 * 判断「调用方有没有给 fallback」。
 *
 * 哨兵负责区分「没传」和「传了 undefined」；再叠一个 `=== undefined` 是因为
 * 语义上 `get(key, undefined)` 与 `get(key)` 应当同义（不该把 undefined 当返回值用出去）。
 * 统一口径：**fallback 只在「没有已保存值」时决定返回什么，且 undefined 视同没传。**
 */
function isNoFallback(fallback) {
  return fallback === NO_FALLBACK || fallback === undefined;
}

/** 把可能缺省的 fallback 归一化成「一定有值」：没传就用默认值口径 */
function resolveFallback(key, fallback) {
  return isNoFallback(fallback) ? defaultFor(key) : fallback;
}

const changeHandlers = new Set();

function hasStorage(kind) {
  try {
    const s = kind === 'session' ? globalThis.sessionStorage : globalThis.localStorage;
    if (!s) return false;
    const probe = '__aemeath_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

const localStorageOk = hasStorage('local');
const sessionStorageOk = hasStorage('session');

function readRaw(kind, key) {
  try {
    const s = kind === 'session' ? globalThis.sessionStorage : globalThis.localStorage;
    return s ? s.getItem(key) : null;
  } catch {
    return null;
  }
}

function writeRaw(kind, key, value) {
  try {
    const s = kind === 'session' ? globalThis.sessionStorage : globalThis.localStorage;
    if (s) s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeRaw(kind, key) {
  try {
    const s = kind === 'session' ? globalThis.sessionStorage : globalThis.localStorage;
    if (s) s.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** localStorage 不可用时的内存兜底 */
const memoryPrefs = new Map();

/**
 * 把原始字符串转成该键应有的类型；没有已保存值时返回 fallback。
 *
 * 注意 `raw` 为 null 表示「这个键从没被保存过」——此时类型信息只能来自
 * defaultFor(key)，但**返回值**用调用方给的口径（fallback），
 * 这样 get(key) 与 get(key, fb) 只差在「没有值时给什么」这一件事上。
 */
function coerce(key, raw, fallback) {
  const def = defaultFor(key);
  const missing = resolveFallback(key, fallback);
  if (raw === null || raw === undefined) return missing;
  if (typeof def === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : missing;
  }
  if (typeof def === 'boolean') {
    return raw === true || raw === 'true' || raw === '1';
  }
  return String(raw);
}

function serialize(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function notify(key, value) {
  const all = Settings.all();
  for (const fn of [...changeHandlers]) {
    try {
      fn({ key, value, all });
    } catch (err) {
      console.warn('[aemeath:settings] onChange 回调异常', err);
    }
  }
  emit(AppEvents.SETTINGS_CHANGED, { key, value, all });
}

export const Settings = {
  /** 判断某键是否为敏感键 */
  isSecret(key) {
    return SECRET_KEYS.has(key);
  },

  /**
   * 读取设置。
   *
   * fallback 语义（全文件唯一口径，契约见 tests/settings.test.mjs 与 tests/lead-settings.test.mjs）：
   *  - **已知键一律不返回调用方的 fallback**：有保存值就给保存值，没有就给该键的默认值
   *    （敏感键的默认值是空串 `''`）。理由：key 拼错之外的一切情况都该读到「真实的设置」，
   *    把调用方的哨兵/默认值当结果返回，就会让人把 `'__MISSING__'` 这种字符串当真实
   *    配置（尤其是 API Key）用出去——这正是旧版静默失败的形态。
   *  - 未知键才返回 fallback（仍会 warn），这是 `get('x.y', 'FB')` 唯一的用途。
   *  - `get(key, undefined)` 与 `get(key)` 完全同义（undefined 视同没传，不会被当返回值）。
   *
   * ⚠️ 旧实现写的是 `fallback ?? defaultFor(key)`：`??` 分不清「没传」和「传了非
   * nullish 的哨兵」，于是 `get('chat.apiKey', '__MISSING__')` 在未配置时会把哨兵
   * 当成真实 Key 传下去。现在用 NO_FALLBACK 哨兵区分，别再退回 `??`。
   *
   * ⚠️ 第二个坑：`set()` 里也会调 coerce()，`set(k, 'not-a-number')` 时 fallback
   * 是省略的，必须回落到 DEFAULTS，否则会把 undefined 写进存储。
   *
   * @param {string} key
   * @param {*} [fallback] 仅在 key 未登记时使用
   */
  get(key, fallback = NO_FALLBACK) {
    if (!KNOWN_KEYS.has(key)) {
      console.warn(`[aemeath:settings] 未知设置键 "${key}"，返回 fallback`);
      return isNoFallback(fallback) ? undefined : fallback;
    }
    if (SECRET_KEYS.has(key)) return this.getSecret(key, defaultFor(key));
    if (!localStorageOk) {
      return memoryPrefs.has(key) ? memoryPrefs.get(key) : DEFAULTS[key];
    }
    return coerce(key, readRaw('local', NS_PREFS + key));
  },

  set(key, value) {
    if (SECRET_KEYS.has(key)) return this.setSecret(key, value);
    if (!KNOWN_KEYS.has(key)) {
      console.warn(`[aemeath:settings] 拒绝写入未知键 "${key}"`);
      return false;
    }
    const next = coerce(key, value);
    if (!localStorageOk) memoryPrefs.set(key, next);
    else writeRaw('local', NS_PREFS + key, serialize(next));
    notify(key, next);
    return true;
  },

  /** 全部偏好（不含密钥） */
  all() {
    const out = {};
    for (const key of ALLOWED_KEYS) out[key] = this.get(key);
    return out;
  },

  /** 只重置偏好，不动密钥 */
  reset() {
    for (const key of ALLOWED_KEYS) {
      if (SECRET_KEYS.has(key)) continue;
      if (!localStorageOk) memoryPrefs.delete(key);
      else removeRaw('local', NS_PREFS + key);
      notify(key, DEFAULTS[key]);
    }
  },

  // —— 敏感值 ——

  getSecret(key, fallback = '') {
    if (memoryOnlySecrets.has(key)) return memorySecrets.get(key) ?? fallback;
    if (!sessionStorageOk) return memorySecrets.get(key) ?? fallback;
    const v = readRaw('session', NS_SECRET + key);
    return v === null ? fallback : v;
  },

  setSecret(key, value, { memoryOnly = false } = {}) {
    const v = value == null ? '' : String(value);
    if (memoryOnly || !sessionStorageOk) {
      memoryOnlySecrets.add(key);
      memorySecrets.set(key, v);
    } else {
      memoryOnlySecrets.delete(key);
      writeRaw('session', NS_SECRET + key, v);
    }
    notify(key, v ? '***' : '');
    return true;
  },

  clearSecret(key) {
    memorySecrets.delete(key);
    memoryOnlySecrets.delete(key);
    removeRaw('session', NS_SECRET + key);
  },

  /** 供隐私说明与自检使用 */
  storageInfo() {
    return { localStorageOk, sessionStorageOk, secretKeys: [...SECRET_KEYS] };
  },

  /**
   * @param {(e:{key:string,value:any,all:object})=>void} fn
   * @returns {() => void}
   */
  onChange(fn) {
    changeHandlers.add(fn);
    return () => changeHandlers.delete(fn);
  },

  /** 把 DEFAULTS 里没有的持久化脏键清掉（升级用） */
  prune() {
    if (!localStorageOk) return 0;
    let removed = 0;
    try {
      const ls = globalThis.localStorage;
      for (let i = ls.length - 1; i >= 0; i -= 1) {
        const k = ls.key(i);
        if (k && k.startsWith(NS_PREFS)) {
          const bare = k.slice(NS_PREFS.length);
          if (!ALLOWED_KEYS.has(bare)) {
            ls.removeItem(k);
            removed += 1;
          }
        }
      }
    } catch {
      /* ignore */
    }
    return removed;
  },
};

export default Settings;
