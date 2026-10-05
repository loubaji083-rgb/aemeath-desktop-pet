/**
 * Aemeath 桌宠 —— 常量与几何模型（原创 Q 版角色，零外部素材）
 *
 * 这里是"唯一几何真相"：骨骼锚点、身体轮廓、命中判定都从这一份数据派生，
 * 保证"画出来的形状"与"点得中的区域"永远一致（碰撞数值可推敲）。
 *
 * 画布逻辑尺寸固定 360×480；高分屏由 index.js 按 devicePixelRatio 缩放。
 *
 * ⚠ 本文件只允许用 UTF-8 写：Windows PowerShell 的 `Get-Content -Raw` / `Set-Content`
 *   会按 ANSI(GBK) 解码 UTF-8，一旦回写就会把中文注释变成 U+FFFD 并吞掉换行。
 */

/* ───────────────────────── 画布 ───────────────────────── */

export const CANVAS_W = 360;
export const CANVAS_H = 480;

/** 归一化坐标系：originX/originY 是"脚底中心"，也是所有绘制相对的 (0,0) */
export const ORIGIN_X = CANVAS_W / 2; // 180
export const ORIGIN_Y = 452; // 脚底：下方留 28px 给地面阴影

/** 目标帧率（仅用于 FPS 估计与调试） */
export const TARGET_FPS = 60;

/**
 * 关键分区边界（画布绝对坐标）：
 *  - 头部（含头发）大致占画布上方 1/3：y ∈ [44, 236]
 *  - 身体占下方 2/3：y ∈ [214, 452]
 *  - 头部中心 (180, 140) 正好落在画布上方 1/3（480/3 = 160）以内
 */
export const REGION = {
  headTopY: 44,
  headBottomY: 236,
  bodyTopY: 214,
  bodyBottomY: 452,
};

/* ───────────────────────── 骨骼锚点（归一化坐标） ───────────────────────── */

export const BONES = {
  /** 脚底中心 (0,0) */
  root: { x: 0, y: 0 },
  /** 胯部 */
  hip: { x: 0, y: -74 },
  /** 胸口（呼吸起伏的受力点） */
  chest: { x: 0, y: -122 },
  /** 脖子（头部旋转与延迟跟随的枢轴） */
  neck: { x: 0, y: -188 },
  /** 头部中心 */
  head: { x: 0, y: -312 },
  /** 脸的中心（五官基准） */
  face: { x: 0, y: -302 },
  /** 肩宽（手臂挂点） */
  shoulder: { x: 74, y: -158 },
};

/* ───────────────────────── 身体轮廓（归一化坐标） ───────────────────────── */

/** 头部：略带纵向拉伸的蛋形 */
export const HEAD = { cx: 0, cy: -312, rx: 62, ry: 58 };
/** 脸部椭圆（五官都落在这里面） */
export const FACE = { cx: 0, cy: -302, rx: 43, ry: 37 };

/**
 * 躯干多边形（从圆角上衣下沿闭环到脖子）。
 * 宽度往胯部收窄，形成 Q 版"短粗上身"的可爱比例。
 * 上沿从 -184 抬到 -212（world 240）：下巴 world 198 与上沿之间原本有 70px 的空档，
 * 只填着后发，读起来像"头浮在身体上"（Lead 返工单 ③）；抬高后躯干也变高，
 * 头身比更接近 1:1.5 的 Q 版比例。
 */
export const TORSO = [
  [-54, -212],
  [54, -212],
  [58, -186],
  [54, -112],
  [58, -78],
  [50, -66],
  [-50, -66],
  [-58, -78],
  [-54, -112],
  [-58, -186],
];

/**
 * 腿 / 鞋（归一化坐标，用于站立时的小短腿）。
 * `bottom` 是脚踝/鞋底所在的脚底系 y：必须贴近 0（脚底），否则角色会悬在地面阴影上方。
 * 曾经写成 -12，脚离地 38px，屏幕上像飘着。
 */
export const LEGS = [
  { x: -22, top: -76, bottom: 0, w: 19 },
  { x: 22, top: -76, bottom: 0, w: 19 },
];
export const FOOT = { w: 34, h: 15 };

/* ───────────────────────── 头发轮廓 ───────────────────────── */

/**
 * 后发（披发）：绘制在身体之后、头之前，形成"延迟跟随"最明显的部件。
 * 注意 rx 是**半宽**（脚底系）：88 会让两侧各超出躯干 30px，视觉上变成"披风罩住全身"，
 * 所以收敛到 78、bottom 收到 -152（发梢落在胯部上方），让躯干与手臂露出来。
 */
export const BACK_HAIR = {
  cx: 0,
  cy: -300,
  rx: 78,
  ry: 96,
  bottom: -152,
  /** 发梢摆动的 3 个控制点（归一化 x，越大越外侧） */
  tips: [-58, 0, 58],
};

/**
 * 侧发（鬓角）：位于头部两侧，属于 'hair' 命中区。
 * 曾经的 rx22/ry54（每侧 44×114px、外侧超出头壳 11px、下缘糊到肩膀 world 224）
 * 读起来像"两只大耳朵"、且与后发体量重复；Lead 裁决 ① 批准收窄到 34×80、
 * 下缘提到 world 190，正好贴在耳侧，不再压到肩膀。
 */
export const SIDE_HAIR = {
  left: { cx: -56, cy: -302, rx: 17, ry: 40 },
  right: { cx: 56, cy: -302, rx: 17, ry: 40 },
};

/**
 * 前发（刘海）：盖在脸上，绘制顺序在眼睛之后。
 * 锯齿 7 段、幅度由中间向两侧递减（旧版只有 4 段、drop 22~26，
 * 中间最长的一束落到 world ≈200，把额头切成一条"拉链"，还压到眉毛与眼睛）。
 * 现在的 drop 让最长的中间束停在眉毛上方约 7px，两侧几乎平贴额头。
 */
export const FRONT_HAIR = {
  cx: 0,
  cy: -356,
  rx: 62,
  ry: 40,
  /** 锯齿刘海：相对 (0, y) 的一串 x 偏移 + 尖长（w 是发束根部宽度，drop 是尖长） */
  strands: [
    { x: -50, w: 16, drop: 5, lean: -0.26 },
    { x: -34, w: 15, drop: 9, lean: -0.16 },
    { x: -17, w: 18, drop: 12, lean: -0.06 },
    { x: 1, w: 19, drop: 13, lean: 0.04 },
    { x: 19, w: 17, drop: 11, lean: 0.12 },
    { x: 35, w: 15, drop: 8, lean: 0.2 },
    { x: 50, w: 16, drop: 5, lean: 0.28 },
  ],
};

/* ───────────────────────── 手脚（命中 + 绘制共用） ───────────────────────── */

/**
 * 手：圆角小手套。命中判定用手心圆（比视觉略大，符合"点到手"的手感）。
 *  - rest   ：待机握在身体两侧
 *  - forward：说话/打招呼时伸到身前
 */
/**
 * 手：圆角小手套。命中判定用手心圆（比视觉略大，符合"点到手"的手感）。
 *  - rest   ：自然垂在躯干两侧（Lead 返工单 ②：旧值 y=-150 → world 302，
 *             手搭在胸口上，正面看像"把两只手举在胸前"；现在 y=-104 → world 348）
 *  - forward：说话/打招呼时伸到身前（world ≈302，抬到胸口高度）
 */
export const HANDS = {
  left: { x: -68, y: -104, r: 15, hitR: 21 },
  right: { x: 68, y: -104, r: 15, hitR: 21 },
  forwardLeft: { x: -46, y: -150, r: 15, hitR: 21 },
  forwardRight: { x: 46, y: -150, r: 15, hitR: 21 },
};

/* ───────────────────────── 动作 id（契约 §4：至少 12 个） ───────────────────────── */

export const ACTIONS = [
  'tap-head', // 摸头：眯眼 + 蹭
  'tap-face', // 戳脸：惊讶 + 鼓腮
  'tap-body', // 戳身体：扭动 + 害羞
  'tap-hand', // 牵手：抬手 + 开心
  'double-tap', // 双击：跳一下 + 星星眼
  'long-press', // 长按：靠过来 + 蹭手心
  'drag', // 拖拽：身体晃 + 头发飘
  'drop', // 落下：回弹 + 站定
  'idle-random', // 随机小动作（打哈欠/看四周/整理头发）
  'greet', // 打招呼
  'sleep', // 睡觉（呼吸变慢）
  'wake', // 醒来（伸懒腰）
];

/** 命中部位 */
export const HIT_PARTS = ['head', 'face', 'body', 'hand', 'hair', 'none'];

/** 部位的点按 → 一次性动作映射 */
export const PART_ACTION = {
  head: 'tap-head',
  hair: 'tap-head',
  face: 'tap-face',
  body: 'tap-body',
  hand: 'tap-hand',
};

/** 每种动作的去抖冷却（毫秒）：防止连点把动画刷爆 */
export const ACTION_COOLDOWN = {
  'tap-head': 700,
  'tap-face': 700,
  'tap-body': 700,
  'tap-hand': 700,
  'double-tap': 900,
  'long-press': 1400,
  drag: 300,
  drop: 400,
  'idle-random': 5200,
  greet: 2600,
  sleep: 2000,
  wake: 2000,
};

/* ───────────────────────── 交互时序常量 ───────────────────────── */

export const TIMING = {
  /** 双击判定窗口 */
  doubleTapMs: 250,
  /** 长按判定阈值 */
  longPressMs: 520,
  /** 超过该位移视为拖拽（并取消长按） */
  dragThresholdPx: 7,
  /** 拖拽惯性的衰减（每秒保留比例） */
  dragVelocityDecay: 3.2,
  /** 单次"随机小动作"的间隔区间 */
  idleActionMinMs: 9000,
  idleActionMaxMs: 20000,
};

/* ───────────────────────── 配色（原创柔和色板） ───────────────────────── */

export const PALETTE = {
  hairBack: '#8fd7e8',
  hairBackDark: '#6fc0d6',
  hairMain: '#a9e4f2',
  hairLight: '#d3f2fa',
  hairShade: '#7cc9de',

  skin: '#ffe6d6',
  skinShade: '#f6cdb8',
  skinLine: '#d8a48f',

  blush: 'rgba(255,143,163,0.42)',
  blushDeep: 'rgba(255,120,146,0.55)',

  eyeWhite: '#ffffff',
  irisOuter: '#4fb3c9',
  irisInner: '#8fe0ef',
  pupil: '#2b3a4a',
  eyeHi: '#ffffff',
  lash: '#5a6b7d',
  brow: '#7a93a6',

  cloth: '#a9b6f5',
  clothDark: '#8d9ce8',
  clothLight: '#c7d0fb',
  clothLine: '#7d8ce0',

  inner: '#ffd9e6',
  cuff: '#fdfdff',
  shoe: '#7a86d6',

  line: 'rgba(66,84,110,0.55)',
  lineSoft: 'rgba(66,84,110,0.28)',

  mouth: '#e06a86',
  mouthInner: '#b8425f',

  shadow: 'rgba(70,100,140,0.20)',
  glow: 'rgba(255,246,190,0.95)',
  star: '#ffe9a3',

  bubbleBg: 'rgba(255,255,255,0.97)',
  bubbleLine: 'rgba(120,160,200,0.65)',
  bubbleText: '#2f4358',
};

/** 眼睛参数 */
export const EYE = {
  /** 双眼中心（归一化） */
  left: { x: -19, y: -304 },
  right: { x: 19, y: -304 },
  /** 眼球尺寸（高度会乘 open 与 blink） */
  rx: 11,
  ry: 14.5,
  /** 瞳孔相对眼睛中心的偏移范围 */
  gazeX: 4.2,
  gazeY: 3.4,
  /** 绘制用的伪 3D 瞳孔基准 Y */
  pupilBaseY: -305,
  pupilRx: 6.4,
  pupilRy: 7.6,
};

/** 抬头/低头时视觉偏移（假 3D）：yaw 越大，五官越小幅外移，pitch 影响 y 偏移 */
export const FACE_PROJECTION = {
  yawX: 6.5,
  pitchY: 3.2,
};

/** 随机小动作表：权重越大越常发生 */
export const IDLE_ACTIONS = [
  { id: 'idle-random', variant: 'yawn', weight: 3 },
  { id: 'idle-random', variant: 'look-around', weight: 3 },
  { id: 'idle-random', variant: 'fix-hair', weight: 2 },
  { id: 'idle-random', variant: 'hop-corner', weight: 2 },
];
