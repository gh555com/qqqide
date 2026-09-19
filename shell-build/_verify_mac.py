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
#         pyobjc 完整链（objc/Cocoa/Quartz/CoreText/ApplicationServices）
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
QD = 'qqqide-data/'          # ★ mac 外置托管根（≈ Windows gh555.com：Data/ + engines/）


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
check('qqqide-data' in {n.split('/')[0] for n in names}, 'top-level qqqide-data present')
check(count(EP + 'shell-out/') > 0 and (EP + 'shell-out/main.js') in nameset, 'shell-out/main.js present')
check((EP + 'shell-out/bootstrap.js') in nameset, 'shell-out/bootstrap.js present')
check(count(EP + 'webapp/') > 100, 'webapp bundled (%d entries)' % count(EP + 'webapp/'))
check((QD + 'engines/manifest.json') in nameset, 'qqqide-data/engines/manifest.json present')

# ── mac 外置托管根（2026-09-16）：engines 出 bundle + 相对 symlink 桥接 ──
linkmap = {m.name: m.linkname for m in tf.getmembers() if m.issym()}
eng_link = linkmap.get(EP + 'engines')
check(eng_link == '../../../../qqqide-data/engines',
      'engines symlink -> ../../../../qqqide-data/engines (got %s)' % eng_link)
check((QD + 'engines/python/bin/python3.11') in nameset, 'external engines python tree present')
check(str(ARCH) in ('arm64', 'x64'), 'arch flag sane (%s)' % ARCH)
check(count('qqqide.app/Contents/MacOS/Data') == 0, 'no Data inside .app bundle (sig seal safe)')
check((QD + 'Data/alphal/factory_version') in nameset, 'qqqide-data/Data/alphal/factory_version present')

# ── mac 一键启动脚本（去隔离 + 自签名 + 启动）──
if '\u9996\u6b21\u542f\u52a8.command' in nameset:
    cmd_txt = tf.extractfile('\u9996\u6b21\u542f\u52a8.command').read().decode('utf-8', 'replace')
    check('codesign' in cmd_txt and 'xattr -dr com.apple.quarantine' in cmd_txt,
          'launcher .command: codesign + dequarantine present')
else:
    check(False, 'launcher .command present')
check('README-\u4f7f\u7528\u8bf4\u660e.txt' in nameset, 'README present')

# ── mac 自定义图标（2026-09-19）: 默认 Electron 图标必须已替换 ──
icns_p = 'qqqide.app/Contents/Resources/electron.icns'
if icns_p in nameset:
    _im = tf.getmember(icns_p)
    _ih = first_bytes(icns_p, 4)
    check(_im.size > 300000 and _ih == b'icns', 'mac: custom icns applied (%dB)' % _im.size)
else:
    check(False, 'mac: electron.icns present')
check((C + 'Resources/qqqide.icns') in nameset, 'mac: qqqide.icns present')

# ── node_modules runtime deps (shell-out require targets) ──
check((EP + 'node_modules/sql.js/package.json') in nameset, 'node_modules/sql.js bundled (shell hard dep)')
check((EP + 'node_modules/sql.js/dist/sql-wasm.js') in nameset, 'sql.js dist/sql-wasm.js present')
check((EP + 'node_modules/sql.js/dist/sql-wasm.wasm') in nameset, 'sql.js dist/sql-wasm.wasm present')
check(count(EP + 'node_modules/monaco-editor/min/') > 0, 'monaco-editor/min bundled')

# ── PySide2→PySide6 垫片 + mac 热键分支（2026-09-16）──
shim_sp = QD + 'engines/python/lib/python3.11/site-packages/'
check((shim_sp + '_qqq_pyside2_shim.py') in nameset, 'pyside2 shim module present')
check((shim_sp + '_qqq_pyside2_shim.pth') in nameset, 'pyside2 shim .pth present (auto-load)')

# ── pyobjc 完整链（window-there AX 功能 + ApplicationServices 伞形包）──
check((shim_sp + 'objc/_objc.cpython-311-darwin.so') in nameset, 'pyobjc-core (objc) present')
check((shim_sp + 'Cocoa/__init__.py') in nameset, 'pyobjc Cocoa present')
check((shim_sp + 'Quartz/__init__.py') in nameset, 'pyobjc Quartz present')
check((shim_sp + 'CoreText/__init__.py') in nameset and
      (shim_sp + 'CoreText/_manual.cpython-311-darwin.so') in nameset,
      'pyobjc CoreText present (ApplicationServices hard dep)')
check((shim_sp + 'ApplicationServices/__init__.py') in nameset, 'pyobjc ApplicationServices present')

# ── window-there macOS AX 链（3W/3X 修复：正确 API 面 + 无坏常量）──
gpf = EP + 'webapp/goods/window-there/ge_2_platform.py'
if gpf in nameset:
    gpf_txt = tf.extractfile(gpf).read().decode('utf-8', 'replace')
    check('AXUIElementCopyElementAtPosition' in gpf_txt and 'AXUIElementGetPid' in gpf_txt,
          'window-there: AX system-wide + GetPid path present')
    check(('kAXWindowPositionAttribute' not in gpf_txt) and ('kAXPIDAttribute' not in gpf_txt),
          'window-there: no invalid AX constants')
else:
    check(False, 'webapp/goods/window-there/ge_2_platform.py present')
pb = EP + 'shell-out/py-broker.py'
if pb in nameset:
    pb_txt = tf.extractfile(pb).read().decode('utf-8', 'replace')
    check('_mac_squad_summon' in pb_txt and 'NSRunningApplication' in pb_txt,
          'py-broker.py carries mac summon branch')
    check('_mac_mem_snapshot' in pb_txt and 'proc_pid_rusage' in pb_txt,
          'py-broker.py: mac mem snapshot present')
else:
    check(False, 'shell-out/py-broker.py present')

# ── mac 三项修复回归断言（2026-09-16：3X 选择器可见性 / Roam 图标 / 内存快照）──
gui = EP + 'webapp/goods/window-there/ge_2_ui.py'
if gui in nameset:
    gui_txt = tf.extractfile(gui).read().decode('utf-8', 'replace')
    check('WA_MacAlwaysShowToolWindow' in gui_txt, 'window-there: selector MacAlwaysShowToolWindow present')
    check('activateIgnoringOtherApps' in gui_txt, 'window-there: selector NSApp activate present')
    check("== 'darwin'" in gui_txt, 'window-there: check_focus darwin branch present')
else:
    check(False, 'webapp/goods/window-there/ge_2_ui.py present')
roamjs = EP + 'webapp/goods/file-explorer/q2-roam.js'
if roamjs in nameset:
    roam_txt = tf.extractfile(roamjs).read().decode('utf-8', 'replace')
    check('\U0001F4C4' in roam_txt and '\U0001F5C8' not in roam_txt,
          'roam: file icon glyph renderable on mac (no tofu)')
else:
    check(False, 'webapp/goods/file-explorer/q2-roam.js present')
# ── roam 'd' 键 → 系统回收站（2026-09-19）：webapp 能力探测 + 壳层 trash IPC ──
if roamjs in nameset:
    check('fs.trashItem' in roam_txt and '_roamShellHasTrash' in roam_txt,
          "roam: 'd' key -> system trash wired (fs.trashItem + capability probe)")
_tr_mj = EP + 'shell-out/main.js'
_tr_pre = EP + 'shell-out/preload.js'
if _tr_mj in nameset and _tr_pre in nameset:
    check('qqqide:fs:trash' in tf.extractfile(_tr_mj).read().decode('utf-8', 'replace'),
          'shell: roam trash IPC (qqqide:fs:trash) present')
    check('trashItem' in tf.extractfile(_tr_pre).read().decode('utf-8', 'replace'),
          'shell: preload trashItem exposed')

# ── 批次 B 回归断言（2026-09-16：OS 目录 mac 化 / kmd zsh / 剪贴板 / qmd 守卫）──
mj = EP + 'shell-out/main.js'
if mj in nameset:
    mj_txt = tf.extractfile(mj).read().decode('utf-8', 'replace')
    check('Application Support' in mj_txt, 'shell: getOsBaseDir mac path (Library/Application Support)')
    check('/bin/zsh' in mj_txt, 'shell: kmd zsh resolver present')
    check('mac-pasteboard.py' in mj_txt, 'shell: mac clipboard helper wired')
    # mac 应用内更新机制 v0（2026-09-18）
    check('qqqide:update:mac-state' in mj_txt, 'shell: mac updater IPC wired')
    check('apply-update.sh' in mj_txt, 'shell: mac updater helper script present')
    check('qqqide-app-prev' in mj_txt, 'shell: mac updater rollback point present')
    # mac 应用内更新 v1（2026-09-19 退出即换 + 无头探针）
    check('maybeAutoApplyOnQuit' in mj_txt, 'shell: mac updater v1: quit-apply wired')
    check('--update-probe' in mj_txt and 'probe-result' in mj_txt, 'shell: mac updater v1: quiet probe wired')
    check('MODE="${2:-restart}"' in mj_txt, 'shell: mac updater v1: helper MODE arg present')
    # mac 应用内更新 v2（2026-09-19 增量下载: 单元状态 / 增量装配 / 回退全量）
    check('units.pending.json' in mj_txt, 'shell: mac updater v2: units pending state present')
    check('incremental begin' in mj_txt, 'shell: mac updater v2: incremental download wired')
    check('units state healed' in mj_txt, 'shell: mac updater v2: units state self-heal wired')
else:
    check(False, 'shell-out/main.js present')
check((EP + 'webapp/core/update-machine.js') in nameset, 'webapp: update-machine.js present (mac update UI)')
swf = EP + 'webapp/service-worker.js'
if swf in nameset:
    sw_txt = tf.extractfile(swf).read().decode('utf-8', 'replace')
    check('core/update-machine.js' in sw_txt, 'webapp: update-machine.js precached')
check((EP + 'shell-out/mac-pasteboard.py') in nameset, 'shell-out/mac-pasteboard.py present')
check((EP + 'shell-out/py-broker.py') in nameset, 'shell-out/py-broker.py present (batch B)')
kmdhtml = EP + 'webapp/goods/kmd/kmd-ui.html'
if kmdhtml in nameset:
    kh = tf.extractfile(kmdhtml).read().decode('utf-8', 'replace')
    check('data-shell="zsh"' in kh and 'data-shell="bash"' in kh, 'kmd-ui: zsh/bash tabs present')
    check("_isMac" in kh, 'kmd-ui: platform switch present')
else:
    check(False, 'webapp/goods/kmd/kmd-ui.html present')
qmdjs = EP + 'webapp/goods/qmd/qmd.js'
if qmdjs in nameset:
    qj = tf.extractfile(qmdjs).read().decode('utf-8', 'replace')
    check('_isMac' in qj and 'ConPTY' in qj, 'qmd: mac skip guard present')
else:
    check(False, 'webapp/goods/qmd/qmd.js present')

# ── VIG 履历链 + ghrun mac 兜底（2026-09-19: winthere 埋点 / squad 计数 / ghrun 定位）──
if mj in nameset:
    check('winthereExternal' in mj_txt, 'shell: vig winthereExternal (window-there stats readback)')
    check('vigSquadSummon' in mj_txt, 'shell: vig squad-summon counting wired')
    _gi = mj_txt.find('resolveGhrunBin')
    check(_gi >= 0 and 'getAppPath' in mj_txt[_gi:_gi + 1600],
          'shell: ghrun mac fallback (app.getAppPath in resolver)')
wts = EP + 'webapp/goods/window-there/window_there_store.py'
if wts in nameset:
    wt_txt = tf.extractfile(wts).read().decode('utf-8', 'replace')
    check("'stats.json'" in wt_txt and 'bump_stat' in wt_txt, 'window-there: VIG stats.json writer present')
    check("'Application Support'" in wt_txt, 'window-there: mac OS dir branch in store')
else:
    check(False, 'webapp/goods/window-there/window_there_store.py present')
if gui in nameset:
    check('bump_stat' in gui_txt, 'window-there: restore counting wired (ge_2_ui)')

# ── junk (must be zero) ──
check(count(QD + 'engines/__pycache__/') == 0, 'no engines/__pycache__')
check(count(EP + 'shell-out/__pycache__/') == 0, 'no shell-out/__pycache__')
check(sum(1 for n in names if n.startswith(EP + 'webapp/') and '__pycache__' in n) == 0,
      'no webapp __pycache__ (goods pyc leak)')
check((EP + 'webapp/_fix_html.js') not in nameset, 'no webapp root dev scripts (_fix_html.js)')

# webapp 根级文件开发路径泄漏扫描（脚本类残留自证：内嵌 dev 机路径）
_bad_leak = []
for _n in names:
    if not _n.startswith(EP + 'webapp/') or _n.count('/') != EP.count('/') + 1:
        continue
    try:
        _m = tf.getmember(_n)
        if not _m.isfile() or _m.size > 400000:
            continue
        _raw = tf.extractfile(_m).read()
    except Exception:
        continue
    if b'wol/py/qqq-shell-v2' in _raw or b'wol\\py\\qqq-shell-v2' in _raw:
        _bad_leak.append(_n)
check(len(_bad_leak) == 0, 'no dev-path leak in webapp root files' + (' -> ' + ', '.join(_bad_leak) if _bad_leak else ''))
check(not ((QD + 'engines/vc_runtime') in nameset or count(QD + 'engines/vc_runtime/') > 0),
      'no engines/vc_runtime (win-only)')

# ── key binaries: Mach-O + exec bit ──
bins = [
    ('Contents/MacOS/qqqide', 'qqqide.app/Contents/MacOS/qqqide'),
    ('engines/ghrun', QD + 'engines/ghrun'),
    ('engines/watchdog', QD + 'engines/watchdog'),
    ('engines/ripgrep/rg', QD + 'engines/ripgrep/rg'),
    ('engines/git/git', QD + 'engines/git/git'),
    ('engines/python/bin/python3.11', QD + 'engines/python/bin/python3.11'),
    ('engines/ffmpeg/darwin-%s/ffmpeg' % ARCH, QD + 'engines/ffmpeg/darwin-%s/ffmpeg' % ARCH),
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
