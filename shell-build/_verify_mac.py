# -*- coding: utf-8 -*-
# ============================================================================
# _verify_mac.py — mac 产物质检（每次 pack:mac-* 后复用）
#
# usage: python shell-build/_verify_mac.py [tar.gz path] [--arch=arm64|x64]
#   省略路径 → 自动取 dist-pack/qqqide-mac-*.tar.gz 中最新修改的一个
# exit: 0 = PASS / 1 = FAIL（打印全部问题清单）
#
# 检查项：sha256 指纹 / 顶层结构 / 残留（pycache·vc_runtime）/ 关键二进制
#         Mach-O 架构 / 符号链接（数量 + 反斜杠）/ Info.plist 契约 / 入口链
# ============================================================================
import hashlib
import os
import re
import sys
import tarfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist-pack')


def find_tar():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if args:
        return args[0]
    cands = [os.path.join(DIST, f) for f in os.listdir(DIST)
             if f.startswith('qqqide-mac-') and f.endswith('.tar.gz')]
    if not cands:
        raise SystemExit('no mac tar found in dist-pack')
    return max(cands, key=os.path.getmtime)


TAR = find_tar()
ARCH = 'arm64' if 'arm64' in os.path.basename(TAR) else 'x64'
for a in sys.argv[1:]:
    if a.startswith('--arch='):
        ARCH = a.split('=', 1)[1]

fails = []


def check(ok, msg):
    print('[%s] %s' % ('OK ' if ok else 'FAIL', msg))
    if not ok:
        fails.append(msg)


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(4 * 1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()


def magic(b):
    if b.startswith(b'\xcf\xfa\xed\xfe'): return 'Mach-O-64LE'
    if b[:4] == b'\xca\xfe\xba\xbe': return 'Mach-O-FAT'
    if b.startswith(b'\x7fELF'): return 'ELF-Linux'
    if b.startswith(b'MZ'): return 'PE-Windows'
    if b.startswith(b'#!'): return 'shebang'
    return '?' + b[:6].hex()


print('file   :', os.path.basename(TAR))
print('arch   : mac-' + ARCH)
sz = os.path.getsize(TAR)
print('size   : %d bytes (%.1f MB)' % (sz, sz / 1048576.0))
print('sha256 :', sha256(TAR))

tf = tarfile.open(TAR, 'r:gz')
names = tf.getnames()
nameset = set(names)
print('entries:', len(names))

EP = 'qqqide.app/Contents/Resources/app/'
C = 'qqqide.app/Contents/'


def first_bytes(name, n=8):
    try:
        with tf.extractfile(name) as f:
            return f.read(n)
    except Exception as e:
        return ('ERR:%s' % e).encode()


def count(prefix):
    return sum(1 for n in names if n.startswith(prefix))


# ── structure ──
check('qqqide.app' in {n.split('/')[0] for n in names}, 'top-level qqqide.app present')
check(count(EP + 'shell-out/') > 0 and (EP + 'shell-out/main.js') in nameset, 'shell-out/main.js present')
check((EP + 'shell-out/bootstrap.js') in nameset, 'shell-out/bootstrap.js present')
check(count(EP + 'webapp/') > 100, 'webapp bundled (%d entries)' % count(EP + 'webapp/'))
check((EP + 'engines/manifest.json') in nameset, 'engines/manifest.json present')

# ── node_modules runtime deps (shell-out require targets) ──
check((EP + 'node_modules/sql.js/package.json') in nameset, 'node_modules/sql.js bundled (shell hard dep)')
check((EP + 'node_modules/sql.js/dist/sql-wasm.js') in nameset, 'sql.js dist/sql-wasm.js present')
check((EP + 'node_modules/sql.js/dist/sql-wasm.wasm') in nameset, 'sql.js dist/sql-wasm.wasm present')
check(count(EP + 'node_modules/monaco-editor/min/') > 0, 'monaco-editor/min bundled')

# ── PySide2→PySide6 垫片 + mac 热键分支（2026-09-16）──
shim_sp = EP + 'engines/python/lib/python3.11/site-packages/'
check((shim_sp + '_qqq_pyside2_shim.py') in nameset, 'pyside2 shim module present')
check((shim_sp + '_qqq_pyside2_shim.pth') in nameset, 'pyside2 shim .pth present (auto-load)')
pb = EP + 'shell-out/py-broker.py'
if pb in nameset:
    pb_txt = tf.extractfile(pb).read().decode('utf-8', 'replace')
    check('_mac_squad_summon' in pb_txt and 'NSRunningApplication' in pb_txt,
          'py-broker.py carries mac summon branch')
else:
    check(False, 'shell-out/py-broker.py present')

# ── junk (must be zero) ──
check(count(EP + 'engines/__pycache__/') == 0, 'no engines/__pycache__')
check(count(EP + 'shell-out/__pycache__/') == 0, 'no shell-out/__pycache__')
check(not ((EP + 'engines/vc_runtime') in nameset or count(EP + 'engines/vc_runtime/') > 0),
      'no engines/vc_runtime (win-only)')

# ── key binaries: Mach-O + exec bit ──
bins = [
    ('Contents/MacOS/qqqide', 'qqqide.app/Contents/MacOS/qqqide'),
    ('engines/ghrun', EP + 'engines/ghrun'),
    ('engines/watchdog', EP + 'engines/watchdog'),
    ('engines/ripgrep/rg', EP + 'engines/ripgrep/rg'),
    ('engines/git/git', EP + 'engines/git/git'),
    ('engines/python/bin/python3.11', EP + 'engines/python/bin/python3.11'),
    ('engines/ffmpeg/darwin-%s/ffmpeg' % ARCH, EP + 'engines/ffmpeg/darwin-%s/ffmpeg' % ARCH),
]
for label, p in bins:
    if p not in nameset:
        check(False, label + ' present')
        continue
    m = tf.getmember(p)
    mg = magic(first_bytes(p))
    ok = m.isfile() and (mg.startswith('Mach-O')) and (m.mode & 0o111)
    check(ok, '%s: %s %dB mode=%o' % (label, mg, m.size, m.mode))

# ── symlinks ──
links = [(m.name, m.linkname) for m in tf.getmembers() if m.issym()]
check(len(links) >= 20, 'symlinks: %d (>=20)' % len(links))
bad = [b for a, b in links if '\\' in b]
check(len(bad) == 0, 'no backslash in link targets')

# ── plist contract ──
plist = tf.extractfile('qqqide.app/Contents/Info.plist').read().decode('utf-8', 'replace')
def plist_val(key):
    m = re.search(r'<key>%s</key>\s*<string>([^<]*)</string>' % key, plist)
    return m.group(1) if m else None

check(plist_val('CFBundleExecutable') == 'qqqide', 'plist Executable=qqqide (got %s)' % plist_val('CFBundleExecutable'))
check(plist_val('CFBundleIdentifier') == 'com.gh555.qqqide', 'plist Identifier=com.gh555.qqqide')
lsmin = plist_val('LSMinimumSystemVersion')
check(lsmin == ('11.0' if ARCH == 'arm64' else '10.13'), 'plist LSMinimum=%s (expect %s)' % (lsmin, '11.0' if ARCH == 'arm64' else '10.13'))
print('       CFBundleShortVersionString =', plist_val('CFBundleShortVersionString'))

# ── verdict ──
print('')
if fails:
    print('VERDICT: FAIL (%d issue(s))' % len(fails))
    for f in fails:
        print('  - ' + f)
    sys.exit(1)
print('VERDICT: PASS — all checks green')
sys.exit(0)
