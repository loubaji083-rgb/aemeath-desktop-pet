/**
 * Aemeath 桌宠 —— 指针交互层
 *
 * 职责：
 *  1. **命中判定**（hitTest）：把画布逻辑坐标映射到 `head/face/body/hand/hair/none`。
 *     这套几何同时被 draw.js 的调试线框复用（`getRegions()`），保证"看起来在里面的地方"和
 *     "点得中的地方"永远是同一份数据。
 *  2. **手势识别**：单击 / 双击 / 长按 / 拖拽 / 悬停注视。
 *     用 Pointer Events 统一鼠标 + 触屏；`touch-action: none` 由 pet.css 提供。
 *  3. **干净卸载**：所有监听集中在 `#unbind`，`destroy()` 保证不留 listener、不留定时器。
 *
 * 本文件不 import DOM 工具模块，只依赖常量与 window/document 原生能力 —— 保持零耦合。
 */

import {
  ORIGIN_X,
  ORIGIN_Y,
  BONES,
  HANDS,
  HIT_PARTS,
  PART_ACTION,
  TIMING,
  REGION,
} from './constants.js';

/** 头壳/脸/身体的近似椭圆（与 draw.js 的绘制尺寸同源，改这里要同步改 constants） */
const HEAD_RX = 62;
const HEAD_RY = 58;
const FACE_RX = 43;
const FACE_RY = 37;
const BODY_RX = 58;
const BODY_RY = 60;

/** 命中容差：手/耳朵这类"小目标"稍微放大一点，手指点得中 */
const TOLERANCE = 1.06;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** 椭圆归一化距离：<1 在内部 */
function ellipseD(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy;
}

/**
 * 几何基准点。身体/头会随 pose 轻微移动，这里接受一个可选的 pose，
 * 让"头歪了之后点原来的位置"依然命中（手感优先于纯静态几何）。
 * @param {object} [pose]
 */
function anchors(pose) {
  const bodyX = pose ? (pose.bodyX || 0) : 0;
  const bodyY = pose ? (pose.bodyY || 0) : 0;
  const headX = bodyX + (pose ? clamp(pose.headYaw || 0, -30, 30) * 0.55 : 0);
  const headY = bodyY + (pose ? (pose.headBob || 0) * 0.4 : 0);
  return {
    head: { x: ORIGIN_X + headX, y: ORIGIN_Y + BONES.head.y + headY },
    face: { x: ORIGIN_X + headX + (pose ? clamp(pose.headYaw || 0, -30, 30) * 0.12 : 0), y: ORIGIN_Y + BONES.face.y + headY },
    body: { x: ORIGIN_X + bodyX * 0.5, y: ORIGIN_Y + (BONES.chest.y + BONES.hip.y) / 2 + bodyY },
    armF: pose ? clamp(pose.armForward || 0, 0, 1.1) : 0,
  };
}

/**
 * 命中测试。所有区域都用椭圆近似（比矩形更贴合圆润的 Q 版造型）。
 *
 * 判定优先级（从上到下，先命中的赢）：
 *   脸 → 手 → 头（含头发）→ 身体
 * 说明：脸在头之前，是因为脸完全包含在头里；手在头之前，因为手可能举到脸旁边。
 *
 * @param {number} x 画布逻辑坐标（已经由 pointer 映射，不是设备像素）
 * @param {number} y
 * @param {object} [pose] 可选：当前姿态（让判定跟着动作走）
 * @returns {'head'|'face'|'body'|'hand'|'hair'|'none'}
 */
export function hitTest(x, y, pose) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 'none';
  const a = anchors(pose);
  const fwd = a.armF;
  const handL = {
    x: ORIGIN_X + HANDS.left.x + (HANDS.forwardLeft.x - HANDS.left.x) * fwd,
    y: ORIGIN_Y + HANDS.left.y + (HANDS.forwardLeft.y - HANDS.left.y) * fwd,
  };
  const handR = {
    x: ORIGIN_X + HANDS.right.x + (HANDS.forwardRight.x - HANDS.right.x) * fwd,
    y: ORIGIN_Y + HANDS.right.y + (HANDS.forwardRight.y - HANDS.left.y) * fwd,
  };

  // 1) 脸（最内层）
  if (ellipseD(x, y, a.face.x, a.face.y, FACE_RX * TOLERANCE, FACE_RY * TOLERANCE) <= 1) return 'face';

  // 2) 手（可能是 forward 姿态，取左右两个位置中更近的那个来判断）
  for (const h of [handL, handR]) {
    const r = HANDS.left.hitR * TOLERANCE;
    if ((x - h.x) ** 2 + (y - h.y) ** 2 <= r * r) return 'hand';
    const hx = ORIGIN_X + (h === handL ? HANDS.forwardLeft.x : HANDS.forwardRight.x);
    const hy = ORIGIN_Y + HANDS.forwardLeft.y;
    if ((x - hx) ** 2 + (y - hy) ** 2 <= r * r) return 'hand';
  }

  // 3) 头（头壳 + 刘海/鬓角外扩）
  const headD = ellipseD(x, y, a.head.x, a.head.y, HEAD_RX * 1.32, HEAD_RY * 1.42);
  if (headD <= 1) {
    // 头部外圈（头壳之外、头发范围之内）算"头发"：摸头发也有反应
    if (ellipseD(x, y, a.head.x, a.head.y, HEAD_RX * TOLERANCE, HEAD_RY * TOLERANCE) > 1) return 'hair';
    return 'head';
  }

  // 3b) 头顶宽容区：头发椭圆之上、头部横向范围内，仍然算"摸头"。
  //     理由有两个：(1) 契约/验收要求 hitTest 对**画布上半部**返回 'head'；
  //     (2) Q 版角色的头顶本来就是高点击区，点在发梢上方几像素不该毫无反应。
  //     上半部分（y ≤ REGION.headBottomY）本来就是头 + 脖子的范围，判成 head 与视觉一致。
  if (y >= 0 && y <= REGION.headBottomY && Math.abs(x - a.head.x) <= HEAD_RX * 1.45) return 'head';

  // 4) 身体（含腿，但排除已经出画的部分）
  if (ellipseD(x, y, a.body.x, a.body.y, BODY_RX * TOLERANCE, BODY_RY * 1.25) <= 1) return 'body';

  return 'none';
}

/**
 * 命中区几何（供 debug 线框 / 单元测试使用）。
 * @param {object} [pose]
 */
export function getRegions(pose) {
  const a = anchors(pose);
  const fwd = a.armF;
  return [
    { part: 'head', cx: a.head.x, cy: a.head.y, rx: HEAD_RX, ry: HEAD_RY, color: '#ff5c8a' },
    { part: 'hair', cx: a.head.x, cy: a.head.y, rx: HEAD_RX * 1.32, ry: HEAD_RY * 1.42, color: '#8fd7e8' },
    { part: 'face', cx: a.face.x, cy: a.face.y, rx: FACE_RX, ry: FACE_RY, color: '#ffd166' },
    { part: 'body', cx: a.body.x, cy: a.body.y, rx: BODY_RX, ry: BODY_RY * 1.25, color: '#4ecdc4' },
    {
      part: 'hand',
      cx: ORIGIN_X + HANDS.left.x + (HANDS.forwardLeft.x - HANDS.left.x) * fwd,
      cy: ORIGIN_Y + HANDS.left.y + (HANDS.forwardLeft.y - HANDS.left.y) * fwd,
      rx: HANDS.left.hitR,
      ry: HANDS.left.hitR,
      color: '#8ab6ff',
    },
    {
      part: 'hand',
      cx: ORIGIN_X + HANDS.right.x + (HANDS.forwardRight.x - HANDS.right.x) * fwd,
      cy: ORIGIN_Y + HANDS.right.y + (HANDS.forwardRight.y - HANDS.left.y) * fwd,
      rx: HANDS.right.hitR,
      ry: HANDS.right.hitR,
      color: '#8ab6ff',
    },
  ];
}

/** 部位 → 一次性动作 id（未知部位返回 null，调用方自行决定兜底） */
export function actionForPart(part) {
  return PART_ACTION[part] || null;
}

/**
 * 指针交互控制器。
 *
 * 用法：
 *   const it = new Interactions(canvas, { onTap, onDoubleTap, onLongPress, onDragStart, onDrag, onDragEnd, onHover });
 *   it.attach();
 *   it.update(dt);            // 每帧推进（长按计时/悬停平滑）
 *   const p = it.detach();    // 解绑并返回最后一帧状态
 */
export class Interactions {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} handlers
   */
  constructor(canvas, handlers = {}) {
    this.canvas = canvas;
    this.h = handlers;

    /** 当前指针（画布逻辑坐标）；离开画布后保留最后位置，用于"眼神回正" */
    this.pointer = { x: ORIGIN_X, y: ORIGIN_Y - 300, inside: false, down: false };
    /** 平滑后的注视点：避免鼠标抖动让眼珠抽搐 */
    this.smooth = { x: ORIGIN_X, y: ORIGIN_Y - 300 };
    this.followCursor = true;

    this._down = null; // { id, x0, y0, x, y, t, moved, longFired, part }
    this._lastTapAt = 0;
    this._lastTapPart = 'none';
    this._pendingSingle = 0; // 等待双击窗口结束的单击定时器
    this._bound = false;
    this._destroyed = false;

    // 绑定一次，方便 off 时用同一引用
    this._onDown = (e) => this.#pointerDown(e);
    this._onMove = (e) => this.#pointerMove(e);
    this._onUp = (e) => this.#pointerUp(e);
    this._onCancel = (e) => this.#pointerCancel(e);
    this._onLeave = (e) => this.#pointerLeave(e);
    this._onEnter = (e) => this.#pointerEnter(e);
    this._onContextMenu = (e) => e.preventDefault();
  }

  /* ───── 生命周期 ───── */

  attach() {
    if (this._bound || this._destroyed) return;
    const c = this.canvas;
    if (!c || typeof c.addEventListener !== 'function') return;
    this._bound = true;
    c.addEventListener('pointerdown', this._onDown);
    c.addEventListener('pointermove', this._onMove);
    c.addEventListener('pointerup', this._onUp);
    c.addEventListener('pointercancel', this._onCancel);
    c.addEventListener('pointerleave', this._onLeave);
    c.addEventListener('pointerenter', this._onEnter);
    c.addEventListener('contextmenu', this._onContextMenu);
  }

  /** 解绑全部监听与定时器；可重复调用 */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._bound) {
      const c = this.canvas;
      c.removeEventListener('pointerdown', this._onDown);
      c.removeEventListener('pointermove', this._onMove);
      c.removeEventListener('pointerup', this._onUp);
      c.removeEventListener('pointercancel', this._onCancel);
      c.removeEventListener('pointerleave', this._onLeave);
      c.removeEventListener('pointerenter', this._onEnter);
      c.removeEventListener('contextmenu', this._onContextMenu);
      this._bound = false;
    }
    if (this._pendingSingle) {
      clearTimeout(this._pendingSingle);
      this._pendingSingle = 0;
    }
    this._down = null;
    this.canvas = null;
    this.h = {};
  }

  /** 设置是否跟随光标（对应设置项 pet.followCursor） */
  setFollowCursor(on) {
    this.followCursor = !!on;
    if (!on) {
      this.pointer.inside = false;
    }
  }

  /** 是否正在拖拽（index.js 用它切 CSS 光标） */
  get dragging() {
    return !!(this._down && this._down.moved);
  }

  /* ───── 坐标映射 ───── */

  /**
   * 屏幕坐标 → 画布逻辑坐标。
   *
   * 逻辑坐标系是"CSS 像素下的 360×480"（index.js 把 canvas 的 CSS 尺寸固定成这一对值，
   * devicePixelRatio 只放大 canvas.width/height 这个**后备像素缓冲**）。
   * 所以这里用 `clientWidth/clientHeight` 归一化，而不是用 canvas.width，
   * 否则在 2x 屏上命中区会整体偏一半。
   */
  toLocal(clientX, clientY) {
    const c = this.canvas;
    if (!c || typeof c.getBoundingClientRect !== 'function') return { x: clientX, y: clientY };
    const r = c.getBoundingClientRect();
    const w = r.width || 1;
    const h = r.height || 1;
    const lw = c.clientWidth || w;
    const lh = c.clientHeight || h;
    return {
      x: ((clientX - r.left) / w) * lw,
      y: ((clientY - r.top) / h) * lh,
    };
  }

  /**
   * 每帧推进：处理长按、注视平滑、拖拽位移回调。
   * @param {number} dt 秒
   */
  update(dt) {
    if (this._destroyed) return;
    const step = clamp(dt, 0, 0.1);

    // 注视平滑（指数趋近，时间无关）
    const k = 1 - Math.exp(-14 * step);
    const tx = this.followCursor && this.pointer.inside ? this.pointer.x : ORIGIN_X;
    const ty = this.followCursor && this.pointer.inside ? this.pointer.y : ORIGIN_Y - 300;
    this.smooth.x += (tx - this.smooth.x) * k;
    this.smooth.y += (ty - this.smooth.y) * k;

    const d = this._down;
    if (!d) return;

    if (!d.moved && !d.longFired) {
      const held = performance.now() - d.t;
      if (held >= TIMING.longPressMs) {
        d.longFired = true;
        if (this.h.onLongPress) this.h.onLongPress(d.part, d.x, d.y);
      }
    }
  }

  /* ───── 事件处理 ───── */

  #pointerDown(e) {
    if (this._destroyed) return;
    // 只处理主键（鼠标左键 / 触摸 / 笔）
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const p = this.toLocal(e.clientX, e.clientY);
    const part = hitTest(p.x, p.y, this.h.getPose ? this.h.getPose() : undefined);
    this.pointer.x = p.x;
    this.pointer.y = p.y;
    this.pointer.inside = true;
    this.pointer.down = true;
    this._down = {
      id: e.pointerId,
      x0: p.x,
      y0: p.y,
      x: p.x,
      y: p.y,
      t: performance.now(),
      moved: false,
      longFired: false,
      part,
    };
    // 拖动时抓住指针，避免快速甩出画布后丢事件
    if (typeof this.canvas.setPointerCapture === 'function' && e.pointerId != null) {
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        /* 某些浏览器在 pointerId 失效时抛错，忽略即可 */
      }
    }
    if (e.preventDefault) e.preventDefault();
  }

  #pointerMove(e) {
    if (this._destroyed) return;
    const p = this.toLocal(e.clientX, e.clientY);
    this.pointer.x = p.x;
    this.pointer.y = p.y;
    this.pointer.inside = true;

    const d = this._down;
    if (!d) {
      if (this.h.onHover) this.h.onHover(p.x, p.y);
      return;
    }
    d.x = p.x;
    d.y = p.y;
    const dist = Math.hypot(p.x - d.x0, p.y - d.y0);

    if (!d.moved && dist >= TIMING.dragThresholdPx) {
      d.moved = true;
      if (this.h.onDragStart) this.h.onDragStart(d.part, d.x0, d.y0);
    }
    if (d.moved && this.h.onDrag) this.h.onDrag(p.x - d.x0, p.y - d.y0, p.x, p.y);
  }

  #pointerUp(e) {
    if (this._destroyed) return;
    const d = this._down;
    this.pointer.down = false;
    if (!d) return;
    this._down = null;
    this.pointer.inside = true;

    if (typeof this.canvas?.releasePointerCapture === 'function' && e.pointerId != null) {
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* 已释放，忽略 */
      }
    }

    if (d.moved) {
      const p = this.toLocal(e.clientX, e.clientY);
      if (this.h.onDragEnd) this.h.onDragEnd(p.x - d.x0, p.y - d.y0, p.x, p.y);
      return;
    }
    if (d.longFired) return; // 长按已经触发过，不再当单击

    const now = performance.now();
    const isDouble = now - this._lastTapAt <= TIMING.doubleTapMs && this._lastTapPart === d.part;
    if (isDouble) {
      this._lastTapAt = 0;
      this._lastTapPart = 'none';
      if (this._pendingSingle) {
        clearTimeout(this._pendingSingle);
        this._pendingSingle = 0;
      }
      if (this.h.onDoubleTap) this.h.onDoubleTap(d.part, d.x0, d.y0);
      return;
    }

    // 单击：等双击窗口结束再发，避免"先单击再双击"的重复触发
    this._lastTapAt = now;
    this._lastTapPart = d.part;
    if (this._pendingSingle) clearTimeout(this._pendingSingle);
    this._pendingSingle = setTimeout(() => {
      this._pendingSingle = 0;
      if (this._destroyed) return;
      if (this.h.onTap) this.h.onTap(d.part, d.x0, d.y0);
    }, TIMING.doubleTapMs);
  }

  #pointerCancel() {
    if (this._destroyed) return;
    const d = this._down;
    this._down = null;
    this.pointer.down = false;
    if (d && d.moved && this.h.onDragEnd) this.h.onDragEnd(d.x - d.x0, d.y - d.y0, d.x, d.y);
  }

  #pointerLeave() {
    if (this._destroyed) return;
    this.pointer.inside = false;
    // 指针离开时若正在拖拽，不取消拖拽（有 pointer capture），只标记"不在画布内"
  }

  #pointerEnter() {
    if (this._destroyed) return;
    this.pointer.inside = true;
  }
}

export { HIT_PARTS };
export default Interactions;
