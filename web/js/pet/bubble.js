/**
 * Aemeath 桌宠 —— 画布内气泡
 *
 * 契约要求气泡由 PetUI 自己画（不依赖 DOM）：core/busy.js 在 `Bubble.hasPetUi === true`
 * 时**只**发 `PET_BUBBLE` 事件、不写 `#pet-reminder` 的 DOM，所以这里的绘制是唯一出口。
 *
 * 设计：
 *  - 纯 Canvas 2D：圆角矩形 + 小尾巴 + 自动换行（中文按字、英文按词）。
 *  - 缓存排版结果：同一段文字 + 同一宽度只排版一次，避免 60fps 下反复 measureText。
 *  - 出现/消失有弹性缩放，文字有"逐渐浮现"的字数动画，但都是纯计算、无 DOM、无定时器。
 */

import { CANVAS_W, PALETTE } from './constants.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const easeOutBack = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const p = t - 1;
  return 1 + c3 * p * p * p + c1 * p * p;
};

/** 气泡样式（想调外观改这里即可，draw 内部不写魔数） */
const STYLE = {
  font: '600 17px "PingFang SC","Microsoft YaHei","Hiragino Sans GB",system-ui,sans-serif',
  lineHeight: 24,
  padX: 16,
  padY: 11,
  radius: 16,
  maxWidth: 268,
  minWidth: 76,
  /** 气泡底边相对头顶的距离 */
  gapAboveHead: 14,
  /** 头顶在画布里的 y（与 constants 的头部区域一致） */
  headTopY: 46,
  /** 出现/消失动画时长（秒） */
  inSec: 0.22,
  outSec: 0.16,
};

/**
 * 按最大宽度换行。
 * 中文逐字换行、英文优先按空格断词（避免把 "hello" 切两半）。
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} maxWidth
 * @returns {string[]}
 */
function wrapText(ctx, text, maxWidth) {
  const out = [];
  const paragraphs = String(text).split(/\r?\n/);
  for (const para of paragraphs) {
    if (para === '') {
      out.push('');
      continue;
    }
    // 先按"空白/单词边界"切成 token：连续 ASCII 词算一个 token，其余（CJK/标点）逐字
    const tokens = para.match(/[A-Za-z0-9_'’\-]+|\s+|[\s\S]/g) || [];
    let line = '';
    for (const tk of tokens) {
      const test = line + tk;
      if (ctx.measureText(test).width <= maxWidth || line === '') {
        line = test;
      } else {
        out.push(line);
        // 行首不留空格
        line = /^\s+$/.test(tk) ? '' : tk;
      }
    }
    if (line !== '') out.push(line);
  }
  return out.length ? out : [''];
}

export class Bubble {
  constructor() {
    this.text = '';
    this.ms = 4200;
    this.elapsed = 0;
    this.visible = false;
    /** 排版缓存：{ text, maxWidth, lines, width, height } */
    this._layout = null;
    this._anim = 0; // 0..1 出现动画
    this._byId = null; // 供外部（测试）确认事件来源
  }

  /**
   * 显示气泡。
   * @param {string} text
   * @param {number} [ms] 停留毫秒（不含出现/消失动画）
   */
  show(text, ms) {
    const t = typeof text === 'string' ? text.trim() : String(text ?? '').trim();
    if (!t) {
      this.hide();
      return;
    }
    this.text = t.slice(0, 240);
    this.ms = Number.isFinite(ms) && ms > 0 ? clamp(ms, 500, 60000) : 4200;
    this.elapsed = 0;
    this.visible = true;
    this._layout = null;
    this._anim = 0;
  }

  hide() {
    this.visible = false;
    this.text = '';
    this._layout = null;
    this._anim = 0;
  }

  /** @param {number} dt 秒 */
  update(dt) {
    const step = clamp(dt, 0, 0.1);
    if (this.visible) {
      this.elapsed += step * 1000;
      this._anim = clamp(this._anim + step / STYLE.inSec, 0, 1);
      if (this.elapsed >= this.ms + STYLE.outSec * 2 * 1000) this.hide();
    } else {
      this._anim = 0;
    }
  }

  /** 剩余可见时间的比例（0..1），用于淡出 */
  get fade() {
    if (!this.visible) return 0;
    const tail = this.ms - this.elapsed;
    if (tail <= 0) return clamp(1 + tail / 400, 0, 1);
    return 1;
  }

  /** 是否有内容需要绘制 */
  get active() {
    return this.visible && this.text !== '';
  }

  /**
   * 在画布坐标里绘制气泡（调用方负责 save/restore 与 ctx 变换已归零）。
   * @param {CanvasRenderingContext2D} ctx
   * @returns {boolean} 是否真的画了
   */
  draw(ctx) {
    if (!this.active || !ctx) return false;
    const anim = this.visible ? this._anim : 0;
    if (anim <= 0.001) return false;

    const prevFont = ctx.font;
    ctx.font = STYLE.font;

    // 排版缓存：宽度只跟 maxWidth 有关，所以缓存键是 text + maxWidth
    let layout = this._layout;
    if (!layout || layout.text !== this.text || layout.maxWidth !== STYLE.maxWidth) {
      const lines = wrapText(ctx, this.text, STYLE.maxWidth);
      let w = STYLE.minWidth;
      for (const l of lines) w = Math.max(w, ctx.measureText(l).width);
      layout = {
        text: this.text,
        maxWidth: STYLE.maxWidth,
        lines,
        width: Math.min(STYLE.maxWidth, w) + STYLE.padX * 2,
        height: lines.length * STYLE.lineHeight + STYLE.padY * 2,
      };
      this._layout = layout;
    }

    const fade = this.fade;
    const scale = easeOutBack(anim);
    // 锚点：水平居中；底部固定在头顶上方
    const cx = CANVAS_W / 2;
    const bottom = STYLE.headTopY - STYLE.gapAboveHead;
    const w = layout.width;
    const h = layout.height;

    ctx.save();
    ctx.globalAlpha = clamp(anim, 0, 1) * clamp(fade, 0, 1);
    // 从尾巴尖位置做弹性缩放，像"从头顶冒出来"
    ctx.translate(cx, bottom);
    ctx.scale(scale, scale);

    const x = -w / 2;
    const y = -h;

    // 阴影（柔和，不抢主体）
    ctx.save();
    ctx.shadowColor = 'rgba(60,90,130,0.22)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 4;
    ctx.beginPath();
    roundRectPath(ctx, x, y, w, h, STYLE.radius);
    ctx.fillStyle = PALETTE.bubbleBg;
    ctx.fill();
    ctx.restore();

    // 主体
    ctx.beginPath();
    roundRectPath(ctx, x, y, w, h, STYLE.radius);
    ctx.fillStyle = PALETTE.bubbleBg;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = PALETTE.bubbleLine;
    ctx.stroke();

    // 小尾巴（等腰三角形 + 与主体同色的覆盖线，消掉尾巴根部的那道描边）
    const tailW = 11;
    const tailH = 9;
    ctx.beginPath();
    ctx.moveTo(-tailW, -1);
    ctx.lineTo(0, tailH);
    ctx.lineTo(tailW, -1);
    ctx.closePath();
    ctx.fillStyle = PALETTE.bubbleBg;
    ctx.fill();
    ctx.strokeStyle = PALETTE.bubbleLine;
    ctx.lineWidth = 2;
    ctx.stroke();
    // 用底色压掉三角形顶边，让尾巴和气泡融为一体
    ctx.beginPath();
    ctx.moveTo(-tailW + 1, -1.6);
    ctx.lineTo(tailW - 1, -1.6);
    ctx.lineWidth = 3.2;
    ctx.strokeStyle = PALETTE.bubbleBg;
    ctx.stroke();

    // 文字：逐字浮现（前 60% 时间内完成），避免整段突然出现
    const revealT = clamp(this.elapsed / Math.max(120, STYLE.inSec * 600), 0, 1);
    const totalChars = layout.lines.reduce((a, l) => a + l.length, 0);
    let budget = Math.ceil(totalChars * revealT) + 1;

    ctx.fillStyle = PALETTE.bubbleText;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < layout.lines.length; i++) {
      const line = layout.lines[i];
      const ly = y + STYLE.padY + STYLE.lineHeight * i + STYLE.lineHeight / 2;
      if (budget <= 0) break;
      const shown = line.slice(0, budget);
      budget -= line.length;
      ctx.fillText(shown, x + STYLE.padX, ly);
    }

    ctx.restore();
    ctx.font = prevFont;
    return true;
  }

  /** 可序列化状态（挂进 getDebugState） */
  getDebugState() {
    return {
      visible: this.visible,
      text: this.text,
      ms: this.ms,
      elapsed: Math.round(this.elapsed),
    };
  }
}

/** 圆角矩形路径（不 fill/stroke，交由调用方决定） */
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export { wrapText, STYLE as BUBBLE_STYLE };
export default Bubble;
