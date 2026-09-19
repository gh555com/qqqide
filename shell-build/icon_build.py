# -*- coding: utf-8 -*-
# ============================================================================
# icon_build.py — 生成 shell/icon.ico + shell/icon.icns（唯一图标资产工厂）
#
# 输入: 任意方形 PNG（默认 E:\p\qqqide\qqq发夹.png 或 argv[1]）
# 输出: {repo}/shell/icon.ico   （多尺寸 16~256，Windows rcedit/electron-builder 用）
#       {repo}/shell/icon.icns  （PNG-based ICNS 容器: icp4/5/6 + ic07~ic14，mac 用）
#
# 说明: ICNS 为标准容器格式（magic + 类型块），macOS 10.7+ 原生支持 PNG 块，
#       故无需 macOS 工具链即可在 Windows 上生成合法 .icns（Electron 生态通用做法）。
#       pack.js mac 段会把 icon.icns 覆盖到 qqqide.app/Contents/Resources/electron.icns。
# usage: python shell-build/icon_build.py [source.png]
# ============================================================================
import io
import os
import struct
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHELL = os.path.join(ROOT, 'shell')

src = sys.argv[1] if len(sys.argv) > 1 else r'E:\p\qqqide\qqq发夹.png'
if not os.path.isfile(src):
    print('source not found:', src)
    sys.exit(2)

img = Image.open(src).convert('RGBA')
w, h = img.size
if w != h:
    s = max(w, h)
    canvas = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    canvas.paste(img, ((s - w) // 2, (s - h) // 2))
    img = canvas
    print('padded %dx%d -> %dx%d' % (w, h, s, s))

# ── ico（多尺寸）—— 默认不生成（Windows 图标保持 shell/icon.ico 原状；仅 --ico 时更新）──
if '--ico' in sys.argv:
    ico_path = os.path.join(SHELL, 'icon.ico')
    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    img.save(ico_path, sizes=ico_sizes)
    print('ico  ->', ico_path, os.path.getsize(ico_path), 'bytes')
else:
    print('ico  -> skipped (pass --ico to update Windows icon)')

# ── icns（PNG-based 容器）──
def png_bytes(size):
    im = img.resize((size, size), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, 'PNG', optimize=True)
    return buf.getvalue()


ICNS_TYPES = [
    (b'icp4', 16), (b'icp5', 32), (b'icp6', 64),
    (b'ic07', 128), (b'ic08', 256), (b'ic09', 512), (b'ic10', 1024),
    (b'ic11', 32), (b'ic12', 64), (b'ic13', 256), (b'ic14', 512),
]
chunks = []
for t, sz in ICNS_TYPES:
    data = png_bytes(sz)
    chunks.append(t + struct.pack('>I', len(data) + 8) + data)
body = b''.join(chunks)
icns = b'icns' + struct.pack('>I', len(body) + 8) + body

icns_path = os.path.join(SHELL, 'icon.icns')
with open(icns_path, 'wb') as f:
    f.write(icns)
print('icns ->', icns_path, os.path.getsize(icns_path), 'bytes')
print('DONE')
