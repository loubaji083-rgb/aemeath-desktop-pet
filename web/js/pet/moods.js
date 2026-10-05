/**
 * Aemeath 桌宠 —— 情绪参数表（10 种）
 *
 * 设计说明：
 *  - 本文件是**纯数据 + 纯函数**，不依赖 DOM / canvas，可被 node:test 直接导入。
 *  - `pose` 里的键与 rig.js 的 RIG_SPEC 一一对应：rig 负责用弹簧把这些目标值插值过去，
 *    所以情绪切换永远是"渐变"而不是"跳变"。
 *  - `props` 是**离散外观属性**（眉毛角度、嘴型样式…），不参与弹簧积分；
 *    但 rig 每帧会把 props 的数值属性按当前情绪的湿度混合，避免嘴型/眉形硬切。
 */

/** @typedef {'idle'|'happy'|'shy'|'surprised'|'sad'|'angry'|'sleepy'|'excited'|'think'|'listen'|'speak'} Mood */

/** 契约要求的情绪集合（顺序即 UI 展示顺序） */
export const MOODS = [
  'idle',
  'happy',
  'shy',
  'surprised',
  'sad',
  'angry',
  'sleepy',
  'excited',
  'think',
  'listen',
  'speak',
];

/**
 * 会随情绪切换而插值的**属性**白名单（数值型）。
 * 嘴型/瞳孔样式属于枚举，切换时直接取当前情绪的值。
 */
export const MOOD_PROP_KEYS = [
  'browAngleL',
  'browAngleR',
  'browY',
  'blush',
  'eyeOpen',
  'eyeSmile',
  'mouthOpen',
  'pupilShape',
  'sweat',
  'sigh',
];

/**
 * 情绪表。
 * @type {Record<Mood, {pose: object, props: object}>}
 */
export const MOOD_TABLE = {
  /* 待机：安静、轻微微笑，呼吸与眨眼全靠底层驱动 */
  idle: {
    pose: {
      breathAmp: 1,
      mouthSmile: 0.3,
      headPitch: 0,
      headYaw: 0,
      browAngle: 0.1,
      bodyLean: 0,
      eyeOpen: 1,
      hairSway: 1,
    },
    props: { mouthStyle: 'soft', pupilShape: 'round', blush: 0.18, eyeSmile: 0.18, sigh: 0 },
  },

  /* 开心：眼睛弯成月牙、嘴角上扬、头发更活泼 */
  happy: {
    pose: {
      breathAmp: 1.15,
      mouthSmile: 0.85,
      headPitch: -2,
      headYaw: 0,
      browAngle: 0.55,
      bodyLean: 0,
      eyeOpen: 0.92,
      hairSway: 1.3,
    },
    props: { mouthStyle: 'smile', pupilShape: 'round', blush: 0.3, eyeSmile: 0.85, sigh: 0 },
  },

  /* 害羞：低头、脸红、手往身前收（由 armForward 驱动）、不敢直视 */
  shy: {
    pose: {
      breathAmp: 0.85,
      mouthSmile: 0.25,
      headPitch: 11,
      headYaw: -6,
      browAngle: -0.3,
      bodyLean: 0,
      eyeOpen: 0.7,
      hairSway: 0.7,
      armForward: 0.7,
      blushPulse: 1,
    },
    props: {
      mouthStyle: 'small',
      pupilShape: 'round',
      blush: 0.95,
      eyeSmile: 0.2,
      browWorry: 0.35,
      sigh: 0,
    },
  },

  /* 惊讶：睁大眼、张嘴、身体微微后仰 */
  surprised: {
    pose: {
      breathAmp: 1.5,
      mouthSmile: 0,
      mouthOpen: 0.6,
      headPitch: -5,
      headYaw: 0,
      browAngle: 0.9,
      bodyLean: -3,
      eyeOpen: 1.28,
      hairSway: 1.2,
      armForward: 0.3,
    },
    props: { mouthStyle: 'o', pupilShape: 'small', blush: 0.2, eyeSmile: 0, sigh: 0 },
  },

  /* 难过：垂眉、嘴角向下、呼吸更浅、肩膀收 */
  sad: {
    pose: {
      breathAmp: 0.62,
      mouthSmile: -0.55,
      headPitch: 9,
      headYaw: -3,
      browAngle: -1,
      bodyLean: 1.5,
      eyeOpen: 0.82,
      hairSway: 0.55,
      armForward: 0.25,
    },
    props: { mouthStyle: 'frown', pupilShape: 'round', blush: 0.1, browWorry: 0.9, sigh: 0.35 },
  },

  /* 生气：竖眉、鼓腮、身体前倾、头发炸一点 */
  angry: {
    pose: {
      breathAmp: 1.35,
      mouthSmile: -0.45,
      headPitch: -3,
      headYaw: 0,
      browAngle: 1.25,
      bodyLean: -2,
      eyeOpen: 1.05,
      hairSway: 1.5,
      pout: 0.85,
    },
    props: { mouthStyle: 'pout', pupilShape: 'sharp', blush: 0.45, sweat: 0.45, sigh: 0 },
  },

  /* 困倦：半睁眼、低头、呼吸慢而深 */
  sleepy: {
    pose: {
      breathAmp: 0.7,
      breathSpeed: 0.5,
      mouthSmile: 0.05,
      mouthOpen: 0.22,
      headPitch: 13,
      headYaw: -4,
      browAngle: -0.5,
      bodyLean: 2,
      eyeOpen: 0.3,
      hairSway: 0.35,
    },
    props: { mouthStyle: 'soft', pupilShape: 'round', blush: 0.25, sigh: 0.6 },
  },

  /* 兴奋：睁眼发光、双手抬起、星特效（由动作/特效通道驱动） */
  excited: {
    pose: {
      breathAmp: 1.7,
      breathSpeed: 1.35,
      mouthSmile: 1,
      mouthOpen: 0.28,
      headPitch: -6,
      headYaw: 0,
      browAngle: 1,
      bodyLean: 0,
      eyeOpen: 1.15,
      hairSway: 1.75,
      armForward: 0.55,
    },
    props: { mouthStyle: 'smile', pupilShape: 'star', blush: 0.4, eyeSmile: 0.4, sigh: 0 },
  },

  /* 思考：眼珠上飘、单手抬起（armForward）、嘴角平 */
  think: {
    pose: {
      breathAmp: 0.9,
      mouthSmile: 0.15,
      headPitch: -7,
      headYaw: 8,
      browAngle: 0.3,
      bodyLean: 0,
      eyeOpen: 0.95,
      hairSway: 0.8,
      armForward: 0.42,
      think: 1,
    },
    props: {
      mouthStyle: 'small',
      pupilShape: 'round',
      blush: 0.15,
      gazeBiasY: -0.55,
      gazeBiasX: 0.25,
      sigh: 0,
    },
  },

  /* 倾听：眼睛睁亮、身体前倾、嘴微张（准备回应） */
  listen: {
    pose: {
      breathAmp: 1.05,
      mouthSmile: 0.35,
      mouthOpen: 0.12,
      headPitch: -3,
      headYaw: 2,
      browAngle: 0.5,
      bodyLean: -1,
      eyeOpen: 1.1,
      hairSway: 0.9,
    },
    props: { mouthStyle: 'soft', pupilShape: 'round', blush: 0.22, eyeSmile: 0.15, sigh: 0 },
  },

  /* 说话：口型由 setMouth/内部节拍驱动，头轻微摆动 */
  speak: {
    pose: {
      breathAmp: 1.1,
      mouthSmile: 0.4,
      headPitch: -2,
      headYaw: 0,
      browAngle: 0.4,
      bodyLean: 0,
      eyeOpen: 1,
      hairSway: 1.1,
      speaking: 1,
      armForward: 0.3,
    },
    props: { mouthStyle: 'talk', pupilShape: 'round', blush: 0.22, eyeSmile: 0.2, sigh: 0 },
  },
};

/** 兜底：未知情绪一律回到 idle */
export const FALLBACK_MOOD = 'idle';

/**
 * 判定情绪名是否合法。
 * @param {unknown} mood
 * @returns {boolean}
 */
export function isMood(mood) {
  return typeof mood === 'string' && Object.prototype.hasOwnProperty.call(MOOD_TABLE, mood);
}

/**
 * 取情绪定义（未知名 → idle，保证永不抛错）。
 * @param {unknown} mood
 * @returns {{pose: object, props: object, name: string}}
 */
export function getMoodDef(mood) {
  const name = isMood(mood) ? /** @type {Mood} */ (mood) : FALLBACK_MOOD;
  return { name, pose: MOOD_TABLE[name].pose, props: MOOD_TABLE[name].props };
}

/**
 * 枚举型属性的默认值（某个情绪没写就用这里的）。
 * 保证 draw.js 永远拿得到完整属性，不用到处写 `?? fallback`。
 */
const PROP_DEFAULTS = {
  mouthStyle: 'soft',
  pupilShape: 'round',
  eyeSmile: 0.2,
  blush: 0.2,
  browAngle: 0,
  browY: 0,
  browWorry: 0,
  sweat: 0,
  sigh: 0,
  gazeBiasX: 0,
  gazeBiasY: 0,
};

/**
 * 把某情绪的属性补全为完整对象（数值属性会被 rig 跨情绪混合）。
 * @param {unknown} mood
 * @returns {Record<string, any>}
 */
export function resolveMoodProps(mood) {
  return { ...PROP_DEFAULTS, ...getMoodDef(mood).props };
}

export default MOOD_TABLE;
