/**
 * 口型驱动（TTS 通用工具）。
 *
 * TTS 有多条链路（浏览器内置 speechSynthesis / 用户自配的 HTTP 音频端点），
 * 它们都不保证提供逐音素的时间信息，所以这里统一用「时间包络 + 音节抖动」
 * 估算张嘴幅度，通过 onMouth(0..1) 回调喂给 PetUI.setMouth()。
 *
 * 设计约束：
 *  - 纯时间驱动，不依赖 DOM / 不依赖任何 TTS 实现，方便单测与复用；
 *  - 不依赖 requestAnimationFrame（页面切到后台时 rAF 会被节流，口型会卡住）；
 *  - 幅度经过 attack/release 包络，避免突然满嘴或突然闭嘴。
 *
 * 红线：本文件与语音模块的任何文件都不包含预训练声线、不做声音克隆。
 */

/** 口型刷新间隔（毫秒）。60ms ≈ 16fps，对嘴型足够且开销极小。 */
export const MOUTH_TICK_MS = 60;

/** 极简数值裁剪（避免为一个函数 import 整个 core/dom.js）。 */
function clamp(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 粗略估算一段文本的朗读时长（毫秒）。
 * 中文按 ~4.5 字/秒，其它字符按 ~14 字符/秒，再按 rate 缩放。
 * 只用于口型包络与超时兜底，不要求精确。
 *
 * @param {string} text
 * @param {number} [rate]
 * @returns {number}
 */
export function estimateSpeechMs(text, rate = 1) {
  const s = String(text ?? '');
  if (!s) return 0;
  const cjk = (s.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/g) || []).length;
  const other = Math.max(0, s.length - cjk);
  const baseMs = (cjk / 4.5 + other / 14) * 1000;
  const r = clamp(rate, 0.1, 10, 1);
  return Math.max(280, baseMs / r);
}

/**
 * 创建一个口型驱动器。
 *
 * @param {(value:number)=>void} onMouth 回调，参数 0..1
 * @param {{tickMs?:number}} [options]
 * @returns {{
 *   start:(estMs:number)=>void,
 *   hint:()=>void,
 *   setTotal:(ms:number)=>void,
 *   stop:()=>void,
 *   isRunning:()=>boolean,
 * }}
 */
export function createMouthDriver(onMouth, options = {}) {
  const tickMs = clamp(options.tickMs, 16, 500, MOUTH_TICK_MS);
  let timer = null;
  let startedAt = 0;
  let totalMs = 0;
  let closeMs = 160;
  let boost = 0;

  function call(v) {
    if (typeof onMouth !== 'function') return;
    try {
      onMouth(v);
    } catch (err) {
      console.warn('[aemeath:voice] onMouth 回调异常', err);
    }
  }

  function frame() {
    const elapsed = Date.now() - startedAt;
    const remain = totalMs - elapsed;
    // 包络：起始 70ms 渐强，结尾 closeMs 渐弱
    let env = 1;
    if (elapsed < 70) env = elapsed / 70;
    if (remain < closeMs) env = Math.max(0, remain / closeMs);

    const t = elapsed / 1000;
    // 8.6Hz 主开合 + 5.3Hz 抖动，模拟连续语音里的音节节奏
    const jaw = 0.44 + 0.34 * Math.sin(t * 2 * Math.PI * 8.6) + 0.18 * Math.sin(t * 2 * Math.PI * 5.3 + 1.1);
    const v = Math.max(0, Math.min(1, (jaw + boost) * env));
    if (boost > 0) boost = Math.max(0, boost - 0.06);
    call(v);
  }

  return {
    start(estMs) {
      this.stop();
      startedAt = Date.now();
      totalMs = Math.max(280, Number(estMs) || 0);
      closeMs = Math.min(160, totalMs * 0.25);
      boost = 0;
      frame();
      timer = setInterval(frame, tickMs);
    },

    /** 收到 boundary / 字幕边界时调用，给一点幅度加成，让嘴型更贴合音节 */
    hint() {
      boost = Math.min(0.22, boost + 0.16);
    },

    /** 用真实音频进度校准包络（HTTP 音频流拿到 duration 后调用） */
    setTotal(ms) {
      const n = Number(ms);
      if (!Number.isFinite(n) || n <= 0) return;
      const elapsed = Date.now() - startedAt;
      totalMs = Math.max(280, n);
      startedAt = Date.now() - Math.min(elapsed, totalMs * 0.9);
      closeMs = Math.min(160, totalMs * 0.25);
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      call(0);
    },

    isRunning() {
      return timer !== null;
    },
  };
}

export default createMouthDriver;
