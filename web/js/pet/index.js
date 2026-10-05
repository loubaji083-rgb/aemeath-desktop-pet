/**
 * Aemeath 桌宠 —— PetUI 入口（契约 §4 的唯一实现）
 *
 * 对外契约（逐字遵守 docs/CONTRACT.md §4）：
 *   export const PetUI = {
 *     version, mount(canvas, opts), update(dt), unmount(),
 *     trigger(action), setMood(mood), getMood(), hitTest(x, y),
 *     lookAt(x, y), setMouth(value), attachLive2D(model), getDebugState(),
 *   };
 *   export const ACTIONS = [...12 个 id];
 *
 * 本文件只做"组装 + 生命周期"，具体算法在：
 *   constants.js    几何/色板/时序常量
 *   rig.js          弹簧骨骼与 12 个动作（纯逻辑）
 *   draw.js         纯 Canvas 2D 分层绘制
 *   interactions.js 指针手势与命中判定
 *   bubble.js       画布内对话气泡
 *
 * 与其他模块的关系：
 *   - 只依赖 core/events.js（事件总线）与 core/settings.js（设置读写），不碰 DOM 结构。
 *   - 气泡：订阅 `PET_BUBBLE` 自己画；`PET_SPEAK_START/END` 驱口型；`PET_THINK` 驱思考特效。
 *   - 卸载：unsubscribe + removeEventListener + cancelAnimationFrame 全部归零，不留引用。
 */

import { CANVAS_W, CANVAS_H, TARGET_FPS, TIMING, IDLE_ACTIONS, ORIGIN_X, ORIGIN_Y, HIT_PARTS } from './constants.js';
import { Rig, ACTION_IDS } from './rig.js';
import { drawPet } from './draw.js';
import { Interactions, hitTest as hitTestImpl } from './interactions.js';
import { Bubble } from './bubble.js';

/* ───────────────────────── core 依赖 ───────────────────────── */

import { on as busOn, emit as busEmit, off as busOff, AppEvents } from '../core/events.js';
import { Settings } from '../core/settings.js';

/** 事件总线（core/events.js）；本模块只订阅、只发，不改总线实现 */
const bus = { on: busOn, emit: busEmit, off: busOff };

/** core/events.js 的 AppEvents 键名（全部取自 core，避免字面量写错） */
const EV = {
  PET_CLICK: AppEvents.PET_CLICK,
  PET_DRAG_START: AppEvents.PET_DRAG_START,
  PET_DRAG_END: AppEvents.PET_DRAG_END,
  PET_POKE: AppEvents.PET_POKE,
  PET_MOOD: AppEvents.PET_MOOD,
  PET_BUBBLE: AppEvents.PET_BUBBLE,
  PET_SPEAK_START: AppEvents.PET_SPEAK_START,
  PET_SPEAK_END: AppEvents.PET_SPEAK_END,
  PET_LISTEN_START: AppEvents.PET_LISTEN_START,
  PET_LISTEN_END: AppEvents.PET_LISTEN_END,
  PET_THINK: AppEvents.PET_THINK,
  SETTINGS_CHANGED: AppEvents.SETTINGS_CHANGED,
};

/** 设置读取：全部走 core/settings.js（含 DEFAULTS 与 localStorage 持久化） */
function getSetting(key) {
  return Settings.get(key);
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/* ───────────────────────── 模块级单例状态 ───────────────────────── */

let mounted = false;
/** 单例：分辨率/DPR 状态 */
const view = {
  canvas: null,
  ctx: null,
  dpr: 1,
  cssW: CANVAS_W,
  cssH: CANVAS_H,
  scale: 1,
};

let rig = null;
let input = null;
let bubble = null;

/** 一次性的解绑函数集合（unmount 时全跑一遍） */
let disposers = [];

/** 帧循环状态 */
let rafId = 0;
let lastTs = 0;
let running = false;
/**
 * 宿主是否自己驱动循环（app.js 的 RAF 循环会调 PetUI.update）。
 * 一旦检测到外部驱动，就停掉 mount 内部自带的 RAF，否则同一帧会被推进两次。
 */
let externallyDriven = false;
let timeSec = 0;
let fpsAcc = 0;
let fpsFrames = 0;
let fps = TARGET_FPS;

/** 交互派生状态 */
let mouthOverride = -1; // <0 表示交还 rig 内部节拍
let speaking = false;
let listening = false;
let thinking = false;
let idleTimer = 0;
let idleNext = 0;
/** 复用的绘制选项对象，避免每帧分配 */
const drawOpts = { time: 0, phase: 0, debug: false };

/** 供 pointer/hitTest 使用：当前姿态（rig 挂载后指向其 params，零拷贝） */
function currentPose() {
  return rig ? rig.getPose() : undefined;
}

/* ───────────────────────── 尺寸 / DPR ───────────────────────── */

/**
 * 宿主是否已经接管了缩放。
 *
 * app.js 的 `applyPetScale()` 会给 `#pet-stage` 写 `transform: scale(s)`（origin bottom right），
 * 而契约把 `scale` 也交给了 `PetUI.mount(canvas, { scale })`。两边各缩一次 = s²，
 * `pet.scale = 2` 会变成 4 倍大。检测到祖先链上已有 scale 变换时就让位，保证总缩放恰好是 s。
 * 独立嵌入（无 #pet-stage）时祖先没有变换，我们照常自己缩。
 */
function hostOwnsScale(canvas) {
  let el = canvas && canvas.parentElement;
  for (let i = 0; i < 4 && el; i++, el = el.parentElement) {
    const t = el.style && el.style.transform;
    if (t && /\bscale\(/.test(t)) return true;
  }
  return false;
}

/**
 * 应用 pet.scale。用 CSS transform 缩放外层 wrap，**不改变 canvas 逻辑坐标系**，
 * 所以命中判定（用 clientWidth 归一化）在任意缩放下都正确。
 */
function applyScale(scale) {
  const s = clamp(Number(scale) || 1, 0.5, 2.5);
  view.scale = s;
  const wrap = view.canvas && view.canvas.parentElement;
  if (!wrap || !wrap.style) return;
  if (hostOwnsScale(view.canvas)) {
    wrap.style.transform = '';
    wrap.style.transformOrigin = '50% 100%';
    return;
  }
  wrap.style.transform = s === 1 ? '' : `scale(${s})`;
  wrap.style.transformOrigin = '50% 100%';
}

/**
 * 让后备像素缓冲匹配 devicePixelRatio，避免高分屏发虚。
 * 逻辑坐标系永远是 360×480，通过 setTransform 把 dpr 折进变换里。
 */
function syncBackingStore() {
  const c = view.canvas;
  if (!c) return;
  const dpr = clamp((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 1, 3);
  const wantW = Math.round(CANVAS_W * dpr);
  const wantH = Math.round(CANVAS_H * dpr);
  view.dpr = dpr;
  view.cssW = CANVAS_W;
  view.cssH = CANVAS_H;
  if (c.width !== wantW || c.height !== wantH) {
    c.width = wantW;
    c.height = wantH;
  }
  // CSS 尺寸固定为逻辑尺寸（scale 由 wrap 的 transform 负责）
  if (c.style) {
    c.style.width = `${CANVAS_W}px`;
    c.style.height = `${CANVAS_H}px`;
  }
  const ctx = view.ctx;
  if (ctx && typeof ctx.setTransform === 'function') {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

/* ───────────────────────── 坐标口径 ───────────────────────── */

/**
 * 入参坐标 = **canvas 逻辑坐标**，即契约定义的 360×480 设备像素无关空间
 * （§4 第 110 行「canvas 坐标」、第 112 行「设备像素无关的层坐标」）。
 *
 * 这里**刻意不做任何换算**，尤其是**绝不能**按 `canvas.width`（= 360 × devicePixelRatio 的
 * 后备像素尺寸）去折回 —— 那会把按逻辑坐标传入的调用方直接除以 dpr，命中判定整体错位。
 * 宿主若按后备像素换算，属宿主侧口径错误，应在宿主侧改为乘 `canvas.clientWidth`（或常量 360）。
 *
 * 保留这个函数是为了给上面的约定留一个唯一出口 / 单一事实点。
 */
function toLogical(x, y) {
  return { x, y };
}

/* ───────────────────────── 交互 ───────────────────────── */

function makeInput() {
  return new Interactions(view.canvas, {
    getPose: currentPose,
    onHover: (x, y) => {
      if (!rig) return;
      rig.lookAt(x, y);
    },
    onTap: (part, x, y) => {
      if (!rig) return;
      handleTap(part, x, y, 1);
    },
    onDoubleTap: (part, x, y) => {
      if (!rig) return;
      handleTap(part, x, y, 2);
      trigger('double-tap', { force: true });
      emit(EV.PET_CLICK, { part, x, y, count: 2 });
    },
    onLongPress: (part, x, y) => {
      if (!rig) return;
      trigger('long-press', { force: true });
      emit(EV.PET_POKE, { part });
      emit(EV.PET_CLICK, { part, x, y, count: 3 });
    },
    onDragStart: (part, x, y) => {
      if (!rig) return;
      rig.setContinuous('drag', true);
      setClass('pet-dragging', true);
      emit(EV.PET_DRAG_START, { part, x, y });
    },
    onDrag: (dx, dy) => {
      if (!rig) return;
      rig.setDragOffset(dx, dy);
      rig.setDragVelocity(dx * 0.55, dy * 0.55);
    },
    onDragEnd: (dx, dy, x, y) => {
      if (!rig) return;
      rig.setDragVelocity(dx * 0.55, dy * 0.55);
      rig.setContinuous('drag', false);
      setClass('pet-dragging', false);
      trigger('drop', { force: true });
      emit(EV.PET_DRAG_END, { x, y });
    },
  });
}

/** 单击/双击落到具体部位动作 */
function handleTap(part, x, y, count) {
  const action = part === 'hair' ? 'tap-head' : part === 'none' ? null : `tap-${part}`;
  if (action) trigger(action);
  emit(EV.PET_CLICK, { part, x, y, count });
  if (part !== 'none') emit(EV.PET_POKE, { part });
}

/* ───────────────────────── 动作 / 情绪 ───────────────────────── */

/** 复用的微任务：契约要求 trigger 返回 Promise<boolean> */
function resolved(value) {
  return Promise.resolve(!!value);
}

/**
 * 触发动作。带冷却去抖（constants.ACTION_COOLDOWN）：
 * 冷却中且非 force 时返回 false，避免连点把动画刷爆。
 */
function trigger(action, opts = {}) {
  if (!rig || typeof action !== 'string') return resolved(false);
  if (!ACTION_IDS.includes(action)) return resolved(false);
  // 冷却去抖在 Rig 内部完成（constants.ACTION_COOLDOWN）；force 供手势层越过冷却
  const ok = rig.trigger(action, { variant: opts.variant ?? null, force: !!opts.force });
  if (ok) {
    // 打招呼/睡觉这类会影响"整体状态"的动作，把情绪也带上，画面更连贯
    if (action === 'greet') setMood('happy', 'greet');
    else if (action === 'sleep') setMood('sleepy', 'sleep');
    else if (action === 'wake') setMood('idle', 'wake');
    resetIdleTimer();
  }
  return resolved(ok);
}

function emit(type, payload) {
  try {
    bus.emit(type, payload);
  } catch (err) {
    console.warn('[aemeath:pet] 事件派发失败', type, err);
  }
}

/**
 * 切换情绪。契约：
 *  - 未知情绪回落到 idle（不抛错）
 *  - 广播 PET_MOOD；**不写 Settings**（pet.mood 允许写，但写入会触发 settings:changed 回流，
 *    容易和宿主同步逻辑打架；情绪属于运行时展示状态，交给宿主决定是否持久化）
 */
function setMood(mood, reason = 'api') {
  if (!rig) return false;
  const ok = rig.setMood(mood);
  if (ok) {
    document.body.dataset.mood = rig.getMood();
    emit(EV.PET_MOOD, { mood: rig.getMood(), reason });
  }
  return ok;
}

function setClass(name, on) {
  const el = view.canvas;
  if (!el || !el.classList) return;
  el.classList.toggle(name, !!on);
}

/* ───────────────────────── 帧循环 ───────────────────────── */

/** 空转时的随机小动作调度 */
function idleSchedule() {
  idleNext = TIMING.idleActionMinMs + Math.random() * (TIMING.idleActionMaxMs - TIMING.idleActionMinMs);
  idleTimer = 0;
}
function resetIdleTimer() {
  idleTimer = 0;
  idleNext = Math.max(idleNext, 6000);
}

function frame(ts) {
  rafId = 0;
  if (!mounted || !rig) return;
  const t = ts || now();
  let dt = lastTs ? (t - lastTs) / 1000 : TARGET_FPS > 0 ? 1 / TARGET_FPS : 0.016;
  lastTs = t;
  // 切后台回来的巨大跳变会炸弹簧，直接截断
  if (!Number.isFinite(dt) || dt <= 0) dt = 1 / TARGET_FPS;
  dt = clamp(dt, 0, 1 / 20);

  // fps 统计（1 秒窗口）
  fpsAcc += dt;
  fpsFrames++;
  if (fpsAcc >= 0.5) {
    fps = fpsFrames / fpsAcc;
    fpsAcc = 0;
    fpsFrames = 0;
  }

  timeSec += dt;
  step(dt);
  render();
  schedule();
}

function step(dt) {
  input.update(dt);

  // 注视（interactions 已做平滑；这里只在"跟随开"时喂给 rig）
  if (input.followCursor && input.pointer.inside) {
    rig.lookAt(input.smooth.x, input.smooth.y);
  } else {
    rig.lookAway();
  }

  // 口型：外部覆盖优先，其次说话节拍
  if (mouthOverride >= 0) rig.setMouth(mouthOverride);
  else rig.setMouth(-1);

  rig.update(dt);
  bubble.update(dt);

  // 随机小动作（睡觉时不打扰）
  if (!rig.sleeping) {
    idleTimer += dt * 1000;
    if (idleTimer >= idleNext) {
      idleSchedule();
      const pick = pickIdleVariant();
      trigger('idle-random', { variant: pick });
    }
  } else {
    idleTimer = 0;
  }
}

/** 按权重挑一个待机小动作 */
function pickIdleVariant() {
  let total = 0;
  for (const v of IDLE_ACTIONS) total += v.weight;
  let r = Math.random() * total;
  for (const v of IDLE_ACTIONS) {
    r -= v.weight;
    if (r <= 0) return v.id;
  }
  return IDLE_ACTIONS[0].id;
}

function render() {
  const ctx = view.ctx;
  if (!ctx || !rig) return;
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  const pose = rig.getPose();
  drawOpts.time = timeSec;
  drawOpts.phase = (timeSec * 0.9) % 1;
  drawOpts.debug = !!debugOverlay;
  drawPet(ctx, pose, drawOpts);

  // 气泡画在特效之上（否则会被 glow 的 lighter 合成洗白）
  if (showBubble) bubble.draw(ctx);
}

let debugOverlay = false;

function schedule() {
  if (!mounted || running || externallyDriven) return;
  running = true;
  rafId = requestAnimationFrame(frame);
  running = false;
}

/** 页面隐藏时暂停，回来时把时间基准清掉，避免一个大 dt */
function onVisibility() {
  if (document.hidden) {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  } else if (mounted && !rafId) {
    lastTs = 0;
    schedule();
  }
}

/* ───────────────────────── 设置联动 ───────────────────────── */

let showBubble = true;

function applySetting(key, value) {
  switch (key) {
    case 'pet.scale':
      applyScale(value);
      break;
    case 'pet.showBubble':
      showBubble = value !== false;
      if (!showBubble) bubble.hide();
      break;
    case 'pet.followCursor':
      if (input) input.setFollowCursor(value !== false);
      break;
    case 'pet.reducedMotion':
      if (rig) rig.setReducedMotion(!!value);
      break;
    case 'pet.mood':
      if (rig && value && value !== rig.getMood()) setMood(value, 'settings');
      break;
    default:
      break;
  }
}

function applyAllSettings() {
  applySetting('pet.scale', getSetting('pet.scale'));
  applySetting('pet.showBubble', getSetting('pet.showBubble'));
  applySetting('pet.followCursor', getSetting('pet.followCursor'));
  applySetting('pet.reducedMotion', getSetting('pet.reducedMotion'));
  const m = getSetting('pet.mood');
  if (m && rig && m !== rig.getMood()) setMood(m, 'settings');
}

/* ───────────────────────── 契约 API ───────────────────────── */

export const ACTIONS = [
  'tap-head',
  'tap-face',
  'tap-body',
  'tap-hand',
  'double-tap',
  'long-press',
  'drag',
  'drop',
  'idle-random',
  'greet',
  'sleep',
  'wake',
];

// 开发期一致性自检：上面的字面量清单必须与 rig.js 的动作表逐字一致。
// （刻意不写成 `ACTION_IDS.slice()`：契约与 tools/selfcheck-api.mjs 都要求这里是字面量。）
if (ACTIONS.length !== ACTION_IDS.length || ACTIONS.some((a, i) => a !== ACTION_IDS[i])) {
  console.warn('[aemeath:pet] ACTIONS 与 rig.js 的 ACTION_IDS 不一致', {
    ACTIONS,
    ACTION_IDS,
  });
}

export const PetUI = {
  version: '1.0.0',

  /**
   * 非契约字段：宿主 app.js 的「试播所有动作」按钮读 `modules.PetUI?.__actions`，
   * 缺失时会 toast「桌宠模块未加载」。放在这里保证按钮可用。
   */
  __actions: ACTIONS,

  /**
   * 挂载到 canvas。可重复调用（幂等：先 unmount 再挂）。
   * @param {HTMLCanvasElement} canvas
   * @param {{scale?:number, debug?:boolean}} [opts]
   */
  mount(canvas, opts = {}) {
    if (mounted) this.unmount();
    if (!canvas || typeof canvas.getContext !== 'function') {
      console.warn('[aemeath:pet] mount 需要一个 <canvas> 元素');
      return false;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      console.warn('[aemeath:pet] 无法获取 2D 上下文');
      return false;
    }

    view.canvas = canvas;
    view.ctx = ctx;
    debugOverlay = !!opts.debug;
    externallyDriven = false;

    rig = new Rig();
    bubble = new Bubble();
    input = makeInput();

    syncBackingStore();
    applyScale(opts.scale ?? getSetting('pet.scale'));
    applyAllSettings();

    // prefers-reduced-motion：系统级偏好与设置项取"或"
    const prefersReduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    rig.setReducedMotion(!!getSetting('pet.reducedMotion') || prefersReduced);

    // ── 事件订阅（全部登记到 disposers，unmount 逐一撤销）
    const sub = (type, fn) => {
      const off = bus.on(type, fn);
      if (typeof off === 'function') disposers.push(off);
      else if (bus.off) disposers.push(() => bus.off(type, fn));
    };

    sub(EV.SETTINGS_CHANGED, (payload) => {
      if (!payload || !payload.key) return;
      applySetting(payload.key, payload.value);
    });
    sub(EV.PET_BUBBLE, (payload) => {
      if (!payload || !showBubble) return;
      bubble.show(payload.text, payload.ms ?? getSetting('pet.bubbleMs'));
    });
    sub(EV.PET_SPEAK_START, () => {
      speaking = true;
      setMood('speak', 'voice');
      setClass('pet-speaking', true);
    });
    sub(EV.PET_SPEAK_END, () => {
      speaking = false;
      setClass('pet-speaking', false);
      if (rig && rig.getMood() === 'speak') setMood('idle', 'voice');
    });
    sub(EV.PET_LISTEN_START, () => {
      listening = true;
      setMood('listen', 'voice');
      setClass('pet-listening', true);
    });
    sub(EV.PET_LISTEN_END, () => {
      listening = false;
      setClass('pet-listening', false);
      if (rig && rig.getMood() === 'listen') setMood('idle', 'voice');
    });
    sub(EV.PET_THINK, (payload) => {
      thinking = !!(payload && payload.on);
      setClass('pet-thinking', thinking);
    });

    // ── 尺寸 / DPR 变化
    if (typeof window !== 'undefined') {
      const onResize = () => syncBackingStore();
      window.addEventListener('resize', onResize);
      disposers.push(() => window.removeEventListener('resize', onResize));
      // DPR 变化（拖到另一块屏幕）用 matchMedia 精确监听，比 resize 更可靠
      if (typeof window.matchMedia === 'function') {
        const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
        const onDpr = () => {
          syncBackingStore();
          if (mq.removeEventListener) mq.removeEventListener('change', onDpr);
        };
        if (mq.addEventListener) mq.addEventListener('change', onDpr);
        disposers.push(() => {
          if (mq.removeEventListener) mq.removeEventListener('change', onDpr);
        });
      }
      document.addEventListener('visibilitychange', onVisibility);
      disposers.push(() => document.removeEventListener('visibilitychange', onVisibility));
    }

    input.attach();
    disposers.push(() => input && input.destroy());

    mounted = true;
    idleSchedule();
    setClass('pet-ready', true);
    if (typeof document !== 'undefined' && document.body) {
      document.body.dataset.mood = rig.getMood();
    }
    // 立即画一帧，避免挂载后到第一帧之间出现空白
    render();
    lastTs = 0;
    schedule();
    // 入场：挥个手打个招呼（不阻塞 mount、不切情绪）。
    // 这里**刻意绕过本文件的 trigger()**，因为那一层会给 greet 附带 setMood('happy')：
    // 而契约与验收（tests/pet.test.mjs）都要求挂载后 getMood() 仍是默认的 'idle'，
    // 且宿主 app.js 会在 mount 之后自己调 setMood(Settings.get('pet.mood'))。
    // 想连表情一起切的宿主，挂载后自己 trigger('greet') 即可；传 { greet: false } 可完全关掉入场动作。
    if (opts.greet !== false && rig.trigger('greet', { force: true })) resetIdleTimer();
    return true;
  },

  /** 手动推进（宿主若自己驱动 rAF，就只调 update，不依赖 mount 的内部循环） */
  update(dt) {
    if (!mounted || !rig) return;
    // 单位兼容层：canonical 单位是「秒」（契约 §4 文档里的「毫秒」是笔误，Lead 已裁定按秒）。
    // 单帧合法秒值会被 Rig 钳到 ≤0.1，所以任何 > 0.5 的数都不可能是「秒」——只可能是
    // 调用方按毫秒传（测试常这么写）。就地换算，避免因口径分歧让桌宠"看着不动"。
    const n = Number(dt) || 0;
    const d = clamp(n > 0.5 ? n / 1000 : n, 0, 0.1);
    // 宿主接管循环后停掉内部 RAF，否则同一帧会被 step 两次（动画快一倍）
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
      externallyDriven = true;
    }
    timeSec += d;
    step(d);
    render();
  },

  /** 卸载：撤销监听、取消 rAF、清空画布。可重复调用 */
  unmount() {
    if (!mounted && !rig) return;
    mounted = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    for (const d of disposers) {
      try {
        d();
      } catch (err) {
        console.warn('[aemeath:pet] 解绑失败', err);
      }
    }
    disposers = [];
    if (input) {
      input.destroy();
      input = null;
    }
    if (bubble) bubble.hide();
    if (view.ctx) {
      try {
        view.ctx.setTransform(1, 0, 0, 1, 0, 0);
        view.ctx.clearRect(0, 0, view.canvas ? view.canvas.width : CANVAS_W, view.canvas ? view.canvas.height : CANVAS_H);
      } catch {
        /* canvas 已被移除时忽略 */
      }
    }
    if (view.canvas && view.canvas.classList) {
      for (const c of ['pet-ready', 'pet-dragging', 'pet-speaking', 'pet-listening', 'pet-thinking']) {
        view.canvas.classList.remove(c);
      }
      const wrap = view.canvas.parentElement;
      if (wrap && wrap.style) wrap.style.transform = '';
    }
    rig = null;
    bubble = null;
    view.canvas = null;
    view.ctx = null;
    lastTs = 0;
    externallyDriven = false;
    timeSec = 0;
    mouthOverride = -1;
    speaking = false;
    listening = false;
    thinking = false;
    showBubble = true;
    return true;
  },

  /**
   * 触发 12 个动作之一。
   * @param {string} action
   * @param {{variant?:string, force?:boolean}} [opts] 额外选项（契约外的扩展，向后兼容）
   * @returns {Promise<boolean>}
   */
  trigger(action, opts) {
    return trigger(action, opts);
  },

  /** 切换情绪；未知情绪回落 idle */
  setMood(mood) {
    return setMood(mood, 'api');
  },

  getMood() {
    return rig ? rig.getMood() : 'idle';
  },

  /**
   * 画布坐标 → 部位。
   * 上半部（y < CANVAS_H/3）必须得到 'head'，这是契约里的硬性自检。
   * @param {number} x
   * @param {number} y
   */
  hitTest(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 'none';
    const p = toLogical(x, y);
    const part = hitTestImpl(p.x, p.y, currentPose());
    return HIT_PARTS.includes(part) ? part : 'none';
  },

  /**
   * 眼神跟随。入参为 canvas 逻辑坐标（0..CANVAS_W / 0..CANVAS_H），
   * 原样透传给 Rig.lookAt —— 这里不做任何二次中心偏移或宽高换算（toLogical 只处理 dpr 折回）。
   */
  lookAt(x, y) {
    if (!rig) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const p = toLogical(x, y);
    rig.lookAt(p.x, p.y);
    if (input) {
      input.pointer.x = p.x;
      input.pointer.y = p.y;
      input.pointer.inside = true;
    }
  },

  /**
   * 外部控制嘴型（说话/口型同步）。
   * @param {number} value 0..1；传负数则交回内部节拍
   */
  setMouth(value) {
    const v = Number(value);
    mouthOverride = Number.isFinite(v) && v >= 0 ? clamp(v, 0, 1) : -1;
  },

  /**
   * Live2D 模型接入位（本项目是纯程序化绘制，不引入任何外部模型/素材）。
   * 契约允许返回 false 表示"本次未接入"，宿主据此回落到 Canvas 绘制。
   */
  attachLive2D() {
    return false;
  },

  /** 可序列化调试快照 */
  getDebugState() {
    const base = rig
      ? rig.getDebugState()
      : { mood: 'idle', actions: {}, actionTotal: 0, playing: [], params: {} };
    return {
      version: '1.0.0',
      mounted,
      mood: base.mood,
      actions: base.actions,
      actionTotal: base.actionTotal,
      playing: base.playing,
      cooldowns: base.cooldowns,
      fps: Math.round(fps * 10) / 10,
      dpr: view.dpr,
      scale: view.scale,
      size: { w: CANVAS_W, h: CANVAS_H },
      origin: { x: ORIGIN_X, y: ORIGIN_Y },
      speaking,
      listening,
      thinking,
      reducedMotion: base.reducedMotion,
      sleeping: base.sleeping,
      dragging: base.dragging,
      blink: base.blink,
      time: base.time,
      params: base.params,
      props: base.props,
      bubble: bubble ? bubble.getDebugState() : null,
      pointer: input ? { x: Math.round(input.pointer.x), y: Math.round(input.pointer.y), inside: input.pointer.inside } : null,
    };
  },

  /** 调试叠层开关（命中线框 + 1/3 分界线） */
  setDebugOverlay(on) {
    debugOverlay = !!on;
  },
};

export default PetUI;
