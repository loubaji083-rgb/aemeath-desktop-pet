#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rasterize-canvas.py —— 把 dump-pet-frame.mjs 导出的 Canvas 指令流回放成 PNG

为什么要有这一步：
  单元测试和冒烟测试只能回答「有没有异常 / 有没有 NaN」，回答不了
  「这张脸是不是画糊了 / 眼睛是不是跑到下巴上 / 头发是不是盖住了整张脸」。
  那些问题只有在真的变成像素之后才看得见。所以：
    1. tools/dump-pet-frame.mjs  用记录型 context 跑真实渲染，导出 JSON 指令流
    2. 本脚本用 Pillow 回放 → frame.png
    3. 人（或模型）看图判断

支持的 Canvas 子集 = 本项目 draw.js / rig.js 实际用到的部分：
  save/restore/translate/scale/rotate/transform/setTransform
  beginPath/closePath/moveTo/lineTo/quadraticCurveTo/bezierCurveTo/arc/arcTo/ellipse/rect/roundRect
  fill/stroke/clip/fillRect/strokeRect/clearRect/fillText
  createLinearGradient/createRadialGradient（按平均色近似，不逐像素插值）
  globalAlpha（整体不透明度）

明确的近似（看图时要知道，别当成 bug）：
  - 渐变按「平均色」填充，没有逐像素插值
  - 没有阴影 / 混合模式 / 滤镜
  - globalCompositeOperation 未实现（本项目没用到）
  - 曲线按固定段数折线化

clip 的作用域：
  Canvas 里 `clip()` 建立的裁剪区域在 `restore()` 之前一直有效。本脚本按
  `save`/`restore` op 配对维护 `clip_stack` —— dump 侧曾经不记录 save/restore，
  导致第一个 clip 永久生效、把身体下半身全裁掉（PNG 里"看不见腿"的假象）。
  改 dump 侧时**务必**保留 save/restore 的 op 输出。

用法：
  python tools/rasterize-canvas.py tools/.frame.json tools/.frame.png [--scale 2]
"""

import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageChops

# ----------------------------------------------------------------------------
# 颜色解析
# ----------------------------------------------------------------------------

NAMED = {
    "black": (0, 0, 0, 255),
    "white": (255, 255, 255, 255),
    "red": (255, 0, 0, 255),
    "green": (0, 128, 0, 255),
    "blue": (0, 0, 255, 255),
    "transparent": (0, 0, 0, 0),
}


def parse_color(c):
    """#rgb / #rrggbb / #rrggbbaa / rgba(...) / rgb(...) -> (r,g,b,a)"""
    if c is None:
        return (0, 0, 0, 255)
    if isinstance(c, dict):
        return avg_color_of_gradient(c)
    s = str(c).strip()
    if s in NAMED:
        return NAMED[s]
    if s.startswith("#"):
        h = s[1:]
        if len(h) == 3:
            h = "".join(ch * 2 for ch in h)
        if len(h) == 4:
            h = "".join(ch * 2 for ch in h)
        if len(h) == 6:
            return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255)
        if len(h) == 8:
            return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), int(h[6:8], 16))
    if s.startswith("rgb"):
        inner = s[s.index("(") + 1: s.rindex(")")]
        parts = [p.strip() for p in inner.replace("/", ",").split(",") if p.strip()]
        try:
            r, g, b = (int(float(parts[0])), int(float(parts[1])), int(float(parts[2])))
            a = 255
            if len(parts) >= 4:
                v = float(parts[3])
                a = int(round(v * 255)) if v <= 1 else int(v)
            return (max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b)), max(0, min(255, a)))
        except Exception:
            pass
    return (0, 0, 0, 255)


def avg_color_of_gradient(g):
    """
    渐变近似：取所有 stop 颜色的**加权平均**（按相邻 stop 的 offset 距离加权）。
    本项目里渐变只用于柔和的皮肤/头发/腮红过渡，平均色足以判断「位置与形状对不对」。
    dump 侧（tools/dump-pet-frame.mjs）已经把 addColorStop 的 offset/color 记进 stops，
    所以这里用的是**真实颜色**，不是猜的。
    """
    stops = g.get("stops") or []
    if not stops:
        return (200, 170, 175, 255)
    if len(stops) == 1:
        return parse_color(stops[0].get("color"))
    total_w = 0.0
    acc = [0.0, 0.0, 0.0, 0.0]
    for i in range(len(stops) - 1):
        c0 = parse_color(stops[i].get("color"))
        c1 = parse_color(stops[i + 1].get("color"))
        try:
            w = abs(float(stops[i + 1].get("offset", 0)) - float(stops[i].get("offset", 0)))
        except Exception:
            w = 1.0
        if w <= 0:
            w = 0.001
        total_w += w
        for k in range(4):
            acc[k] += (c0[k] + c1[k]) / 2.0 * w
    if total_w <= 0:
        return parse_color(stops[-1].get("color"))
    return tuple(int(round(acc[k] / total_w)) for k in range(4))


# ----------------------------------------------------------------------------
# 路径折线化
# ----------------------------------------------------------------------------

CURVE_STEPS = 24


def dedupe(pts):
    """去掉相邻重复点。

    Canvas 的 closePath() 会在路径末尾补一条「回到起点」的边；若路径本身已经
    结束在起点上（draw.js 的 capsule() 就是这种形态），折线化后就会出现一对
    重合点 + 一条零长度边。PIL 的 polygon() 扫描线遇到零长度边时会把自相交
    轮廓只填出**一半**（右半），于是竖直的胶囊被渲染成「纺锤/锥形」——
    脖子、腿、手臂因此看起来是锥体，而它们从来不是。本项目为此误诊过一轮。
    """
    out = []
    for p in pts:
        if not out or abs(p[0] - out[-1][0]) > 1e-9 or abs(p[1] - out[-1][1]) > 1e-9:
            out.append(p)
    while len(out) > 2 and abs(out[0][0] - out[-1][0]) <= 1e-9 and abs(out[0][1] - out[-1][1]) <= 1e-9:
        out.pop()
    return out


def apply_matrix(m, x, y):
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def arc_points(cx, cy, rx, ry, rot, a0, a1, ccw, steps=None):
    if steps is None:
        sweep = abs(a1 - a0)
        steps = max(6, min(96, int(sweep / (math.pi / 24)) + 2))
    if ccw and a1 > a0:
        a1 -= 2 * math.pi
    elif not ccw and a1 < a0:
        a1 += 2 * math.pi
    pts = []
    for i in range(steps + 1):
        t = i / steps
        ang = a0 + (a1 - a0) * t
        x = rx * math.cos(ang)
        y = ry * math.sin(ang)
        if rot:
            cr, sr = math.cos(rot), math.sin(rot)
            x, y = x * cr - y * sr, x * sr + y * cr
        pts.append((cx + x, cy + y))
    return pts


def fill_nonzero(size, pts, color):
    """按 canvas 的**非零环绕规则（nonzero winding）**填充多边形，带 2x2 超采样抗锯齿。

    返回与调用方同尺寸（设备像素）的 RGBA 图层。`size` 传设备像素尺寸。

    为什么不能用 PIL 的 `ImageDraw.polygon()`：它用的是偶奇（even-odd）规则。
    而本项目 `web/js/pet/draw.js` 的 `capsule()` 曾经生成**自相交**的「领结」
    路径（两段弧扫同一侧），浏览器按非零环绕规则填充、PIL 按偶奇规则填充，
    两者结果不同 —— 像素图里脖子/腿/手臂因此全变成「锥形/纺锤形」，
    本项目为此误诊过整整一轮（连美术都被要求返工）。
    """
    w, h = size
    ss = 2  # 超采样倍数
    W, H = w * ss, h * ss
    cover = Image.new("L", (W, H), 0)
    cp = cover.load()
    n = len(pts)
    if n < 3:
        return None
    ys = [p[1] for p in pts]
    y0 = max(0, int(math.floor(min(ys) * ss)) - 1)
    y1 = min(H - 1, int(math.ceil(max(ys) * ss)) + 1)
    for py in range(y0, y1 + 1):
        yc = (py + 0.5) / ss
        xs = []
        for i in range(n):
            xa, ya = pts[i]
            xb, yb = pts[(i + 1) % n]
            if ya == yb:
                continue
            if (ya > yc) != (yb > yc):
                t = (yc - ya) / (yb - ya)
                xs.append((xa + t * (xb - xa), 1 if yb > ya else -1))
        if len(xs) < 2:
            continue
        xs.sort(key=lambda v: v[0])
        wind = 0
        for k in range(len(xs) - 1):
            wind += xs[k][1]
            if wind == 0:
                continue
            a = int(math.floor(xs[k][0] * ss + 0.5))
            b = int(math.floor(xs[k + 1][0] * ss + 0.5))
            for px in range(max(0, a), min(W - 1, b) + 1):
                cp[px, py] = 255
    if ss != 1:
        cover = cover.resize((w, h), Image.BILINEAR)
    sol = Image.new("RGBA", (w, h), color)
    sol.putalpha(ImageChops.multiply(sol.getchannel("A"), cover))
    return sol


# LEDGER:nonzero-fill-replaced-do_fill
def flatten(cmds):
    """把指令序列折线化成 [(x,y), ...]（局部坐标）。"""
    out = []
    cur = None
    start = None
    for cmd in cmds:
        k = cmd[0]
        if k == "M":
            cur = (cmd[1], cmd[2])
            start = cur
            out.append(cur)
        elif k == "L":
            cur = (cmd[1], cmd[2])
            out.append(cur)
        elif k == "Q":
            if cur is None:
                cur = (cmd[3], cmd[4])
                out.append(cur)
                continue
            x0, y0 = cur
            cx, cy, x1, y1 = cmd[1], cmd[2], cmd[3], cmd[4]
            for i in range(1, CURVE_STEPS + 1):
                t = i / CURVE_STEPS
                mt = 1 - t
                out.append((mt * mt * x0 + 2 * mt * t * cx + t * t * x1,
                            mt * mt * y0 + 2 * mt * t * cy + t * t * y1))
            cur = (x1, y1)
        elif k == "C":
            if cur is None:
                cur = (cmd[5], cmd[6])
                out.append(cur)
                continue
            x0, y0 = cur
            c1x, c1y, c2x, c2y, x1, y1 = cmd[1:7]
            for i in range(1, CURVE_STEPS + 1):
                t = i / CURVE_STEPS
                mt = 1 - t
                out.append((
                    mt**3 * x0 + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t**3 * x1,
                    mt**3 * y0 + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t**3 * y1,
                ))
            cur = (x1, y1)
        elif k == "A":
            x, y, r, a0, a1, cw = cmd[1:7]
            # 注意第 8 个位置参数是 **ccw**，不是 rot！
            # 早先这里写成 arc_points(x, y, r, r, 0, a0, a1, bool(cw))，把「逆时针标志」
            # 当成了旋转角 rot —— 于是每个圆弧都被额外旋转 0 或 1 弧度、整段弧被平移，
            # 胶囊路径（腿/脖子/手臂）渲染成"!"形楔子。像素图因此看起来像"锥形四肢"，
            # 但那从来不是画法的问题。修法：显式传关键字实参。
            #
            # Canvas 规范：arc() 的起点与当前点不同时会自动补一条 lineTo（等价于
            # 先 lineTo(弧起点) 再画弧）。draw.js 的 capsule() 正是依赖这个行为：
            # 它的最后一段 A 前面紧跟 lineTo，真正的弧起点与当前点只差 0.5px。
            # 这里若不补这条线，路径会被"拉"到弧起点，折线化后多出一根横贯中轴的
            # 碟形闭合线 —— 胶囊被填成"纺锤/锥形"，看起来就像脖子和腿是锥体。
            pts = arc_points(x, y, r, r, 0, a0, a1, ccw=bool(cw))
            if pts and cur is not None:
                dx0, dy0 = pts[0][0] - cur[0], pts[0][1] - cur[1]
                if (dx0 * dx0 + dy0 * dy0) > 1e-9:
                    out.append(pts[0])
            out.extend(pts)
            if pts:
                cur = pts[-1]
        elif k == "E":
            x, y, rx, ry, rot, a0, a1, cw = cmd[1:9]
            pts = arc_points(x, y, rx, ry, rot, a0, a1, ccw=bool(cw))
            out.extend(pts)
            if pts:
                cur = pts[-1]
        elif k == "AT":
            # arcTo：为简化，直接连到 (x2,y2)（本项目里只用于圆角矩形，影响极小）
            x2, y2 = cmd[3], cmd[4]
            out.append((x2, y2))
            cur = (x2, y2)
        elif k == "R":
            x, y, w, h = cmd[1:5]
            out.extend([(x, y), (x + w, y), (x + w, y + h), (x, y + h), (x, y)])
            cur = (x, y)
        elif k == "RR":
            x, y, w, h, r = cmd[1:6]
            r = max(0.0, min(float(r), w / 2, h / 2))
            pts = []
            for (ccx, ccy, a0) in [(x + r, y + r, math.pi), (x + w - r, y + r, -math.pi / 2),
                                   (x + w - r, y + h - r, 0.0), (x + r, y + h - r, math.pi / 2)]:
                pts.extend(arc_points(ccx, ccy, r, r, 0, a0, a0 + math.pi / 2, False, steps=8))
            out.extend(pts)
            out.append(pts[0] if pts else (x, y))
            cur = pts[0] if pts else (x, y)
        elif k == "Z":
            if start:
                out.append(start)
                cur = start
    return out


# ----------------------------------------------------------------------------
# 回放
# ----------------------------------------------------------------------------

class Rasterizer:
    def __init__(self, width, height, scale):
        self.w = width
        self.h = height
        self.s = scale
        self.img = Image.new("RGBA", (width * scale, height * scale), (0, 0, 0, 0))
        self.clip_stack = []   # 每项是 ('mask', L_image) 或 ('rect', (l,t,r,b))
        self.save_stack = []   # 每项 = 进入 save() 时的 len(clip_stack)
        self.unknown_ops = {}

    # -- 裁剪 -------------------------------------------------------------
    def current_clip_mask(self):
        if not self.clip_stack:
            return None
        m = None
        for kind, val in self.clip_stack:
            if kind == "mask":
                m = val if m is None else ImageChops.multiply(m, val)
        return m

    def clip_rect_dev(self):
        box = (0, 0, self.w, self.h)
        for kind, val in self.clip_stack:
            if kind == "rect":
                box = (max(box[0], val[0]), max(box[1], val[1]),
                       min(box[2], val[2]), min(box[3], val[3]))
        return box

    # -- 绘制 -------------------------------------------------------------
    def layer(self):
        return Image.new("RGBA", self.img.size, (0, 0, 0, 0))

    def dev_points(self, cmds, m):
        pts = flatten(cmds)
        return [apply_matrix(m, x, y) for (x, y) in pts]

    def scaled(self, pts):
        return [(x * self.s, y * self.s) for (x, y) in pts]

    def do_fill(self, cmds, m, color, alpha):
        pts = self.scaled(dedupe(self.dev_points(cmds, m)))
        if len(pts) < 3:
            return
        r, g, b, a = color
        a = int(a * max(0.0, min(1.0, alpha)))
        if a <= 0:
            return
        lay = fill_nonzero(self.img.size, pts, (r, g, b, a))
        if lay is not None:
            self.composite(lay)

    def do_stroke(self, cmds, m, color, width, alpha):
        pts = self.scaled(self.dev_points(cmds, m))
        if len(pts) < 2:
            return
        r, g, b, a = color
        a = int(a * max(0.0, min(1.0, alpha)))
        if a <= 0:
            return
        wpx = max(1, int(round(width * self.s)))
        lay = self.layer()
        d = ImageDraw.Draw(lay)
        d.line(pts, fill=(r, g, b, a), width=wpx, joint="curve")
        self.composite(lay)

    def do_rect(self, rect, m, color, alpha, stroke=False, width=1):
        x, y, w, h = rect
        corners = [apply_matrix(m, x, y), apply_matrix(m, x + w, y),
                   apply_matrix(m, x + w, y + h), apply_matrix(m, x, y + h)]
        pts = [(px * self.s, py * self.s) for (px, py) in corners]
        r, g, b, a = color
        a = int(a * max(0.0, min(1.0, alpha)))
        if a <= 0:
            return
        lay = self.layer()
        d = ImageDraw.Draw(lay)
        if stroke:
            d.line(pts + [pts[0]], fill=(r, g, b, a), width=max(1, int(round(width * self.s))))
        else:
            d.polygon(dedupe(pts), fill=(r, g, b, a))
        self.composite(lay)

    def do_text(self, item):
        text = item.get("text", "")
        if not text.strip():
            return
        x, y = item["at"]
        m = item["transform"]
        px, py = apply_matrix(m, x, y)
        px, py = px * self.s, py * self.s
        color = parse_color(item.get("style"))
        alpha = item.get("alpha", 1)
        r, g, b, a = color
        a = int(a * max(0.0, min(1.0, alpha)))
        if a <= 0:
            return
        size = 14
        fontspec = str(item.get("font", ""))
        if "px" in fontspec:
            try:
                size = int(round(float(fontspec.split("px")[0].strip())))
            except Exception:
                pass
        font = None
        for cand in ("C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf",
                     "C:/Windows/Fonts/arial.ttf"):
            try:
                font = _truetype(cand, max(6, int(size * self.s)))
                break
            except Exception:
                continue
        if font is None:
            return
        lay = self.layer()
        d = ImageDraw.Draw(lay)
        # textBaseline 未实现；默认按 center 近似（气泡是单行居中文字）
        d.text((px, py), text, fill=(r, g, b, a), font=font, anchor="mm")
        self.composite(lay)

    def composite(self, lay):
        """按 clip 蒙版合成一层。"""
        clip_box = self.clip_rect_dev()
        if clip_box != (0, 0, self.w, self.h):
            # 用矩形裁剪做快速路径
            box = (int(clip_box[0] * self.s), int(clip_box[1] * self.s),
                   int(clip_box[2] * self.s), int(clip_box[3] * self.s))
            big = Image.new("RGBA", self.img.size, (0, 0, 0, 0))
            if box[2] > box[0] and box[3] > box[1]:
                region = lay.crop(box)
                big.paste(region, (box[0], box[1]))
            lay = big
        mask = self.current_clip_mask()
        if mask is not None:
            lay = Image.composite(lay, Image.new("RGBA", self.img.size, (0, 0, 0, 0)), mask)
        self.img = Image.alpha_composite(self.img, lay)

    # -- 主循环 -----------------------------------------------------------
    def run(self, ops):
        import os
        trace_px = os.environ.get("AEMEATH_TRACE_PIXEL")
        for idx, item in enumerate(ops):
            op = item.get("op")
            m = item.get("transform", [1, 0, 0, 1, 0, 0])
            alpha = item.get("alpha", 1)
            if trace_px:
                try:
                    tx, ty = (int(v) for v in trace_px.split(","))
                except Exception:
                    tx, ty = 190, 220
                px = self.img.getpixel((tx * self.s, ty * self.s))
                print(f"  [{idx:3d}] {op:10s} style={str(item.get('style'))[:28]:28s} px({tx},{ty})={px}")
            if op == "fill":
                self.do_fill(item["cmds"], m, parse_color(item.get("style")), alpha)
            elif op == "stroke":
                self.do_stroke(item["cmds"], m, parse_color(item.get("style")),
                               item.get("width", 1), alpha)
            elif op == "fillRect":
                self.do_rect(item["rect"], m, parse_color(item.get("style")), alpha)
            elif op == "strokeRect":
                self.do_rect(item["rect"], m, parse_color(item.get("style")), alpha,
                             stroke=True, width=item.get("width", 1))
            elif op == "clearRect":
                x, y, w, h = item["rect"]
                if x <= 0 and y <= 0 and w >= self.w and h >= self.h:
                    self.img = Image.new("RGBA", self.img.size, (0, 0, 0, 0))
            elif op == "clip":
                pts = self.scaled(dedupe(self.dev_points(item["cmds"], m)))
                if len(pts) >= 3:
                    mask = Image.new("L", self.img.size, 0)
                    ImageDraw.Draw(mask).polygon(pts, fill=255)
                    self.clip_stack.append(("mask", mask))
            elif op == "save":
                # canvas 的 save() 保存的是**裁剪区域**；回放端必须按栈深配对，
                # 否则第一个 clip 会永久生效（曾把身体下半身整块裁掉）。
                self.save_stack.append(len(self.clip_stack))
            elif op == "restore":
                depth = self.save_stack.pop() if self.save_stack else 0
                if depth < 0:
                    depth = 0
                del self.clip_stack[depth:]
            elif op == "text":
                self.do_text(item)
            else:
                self.unknown_ops[op] = self.unknown_ops.get(op, 0) + 1


def _truetype(path, size):
    from PIL import ImageFont
    return ImageFont.truetype(path, size)


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])
    scale = 2
    if "--scale" in sys.argv:
        scale = int(sys.argv[sys.argv.index("--scale") + 1])

    payload = json.loads(src.read_text(encoding="utf-8"))
    w = payload["canvas"]["width"]
    h = payload["canvas"]["height"]

    r = Rasterizer(w, h, scale)
    r.run(payload["ops"])

    # 拼一层浅色棋盘底，避免透明区域在小图里看不出边界
    bg = Image.new("RGBA", r.img.size, (48, 52, 64, 255))
    out = Image.alpha_composite(bg, r.img)
    out.convert("RGB").save(dst)

    print(f"mood={payload.get('mood')} action={payload.get('action') or '(none)'} "
          f"ops={len(payload['ops'])} -> {dst} ({out.size[0]}x{out.size[1]})")
    if r.unknown_ops:
        print("未实现的指令（会被忽略，看图时请留意）：", r.unknown_ops)
    return 0


if __name__ == "__main__":
    sys.exit(main())
