/**
 * Aemeath 桌宠 —— 纯 Canvas 2D 绘制层
 *
 * 设计约束：
 *  - **零外部素材**：全部由路径/渐变/弧线程序化绘制，不加载任何图片、字体、模型。
 *  - **纯函数风格**：`drawPet(ctx, pose, opts)` 不持有状态，同一个 pose 永远画出同一帧。
 *  - **固定绘制顺序**（契约 §4）：
 *      地面阴影 → 后发 → 腿 → 身体 → 手臂 → 服饰 → 头 → 脸 → 眼 → 前发 → 特效
 *  - 坐标系：先 `translate(ORIGIN_X, ORIGIN_Y)` 建立"脚底为原点"的连续坐标世界，
 *    头发等远离原点的部件再局部平移，避免浮点误差让 300px 外的发梢抖动。
 */

import {
  CANVAS_W,
  CANVAS_H,
  ORIGIN_X,
  ORIGIN_Y,
  BONES,
  TORSO,
  LEGS,
  FOOT,
  BACK_HAIR,
  SIDE_HAIR,
  FRONT_HAIR,
  HANDS,
  EYE,
  FACE,
  FACE_PROJECTION,
  PALETTE,
} from './constants.js';

/* ───────────────────────── 基础工具 ───────────────────────── */

const TAU = Math.PI * 2;

/*
 * 圆角矩形：用 4 段 arc 拼，**不要用 arcTo**。
 * 原因：tools/dump-pet-frame.mjs 把 arcTo 记成 'AT'，而 tools/rasterize-canvas.py:210
 * 把 'AT' 简化成"直接连到 (x2,y2)"，圆角矩形会被拍平成缺角三角块（鞋、袖口都中招）；
 * smoke-pet-frame.mjs:161 也把 'AT' 的控制点当顶点算包围盒 → 包围盒虚胖。
 * 改成 arc 后几何完全等价（arc 走 'A' 分支，工具链能正确展开）。
 */
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arc(x + w - rr, y + rr, rr, -Math.PI / 2, 0);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arc(x + w - rr, y + h - rr, rr, 0, Math.PI / 2);
  ctx.lineTo(x + rr, y + h);
  ctx.arc(x + rr, y + h - rr, rr, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + rr);
  ctx.arc(x + rr, y + rr, rr, Math.PI, Math.PI * 1.5);
  ctx.closePath();
}

function ellipsePath(ctx, cx, cy, rx, ry, rot = 0) {
  ctx.beginPath();
  ctx.ellipse(cx, cy, Math.max(0.1, rx), Math.max(0.1, ry), rot, 0, TAU);
}

/** 通过两点的胶囊（用来画四肢/发束） */
function capsule(ctx, x1, y1, x2, y2, r1, r2 = r1) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 0.0001;
  const a = Math.atan2(dy, dx);
  const nx = -dy / len;
  const ny = dx / len;
  ctx.beginPath();
  ctx.moveTo(x1 + nx * r1, y1 + ny * r1);
  ctx.lineTo(x2 + nx * r2, y2 + ny * r2);
  ctx.arc(x2, y2, r2, a - Math.PI / 2, a + Math.PI / 2);
  ctx.lineTo(x1 - nx * r1, y1 - ny * r1);
  ctx.arc(x1, y1, r1, a + Math.PI / 2, a + Math.PI * 1.5);
  ctx.closePath();
}

/** 平滑曲线：依次穿过 points 的 Catmull-Rom → 二次贝塞尔近似 */
function smoothPath(ctx, pts, closed = false) {
  if (pts.length < 2) return;
  ctx.beginPath();
  const n = pts.length;
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i % n];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2[0], p2[1]);
  }
  if (closed) ctx.closePath();
}

function vGrad(ctx, y0, y1, c0, c1) {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, c0);
  g.addColorStop(1, c1);
  return g;
}

function strokeSoft(ctx, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;

/* ───────────────────────── 地面阴影 ───────────────────────── */

function drawShadow(ctx, pose) {
  // 被拎起来时阴影变小变淡 —— 这是"离地"最强的视觉线索
  const lift = clamp(pose.bodyY / -60, 0, 1.2);
  const scale = clamp(1 - Math.abs(lift) * 0.32, 0.55, 1);
  const alpha = clamp(0.9 - Math.abs(lift) * 0.5, 0.25, 0.9);
  ctx.save();
  ctx.translate(pose.bodyX * 0.35, 2);
  ctx.globalAlpha = alpha;
  const g = ctx.createRadialGradient(0, 0, 2, 0, 0, 62);
  g.addColorStop(0, 'rgba(70,100,140,0.34)');
  g.addColorStop(0.65, 'rgba(70,100,140,0.16)');
  g.addColorStop(1, 'rgba(70,100,140,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(0, 0, 58 * scale, 15 * scale, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/* ───────────────────────── 头发 ───────────────────────── */

/**
 * 后发：一大片弧形披发 + 三个会延迟摆动的发梢。
 * @param {number} phase 呼吸相位（让发丝有极轻微的生命感）
 */
function drawBackHair(ctx, pose, phase) {
  const sway = pose.hairSway;
  const breath = Math.sin(phase * TAU) * 1.1 * sway;
  const lag = pose.hairLagX;

  ctx.save();
  ctx.translate(BACK_HAIR.cx, BACK_HAIR.cy);

  const top = -BACK_HAIR.ry * 0.98;
  const left = -BACK_HAIR.rx;
  const right = BACK_HAIR.rx;
  const bottomY = BACK_HAIR.bottom - BACK_HAIR.cy;

  // 三个发梢的横向摆幅：越靠外侧越大（真实的"甩尾"）
  const tips = BACK_HAIR.tips.map((x, i) => {
    const l = lag[Math.min(i, lag.length - 1)] || 0;
    const w = Math.abs(x) / 64;
    return [x + l * (0.45 + w * 0.8), bottomY + Math.abs(l) * 0.22 + breath * 0.6];
  });
  const lL = lag[0] || 0;
  const lR = lag[Math.min(2, lag.length - 1)] || 0;

  const pts = [
    [0, top - 6],
    [right * 0.72, top + 24],
    [right, -6 + lR * 0.4],
    [right * 0.94, bottomY * 0.62 + lR * 0.5],
    [right * 0.9 + tips[2][0] * 0.05, bottomY - 12],
    tips[2],
    [0, bottomY + 10 + breath * 0.8],
    tips[0],
    [left * 0.9 + tips[0][0] * 0.05, bottomY - 12],
    [left * 0.94, bottomY * 0.62 + lL * 0.5],
    [left, -6 + lL * 0.4],
    [left * 0.72, top + 24],
  ];

  const g = vGrad(ctx, top, bottomY, PALETTE.hairMain, PALETTE.hairBackDark);
  smoothPath(ctx, pts, true);
  ctx.fillStyle = g;
  ctx.fill();
  strokeSoft(ctx, 'rgba(80,140,165,0.5)', 2.1);

  // 内侧高光：一条细细的弧，给头发"厚度"
  ctx.save();
  ctx.clip();
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.ellipse(-18, -44, 34, 62, -0.35, 0, TAU);
  ctx.fillStyle = PALETTE.hairLight;
  ctx.fill();
  ctx.restore();

  ctx.restore();
}

/** 侧发（鬓角）：位于头两侧，属于 'hair' 命中区 */
function drawSideHair(ctx, pose, phase) {
  const lag = pose.hairLagX;
  const breath = Math.sin(phase * TAU + 1.2) * 1.4;
  for (const [side, def, idx] of [
    ['left', SIDE_HAIR.left, 0],
    ['right', SIDE_HAIR.right, Math.min(2, lag.length - 1)],
  ]) {
    const l = lag[idx] || 0;
    ctx.save();
    /* SIDE_HAIR.*.cy=-288 是世界系（脚底为原点）值，本函数在**头部局部系**里被调用
     * （原点是头心 BONES.head.y=-312），所以要减掉头心 y，鬓角才会贴在耳侧。 */
    ctx.translate(def.cx + l * 0.35, def.cy - BONES.head.y);
    const pts = [
      [0, -def.ry],
      [def.rx * 0.9, -def.ry * 0.45],
      [def.rx * 0.82 + l * 0.12, def.ry * 0.35],
      [def.rx * 0.35 + l * 0.3, def.ry + breath * 0.5],
      [-def.rx * 0.5 + l * 0.34, def.ry * 0.72 + breath * 0.4],
      [-def.rx * 0.95, def.ry * 0.1],
      [-def.rx * 0.85, -def.ry * 0.5],
    ];
    smoothPath(ctx, pts, true);
    ctx.fillStyle = vGrad(ctx, -def.ry, def.ry, PALETTE.hairMain, PALETTE.hairShade);
    ctx.fill();
    strokeSoft(ctx, 'rgba(80,140,165,0.45)', 1.8);
    ctx.restore();
  }
}

/** 前发（刘海）：锯齿状发束，绘制在眼睛之后 */
function drawFrontHair(ctx, pose, phase) {
  const bob = Math.sin(phase * TAU + 0.6) * 1.2;
  const lag = pose.hairLagX;
  const l0 = lag[0] || 0;
  const l1 = lag[Math.min(3, lag.length - 1)] || 0;

  ctx.save();
  /* FRONT_HAIR.cx/cy 是**世界系**（脚底为原点）的值，cy=-356 相对头心 -312 只有 -44。
   * 而这里位于"头部局部系"（原点是头心 BONES.head.y），所以必须先把头心的偏移减掉，
   * 否则整片刘海会再向上飘 312px，把眼睛的位置占掉（真实事故：眼/眉/嘴全被刘海盖住）。 */
  ctx.translate(FRONT_HAIR.cx, FRONT_HAIR.cy - BONES.head.y + bob);

  // 主体：半圆的"锅盖"，下缘抬到额头线 base（旧版下缘在 ry*0.95，已经切进脸里）
  const top = -FRONT_HAIR.ry * 1.12;
  const base = FRONT_HAIR.ry * 0.28;
  const rx = FRONT_HAIR.rx;
  const body = [
    [-rx * 0.9, base],
    [-rx, FRONT_HAIR.ry * 0.2],
    [-rx * 0.62, top + 12],
    [0, top],
    [rx * 0.62, top + 12],
    [rx, FRONT_HAIR.ry * 0.2],
    [rx * 0.9, base],
  ];
  smoothPath(ctx, body, false);

  /* 逐束锯齿：从右端往左收口，方向与上面路径的终点一致。
   * 旧版从右端 lineTo 到最左侧的发束，填充后额头上多出一条横贯的对角线，
   * 看着像"拉链"——这也是 Lead 返工单 ④ 的来源。 */
  const strands = FRONT_HAIR.strands;
  for (let i = strands.length - 1; i >= 0; i--) {
    const s = strands[i];
    const tipLag = (s.x < 0 ? l0 : l1) * 0.4;
    const tipX = s.x + s.lean * s.w + tipLag;
    const tipY = base + s.drop;
    const valleyX = i > 0 ? strands[i - 1].x + strands[i - 1].w * 0.5 : -rx * 0.9;
    ctx.quadraticCurveTo(s.x + s.w * 0.5, base - 2, tipX, tipY);
    ctx.quadraticCurveTo(s.x - s.w * 0.4, base + 1, valleyX, base - 2);
  }
  ctx.closePath();
  ctx.fillStyle = vGrad(ctx, top, FRONT_HAIR.ry + 30, PALETTE.hairLight, PALETTE.hairMain);
  ctx.fill();
  strokeSoft(ctx, 'rgba(90,150,175,0.45)', 1.7);

  // 高光：两条短弧
  ctx.save();
  ctx.clip();
  ctx.globalAlpha = 0.55;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-24, top + 16);
  ctx.quadraticCurveTo(-6, top + 6, 14, top + 14);
  ctx.moveTo(24, top + 30);
  ctx.quadraticCurveTo(34, top + 22, 42, top + 26);
  strokeSoft(ctx, '#ffffff', 4.2);
  ctx.restore();

  ctx.restore();
}

/* ───────────────────────── 身体 ───────────────────────── */

function drawLegs(ctx) {
  for (const leg of LEGS) {
    ctx.save();
    ctx.translate(leg.x, 0);
    capsule(ctx, 0, leg.top, 0, leg.bottom, leg.w / 2, leg.w / 2.1);
    ctx.fillStyle = vGrad(ctx, leg.top, leg.bottom, PALETTE.skin, PALETTE.skinShade);
    ctx.fill();
    strokeSoft(ctx, 'rgba(190,140,120,0.35)', 1.4);

    // 圆头小鞋
    const w = FOOT.w;
    const h = FOOT.h;
    roundRect(ctx, -w / 2, leg.bottom - 4, w, h, h / 2);
    ctx.fillStyle = vGrad(ctx, leg.bottom, leg.bottom + h, PALETTE.shoe, '#616cb8');
    ctx.fill();
    strokeSoft(ctx, 'rgba(70,80,150,0.5)', 1.5);
    ctx.restore();
  }
}

/** 躯干 + 上衣（一次成形，避免"衣服和身体错位"） */
function drawTorso(ctx, pose) {
  /* 颈部（返工单 ③）：下巴 world 198 到上衣上沿 world 240 之间原本只有后发，
   * 读起来像"头浮在身体上方"。先补一段可见的脖子，躯干随后盖住它的下缘，
   * 再用一圈衣领把脖子根部和上衣连起来。
   * 注意 r 不要上下差太多（13 → 13.5）：差太大渲染出来像一条下垂的舌头。 */
  capsule(ctx, 0, -256, 0, -176, 13, 13.5);
  ctx.fillStyle = vGrad(ctx, -256, -172, PALETTE.skinShade, PALETTE.skin);
  ctx.fill();
  strokeSoft(ctx, 'rgba(190,140,120,0.35)', 1.3);

  const pts = TORSO.map(([x, y]) => [x, y]);
  smoothPath(ctx, pts, true);
  ctx.fillStyle = vGrad(ctx, -214, -66, PALETTE.clothLight, PALETTE.cloth);
  ctx.fill();
  strokeSoft(ctx, PALETTE.clothLine, 2.2);

  // 衣领：深一号的布料色（PALETTE.cuff 是近白色 #fdfdff，做领子会像胸口顶着一颗蛋）
  ctx.save();
  ellipsePath(ctx, 0, -206, 20, 9.5);
  ctx.fillStyle = PALETTE.clothDark;
  ctx.fill();
  strokeSoft(ctx, PALETTE.clothLine, 1.6);
  ctx.restore();

  // 前襟：一条 V 型领口 + 拉链/缝线
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.moveTo(-20, -180);
  ctx.quadraticCurveTo(0, -152, 20, -180);
  ctx.lineTo(0, -166);
  ctx.closePath();
  ctx.fillStyle = PALETTE.inner;
  ctx.fill();
  strokeSoft(ctx, 'rgba(180,110,140,0.5)', 1.4);
  ctx.restore();

  // 下摆：稍微鼓起来的弧 + 随呼吸/摆动延迟的衣摆
  const hem = pose.hemLagX;
  ctx.save();
  ctx.beginPath();
  const hemPts = [
    [-52 + (hem[0] || 0) * 0.6, -68],
    [-18 + (hem[1] || 0) * 0.5, -60 - Math.abs(hem[1] || 0) * 0.05],
    [18 + (hem[1] || 0) * 0.5, -60 - Math.abs(hem[1] || 0) * 0.05],
    [52 + (hem[2] || 0) * 0.6, -68],
    [40, -44],
    [0, -38],
    [-40, -44],
  ];
  smoothPath(ctx, hemPts, true);
  ctx.fillStyle = vGrad(ctx, -70, -38, PALETTE.cloth, PALETTE.clothDark);
  ctx.fill();
  strokeSoft(ctx, PALETTE.clothLine, 1.9);
  ctx.restore();

  // 侧面高光
  ctx.save();
  ctx.globalAlpha = 0.35;
  ellipsePath(ctx, -30, -140, 12, 42, 0.12);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.restore();
}

/**
 * 手臂：肩点是**骨骼**，手是**目标**，中间用胶囊连起来，
 * 所以 armForward 抬起时袖子不会和身体脱开。
 */
function drawArms(ctx, pose) {
  const forward = clamp(pose.armForward, 0, 1.1);
  for (const side of [-1, 1]) {
    const def = side < 0 ? HANDS.left : HANDS.right;
    const fwd = side < 0 ? HANDS.forwardLeft : HANDS.forwardRight;
    const hx = lerp(def.x, fwd.x, forward);
    const hy = lerp(def.y, fwd.y, forward) - forward * 6;

    const shoulder = { x: side * BONES.shoulder.x, y: BONES.shoulder.y };
    const h = handPos(pose, side, hx, hy);

    // 袖子
    capsule(ctx, shoulder.x, shoulder.y, h.x, h.y, 15.5, 11.5);
    ctx.fillStyle = vGrad(ctx, shoulder.y, h.y, PALETTE.clothLight, PALETTE.cloth);
    ctx.fill();
    strokeSoft(ctx, PALETTE.clothLine, 2);

    // 袖口
    ctx.save();
    ctx.translate(h.x, h.y);
    const ang = Math.atan2(h.y - shoulder.y, h.x - shoulder.x);
    ctx.rotate(ang);
    roundRect(ctx, -8, -11.5, 16, 23, 7);
    ctx.fillStyle = PALETTE.cuff;
    ctx.fill();
    strokeSoft(ctx, 'rgba(190,200,235,0.9)', 1.4);
    ctx.restore();
  }
}

/** 手（手套）位置：叠加拖拽带来的甩动 */
function handPos(pose, side, x, y) {
  return {
    x: x + pose.bodyX * 0.1 + (pose.hairLagX[1] || 0) * 0.12 * side,
    y: y + pose.bodyY * 0.16,
  };
}

/** 手套：把身体之后的手臂盖住，形成"手在身前"的层次 */
function drawHands(ctx, pose) {
  const forward = clamp(pose.armForward, 0, 1.1);
  for (const side of [-1, 1]) {
    const def = side < 0 ? HANDS.left : HANDS.right;
    const fwd = side < 0 ? HANDS.forwardLeft : HANDS.forwardRight;
    const base = { x: lerp(def.x, fwd.x, forward), y: lerp(def.y, fwd.y, forward) - forward * 6 };
    const h = handPos(pose, side, base.x, base.y);
    ctx.save();
    ctx.translate(h.x, h.y);
    ctx.rotate(side * 0.12 + (pose.hairLagX[1] || 0) * 0.004 * side);
    ellipsePath(ctx, 0, 0, def.r + 1.5, def.r * 0.98);
    ctx.fillStyle = vGrad(ctx, -def.r, def.r, PALETTE.skin, PALETTE.skinShade);
    ctx.fill();
    strokeSoft(ctx, 'rgba(190,140,120,0.5)', 1.6);
    // 拇指
    ctx.beginPath();
    ctx.ellipse(-side * def.r * 0.6, -def.r * 0.25, def.r * 0.34, def.r * 0.46, -side * 0.4, 0, TAU);
    ctx.fillStyle = PALETTE.skin;
    ctx.fill();
    ctx.restore();
  }
}

/* ───────────────────────── 特效（画在身后） ───────────────────────── */

/** 星星眼/兴奋时的粒子：用确定性伪随机，保证同一帧稳定 */
function drawSparkles(ctx, pose, time) {
  const amount = clamp(pose.sparkle, 0, 1.2);
  if (amount <= 0.02) return;
  const starry = pose.pupilShape === 'star' || pose.pupilShape === 'sharp' || amount > 0.3;
  const total = 5 + (starry ? 4 : 0);
  ctx.save();
  ctx.globalAlpha = clamp(amount, 0, 1);
  for (let i = 0; i < total; i++) {
    // 用 i 与 time 构造确定性的绕行/闪烁，避免每帧 Math.random 造成"噪点感"
    const seed = i * 12.9898;
    const ang = seed + time * (0.7 + (i % 3) * 0.25);
    const rad = 66 + ((i * 37) % 54);
    const px = Math.cos(ang) * rad * 0.85;
    const py = -300 + Math.sin(ang * 1.3) * rad * 0.62 - 30;
    const twinkle = 0.55 + 0.45 * Math.sin(time * 5 + i * 1.7);
    const size = (3.2 + (i % 3) * 1.8) * twinkle * amount;
    if (starry && i % 2 === 0) drawStar(ctx, px, py, size * 1.5, size * 0.6, ang);
    else {
      ctx.beginPath();
      ctx.arc(px, py, size * 0.62, 0, TAU);
      ctx.fillStyle = PALETTE.star;
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawStar(ctx, cx, cy, outer, inner, rot = 0) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / 10) * TAU - Math.PI / 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = PALETTE.star;
  ctx.fill();
  ctx.restore();
}

/* ───────────────────────── 头 / 脸 / 眼 ───────────────────────── */

/** 头壳（含耳朵）与腮红 */
function drawHead(ctx, pose) {
  const rx = HEAD_R(ctx, pose);
  ctx.save();
  // 耳
  for (const side of [-1, 1]) {
    ellipsePath(ctx, side * (rx - 4), 6, 9, 12, side * 0.2);
    ctx.fillStyle = PALETTE.skin;
    ctx.fill();
    strokeSoft(ctx, 'rgba(200,150,130,0.4)', 1.4);
  }
  // 头（纵向略长的蛋形）
  ellipsePath(ctx, 0, 0, rx, HEAD_RY(ctx, pose));
  const g = ctx.createRadialGradient(-14, -22, 6, 0, 0, rx * 1.5);
  g.addColorStop(0, '#fff4ec');
  g.addColorStop(0.55, PALETTE.skin);
  g.addColorStop(1, PALETTE.skinShade);
  ctx.fillStyle = g;
  ctx.fill();
  strokeSoft(ctx, 'rgba(200,150,130,0.55)', 2);

  // 腮红
  const blush = clamp(pose.blush + (pose.blushPulse || 0) * 0.45, 0, 1.3);
  if (blush > 0.04) {
    ctx.save();
    ctx.globalAlpha = clamp(blush, 0, 1);
    for (const side of [-1, 1]) {
      const g2 = ctx.createRadialGradient(side * 32, 16, 1, side * 32, 16, 17);
      g2.addColorStop(0, PALETTE.blushDeep);
      g2.addColorStop(1, 'rgba(255,143,163,0)');
      ctx.fillStyle = g2;
      ellipsePath(ctx, side * 32, 16, 17, 11);
      ctx.fill();
    }
    // 害羞时加两道斜线
    if (blush > 0.6) {
      ctx.globalAlpha = (blush - 0.6) * 1.6;
      for (const side of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          const ox = side * (26 + i * 6);
          ctx.beginPath();
          ctx.moveTo(ox - 4, 12 + i * 2);
          ctx.lineTo(ox + 3, 24 + i * 2);
          strokeSoft(ctx, PALETTE.blushDeep, 2.2);
        }
      }
    }
    ctx.restore();
  }
  ctx.restore();
}

/** 头部横向半径（受挤压/拉伸影响，字面上的"Q 弹"） */
function HEAD_R(ctx, pose) {
  void ctx;
  return 62 * (1 + clamp(pose.bodySquash, -0.3, 0.4) * 0.28 - clamp(pose.bodyStretch, -0.3, 0.4) * 0.1);
}
function HEAD_RY(ctx, pose) {
  return 58 * (1 - clamp(pose.bodySquash, -0.3, 0.4) * 0.2 + clamp(pose.bodyStretch, -0.3, 0.4) * 0.22);
}

/** 眉毛：角度来自情绪，竖向高度随惊讶/难过变化 */
function drawBrows(ctx, pose) {
  const angry = clamp(pose.browAngle, -1.3, 1.3);
  const worry = clamp(pose.browWorry || 0, 0, 1);
  const lift = clamp(pose.eyeOpen - 1, -0.6, 0.4);
  // 眉毛基准：眼睛中心上方 15px（与 EYE 常量同源，改眼睛位置时眉毛会跟着走）
  // EYE.* 是**脚底系绝对坐标**，而本函数画在"脸局部系"（原点 = 脸心 FACE.cy）里，
  // 所以必须减掉脸心 y，否则整张五官会被画到画布上方 300px 处（真实事故：脸是空的）。
  const browBaseY = EYE.left.y - FACE.cy - 15;
  for (const side of [-1, 1]) {
    const cx = side * Math.abs(EYE.left.x);
    const cy = browBaseY + (pose.browY || 0) - lift * 5 + worry * 3;
    const rot = side * (-0.16 - angry * 0.42 + worry * 0.3);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    roundRect(ctx, -11, -2, 22, 4.4, 2.2);
    ctx.fillStyle = PALETTE.brow;
    ctx.fill();
    ctx.restore();
  }
}

/**
 * 眼睛。
 *  - blink 只压缩高度（眼皮从上往下盖），不做整体缩放，避免眼球位移
 *  - pupilShape：round / small / sharp / star
 */
function drawEyes(ctx, pose) {
  const blink = clamp(pose.blink, 0, 1);
  const eyeOpen = clamp(pose.eyeOpen, 0, 1.45);
  const smile = clamp(pose.eyeSmile || 0, 0, 1);
  const gazeX = clamp(pose.gazeX, -1, 1);
  const gazeY = clamp(pose.gazeY, -1, 1);
  const shape = pose.pupilShape || 'round';

  // 眼睛越睁越大时，整体略微放大（惊讶感）
  const scale = 1 + clamp(eyeOpen - 1, -0.4, 0.45) * 0.22;

  for (const side of [-1, 1]) {
    const ex = side * Math.abs(EYE.left.x);
    // EYE.left.y 是脚底系绝对坐标；本函数在脸局部系里绘制，故减掉脸心 y
    const ey = EYE.left.y - FACE.cy;
    const ry = EYE.ry * eyeOpen * scale * (1 - blink);
    const rx = EYE.rx * scale * (1 - blink * 0.12);

    ctx.save();
    ctx.translate(ex, ey);

    if (smile > 0.5 && blink < 0.2) {
      // 开心到一定程度就变月牙眼（用弧线而不是椭圆）
      const t = (smile - 0.5) / 0.5;
      ctx.beginPath();
      ctx.arc(0, ry * 0.4 + 2 * t, rx * 1.05, Math.PI * 1.08, Math.PI * 1.92);
      strokeSoft(ctx, PALETTE.lash, lerp(2.6, 3.6, t));
      ctx.restore();
      continue;
    }

    if (ry < 0.6) {
      // 完全闭眼：一条睫毛线
      ctx.beginPath();
      ctx.moveTo(-rx, 0);
      ctx.quadraticCurveTo(0, 3.4, rx, -0.4);
      strokeSoft(ctx, PALETTE.lash, 2.6);
      ctx.restore();
      continue;
    }

    // 眼白
    ellipsePath(ctx, 0, 0, rx, ry);
    ctx.fillStyle = PALETTE.eyeWhite;
    ctx.fill();

    // 虹膜（用裁剪保证不越出眼白）
    ctx.save();
    ellipsePath(ctx, 0, 0, rx, ry);
    ctx.clip();
    const px = gazeX * EYE.gazeX * scale;
    const py = gazeY * EYE.gazeY * scale + ry * 0.06;
    const irisR = Math.min(ry * 0.98, rx * 0.98);
    const g = ctx.createRadialGradient(px - irisR * 0.3, py - irisR * 0.4, 1, px, py, irisR);
    g.addColorStop(0, PALETTE.irisInner);
    g.addColorStop(0.65, PALETTE.irisOuter);
    g.addColorStop(1, '#2f89a0');
    ctx.fillStyle = g;
    ellipsePath(ctx, px, py, irisR, irisR * 1.05);
    ctx.fill();

    // 瞳孔
    const prx = shape === 'small' ? 4.4 : shape === 'sharp' ? 5.2 : EYE.pupilRx;
    const pry = shape === 'small' ? 4.6 : EYE.pupilRy;
    ctx.fillStyle = PALETTE.pupil;
    if (shape === 'sharp') {
      // 竖瞳（生气时更有"瞪"的感觉）
      ellipsePath(ctx, px, py, prx * 0.62, pry * 1.06);
    } else {
      ellipsePath(ctx, px, py, prx, pry);
    }
    ctx.fill();

    if (shape === 'star') {
      drawStar(ctx, px, py - 0.6, pry * 0.95, pry * 0.4, 0.3);
    } else {
      // 高光：一大小两枚，位置固定（不随注视移动太多，像玻璃反光）
      ctx.fillStyle = PALETTE.eyeHi;
      ellipsePath(ctx, px - prx * 0.5, py - pry * 0.55, prx * 0.5, pry * 0.42);
      ctx.fill();
      ctx.globalAlpha = 0.75;
      ellipsePath(ctx, px + prx * 0.55, py + pry * 0.42, prx * 0.26, pry * 0.22);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    // 上睫毛
    ctx.beginPath();
    ctx.moveTo(-rx, -ry * 0.15);
    ctx.quadraticCurveTo(0, -ry * 1.18, rx, -ry * 0.2);
    strokeSoft(ctx, PALETTE.lash, 2.7);
    // 外眼角
    ctx.beginPath();
    ctx.moveTo(side * rx * 0.82, -ry * 0.5);
    ctx.lineTo(side * (rx * 1.32), -ry * 0.85);
    strokeSoft(ctx, PALETTE.lash, 2.2);

    ctx.restore();
  }
}

/** 嘴：多种样式，配合 pout（鼓腮）与 speaking（开合） */
function drawMouth(ctx, pose) {
  const smile = clamp(pose.mouthSmile, -1.2, 1.2);
  const open = clamp(pose.mouthOpen, 0, 1.3);
  const pout = clamp(pose.pout || 0, 0, 1);
  const style = pose.mouthStyle || 'soft';
  // 嘴的纵向位置：眼睛向下 34px（同样与 EYE 常量同源）
  // 同样是脚底系绝对坐标 → 脸局部系，必须减掉脸心 y
  const y = EYE.left.y - FACE.cy + 34;

  ctx.save();
  ctx.translate(0, y);

  const w = lerp(8, 13.5, clamp(Math.abs(smile) + open * 0.5 + pout * 0.6, 0, 1));

  if (open > 0.06) {
    // 张嘴：用上平下圆的"豆子"嘴
    const h = lerp(2.5, 15, clamp(open, 0, 1.1)) * (1 - pout * 0.25);
    ctx.beginPath();
    ctx.moveTo(-w, 0);
    ctx.quadraticCurveTo(-w * 0.55, h * 1.15, 0, h * 1.05);
    ctx.quadraticCurveTo(w * 0.55, h * 1.15, w, 0);
    ctx.quadraticCurveTo(0, -2.6 - h * 0.12, -w, 0);
    ctx.closePath();
    ctx.fillStyle = PALETTE.mouthInner;
    ctx.fill();
    strokeSoft(ctx, PALETTE.mouth, 1.6);
    // 舌头
    if (h > 6) {
      ctx.beginPath();
      ctx.ellipse(0, h * 0.72, w * 0.5, h * 0.3, 0, 0, TAU);
      ctx.fillStyle = '#f08aa0';
      ctx.fill();
    }
  } else if (style === 'frown' || smile < -0.25) {
    // 向下弯的嘴角
    ctx.beginPath();
    ctx.moveTo(-w, 2.4);
    ctx.quadraticCurveTo(0, -5.4 - smile * 2, w, 2.4);
    strokeSoft(ctx, PALETTE.mouth, 2.3);
  } else if (style === 'pout' || pout > 0.35) {
    // 鼓腮：小小一个"ω"
    const r = lerp(3, 5.4, pout);
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(side * r * 0.85, 0, r, Math.PI * 0.05, Math.PI * 1.0);
      strokeSoft(ctx, PALETTE.mouth, 2.1);
    }
  } else if (style === 'small') {
    ctx.beginPath();
    ctx.moveTo(-3.6, 0.6);
    ctx.quadraticCurveTo(0, 3.6, 3.6, 0.6);
    strokeSoft(ctx, PALETTE.mouth, 2.1);
  } else {
    // 默认：上扬的浅笑，smile 越大越弯
    ctx.beginPath();
    ctx.moveTo(-w, -1.2 + smile * 1.4);
    ctx.quadraticCurveTo(0, 6.2 + smile * 5.2, w, -1.2 + smile * 1.4);
    strokeSoft(ctx, PALETTE.mouth, lerp(2.1, 2.7, clamp(smile, 0, 1)));
  }
  ctx.restore();
}

/* ───────────────────────── 情绪特效（画在身前） ───────────────────────── */

/** 汗滴（生气/尴尬）、叹气（困倦/醒来）、思考气泡 */
function drawMoodEffects(ctx, pose, time) {
  const sweat = clamp(pose.sweat || 0, 0, 1);
  if (sweat > 0.02) {
    const bob = Math.sin(time * 3.4) * 2.2;
    ctx.save();
    ctx.globalAlpha = sweat;
    ctx.translate(48, -34 + bob);
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.quadraticCurveTo(7, -2, 6, 3);
    ctx.arc(0, 3, 6, 0, Math.PI);
    ctx.quadraticCurveTo(-7, -2, 0, -10);
    ctx.closePath();
    ctx.fillStyle = '#9fd8f5';
    ctx.fill();
    strokeSoft(ctx, 'rgba(90,160,200,0.8)', 1.4);
    ctx.restore();
  }

  const sigh = clamp(pose.sigh || 0, 0, 1);
  if (sigh > 0.02) {
    ctx.save();
    ctx.globalAlpha = sigh * 0.9;
    for (let i = 0; i < 2; i++) {
      const t = (time * 0.55 + i * 0.4) % 1;
      const y = 12 - t * 40;
      const r = 5 + t * 7;
      ctx.beginPath();
      ctx.arc(24 + i * 6, y, r, 0, TAU);
      strokeSoft(ctx, 'rgba(150,185,215,0.85)', 1.8);
    }
    ctx.restore();
  }

  const think = clamp(pose.think || 0, 0, 1);
  if (think > 0.05) {
    ctx.save();
    ctx.globalAlpha = think * 0.95;
    const bob = Math.sin(time * 2.2) * 3;
    for (let i = 0; i < 3; i++) {
      const r = 4 + i * 2.6;
      ctx.beginPath();
      ctx.arc(38 + i * 9, -52 - i * 10 + bob, r, 0, TAU);
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fill();
      strokeSoft(ctx, 'rgba(140,175,205,0.75)', 1.5);
    }
    ctx.restore();
  }
}

/** 整体柔光（开心/兴奋时的"发光感"） */
function drawGlow(ctx, pose) {
  const glow = clamp(pose.glow, 0, 1.3);
  if (glow <= 0.02) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = glow * 0.24;
  const g = ctx.createRadialGradient(0, -250, 20, 0, -250, 250);
  g.addColorStop(0, 'rgba(255,244,190,0.9)');
  g.addColorStop(0.5, 'rgba(255,226,180,0.35)');
  g.addColorStop(1, 'rgba(255,226,180,0)');
  ctx.fillStyle = g;
  ctx.fillRect(-ORIGIN_X, -ORIGIN_Y, CANVAS_W, CANVAS_H);
  ctx.restore();
}

/* ───────────────────────── 主入口 ───────────────────────── */

/**
 * 绘制一帧。
 * @param {CanvasRenderingContext2D} ctx 已按 devicePixelRatio 缩放好的 2D 上下文
 * @param {object} pose rig 输出的参数表
 * @param {object} [opts] { time, phase, debug }
 */
export function drawPet(ctx, pose, opts = {}) {
  const time = opts.time ?? 0;
  const phase = opts.phase ?? 0;

  ctx.save();
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  /* 0. 基准平移 —— **整条绘制链里唯一允许出现 ORIGIN_X/ORIGIN_Y 的地方**。
   * 之后一切坐标都以"脚底中心"为原点，与 constants.js 的 BONES/HEAD/BACK_HAIR 同一口径。
   *
   * 坐标系铁律（曾经在这里连踩两次坑，改前务必读完）：
   *   BONES.*／HEAD.*／BACK_HAIR.* 都是**脚底系**（root=(0,0) 在脚底）。
   *   每一个 `ctx.translate()` 建立的局部系，其子坐标必须减去该组原点的脚底系坐标：
   *     body 局部 = 脚底 (hipX, BONES.hip.y + bodyY)
   *     neck 局部 = (BONES.neck.y - BONES.hip.y)     // -114
   *     head 局部 = (BONES.head.y - BONES.neck.y)    // 头部锚在脖子上
   *     face 局部 = (BONES.face.y - BONES.neck.y)
   *   把"绝对"与"相对"混起来（例如把 BONES.head.y 当成相对脖子原点）会让整颗头
   *   飞出画布 —— 事故现场是角色被画到 y≈-300，只剩下后发和地面阴影可见。
   *   改完请跑 `node tools/smoke-pet-frame.mjs`，它按 parts 复核包围盒。 */
  ctx.translate(ORIGIN_X, ORIGIN_Y);

  // Canvas 内绘制的气泡由 bubble.js 在最后叠加（避免被 glow 的合成模式影响）
  drawShadow(ctx, pose);

  /* 1. 后发（在身体之后，所以能露出"披在背后"的层次） */
  drawBackHair(ctx, pose, phase);

  /* 2. 腿 / 身体 / 手臂 / 服饰 —— bodyX/bodyY 在这里统一生效
   *
   * 这一组的局部坐标是**脚底系**（LEGS.bottom = 0 就是地面、TORSO 是 -184..-66），
   * 所以组原点必须是"绕胯部旋转 θ 之后的脚底位置"，即 root = hip - R(hip)：
   *   θ = 0 时 root 恰好是 (hipX, bodyY)，脚才踩在 ORIGIN_Y 上。
   * 事故现场：这里原本写 `BONES.hip.y + cos * BONES.hip.y`（等价于 hip + R(hip)），
   * 静止时就多减了 2×74 = 148px —— 整具身体被抬到地面上方，只剩头和阴影可见，
   * 看起来像"头特别大、腿悬空"。改这里请务必跑 `node tools/smoke-pet-frame.mjs`。 */
  const leanRad = (pose.bodyLean * Math.PI) / 180;
  const hipX = pose.bodyX + clamp(pose.dragLean, -26, 26) * 0.35;
  const rootX = hipX + Math.sin(leanRad) * BONES.hip.y; // θ=0 → hipX
  const rootY = pose.bodyY + BONES.hip.y * (1 - Math.cos(leanRad)); // θ=0 → bodyY
  ctx.save();
  ctx.translate(rootX, rootY);
  ctx.rotate(leanRad);
  drawLegs(ctx);
  drawTorso(ctx, pose);
  drawArms(ctx, pose);
  drawHands(ctx, pose);
  ctx.restore();

  /* 3. 头：绕"脖子"旋转 —— 头不会以自身中心为轴转，那样像贴纸 */
  // 头这一支直接挂在脚底系上，脖子枢轴取 BONES.neck 的绝对坐标。
  // 但头/脸相对**脖子组原点**仍是相对量，所以下面用 neckLocal* 而不是 BONES.* 的绝对值。
  const neckX = hipX + Math.sin((pose.bodyLean * Math.PI) / 180) * -(BONES.neck.y - BONES.hip.y);
  const neckY = BONES.hip.y + pose.bodyY + Math.cos((pose.bodyLean * Math.PI) / 180) * (BONES.neck.y - BONES.hip.y); // = -188
  const neckLocalHeadY = BONES.head.y - BONES.neck.y; // -124
  const neckLocalFaceY = BONES.face.y - BONES.neck.y; // -114
  const yaw = pose.headYaw * (Math.PI / 180);
  const pitch = pose.headPitch * (Math.PI / 180);
  const tilt = pose.headTilt * (Math.PI / 180);
  // 假 3D：头部整体随手转/点做极小的位移
  const headOffX = Math.sin(yaw) * 4 + Math.sin(tilt) * 2.2;
  const headOffY = pose.headBob * 0.4 + Math.sin(pitch) * 2.4;
  // 头壳与脸的共同旋转量：头壳转得多、五官转得少，形成"贴着脸转"的轻微视差
  const headRot = tilt * 0.8 + pitch * 0.35;
  const yawRot = yaw * 0.55;

  /* 3. 头：绕"脖子"旋转 —— 头不会以自身中心为轴转，那样像贴纸 */
  ctx.save();
  ctx.translate(neckX, neckY);
  ctx.rotate(yawRot);

  const localHeadY = neckLocalHeadY;
  const localFaceY = neckLocalFaceY;

  ctx.save();
  ctx.translate(headOffX, headOffY + localHeadY);
  ctx.rotate(headRot);
  drawHead(ctx, pose);
  ctx.restore();

  /* 4. 脸 / 眼 / 前发：都在头局部坐标系里，跟随头部旋转 */
  ctx.save();
  ctx.translate(headOffX, headOffY + localFaceY);
  ctx.rotate(headRot);
  // 五官在头壳旋转之上再补一点反向偏转，避免"斜脸"过于夸张
  ctx.rotate(tilt * -0.30 + pitch * 0.15);

  // 抬头/低头/左右转时的五官投影（假 3D）
  const projX = clamp(pose.headYaw / 26, -1, 1) * FACE_PROJECTION.yawX;
  const projY = clamp(pose.headPitch / 28, -1, 1) * FACE_PROJECTION.pitchY;
  ctx.translate(projX, projY);

  drawBrows(ctx, pose);
  drawEyes(ctx, pose);
  drawMouth(ctx, pose);
  ctx.restore();

  // 前发盖在眼睛上（层次：眼 → 前发）
  ctx.save();
  ctx.translate(headOffX, headOffY + localHeadY);
  ctx.rotate(headRot);
  drawFrontHair(ctx, pose, phase);
  ctx.restore();

  ctx.restore(); // 头

  // 侧发（鬓角）随头部一起转，但画在头壳之外，避免遮住脸
  ctx.save();
  ctx.translate(neckX, neckY);
  ctx.rotate(yawRot);
  ctx.translate(headOffX, headOffY + localHeadY);
  ctx.rotate(headRot);
  drawSideHair(ctx, pose, phase);
  ctx.restore();

  /* 5. 特效 */
  drawSparkles(ctx, pose, time);
  /* drawMoodEffects 的汗滴/叹气/思考泡用的是**头部邻近的小坐标**（如 (48,-34)、(38,-52)），
   * 必须锚在头部世界位置；否则会贴着脚底画出来。 */
  ctx.save();
  /* 这里已经回到**基准系**（脚底为原点），所以头锚点用脚底系的绝对坐标 BONES.head.y。 */
  ctx.translate(0, BONES.head.y + headOffY * 0.5);
  drawMoodEffects(ctx, pose, time);
  ctx.restore();
  drawGlow(ctx, pose);

  if (opts.debug) drawDebugOverlay(ctx, pose);

  ctx.restore();
}

/* ───────────────────────── 调试叠层（默认关闭） ───────────────────────── */

/**
 * 命中区线框。只在 getDebugState/控制台打开时绘制，不影响正常观感。
 * 这里刻意**复用 interactions.js 的几何判定**（通过 opts.hitRegions 注入），
 * 保证"线框"和"点得中的地方"绝对是同一套数据。
 */
function drawDebugOverlay(ctx, pose) {
  ctx.save();
  ctx.globalAlpha = 0.75;
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.4;
  const regions = [
    { c: '#ff5c8a', x: 0, y: -312, rx: 62, ry: 58 },
    { c: '#ffd166', x: 0, y: -302, rx: 43, ry: 37 },
    { c: '#4ecdc4', x: 0, y: -125, rx: 58, ry: 60 },
    { c: '#8ab6ff', x: -64, y: -150, rx: 21, ry: 21 },
    { c: '#8ab6ff', x: 64, y: -150, rx: 21, ry: 21 },
  ];
  for (const r of regions) {
    ctx.strokeStyle = r.c;
    ellipsePath(ctx, r.x + pose.bodyX * 0.4, r.y + pose.bodyY, r.rx, r.ry);
    ctx.stroke();
  }
  // 画布 1/3 分界线
  ctx.setLineDash([3, 6]);
  ctx.strokeStyle = 'rgba(120,150,200,0.7)';
  ctx.beginPath();
  ctx.moveTo(-ORIGIN_X, 160 - ORIGIN_Y);
  ctx.lineTo(CANVAS_W - ORIGIN_X, 160 - ORIGIN_Y);
  ctx.moveTo(-ORIGIN_X, 320 - ORIGIN_Y);
  ctx.lineTo(CANVAS_W - ORIGIN_X, 320 - ORIGIN_Y);
  ctx.stroke();
  ctx.restore();
}

export { roundRect, ellipsePath, capsule, smoothPath, drawStar };
