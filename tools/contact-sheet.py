# 把若干 mood 的帧拼成一张对照表，用于目视验收（开源工具，随仓库发布）。
#
# 用法：
#   python tools/contact-sheet.py <输出.png> [mood1,mood2,...] [--dir <帧目录>]
#
# 帧目录默认 tools/samples，按 <dir>/frame-<mood>.png 查找。
# 典型流程（每格都用同样的 --scale，否则格子大小会不一致）：
#   for m in idle happy shy surprised sad angry; do
#     node tools/dump-pet-frame.mjs --mood $m --out /tmp/$m.json
#     python tools/rasterize-canvas.py /tmp/$m.json /tmp/frame-$m.png --scale 1
#   done
#   python tools/contact-sheet.py tools/samples/contact-sheet.png idle,happy,shy,surprised,sad,angry --dir /tmp
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent

args = [a for a in sys.argv[1:]]
dir_override = None
if "--dir" in args:
    i = args.index("--dir")
    dir_override = args[i + 1] if i + 1 < len(args) else None
    del args[i:i + 2]

samples = Path(dir_override) if dir_override else (root / "samples")
out_path = Path(args[0]) if args else (root / ".contact-sheet.png")
moods = args[1].split(",") if len(args) > 1 else ["idle", "happy", "shy", "surprised", "sad", "angry"]
COLS, PAD, LABEL = 3, 8, 22

tiles = []
for m in moods:
    p = samples / f"frame-{m}.png"
    if not p.exists():
        print(f"跳过 {m}（缺 {p}）")
        continue
    tiles.append((m, Image.open(p).convert("RGB")))
if not tiles:
    raise SystemExit("没有任何帧可拼")

sizes = {im.size for _, im in tiles}
if len(sizes) > 1:
    raise SystemExit(f"格子尺寸不一致 {sorted(sizes)}；请让所有帧用同一个 --scale 重出")

w, h = tiles[0][1].size
rows = (len(tiles) + COLS - 1) // COLS
sheet = Image.new("RGB", (COLS * w + (COLS + 1) * PAD, rows * (h + LABEL) + (rows + 1) * PAD), (24, 26, 32))
draw = ImageDraw.Draw(sheet)
try:
    font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 16)
except Exception:
    font = ImageFont.load_default()

for i, (m, im) in enumerate(tiles):
    cx = PAD + (i % COLS) * (w + PAD)
    cy = PAD + (i // COLS) * (h + LABEL + PAD)
    draw.text((cx + 4, cy + 2), m, fill=(230, 230, 240), font=font)
    sheet.paste(im, (cx, cy + LABEL))

sheet.save(out_path)
print(f"写出 {out_path} ({sheet.size[0]}x{sheet.size[1]})，{len(tiles)} 格：{[m for m, _ in tiles]}")
