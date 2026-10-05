/**
 * 极简事件总线（零依赖）。
 * 契约见 docs/CONTRACT.md §3。
 */

/** @type {Map<string, Set<Function>>} */
const listeners = new Map();

/**
 * 订阅事件。
 * @param {string} type
 * @param {(payload:any)=>void} handler
 * @returns {() => void} 取消订阅
 */
export function on(type, handler) {
  if (typeof type !== 'string' || typeof handler !== 'function') {
    throw new TypeError('[aemeath:events] on(type, handler) 参数非法');
  }
  let set = listeners.get(type);
  if (!set) {
    set = new Set();
    listeners.set(type, set);
  }
  set.add(handler);
  return () => off(type, handler);
}

/**
 * 只订阅一次。
 * @param {string} type
 * @param {(payload:any)=>void} handler
 * @returns {() => void}
 */
export function once(type, handler) {
  const wrapped = (payload) => {
    off(type, wrapped);
    handler(payload);
  };
  return on(type, wrapped);
}

/**
 * 取消订阅。不传 handler 时清空该事件的全部订阅。
 * @param {string} type
 * @param {(payload:any)=>void} [handler]
 */
export function off(type, handler) {
  const set = listeners.get(type);
  if (!set) return;
  if (!handler) {
    set.clear();
    return;
  }
  set.delete(handler);
}

/**
 * 发布事件。订阅者抛错不会影响其他订阅者，也不会影响发布方。
 * @param {string} type
 * @param {any} [payload]
 */
export function emit(type, payload) {
  const set = listeners.get(type);
  if (!set || set.size === 0) return;
  // 复制一份，允许订阅者在回调里 off 自己
  for (const fn of [...set]) {
    try {
      fn(payload);
    } catch (err) {
      console.warn(`[aemeath:events] 订阅者异常 (${type})`, err);
    }
  }
}

export function listenerCount(type) {
  return listeners.get(type)?.size ?? 0;
}

export function clearAllListeners() {
  listeners.clear();
}

export const AppEvents = {
  READY: 'app:ready',

  PET_CLICK: 'pet:click',
  PET_DRAG_START: 'pet:drag:start',
  PET_DRAG_END: 'pet:drag:end',
  PET_POKE: 'pet:poke',
  PET_MOOD: 'pet:mood',
  PET_BUBBLE: 'pet:bubble',
  PET_SPEAK_START: 'pet:speak:start',
  PET_SPEAK_END: 'pet:speak:end',
  PET_LISTEN_START: 'pet:listen:start',
  PET_LISTEN_END: 'pet:listen:end',
  PET_THINK: 'pet:think',

  CHAT_SEND: 'chat:send',
  CHAT_DELTA: 'chat:delta',
  CHAT_DONE: 'chat:done',
  CHAT_ERROR: 'chat:error',

  VOICE_TTS_START: 'voice:tts:start',
  VOICE_TTS_END: 'voice:tts:end',
  VOICE_STT_RESULT: 'voice:stt:result',
  VOICE_STATE: 'voice:state',

  PANEL_TOGGLE: 'panel:toggle',
  SETTINGS_CHANGED: 'settings:changed',
  TOAST: 'ui:toast',
};
