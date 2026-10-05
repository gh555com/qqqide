# -*- coding: utf-8 -*-
# ============================================================================
# _verify_linux.py — linux 产物质检（每次 pack:linux-* 后复用）
#
# usage: python shell-build/_verify_linux.py [tar.gz path]
#   省略路径 → 自动取 dist-pack/qqqide-linux-*.tar.gz 中最新修改的一个
# exit: 0 = PASS / 1 = FAIL（打印全部问题清单）
#
# 检查项：sha256 指纹 / 单文件夹容器（qqqide/）/ 顶层结构 / ELF 架构（x86-64 全检）
#         外置托管根符号链接（engines -> ../../qqqide-data/engines）/ 关键二进制
#         启动脚本（沙箱修复链）/ desktop/README/图标 / 残留（pycache·vc_runtime·win 二进制）
#         factory_version（发布闸门一致性）
# ============================================================================
import hashlib
import os
import struct
import sys
import tarfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist-pack')


def find_tar():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if args:
        return args[0]
    cands = [os.path.join(DIST, f) for f in os.listdir(DIST)
             if f.startswith('qqqide-linux-') and f.endswith('.tar.gz')]
    if not cands:
        raise SystemExit('no linux tar found in dist-pack')
    return max(cands, key=os.path.getmtime)


TAR = find_tar()
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


print('file   :', os.path.basename(TAR))
sz = os.path.getsize(TAR)
print('size   : %d bytes (%.1f MB)' % (sz, sz / 1048576.0))
print('sha256 :', sha256(TAR))

tf_raw = tarfile.open(TAR, 'r:gz')
raw_names = tf_raw.getnames()
raw_tops = {n.split('/')[0] for n in raw_names}
CONTAINER = 'qqqide/'
CONTAINER_OK = (raw_tops == {'qqqide'})
PREFIX = CONTAINER if CONTAINER_OK else ''


def _s(n):
    return n[len(PREFIX):] if (PREFIX and n.startswith(PREFIX)) else n


names = [_s(n) for n in raw_names if _s(n)]
nameset = set(names)
print('entries:', len(names))


class _TfView:
    """容器剥离视图：对外以剥壳名工作，getmember/extractfile 自动映射回真实名。"""

    def __init__(self, tf, prefix):
        self._tf = tf
        self._p = prefix

    def _real(self, name):
        return (self._p + name) if self._p else name

    def getmember(self, name):
        return self._tf.getmember(self._real(name))

    def extractfile(self, name, *a):
        if isinstance(name, str):
            name = self._real(name)
        return self._tf.extractfile(name, *a)


tf = _TfView(tf_raw, PREFIX)

# ── 单文件夹容器断言（第一条）──
check(CONTAINER_OK, 'single-folder container: all entries under qqqide/ (tops=%s)' % sorted(raw_tops)[:6])

EP = 'resources/app/'
QD = 'qqqide-data/'


def first_bytes(name, n=8):
    try:
        with tf.extractfile(name) as f:
            return f.read(n)
    except Exception as e:
        return ('ERR:%s' % e).encode()


def count(prefix):
    return sum(1 for n in names if n.startswith(prefix))


def elf_arch(name):
    """返回 (is_elf, arch_str)。x86-64 LE → 'x86-64'。"""
    b = first_bytes(name, 20)
    if len(b) < 20 or b[:4] != b'\x7fELF':
        return False, 'not-elf'
    m = struct.unpack('<H', b[18:20])[0]
    return True, {0x3e: 'x86-64', 0xb7: 'aarch64'}.get(m, '0x%x' % m)


# ── structure ──
check('qqqide' in nameset, 'top-level qqqide binary present')
check(count(EP + 'shell-out/') > 0, 'resources/app/shell-out present')
check((EP + 'shell-out/main.js') in nameset, 'shell-out/main.js present')
check(count(EP + 'webapp/') > 100, 'webapp bundled (%d entries)' % count(EP + 'webapp/'))
check((QD + 'engines/manifest.json') in nameset, 'qqqide-data/engines/manifest.json present')

# ── linux 外置托管根：engines 出程序目录 + 相对 symlink 桥接 ──
linkmap = {_s(m.name): m.linkname for m in tf_raw.getmembers() if m.issym()}
eng_link = linkmap.get(EP + 'engines')
check(eng_link == '../../qqqide-data/engines',
      'engines symlink -> ../../qqqide-data/engines (got %s)' % eng_link)
check((QD + 'engines/python/bin/python3.11') in nameset, 'external engines python tree present')

# ── ELF 架构全检（x86-64）──
for label, rel in (
        ('main binary', 'qqqide'),
        ('chrome-sandbox', 'chrome-sandbox'),
        ('python', QD + 'engines/python/bin/python3.11'),
        ('ghrun', QD + 'engines/ghrun'),
        ('watchdog', QD + 'engines/watchdog'),
        ('ripgrep', QD + 'engines/ripgrep/rg'),
        ('git', QD + 'engines/git/git'),
):
    is_elf, arch = elf_arch(rel)
    check(is_elf and arch == 'x86-64', '%s: ELF x86-64 (got %s/%s)' % (label, 'elf' if is_elf else '?', arch))

# ── 可执行位（tar mode 断言）──
for label, rel in (('qqqide', 'qqqide'), ('chrome-sandbox', 'chrome-sandbox')):
    try:
        mode = tf.getmember(rel).mode
        check(bool(mode & 0o111), '%s executable bit (%o)' % (label, mode))
    except Exception as e:
        check(False, '%s executable bit (%s)' % (label, e))

# ── 启动脚本（沙箱修复链）/ desktop / README / 图标 ──
if '\u9996\u6b21\u542f\u52a8.sh' in nameset:
    sh_txt = tf.extractfile('\u9996\u6b21\u542f\u52a8.sh').read().decode('utf-8', 'replace')
    check('chrome-sandbox' in sh_txt and 'chmod 4755' in sh_txt and '--no-sandbox' in sh_txt,
          'launcher sh: sandbox fix chain (setuid + userns + fallback) present')
    check('\u5b89\u88c5\u8f93\u5165\u6743\u9650.sh' in sh_txt, 'launcher sh: input-permission step wired')
else:
    check(False, 'launcher sh present')
check('\u5b89\u88c5\u684c\u9762\u56fe\u6807.sh' in nameset, 'desktop-install sh present')

try:
    _first_txt = tf.extractfile('\u9996\u6b21\u542f\u52a8.sh').read().decode('utf-8', 'replace') if '\u9996\u6b21\u542f\u52a8.sh' in nameset else ''
except Exception:
    _first_txt = ''
check('\u5b89\u88c5\u8f93\u5165\u6743\u9650.sh' in nameset and '\u5b89\u88c5\u8f93\u5165\u6743\u9650.sh' in _first_txt,
      'input-permission sh present + wired into first-run (udev uaccess)')

# ── 全局热键链（evdev 内核级按键源 —— Wayland 会话下 X11 监听对 Wayland 原生窗口失聪）──
check((EP + 'shell-out/qqqide_evdev.py') in nameset, 'shell-out/qqqide_evdev.py present')
try:
    _brk = tf.extractfile(EP + 'shell-out/py-broker.py').read().decode('utf-8', 'replace')
    check('qqqide_evdev' in _brk and 'evdev' in _brk, 'py-broker: evdev key source wired (X11 fallback kept)')
except Exception as e:
    check(False, 'py-broker readable (%s)' % e)

try:
    _q3 = tf.extractfile(EP + 'webapp/goods/window-there/q3.py').read().decode('utf-8', 'replace')
    check('qqqide_evdev' in _q3, 'window-there: evdev key source wired')
except Exception as e:
    check(False, 'window-there readable (%s)' % e)
check((EP + 'webapp/goods/window-there/qqqide_evdev.py') in nameset, 'window-there/qqqide_evdev.py present')

# ── VIG 遥测链 + goods OS 级根三分支对齐（缺 linux 分支 = 数据分裂/遥测读空）──
_mj = EP + 'shell-out/main.js'
if _mj in nameset:
    _mj_txt = tf.extractfile(_mj).read().decode('utf-8', 'replace')
    check('XDG_DATA_HOME' in _mj_txt, 'shell: getOsBaseDir linux path (XDG_DATA_HOME)')
    check('winthereExternal' in _mj_txt, 'shell: vig winthereExternal (window-there stats readback)')
    check('vigSquadSummon' in _mj_txt, 'shell: vig squad-summon counting wired')
    _gi = _mj_txt.find('resolveGhrunBin')
    check(_gi >= 0 and 'getAppPath' in _mj_txt[_gi:_gi + 1600],
          'shell: ghrun linux fallback (app.getAppPath in resolver)')
    check('migrateLegacyOsDirs' in _mj_txt, 'shell: legacy OS-dir migration (mac/linux) present')
else:
    check(False, 'shell-out/main.js present')
for _vlab, _vrel in (
        ('window-there store', EP + 'webapp/goods/window-there/window_there_store.py'),
        ('kope store', EP + 'webapp/goods/kope-a/kope_store.py'),
        ('kope settings', EP + 'webapp/goods/kope-a/q3.py')):
    if _vrel in nameset:
        _vtxt = tf.extractfile(_vrel).read().decode('utf-8', 'replace')
        check('XDG_DATA_HOME' in _vtxt and '.local' in _vtxt,
              _vlab + ': linux OS-dir branch present (XDG, aligns shell getOsBaseDir)')
    else:
        check(False, _vlab + ' present (%s)' % _vrel)
check('qqqide.desktop' in nameset, 'qqqide.desktop present')
check('README-\u4f7f\u7528\u8bf4\u660e.txt' in nameset, 'README present')
check('qqqide.png' in nameset, 'qqqide.png icon present')

# ── 残留断言（防跨平台垃圾）──
check(count(QD + 'engines/vc_runtime') == 0, 'no vc_runtime (win-only)')
check((QD + 'engines/python/python.exe') not in nameset, 'no win python.exe')
check((QD + 'engines/ghrun.exe') not in nameset, 'no win ghrun.exe')
check((QD + 'engines/watchdog.exe') not in nameset, 'no win watchdog.exe')
check(count(QD + 'engines/ripgrep/rg-mac') == 0 and (QD + 'engines/ripgrep/rg.exe') not in nameset,
      'no cross-platform ripgrep leftovers')
check(count(QD + 'engines/ci/') == 0, 'no engines/ci build sources')
# python-build-standalone 自带 encodings 等启动加速 pyc（cpython-311、合法）——仅放行
# qqqide-data/engines/python/ 树内；其余任何位置（webapp/shell-out/其他引擎）出现即判污染。
pyc_bad = [n for n in names if '__pycache__' in n and not n.startswith(QD + 'engines/python/')]
check(len(pyc_bad) == 0, 'no stray __pycache__ (%d found)' % len(pyc_bad))
foreign = [n for n in names if 'cpython-38' in n or 'cpython-310' in n]
check(len(foreign) == 0, 'no foreign-version pyc (%d found)' % len(foreign))

# ── factory_version（发布闸门会再比对源码版本）──
fv = None
try:
    fv = tf.extractfile(QD + 'Data/alphal/factory_version').read().decode('utf-8', 'replace').strip()
except Exception:
    pass
check(bool(fv), 'factory_version present (%s)' % fv)

# ── 总结 ──
print()
print('=' * 60)
if fails:
    print('RESULT: FAIL (%d issue(s))' % len(fails))
    for f in fails:
        print('  -', f)
    sys.exit(1)
print('RESULT: PASS — linux package verified')
sys.exit(0)
