/**
 * Aemeath 桌宠 —— 骨骼 / 参数模型与动画引擎
 *
 * 职责：
 *  1. 维护一份扁平、可序列化的**参数表**（pose）：所有绘制差异都只来自这份数据，
 *     draw.js 是纯函数（pose 进，像素出），好读好测。
 *  2. 用**弹簧插值**（半隐式欧拉）驱动每一个参数；不使用 CSS 动画、不使用补间数组。
 *  3. 底层生命感：呼吸（正弦）、眨眼（泊松间隔 + 二次眨眼）、头发/衣摆**逐级延迟跟随**、
 *     眼神跟随鼠标（限幅）、说话口型节拍。
 *  4. 一次性动作引擎：每个动作是一个"从归一化进度 t 到目标值"的纯函数，
 *     叠加在情绪基线上（加法叠加），结束自动回落，不残留状态。
 *
 * 与契约的关系：index.js 只读 pose 交给 draw.js，getDebugState() 也直接来自这里。
 */

import {
  TARGET_FPS,
  TIMING,
  IDLE_ACTIONS,
  ACTION_COOLDOWN,
} from './constants.js';
import { getMoodDef, isMood, resolveMoodProps } from './moods.js';

/* ───────────────────────── 参数表定义 ───────────────────────── */

/**
 * 动画通道定义。
 *  - value：中立值（也是 reset 值）
 *  - stiff/damp：弹簧刚度与阻尼（k 越大越跟手；阻尼相对临界阻尼 sqrt(k)*2 的比例决定回弹）
 *  - lo/hi：硬限幅，防止数值爆炸导致画面崩坏
 *  - array：数组通道（逐个元素各有一个弹簧）
 *  - mood：该键会叠加当前情绪的 pose 目标值
 */
export const RIG_SPEC = [
  // 身体
  ['bodyY', 0, 110, 15, -60, 60, false, true],
  ['bodyX', 0, 150, 19, -90, 90, false, true],
  ['bodyLean', 0, 95, 17, -34, 34, false, true],
  ['bodySquash', 0, 200, 21, -0.35, 0.4, false, false],
  ['bodyStretch', 0, 200, 21, -0.35, 0.35, false, false],
  // 头
  ['headYaw', 0, 110, 15, -30, 30, false, true],
  ['headPitch', 0, 105, 15, -30, 34, false, true],
  ['headTilt', 0, 95, 14, -30, 30, false, true],
  ['headYawLag', 0, 58, 12, -30, 30, false, true],
  ['headBob', 0, 120, 13, -16, 16, false, false],
  // 眼
  ['eyeOpen', 1, 700, 24, 0, 1.45, false, true],
  ['blink', 0, 1600, 46, 0, 1, false, false],
  // 呼吸 / 口
  ['breathAmp', 1, 45, 10, 0, 2.2, false, true],
  ['breathSpeed', 1, 40, 9, 0.3, 1.9, false, true],
  ['mouthSmile', 0, 220, 18, -1, 1.2, false, true],
  ['mouthOpen', 0, 320, 20, 0, 1.3, false, true],
  ['speaking', 0, 260, 16, 0, 1, false, false],
  ['pout', 0, 260, 18, 0, 1, false, false],
  // 头发 / 手 / 姿态
  ['hairSway', 1, 55, 11, 0, 2.2, false, true],
  ['armForward', 0, 130, 16, 0, 1.1, false, true],
  ['think', 0, 200, 16, 0, 1, false, false],
  ['blushPulse', 0, 220, 18, 0, 1, false, false],
  // 眼神（-1..1 的"看向哪里"，不是像素）
  ['gazeX', 0, 260, 19, -1, 1, false, false],
  ['gazeY', 0, 260, 19, -1, 1, false, false],
  // 拖拽
  ['dragLean', 0, 150, 16, -26, 26, false, false],
  ['dragDX', 0, 130, 15, -120, 120, false, false],
  ['dragDY', 0, 130, 15, -120, 120, false, false],
  ['spin', 0, 60, 11, -1, 1, false, false],
  // 特效
  ['glow', 0, 320, 22, 0, 1.3, false, false],
  ['sparkle', 0, 300, 21, 0, 1.2, false, false],
  // 逐级延迟跟随（数组通道：0 = 根部最快，越大越延迟）
  ['hairLagX', 0, 0, 0, -60, 60, true, false],
  ['hairLagY', 0, 0, 0, -60, 60, true, false],
  ['hemLagX', 0, 0, 0, -40, 40, true, false],
];

/** 每层延迟跟随的刚度（越靠发梢越软 → 天然产生"波浪"延迟） */
const HAIR_TIER = [
  { stiff: 105, damp: 16 },
  { stiff: 62, damp: 12.5 },
  { stiff: 34, damp: 9.5 },
  { stiff: 20, damp: 7.5 },
];

const HEM_TIER = [
  { stiff: 120, damp: 17 },
  { stiff: 70, damp: 13 },
  { stiff: 40, damp: 10 },
];

/** 硬编码兜底形状，避免 RIG_SPEC 被改坏时数组长度不一致 */
const HAIR_LEN = 4;
const HEM_LEN = 3;

/** 弹簧子步上限，保证低帧率下积分稳定 */
const FIXED_STEP = 1 / 60;
const MAX_SUBSTEPS = 4;

/** 需要同时影响眼球与头部的注视强度 */
const LOOK = {
  yawScale: 19, // gazeX → 头部左右转（度）
  pitchScale: 9,
  yawLagScale: 9,
};

/* ───────────────────────── 弹簧工具 ───────────────────────── */

function makeSpring(value, stiff, damp) {
  return { value, vel: 0, stiff, damp };
}

function stepSpring(s, target, dt) {
  const k = s.stiff;
  if (k <= 0) {
    s.value = target;
    s.vel = 0;
    return;
  }
  const a = k * (target - s.value) - s.damp * s.vel;
  s.vel += a * dt;
  s.value += s.vel * dt;
}

/* ───────────────────────── 工具函数 ───────────────────────── */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** 0..1 的缓动，用于动作的"进入/退出"平滑（避免动作起止处出现折角） */
function envelope(t, inRatio = 0.18, outRatio = 0.35) {
  if (t <= 0 || t >= 1) return 0;
  const inEnd = Math.max(0.001, inRatio);
  const outStart = Math.min(1 - 0.001, 1 - outRatio);
  if (t < inEnd) return easeOut(t / inEnd);
  if (t > outStart) return easeOut((1 - t) / (1 - outStart));
  return 1;
}

const easeOut = (t) => 1 - (1 - t) * (1 - t);
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t));

/** 归一化正弦波，周期为 1（t 用"秒 × 频率"） */
const wave = (t) => Math.sin(t * Math.PI * 2);

/* ───────────────────────── 一次性动作表 ───────────────────────── */

/**
 * 动作定义：apply(d) 把"叠加量"写进 d。
 *  - d.t 是归一化进度 0..1，可选 d.phase（主要用于吐气特效）
 *  - d.p 是姿态参数对象，直接 set/add 即可；rig 每帧从中立值重建，无需清理
 *  - 写法约定：set 用于主要通道，add 用于叠加抖动
 */
const ACTIONS = {
  /* 摸头：眯眼、头往下压、身体轻轻蹭 */
  'tap-head': {
    dur: 1550,
    loop: true,
    apply(d) {
      const { t, p } = d;
      const e = envelope(t, 0.14, 0.42);
      const purr = wave(t * 2);
      p.add('eyeOpen', -0.62 * e);
      p.set('mouthSmile', 0.62 * e);
      p.add('headPitch', 5.5 * e);
      p.add('bodySquash', 0.12 * e);
      p.add('bodyX', 5 * e * purr);
      p.add('headTilt', 7 * e * purr);
      p.add('hairSway', 0.85 * e);
      p.add('blushPulse', 0.55 * e);
      p.add('armForward', 0.22 * e);
    },
  },

  /* 戳脸：惊讶后鼓腮、脸被戳的一侧歪一下 */
  'tap-face': {
    dur: 1250,
    apply(d) {
      const { t, p } = d;
      const hit = envelope(t, 0.06, 0.55);
      const puff = envelope(clamp((t - 0.16) / 0.42, 0, 1), 0.12, 0.5);
      p.add('eyeOpen', 0.4 * hit);
      p.add('pout', 0.85 * puff);
      p.add('headPitch', -4 * hit + 3 * puff);
      p.add('headTilt', 9 * hit + 5 * puff);
      p.add('bodyX', -6 * hit);
      p.add('glow', 0.35 * hit);
      p.add('blushPulse', 0.4 * puff);
    },
  },

  /* 戳身体：左右扭动两下 + 害羞地抬手 */
  'tap-body': {
    dur: 1700,
    apply(d) {
      const { t, p } = d;
      const wiggle = envelope(t, 0.1, 0.45) * wave(t * 2.2);
      p.add('bodyX', 13 * wiggle);
      p.add('bodyLean', -6 * wiggle);
      p.add('headTilt', 12 * wiggle);
      p.add('headYaw', 5 * wiggle);
      p.add('armForward', 0.55 * envelope(t, 0.2, 0.4));
      p.add('blushPulse', 0.7 * envelope(t, 0.2, 0.4));
      p.add('eyeOpen', -0.22 * envelope(t, 0.2, 0.4));
      p.add('mouthSmile', 0.3 * envelope(t, 0.2, 0.4));
    },
  },

  /* 牵手：两只手抬到身前，开心地上下晃 */
  'tap-hand': {
    dur: 2100,
    apply(d) {
      const { t, p } = d;
      const swing = envelope(t, 0.16, 0.4) * wave(t * 1.6);
      p.add('armForward', 1.05 * envelope(t, 0.16, 0.4));
      p.add('bodyY', -4 * Math.abs(swing));
      p.add('headTilt', 8 * swing);
      p.add('headPitch', -3 * envelope(t, 0.16, 0.4));
      p.add('sparkle', 0.55 * envelope(t, 0.16, 0.4));
      p.add('glow', 0.3 * envelope(t, 0.16, 0.4));
      p.add('mouthSmile', 0.75 * envelope(t, 0.16, 0.4));
      p.add('eyeOpen', -0.18 * envelope(t, 0.16, 0.4));
    },
  },

  /* 双击：跳一下 + 星星眼（收尾时膝盖微屈，避免"瞬移"） */
  'double-tap': {
    dur: 950,
    apply(d) {
      const { t, p } = d;
      const hop = t < 0.42 ? Math.sin(Math.PI * (t / 0.42)) : 0;
      const land = envelope(clamp((t - 0.42) / 0.58, 0, 1), 0.12, 0.7);
      p.add('bodyY', -60 * hop);
      p.add('bodyStretch', 0.28 * hop);
      p.add('bodySquash', 0.22 * land);
      p.add('sparkle', clamp(1.15 - t * 1.1, 0, 1.15));
      p.add('glow', 0.6 * clamp(1 - t * 1.3, 0, 1));
      p.add('armForward', 0.85 * Math.max(hop, land * 0.6));
      p.add('mouthOpen', 0.45 * hop);
      p.add('mouthSmile', 0.7);
      p.add('headPitch', -7 * hop + 4 * land);
      p.add('hairSway', 1.1);
    },
  },

  /* 长按：整个人往手心靠，小声蹭一蹭 */
  'long-press': {
    dur: 4600,
    loop: true,
    apply(d) {
      const { t, p } = d;
      const near = envelope(t, 0.12, 0.3);
      const purr = wave(t * 3.1);
      p.add('bodyLean', -6 * near);
      p.add('bodyY', -3 * near);
      p.add('headPitch', 7 * near);
      p.add('headTilt', 6 * near * purr);
      p.add('eyeOpen', -0.68 * near);
      p.add('mouthSmile', 0.55 * near);
      p.add('blushPulse', 0.8 * near);
      p.add('armForward', 0.35 * near);
      p.add('glow', 0.18 * near);
    },
  },

  /* 拖拽：被拎起来的一半重量感（另一半由真实速度驱动 dragLean） */
  drag: {
    dur: 900,
    loop: true,
    apply(d) {
      const { t, p } = d;
      // 起手有个"被拎起来"的压感，之后只留一点点张力（拖拽中的晃动来自拖拽速度）
      const e = clamp(1 - t, 0, 1) * 0.55 + 0.12;
      p.add('bodyStretch', 0.16 * e);
      p.add('headPitch', -5 * e);
      p.add('eyeOpen', 0.18 * e);
      p.add('hairSway', 1.4 * e);
      p.add('mouthOpen', 0.3 * e);
      p.add('glow', 0.12 * e);
    },
  },

  /* 落下：小跳两下然后站定 */
  drop: {
    dur: 820,
    apply(d) {
      const { t, p } = d;
      const b1 = t < 0.34 ? Math.sin(Math.PI * (t / 0.34)) : 0;
      const b2 = t >= 0.34 && t < 0.66 ? Math.sin(Math.PI * ((t - 0.34) / 0.32)) : 0;
      const set = envelope(clamp((t - 0.66) / 0.34, 0, 1), 0.2, 0.6);
      p.add('bodyY', -30 * b1 - 14 * b2);
      p.add('bodySquash', -0.16 * b1 + 0.3 * b2 + 0.2 * set);
      p.add('bodyStretch', 0.16 * b1 - 0.1 * b2);
      p.add('armForward', 0.5 * (b1 + b2));
      p.add('hairSway', 1.6);
      p.add('eyeOpen', 0.15 * b1);
      p.add('mouthOpen', 0.35 * b1);
    },
  },

  /* 随机小动作：按 variant 走不同小曲线 */
  'idle-random': {
    dur: 2600,
    apply(d) {
      const { t, p, variant } = d;
      const e = envelope(t, 0.16, 0.34);
      if (variant === 'yawn') {
        const open = t < 0.5 ? easeInOut(t / 0.5) : 1 - easeInOut((t - 0.5) / 0.5);
        p.add('mouthOpen', 0.85 * open);
        p.add('eyeOpen', -0.8 * open);
        p.add('headPitch', -8 * open);
        p.add('bodyStretch', 0.14 * open);
        p.add('armForward', 0.5 * open);
        p.add('sigh', 0.7 * open);
        return;
      }
      if (variant === 'look-around') {
        const look = wave(t * 1.5);
        p.add('headYaw', 15 * look * e);
        p.add('bodyX', 4 * look * e);
        p.add('headTilt', 5 * look * e);
        p.add('hairSway', 1.2 * e);
        return;
      }
      if (variant === 'hop-corner') {
        const hop = t < 0.3 ? Math.sin(Math.PI * (t / 0.3)) : 0;
        p.add('bodyY', -26 * hop);
        p.add('bodyX', 16 * e);
        p.add('bodyStretch', 0.18 * hop);
        p.add('headTilt', 8 * e);
        p.add('sparkle', 0.4 * e);
        return;
      }
      // fix-hair：抬手整理头发，眼珠往上瞟
      const raise = t < 0.45 ? easeInOut(t / 0.45) : 1 - easeInOut((t - 0.45) / 0.55);
      p.add('armForward', 0.9 * raise);
      p.add('headPitch', 4 * raise);
      p.add('eyeOpen', -0.25 * raise);
      p.add('mouthSmile', 0.3 * raise);
      p.add('hairSway', 1.5 * raise);
      p.add('think', 0.6 * raise);
    },
  },

  /* 打招呼：抬手挥两下 */
  greet: {
    dur: 1900,
    apply(d) {
      const { t, p } = d;
      const e = envelope(t, 0.14, 0.36);
      const waveT = Math.sin(t * Math.PI * 2 * 2.1);
      p.add('armForward', 1.1 * e);
      p.add('bodyX', 3 * waveT * e);
      p.add('headTilt', 10 * waveT * e);
      p.add('headPitch', -3 * e);
      p.add('mouthSmile', 0.8 * e);
      p.add('eyeOpen', -0.15 * e);
      p.add('sparkle', 0.3 * e);
    },
  },

  /* 睡觉：闭眼、呼吸变慢变浅、头歪下去（可用 wake 打断） */
  sleep: {
    dur: 1500,
    hold: 1e9,
    loop: true,
    apply(d) {
      const { t, p } = d;
      const e = t < 1 ? envelope(t, 0.3, 0.4) : 1;
      p.add('eyeOpen', -1.0 * e);
      p.add('bodySquash', 0.22 * e);
      p.add('bodyY', 5 * e);
      p.add('headPitch', 12 * e);
      p.add('headTilt', 11 * e);
      p.mul('breathSpeed', 0.45);
      p.mul('breathAmp', 0.72);
      p.add('hairSway', -0.55 * e);
      p.add('mouthOpen', 0.18 * e);
    },
  },

  /* 醒来：伸懒腰 + 睁大眼 */
  wake: {
    dur: 1900,
    apply(d) {
      const { t, p } = d;
      const up = clap(t, 0.42, 0.26);
      const settle = clamp((t - 0.62) / 0.38, 0, 1);
      p.add('bodyStretch', 0.3 * up);
      p.add('bodyY', -12 * up + 4 * settle);
      p.add('armForward', 1.15 * up);
      p.add('headPitch', -12 * up + 5 * settle);
      p.add('eyeOpen', 0.35 * up);
      p.add('mouthOpen', 0.55 * up);
      p.add('hairSway', 1.5 * up);
      p.add('glow', 0.4 * up);
      p.add('sigh', 0.5 * up);
    },
  },
};

/** 三角包络：在 center 附近起，宽 width 内为 1，其余为 0（带平滑边） */
function clap(t, center, width) {
  const d = Math.abs(t - center) / (width / 2);
  if (d >= 1) return 0;
  return easeOut(1 - d);
}

/** 动作表对外只读导出（interactions/index 需要知道哪些 id 可用） */
export const ACTION_IDS = Object.keys(ACTIONS);

/* ───────────────────────── 姿态构建器 ───────────────────────── */

/**
 * 每帧重建姿态的工作台：动作通过 add/set/mul 往上面写叠加量。
 * 用类而不是对象字面量，是为了让动作代码读起来干净（也方便 JIT）。
 */
class PoseBuilder {
  constructor(params) {
    /** @type {Record<string, number>} */
    this.p = params;
    /** @type {Record<string, number>} */
    this.adds = Object.create(null);
    /** @type {Record<string, number>} */
    this.muls = Object.create(null);
  }

  reset() {
    for (const k in this.adds) delete this.adds[k];
    for (const k in this.muls) delete this.muls[k];
    return this;
  }

  /** 直接覆盖 */
  set(k, v) {
    this.p[k] = v;
    return this;
  }

  /** 叠加 */
  add(k, v) {
    if (v === 0) return this;
    this.adds[k] = (this.adds[k] || 0) + v;
    return this;
  }

  /** 乘算（呼吸频率这类"缩放式"参数） */
  mul(k, v) {
    this.muls[k] = (this.muls[k] ?? 1) * v;
    return this;
  }

  /** 把叠加量落到参数上（动作之间共享叠加，顺序无关，天然可交换） */
  flush(params) {
    for (const k in this.adds) params[k] += this.adds[k];
    for (const k in this.muls) params[k] *= this.muls[k];
  }
}

/* ───────────────────────── Rig ───────────────────────── */

/**
 * 桌宠骨骼/参数模型。
 * 纯逻辑，不碰 DOM；index.js 负责把 canvas 尺寸与指针坐标喂进来。
 */
export class Rig {
  constructor() {
    /** 弹簧表：number → spring；数组通道 → Map<index, spring> */
    this.springs = new Map();
    /** 当前参数值（绘制唯一输入） */
    this.params = Object.create(null);
    /** 当前弹簧**目标值**（情绪基线 + 正在播放的动作） */
    this.targets = Object.create(null);
    /** 限幅表：key → [lo, hi] */
    this.limits = new Map();

    for (const spec of RIG_SPEC) {
      const [key, value, stiff, damp, lo, hi, isArray] = spec;
      if (isArray) {
        const len = key.startsWith('hair') ? HAIR_LEN : key.startsWith('hem') ? HEM_LEN : HAIR_LEN;
        const tier = key.startsWith('hem') ? HEM_TIER : HAIR_TIER;
        const m = new Map();
        for (let i = 0; i < len; i++) {
          const cfg = tier[Math.min(i, tier.length - 1)];
          m.set(i, makeSpring(value, cfg.stiff, cfg.damp));
        }
        this.springs.set(key, m);
        this.params[key] = new Array(len).fill(value);
        this.targets[key] = new Array(len).fill(value);
      } else {
        this.springs.set(key, makeSpring(value, stiff, damp));
        this.params[key] = value;
        this.targets[key] = value;
      }
      this.limits.set(key, [lo, hi]);
    }

    /** 情绪 */
    this.mood = 'idle';
    this.prevMood = 'idle';
    this.moodBlend = 0;
    this.props = resolveMoodProps('idle');
    this.prevProps = this.props;

    /* 生命感状态 */
    this.time = 0;
    this.breathPhase = 0;
    this.blinkState = 'idle'; // idle | closing | opening
    this.blinkProgress = 0;
    this.blinkCountdown = 400; // 挂载后很快就眨一次，避免"雕像感"
    this.blinkQueue = 0;
    this.mouthPhase = 0;
    this.mouthOverride = -1; // setMouth 外部覆盖，-1 表示未接管
    /** 当前帧用于绘制的眨眼闭眼比例（0 睁 … 1 闭） */
    this.blinkForDraw = 0;

    /* 头发延迟跟随的历史（记录若干帧前的"驱动量"） */
    this.hairHistory = new Array(16).fill(0);
    this.hemHistory = new Array(12).fill(0);

    /* 动作 / 交互 */
    this.actions = [];
    this.actionCounts = Object.create(null);
    this.cooldowns = Object.create(null);
    this.sleeping = false;
    this.petting = false;
    this.dragging = false;
    this.dragVelX = 0;
    this.dragVelY = 0;
    this.impulse = 0;
    this.idleTimer = randBetween(TIMING.idleActionMinMs, TIMING.idleActionMaxMs) / 1000;
    this.reducedMotion = false;
    this.debug = false;

    /** FPS 估计（滚动平均） */
    this._fps = TARGET_FPS;
    this._fpsFrames = 0;
    this._fpsAcc = 0;

    this.pose = new PoseBuilder(this.params);
    this._look = { x: 0, y: 0, active: false };
    this._reducedExternal = false;

    // 合上初始情绪的 props（构造函数里 mood 默认 idle）
    this.#stepProps(0, true);
    this.#applyMoodTargets(true);
  }

  /**
   * 可绘制姿态：数值通道（params）**原地合并**情绪属性（props）。
   * 复用同一个对象，避免 60fps 下每帧分配；调用方只读不写。
   */
  getPose() {
    const out = this.params;
    const p = this.props;
    for (const k in p) out[k] = p[k];
    return out;
  }

  /** 限幅表（构造器里逐个填） */

  /* ───── 对外 API ───── */

  get mounted() {
    return true;
  }

  /** 设置情绪；相同情绪直接返回 false */
  setMood(mood) {
    if (!isMood(mood)) {
      console.warn(`[aemeath:pet] 未知情绪 "${mood}"，忽略`);
      return false;
    }
    if (mood === this.mood) return false;
    this.prevProps = { ...this.props };
    this.prevMood = this.mood;
    this.mood = mood;
    this.moodBlend = 0;
    // 立刻把"脸上会变的东西"合上：调用方可能在两次 update 之间就取 pose 来画，
    // 若等弹簧慢慢混，会出现"心情已经变了但表情还是旧的"这一帧。
    this.#stepProps(0, true);
    return true;
  }

  getMood() {
    return this.mood;
  }

  /**
   * 触发一次性动作。
   * @param {string} name
   * @param {object} [options] { variant, force, restart }
   * @returns {boolean} 是否有该动作
   */
  trigger(name, options = {}) {
    const def = ACTIONS[name];
    if (!def) return false;
    const { variant = null, force = false } = options;

    // 去抖冷却：连点同一动作时，冷却窗口内直接忽略（force 可越过，供手势层使用）
    if (!force && this.cooldownLeft(name) > 0) return false;

    // 睡眠态是"粘性"的：除了 wake / idle-random，其它动作都先唤醒
    if (this.sleeping && name !== 'wake' && name !== 'sleep') {
      if (force) this.sleeping = false;
      else {
        this.trigger('wake');
        this.sleeping = false;
      }
    }

    const existing = this.actions.find((a) => a.name === name && a.variant === variant);
    if (existing) {
      // 已在进行中的一次性动作：重置进度（"连点有反应"），冷却也要重新计时
      existing.elapsed = 0;
      existing.t = 0;
      existing.done = false;
      this.#armCooldown(name);
      return true;
    }

    const rec = {
      name,
      variant,
      def,
      elapsed: 0,
      t: 0,
      done: false,
    };
    this.actions.push(rec);
    this.actionCounts[name] = (this.actionCounts[name] || 0) + 1;
    this.#armCooldown(name);

    if (name === 'sleep') this.sleeping = true;
    else if (name === 'wake') this.sleeping = false;

    // 一次性的"落地姿态"由动作自己保证，这里不错峰
    return true;
  }

  /** 该动作当前是否可触发（interactions/index.js 据此提前拒绝，省一次 push/pop） */
  canTrigger(name) {
    return this.cooldownLeft(name) <= 0;
  }

  /**
   * 剩余冷却毫秒（调试/测试用，也是 `trigger()` 去抖的判据）。
   *
   * **不要把它写成 `cd > 0`**：冷却按 `-= step*1000` 逐帧递减，浮点累减永远差一点，
   * 实测剩下 `1.31e-12` ms —— 落在「>0 为真、Math.round 为 0」的缝里。
   * 那样 `trigger()` 会静默拒绝（返回 false）而调试快照显示「冷却剩 0ms」，
   * 表现为「冷却明明走完了却打不开动作」，极难定位（本仓库为此查了一轮）。
   * 1ms 的余量远小于一帧（16.7ms），四舍五入掉不会让人眼察觉。
   */
  cooldownLeft(name) {
    const cd = this.cooldowns[name];
    return cd > 1 ? Math.round(cd) : 0;
  }

  /** 按 constants.ACTION_COOLDOWN 给动作上冷却 */
  #armCooldown(name) {
    const ms = ACTION_COOLDOWN[name] || 0;
    if (ms > 0) this.cooldowns[name] = ms;
  }

  /** 当前正在播放的动作名列表（调试/测试用） */
  getActions() {
    return this.actions.map((a) => a.name);
  }

  /** 持续型动作的开关（拖拽/抚摸），不会被 cooldown 影响 */
  setContinuous(name, on) {
    if (name === 'drag') {
      if (on === this.dragging) return;
      this.dragging = on;
      if (on) this.trigger('drag');
      else this.stopAction('drag');
      return;
    }
    if (name === 'pet') this.petting = !!on;
  }

  /** 打断某动作（loop 动作需要显式停） */
  stopAction(name) {
    const i = this.actions.findIndex((a) => a.name === name);
    if (i >= 0) this.actions.splice(i, 1);
  }

  /** 拖拽实时位移（canvas 逻辑像素） */
  setDragOffset(dx, dy) {
    this.targets.dragDX = clamp(dx, -120, 120);
    this.targets.dragDY = clamp(dy, -120, 120);
    this.targets.dragLean = clamp(dx * 0.34, -26, 26);
  }

  /** 甩出去的惯性：给一个速度，后续自动衰减 */
  setDragVelocity(vx, vy) {
    this.dragVelX = clamp(vx * 0.9, -900, 900);
    this.dragVelY = clamp(vy * 0.6, -420, 420);
  }

  /** 说话口型外部驱动；传负数 = 交还给内部节拍 */
  setMouth(value) {
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0) {
      this.mouthOverride = -1;
      return;
    }
    this.mouthOverride = clamp(v, 0, 1);
  }

  /** 鼠标跟随：传入 canvas 逻辑坐标 */
  lookAt(x, y) {
    const nx = (Number(x) - 180) / 180;
    const ny = (Number(y) - 240) / 240;
    this._look.x = clamp(Number.isFinite(nx) ? nx : 0, -1, 1);
    this._look.y = clamp(Number.isFinite(ny) ? ny : 0, -1, 1);
    this._look.active = true;
  }

  lookAway() {
    this._look.active = false;
  }

  /** 降低动效幅度（prefers-reduced-motion 或设置项） */
  setReducedMotion(on) {
    this.reducedMotion = !!on;
  }

  /* ───── 每帧推进 ───── */

  /**
   * 推进一帧。
   * @param {number} dt 秒（与 PetUI.update(dt) 同一口径，契约 §4）
   */
  update(dt) {
    // 截断抖动：>100ms 的跳变（切后台/断点）按 100ms 计，否则弹簧会炸
    const seconds = clamp(Number(dt) || 0, 0, 0.1);
    if (seconds <= 0) {
      // 仍然刷新 targets，保证 debug 读数一致
      this.#applyMoodTargets();
      return;
    }
    this.time += seconds;
    this.#trackFps(seconds);

    let left = seconds;
    let steps = 0;
    while (left > 1e-4 && steps < MAX_SUBSTEPS) {
      const step = Math.min(FIXED_STEP, left);
      this.#advance(step);
      left -= step;
      steps += 1;
    }
    // 极低帧率下剩下的时间直接补上，避免时间"欠账"越滚越多
    if (left > 1e-4) this.#advance(left);
  }

  /** 固定子步时长（秒），供调试与测试断言 */
  get fixedStep() {
    return FIXED_STEP;
  }

  /** FPS 估计：0.5 秒窗口，首个窗口直接取测量值，之后做半衰平滑 */
  #trackFps(seconds) {
    this._fpsAcc += seconds;
    this._fpsFrames += 1;
    if (this._fpsAcc >= 0.5) {
      const measured = this._fpsFrames / this._fpsAcc;
      this._fps = this._fps === TARGET_FPS ? measured : lerp(this._fps, measured, 0.5);
      this._fpsAcc = 0;
      this._fpsFrames = 0;
    }
  }

  /** 一个固定子步：动作 → 情绪目标 → 生命感 → 弹簧积分 → 限幅 */
  #advance(step) {
    const params = this.params;

    // 1) 动作进度
    this.#advanceActions(step);

    // 2) 情绪 + 动作 → 目标值（每帧重建，动作不残留状态）
    this.#applyMoodTargets(step);

    // 3) 生命感与交互叠加
    this.#applyLife(step);

    // 4) 弹簧积分 + 限幅
    for (const spec of RIG_SPEC) {
      const [key, , , , lo, hi, isArray] = spec;
      const s = this.springs.get(key);
      const target = this.targets[key];
      if (isArray) {
        for (let i = 0; i < target.length; i++) {
          stepSpring(s.get(i), target[i], step);
          params[key][i] = clamp(s.get(i).value, lo, hi);
        }
      } else {
        stepSpring(s, target, step);
        params[key] = clamp(s.value, lo, hi);
      }
    }

    // 拖拽速度的自然衰减（甩出去之后慢慢停）
    this.dragVelX *= Math.exp(-2.4 * step);
    this.dragVelY *= Math.exp(-2.8 * step);
    if (Math.abs(this.dragVelX) < 0.5) this.dragVelX = 0;
    if (Math.abs(this.dragVelY) < 0.5) this.dragVelY = 0;

    // 冷却推进（interactions 查询）
    for (const k in this.cooldowns) {
      if (this.cooldowns[k] > 0) {
        this.cooldowns[k] -= step * 1000;
        // 浮点余数（实测残 1.31e-12ms）必须一并清掉，否则 `>0` 的判据永远为真。
        if (this.cooldowns[k] <= 1) delete this.cooldowns[k];
      }
    }
  }

  #advanceActions(step) {
    const acts = this.actions;
    for (let i = acts.length - 1; i >= 0; i--) {
      const a = acts[i];
      a.elapsed += step;
      const dur = (a.def.dur + (a.def.hold || 0)) / 1000;
      a.t = dur > 0 ? clamp(a.elapsed / (a.def.dur / 1000), 0, 1) : 1;
      if (a.def.loop) {
        a.t = clamp(a.elapsed / (a.def.dur / 1000), 0, 1.6);
      }
      const expired = a.def.hold
        ? a.elapsed >= dur
        : a.elapsed >= a.def.dur / 1000;
      if (expired) acts.splice(i, 1);
    }
  }

  /** 把情绪基线（+ 正在播放的动作）写进 targets */
  #applyMoodTargets(forceOrStep = false) {
    const force = forceOrStep === true;
    const step = typeof forceOrStep === 'number' ? forceOrStep : 0;
    const p = this.pose.reset();
    const t = this.targets;

    // 情绪基线：只写该情绪声明过的键，其它保持"中立值"
    const def = getMoodDef(this.mood);
    for (const spec of RIG_SPEC) {
      const key = spec[0];
      const neutral = spec[1];
      const isArray = spec[6];
      if (isArray) continue;
      t[key] = key in def.pose ? def.pose[key] : neutral;
    }

    // 动作叠加
    for (const a of this.actions) {
      a.def.apply({
        t: a.t,
        phase: a.elapsed,
        p,
        variant: a.variant,
        rig: this,
      });
    }
    p.flush(t);

    // 情绪属性混合（数值型插值，枚举型到中点了再换）
    this.#stepProps(step, force);
  }

  /**
   * 情绪属性（表情/枚举形状）的过渡。
   * 数值型走线性插值，枚举型（mouthStyle / pupilShape）等混合过半再切换，
   * 避免"半张嘴"这种不存在的中间形状。
   */
  #stepProps(step, force = false) {
    const next = resolveMoodProps(this.mood);
    if (this.moodBlend < 1) this.moodBlend = clamp(this.moodBlend + step * 4.5, 0, 1);
    const b = this.moodBlend;
    for (const key in next) {
      if (typeof next[key] === 'number') {
        const from = typeof this.props[key] === 'number' ? this.props[key] : next[key];
        this.props[key] = lerp(from, next[key], b);
      } else if (b >= 0.5 || force) {
        this.props[key] = next[key];
      }
    }
    if (force) this.props = next;
  }

  /** 呼吸、眨眼、头发延迟、说话节拍、注视、拖拽惯性 */
  #applyLife(step) {
    const t = this.targets;
    const motion = this.reducedMotion ? 0.42 : 1;

    /* 呼吸：正弦，周期 ≈ 3.6s（睡觉时更慢，由 breathSpeed 缩放） */
    const speed = clamp(t.breathSpeed, 0.3, 1.9);
    this.breathPhase += step * (1 / 3.6) * speed;
    if (this.breathPhase > 1) this.breathPhase -= Math.floor(this.breathPhase);
    const breath = Math.sin(this.breathPhase * Math.PI * 2);
    const amp = t.breathAmp * motion;

    let bodyY = t.bodyY;
    let bodySquash = t.bodySquash;
    let bodyStretch = t.bodyStretch;
    bodyY += -breath * 1.7 * amp;
    bodySquash += breath * 0.013 * amp;
    bodyStretch += -breath * 0.016 * amp;

    /* 眨眼状态机：泊松间隔 + 偶发二次眨眼 */
    this.#advanceBlink(step);

    /* 头发延迟跟随：记录历史驱动量，各层按不同延迟取样 */
    const driveX = clamp(
      t.headYaw * 0.5 + t.bodyX * 0.22 + this.dragVelX * 0.024 + t.spin * 26,
      -60,
      60,
    );
    const driveY = clamp(t.headPitch * 0.28 - this.dragVelY * 0.02, -60, 60);
    this.hairHistory.push(driveX);
    if (this.hairHistory.length > 16) this.hairHistory.shift();
    this.hemHistory.push(clamp(t.bodyX * 0.34 + this.dragVelX * 0.02, -40, 40));
    if (this.hemHistory.length > 12) this.hemHistory.shift();

    for (let i = 0; i < t.hairLagX.length; i++) {
      const lagDelay = i * 2;
      t.hairLagX[i] =
        (this.hairHistory[Math.max(0, this.hairHistory.length - 1 - lagDelay)] || 0) * 0.85 * motion;
      t.hairLagY[i] =
        (this.hairHistory[Math.max(0, this.hairHistory.length - 1 - lagDelay)] || 0) * 0.3 * motion;
      t.hairLagY[i] += driveY * 0.22 * (1 - i * 0.18);
    }
    for (let i = 0; i < t.hemLagX.length; i++) {
      const idx = Math.max(0, this.hemHistory.length - 1 - i * 2);
      t.hemLagX[i] = this.hemHistory[idx] * 0.9 * motion;
    }
    // 拖拽/甩动时给一个额外的"甩尾"冲量
    if (this.dragVelX !== 0) {
      const kick = clamp(this.dragVelX * 0.03, -26, 26);
      for (let i = 0; i < t.hairLagX.length; i++) t.hairLagX[i] += kick * (1 - i * 0.15);
    }

    /* 说话口型：外部优先，否则内部节拍 */
    let mouth = t.mouthOpen;
    const speaking = t.speaking > 0.35 || this.props.mouthStyle === 'talk';
    if (this.mouthOverride >= 0) {
      mouth = Math.max(mouth, this.mouthOverride * (0.35 + 0.65 * t.speaking));
    } else if (speaking || this.props.mouthStyle === 'talk') {
      this.mouthPhase += step * 6.4;
      const beat = 0.5 + 0.5 * Math.sin(this.mouthPhase);
      const flutter = 0.5 + 0.5 * Math.sin(this.mouthPhase * 2.9 + 1.3);
      mouth += (0.22 + 0.5 * beat) * flutter * clamp(t.speaking, 0, 1) * 1.05;
    }
    mouth += this.props.mouthOpen || 0;

    /* 注视：鼠标（或思考时的偏置）→ gazeX/gazeY，再驱动头部小幅转动 */
    let gx = 0;
    let gy = 0;
    if (this._look.active) {
      // 死区 + 限幅：中心附近不抖，边缘也不会转过头
      gx = deadzone(this._look.x, 0.08) * (this.reducedMotion ? 0.55 : 1);
      gy = deadzone(this._look.y, 0.1) * (this.reducedMotion ? 0.55 : 1);
      gx = clamp(gx, -1, 1);
      gy = clamp(gy, -1, 1);
    }
    const biasX = this.props.gazeBiasX || 0;
    const biasY = this.props.gazeBiasY || 0;

    t.gazeX = clamp(gx + biasX, -1, 1);
    t.gazeY = clamp(gy + biasY, -1, 1);
    t.headYaw += t.gazeX * LOOK.yawScale * (this._look.active ? 1 : 0.35);
    t.headYawLag = t.gazeX * LOOK.yawLagScale;
    t.headPitch += t.gazeY * LOOK.pitchScale;

    /* 拖拽惯性：松手后的速度衰减用"指数衰减"而不是弹簧，
       避免高刚度弹簧把"甩出去"变成"被打回来" */
    if (!this.dragging && (this.dragVelX || this.dragVelY)) {
      const decayX = Math.exp(-TIMING.dragVelocityDecay * step);
      const decayY = Math.exp(-TIMING.dragVelocityDecay * 1.15 * step);
      t.dragDX = clamp(t.dragDX * decayX + this.dragVelX * step * 0.55, -120, 120);
      t.dragDY = clamp(t.dragDY * decayY + this.dragVelY * step * 0.35, -120, 120);
      t.dragLean = clamp(t.dragLean * decayX + this.dragVelX * step * 0.16, -26, 26);
      t.bodyX += clamp(t.dragDX * 0.22, -22, 22);
      t.bodyY += clamp(t.dragDY * 0.14, -14, 14);
      t.headTilt += clamp(t.dragDX * 0.16, -16, 16);
      t.hairSway += clamp(Math.abs(this.dragVelX) * 0.005, 0, 1.1);
      this.impulse = clamp(Math.abs(this.dragVelX) / 900, 0, 1);
    }

    /* 拖拽位移：index 侧给的实时位移，只在拖拽时叠加；松手后由弹簧自然归位 */
    if (this.dragging) {
      t.bodyX += clamp(t.dragDX * 0.16, -16, 16);
      t.bodyY += clamp(t.dragDY * 0.1, -10, 10);
      t.dragLean += clamp(t.dragDX * 0.12, -10, 10);
    }

    /* 旋转（甩动）归一化到 -1..1 */
    if (t.spin > 0.0001) t.spin = clamp(t.spin * Math.exp(-1.4 * step), 0, 1);

    /* 睡眠时呼吸与眨眼特殊处理 */
    if (this.sleeping) {
      bodyY += 4.5;
      t.hairSway *= 0.5;
    }

    /* 特效的自然衰减 */
    if (!this.actions.some((a) => ['double-tap', 'tap-face', 'laugh'].includes(a.name))) {
      t.glow *= Math.exp(-1.2 * step);
      t.sparkle *= Math.exp(-1.1 * step);
    }

    /* 随机小动作计时器（无动作在播、醒着、没被拖） */
    if (!this.dragging && !this.sleeping && this.actions.length === 0) {
      this.idleTimer -= step;
      if (this.idleTimer <= 0) {
        const pick = weightedPick(IDLE_ACTIONS);
        this.trigger(pick.id, { variant: pick.variant });
        this.idleTimer = randBetween(TIMING.idleActionMinMs, TIMING.idleActionMaxMs) / 1000;
      }
    }

    /* 降幅（prefers-reduced-motion） */
    if (this.reducedMotion) {
      bodyY *= 0.6;
      t.headYaw *= 0.7;
      t.headPitch *= 0.7;
      t.hairLagX = t.hairLagX.map((v) => v * 0.5);
      t.hairLagY = t.hairLagY.map((v) => v * 0.5);
      t.hairSway = Math.min(t.hairSway, 0.8);
    }

    /* 落回目标（限幅交给积分后的 clamp） */
    const baseEyeOpen = t.eyeOpen;
    t.bodyY = bodyY;
    t.bodySquash = bodySquash;
    t.bodyStretch = bodyStretch;
    t.mouthOpen = mouth;
    // 眨眼只影响"渲染出来的 eyeOpen"，不回写目标值（否则会在帧间累乘）
    this.blinkForDraw = computeBlinkVisual(this.blinkState, this.blinkProgress);
    t.eyeOpen = clamp(baseEyeOpen, 0, 1.45);
  }

  #advanceBlink(step) {
    if (this.blinkState === 'idle') {
      this.blinkCountdown -= step * 1000;
      if (this.blinkCountdown <= 0) {
        this.blinkState = 'closing';
        this.blinkProgress = 0;
      }
      return;
    }
    const closeDur = this.reducedMotion ? 0.16 : 0.085;
    const openDur = this.reducedMotion ? 0.2 : 0.11;
    if (this.blinkState === 'closing') {
      this.blinkProgress += step / closeDur;
      if (this.blinkProgress >= 1) {
        this.blinkProgress = 1;
        this.blinkState = 'opening';
      }
      return;
    }
    // opening
    this.blinkProgress -= step / openDur;
    if (this.blinkProgress <= 0) {
      this.blinkProgress = 0;
      this.blinkState = 'idle';
      this.blinkCountdown = nextBlinkDelayMs();
      // 二次眨眼：闭眼刚结束时按概率追加一次短间隔眨眼
      if (this.blinkQueue > 0) {
        this.blinkQueue -= 1;
        this.blinkCountdown = randBetween(90, 190);
      } else if (Math.random() < 0.22) {
        this.blinkQueue = 1;
      }
    }
  }

  /* ───── 调试 ───── */

  /**
   * 可序列化快照。契约要求含 mood / actions 计数 / fps 估计。
   */
  getDebugState() {
    const actions = Object.create(null);
    for (const k in this.actionCounts) actions[k] = this.actionCounts[k];
    // 冷却剩余快照（毫秒，只列还没走完的）。测试要能判断「动作没播是不是因为冷却」，
    // 而不是靠推固定帧数去猜时序 —— 见 tests/pet.test.mjs 里 greet/idle-random 的偶发红。
    const cooldowns = Object.create(null);
    for (const k in this.cooldowns) {
      if (this.cooldowns[k] > 0) cooldowns[k] = Math.round(this.cooldowns[k]);
    }
    const p = this.params;
    return {
      mood: this.mood,
      prevMood: this.prevMood,
      sleeping: this.sleeping,
      dragging: this.dragging,
      reducedMotion: this.reducedMotion,
      fps: Math.round(this._fps * 10) / 10,
      time: Math.round(this.time * 1000) / 1000,
      blink: Math.round((this.blinkForDraw ?? 0) * 1000) / 1000,
      actions,
      actionTotal: Object.values(this.actionCounts).reduce((a, b) => a + b, 0),
      playing: this.getActions(),
      cooldowns,
      params: {
        bodyX: round3(p.bodyX),
        bodyY: round3(p.bodyY),
        bodyLean: round3(p.bodyLean),
        bodySquash: round3(p.bodySquash),
        bodyStretch: round3(p.bodyStretch),
        headYaw: round3(p.headYaw),
        headPitch: round3(p.headPitch),
        headTilt: round3(p.headTilt),
        headBob: round3(p.headBob),
        eyeOpen: round3(p.eyeOpen),
        blink: round3(this.blinkForDraw ?? 0),
        mouthSmile: round3(p.mouthSmile),
        mouthOpen: round3(p.mouthOpen),
        speaking: round3(p.speaking),
        gazeX: round3(p.gazeX),
        gazeY: round3(p.gazeY),
        hairSway: round3(p.hairSway),
        hairLagX: p.hairLagX.map(round3),
        hemLagX: p.hemLagX.map(round3),
        armForward: round3(p.armForward),
        glow: round3(p.glow),
        sparkle: round3(p.sparkle),
        dragLean: round3(p.dragLean),
        spin: round3(p.spin),
      },
      // 情绪派生的"脸上参数"（draw.js 里 pose.blush / pose.mouthStyle 等来自这里）
      props: { ...this.props },
    };
  }
}

/* ───────────────────────── 纯函数辅助 ───────────────────────── */

/** 眨眼视觉值：closing 阶段 0→1，opening 阶段 1→0 */
export function computeBlinkVisual(state, progress) {
  if (state === 'closing') return clamp(progress, 0, 1);
  if (state === 'opening') return clamp(progress, 0, 1);
  return 0;
}

/** 泊松式眨眼间隔（毫秒）：2.4s ~ 6.8s */
function nextBlinkDelayMs() {
  return randBetween(2400, 6800);
}

export function randBetween(min, max) {
  return min + Math.random() * (max - min);
}

function deadzone(v, zone) {
  if (Math.abs(v) <= zone) return 0;
  const sign = v < 0 ? -1 : 1;
  return sign * clamp((Math.abs(v) - zone) / (1 - zone), 0, 1);
}

function round3(v) {
  return Math.round((Number(v) || 0) * 1000) / 1000;
}

function weightedPick(list) {
  let total = 0;
  for (const it of list) total += it.weight;
  let r = Math.random() * total;
  for (const it of list) {
    r -= it.weight;
    if (r <= 0) return it;
  }
  return list[list.length - 1];
}

export default Rig;
