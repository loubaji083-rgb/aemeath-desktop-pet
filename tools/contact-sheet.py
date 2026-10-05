# 一次性工具（Lead）：把 6 个 mood 的帧拼成一张对照表，用于目视验收。
# 用法：
#   node tools/dump-pet-frame.mjs --mood happy --out tools/samples/frame-happy.json
#   python tools/rasterize-canvas.py tools/samples/frame-happy.json tools/samples/frame-happy.png --scale 1
#   python tools/.contact-sheet.py <输出路径>
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent
samples = root / "samples"
out_path = Path(sys.argv[1]) if len(sys.argv) > 1 else root / ".contact-sheet.png"
moods = sys.argv[2].split(",") if len(sys.argv) > 2 else ["idle", "happy", "shy", "surprised", "sad", "angry"]
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
