# -*- coding: utf-8 -*-
# ============================================================================
# build-mac-cross.py — cross-build mac (arm64) engine artifacts on a Windows host
#
# Outputs (dist-pack/, arch = arm64 默认 | x64 via --arch=x64):
#   cross/python-darwin-{arch}/  unpacked component tree (=> engines/python layout)
#   python-darwin-{arch}.zip     CDN-bound rank0 artifact (component recovery)
#   cross/git-darwin-{arch}/     unpacked git component (mac build; universal 制品物化两份)
#
# Sources (verified 2026-09-14):
#   python-build-standalone cpython-3.11.16+20260901 aarch64 install_only_stripped
#     sha256 768f05cf200273bbdda9a5955a5a6892a4b22f2a0b1e4b0a9160f5c7fce86816
#   mac git     https://cdn.gh555.com/u/01KK1SAAR5B53SJXGNVQWP5EB6/MXAAZ7SOOPX32.gz
#   linux git   https://cdn.gh555.com/u/01KK1SAAR5B53SJXGNVQWP5EB6/WWJCJGF4LJWUS.gz
#
# usage: python shell-build/build-mac-cross.py [python|git|all] [--arch=arm64|x64]
# ============================================================================
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tarfile
import urllib.request
import zipfile

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist-pack')
CROSS = os.path.join(DIST, 'cross')
DL = os.path.join(CROSS, '_dl')

# Python 3.11：3.8 分支在 arm64 上无 cffi 轮子（cffi cp38 mac 只有 x86_64）
# → miniaudio 不可用；3.11 = cffi/miniaudio/pyobjc 全有 arm64 原生轮子，
#   PySide6 6.6.3.1 是 cp38-abi3（≥3.8 全兼容），支持线到 2027。
# ★ --arch=arm64|x64（默认 arm64；2026-09-14 增补 x64 —— Mac 虚拟机 / Intel 测试）
ARCH = 'x64' if '--arch=x64' in sys.argv else 'arm64'
PBS_TABLE = {
    'arm64': (
        'https://github.com/astral-sh/python-build-standalone/releases/download/'
        '20260901/cpython-3.11.16%2B20260901-aarch64-apple-darwin-install_only_stripped.tar.gz',
        # 2026-09-14 官方 SHA256SUMS 校验
        '768f05cf200273bbdda9a5955a5a6892a4b22f2a0b1e4b0a9160f5c7fce86816'),
    'x64': (
        'https://github.com/astral-sh/python-build-standalone/releases/download/'
        '20260901/cpython-3.11.16%2B20260901-x86_64-apple-darwin-install_only_stripped.tar.gz',
        # 2026-09-14 官方 SHA256SUMS 校验
        '908b381433f78b832c8d64960ced0f85871893cc8779f413f963e0c9e293c258'),
}
PBS_URL, PBS_SHA = PBS_TABLE[ARCH]
PBS_PY_SERIES = '3.11'
PBS_SOURCES = [
    'https://ghproxy.net/' + PBS_URL,
    'https://gh-proxy.com/' + PBS_URL,
    PBS_URL,
]
GIT_MAC_URL = 'https://cdn.gh555.com/u/01KK1SAAR5B53SJXGNVQWP5EB6/MXAAZ7SOOPX32.gz'
GIT_LINUX_URL = 'https://cdn.gh555.com/u/01KK1SAAR5B53SJXGNVQWP5EB6/WWJCJGF4LJWUS.gz'

MACHO_MAGICS = (b'\xcf\xfa\xed\xfe', b'\xce\xfa\xed\xfe', b'\xca\xfe\xba\xbe')
ELF_MAGIC = b'\x7fELF'


def log(*a):
    print(*a, flush=True)


def http_get(url, dest):
    log('[dl]', url)
    req = urllib.request.Request(url, headers={'User-Agent': 'qqqide-cross-build/1.0'})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, 'wb') as f:
        total = int(r.headers.get('Content-Length') or 0)
        got = 0
        last = 0
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)
            got += len(b)
            if got - last > 8 * 1024 * 1024:
                last = got
                log('     %.1f MB%s' % (got / 1048576.0,
                    (' / %.1f MB' % (total / 1048576.0)) if total else ''))
    log('[dl] done %d bytes' % os.path.getsize(dest))


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def extract_tar_gz(path, dest):
    """symlink/hardlink-aware tar.gz extraction (works on Windows w/ symlink priv)."""
    os.makedirs(dest, exist_ok=True)
    links = []   # (name, linkname, is_hard)
    with tarfile.open(path, 'r:gz') as tf:
        for m in tf.getmembers():
            target = os.path.join(dest, *m.name.split('/'))
            if m.isdir():
                os.makedirs(target, exist_ok=True)
                continue
            if m.issym():
                links.append((m.name, m.linkname, False))
                continue
            if m.islnk():
                links.append((m.name, m.linkname, True))
                continue
            parent = os.path.dirname(target)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with tf.extractfile(m) as src, open(target, 'wb') as dst:
                shutil.copyfileobj(src, dst, 1 << 20)
            try:
                os.chmod(target, m.mode & 0o777)
            except OSError:
                pass
    made = 0
    failed = 0
    for _ in range(4):
        pending = []
        for name, linkname, is_hard in links:
            target = os.path.join(dest, *name.split('/'))
            if os.path.lexists(target):
                continue
            parent = os.path.dirname(target)
            if is_hard:
                resolved = os.path.normpath(os.path.join(dest, *linkname.split('/')))
            else:
                resolved = os.path.normpath(os.path.join(parent, *linkname.split('/')))
            created = False
            if os.path.isfile(resolved):
                try:
                    if is_hard:
                        shutil.copy2(resolved, target)
                    else:
                        os.symlink(linkname, target)
                    created = True
                except OSError:
                    try:
                        shutil.copy2(resolved, target)
                        created = True
                    except Exception:
                        pass
            elif os.path.isdir(resolved) and not is_hard:
                try:
                    os.symlink(linkname, target, target_is_directory=True)
                    created = True
                except OSError:
                    pass
            if created:
                made += 1
            else:
                pending.append((name, linkname, is_hard))
        links = pending
        if not links:
            break
    failed = len(links)
    log('[tar-x] links created=%d failed=%d (%s)' % (made, failed, os.path.basename(path)))
    return made, failed


def dir_size(p):
    total = 0
    for root, dirs, files in os.walk(p):
        for f in files:
            fp = os.path.join(root, f)
            try:
                total += os.path.getsize(fp)
            except OSError:
                pass
    return total


def pip_cross_install(target_sp, pkgs, tag):
    plats = (['macosx_11_0_arm64', 'macosx_11_0_universal2'] if ARCH == 'arm64'
             else ['macosx_11_0_x86_64', 'macosx_10_9_x86_64', 'macosx_11_0_universal2'])
    cmd = [sys.executable, '-m', 'pip', 'install', '--target', target_sp]
    for _pl in plats:
        cmd += ['--platform', _pl]
    cmd += ['--python-version', PBS_PY_SERIES, '--implementation', 'cp',
            '--only-binary=:all:', '--no-deps', '--no-compile', '--upgrade',
            '--no-warn-script-location'] + pkgs
    log('[pip:%s]' % tag, ' '.join(pkgs))
    r = subprocess.run(cmd)
    if r.returncode != 0:
        raise RuntimeError('pip failed for %s' % tag)


def slim_tree(sp):
    """PySide6 slim: remove tool .app bundles + QML plugins + Qt translations +
    host-version __pycache__. goods uses only QtCore/QtGui/QtWidgets (pure
    widgets — no QML, no Designer, no Qt l10n; app UI text is our own i18n)."""
    p6 = os.path.join(sp, 'PySide6')
    saved = 0
    for junk in (os.path.join(p6, 'Assistant.app'), os.path.join(p6, 'Designer.app'),
                 os.path.join(p6, 'Linguist.app'),
                 os.path.join(p6, 'Qt', 'qml'), os.path.join(p6, 'Qt', 'translations')):
        if os.path.exists(junk):
            saved += dir_size(junk)
            shutil.rmtree(junk, ignore_errors=True)
    # host-python pyc pollution (cross-install may compile with the host 3.8)
    for root, dirs, files in os.walk(sp):
        for d in list(dirs):
            if d == '__pycache__':
                full = os.path.join(root, d)
                saved += dir_size(full)
                shutil.rmtree(full, ignore_errors=True)
                dirs.remove(d)
    log('[slim] removed %.1f MB (apps/qml/translations/pycache)' % (saved / 1048576.0))


def _fix_shebang_and_junk(tree):
    # pip --target on a win host may drop win-scheme launchers; strip them and
    # rewrite shebangs of generated scripts.
    for junk in ('Scripts',):
        p = os.path.join(tree, junk)
        if os.path.exists(p):
            shutil.rmtree(p, ignore_errors=True)
            log('[clean] removed stray %s/' % junk)
    bin_dir = os.path.join(tree, 'bin')
    if os.path.isdir(bin_dir):
        for f in os.listdir(bin_dir):
            fp = os.path.join(bin_dir, f)
            if not os.path.isfile(fp):
                continue
            try:
                with open(fp, 'rb') as fh:
                    head = fh.read(120)
                if head.startswith(b'#!') and b'python.exe' in head.lower():
                    with open(fp, 'r', encoding='utf-8', errors='replace') as fh:
                        lines = fh.readlines()
                    lines[0] = '#!/usr/bin/env python3\n'
                    with open(fp, 'w', encoding='utf-8', newline='\n') as fh:
                        fh.writelines(lines)
                    log('[clean] shebang fixed: bin/%s' % f)
                elif head.startswith(b'MZ'):
                    os.remove(fp)
                    log('[clean] removed win launcher: bin/%s' % f)
            except Exception:
                pass


def zip_tree(src, out):
    if os.path.exists(out):
        os.remove(out)
    count = 0
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as z:
        for root, dirs, files in os.walk(src):
            # symlinked dirs are listed in dirs but not walked — materialize them
            for d in list(dirs):
                fp = os.path.join(root, d)
                if os.path.islink(fp):
                    real = os.path.realpath(fp)
                    arc_d = os.path.relpath(fp, src).replace(os.sep, '/')
                    for r2, d2, f2 in os.walk(real):
                        for ff in f2:
                            fpp = os.path.join(r2, ff)
                            arc2 = arc_d + '/' + os.path.relpath(fpp, real).replace(os.sep, '/')
                            z.write(fpp, arc2)
                            count += 1
                    dirs.remove(d)
            for f in files:
                fp = os.path.join(root, f)
                arc = os.path.relpath(fp, src).replace(os.sep, '/')
                z.write(fp, arc)
                count += 1
    log('[zip] %s (%d entries, %.1f MB)' % (os.path.basename(out), count, os.path.getsize(out) / 1048576.0))


def build_python():
    os.makedirs(DL, exist_ok=True)
    dl = os.path.join(DL, 'cpython-3.11.16-darwin-%s.tar.gz' % ARCH)
    if not (os.path.exists(dl) and sha256_file(dl) == PBS_SHA):
        ok = False
        for u in PBS_SOURCES:
            try:
                http_get(u, dl)
                if sha256_file(dl) == PBS_SHA:
                    ok = True
                    break
                log('[!] sha256 mismatch from', u)
                os.remove(dl)
            except Exception as e:
                log('[!] download failed: %s (%s)' % (u, e))
        if not ok:
            raise SystemExit('pb-s download failed from all sources')
    log('[ok] pb-s sha256 verified')

    out_dir = os.path.join(CROSS, 'python-darwin-%s' % ARCH)
    tmp_x = os.path.join(CROSS, '_x_python')
    shutil.rmtree(tmp_x, ignore_errors=True)
    extract_tar_gz(dl, tmp_x)
    inner = os.path.join(tmp_x, 'python')
    if not os.path.isdir(inner):
        inner = tmp_x
    shutil.rmtree(out_dir, ignore_errors=True)
    shutil.copytree(inner, out_dir, symlinks=True)
    shutil.rmtree(tmp_x, ignore_errors=True)
    log('[py] reparented tree ->', out_dir)

    sp = os.path.join(out_dir, 'lib', 'python' + PBS_PY_SERIES, 'site-packages')
    os.makedirs(sp, exist_ok=True)

    # ★ 显式清单 + --no-deps：绕开跨平台解析器（依赖树已全部手工列齐；实测
    #   resolver 对带依赖链的包会失败：cffi 依赖/版本探测等）。
    # ★ pip/setuptools 不装：pb-s 自带（较新），避免 overlay 半混合状态。
    # ★ PySide6-Addons 不装：goods 仅用 QtCore/QtGui/QtWidgets（纯 widgets，
    #   零 QML/零 WebEngine/零 Charts）——Addons 是最大的一块肥肉（~450MB）。
    wheels = [
        'wheel==0.45.1',
        'six==1.17.0',
        'pynput==1.8.2',
        'miniaudio==1.61',
        'cffi==1.17.1', 'pycparser==2.22',
        'PySide6==6.6.3.1', 'shiboken6==6.6.3.1', 'PySide6-Essentials==6.6.3.1',
        'pyobjc-core==10.3.2',
        'pyobjc-framework-Cocoa==10.3.2',
        'pyobjc-framework-Quartz==10.3.2',
        'pyobjc-framework-ApplicationServices==10.3.2',
    ]
    pip_cross_install(sp, wheels, 'core')
    mini_used = '1.61'

    with open(os.path.join(sp, 'sitecustomize.py'), 'w', encoding='utf-8', newline='\n') as f:
        f.write('# Auto-generated: green pack self-containment (macOS ' + ARCH + ')\n'
                'import site\n'
                'site.ENABLE_USER_SITE = False\n')

    with open(os.path.join(out_dir, 'requirements-frozen-mac.txt'), 'w', encoding='utf-8', newline='\n') as f:
        f.write('# qqq-shell-v2 Embedded Python (macOS ' + ARCH + ') — Frozen Requirements\n'
                '# Python 3.11.16 (python-build-standalone 20260901, install_only_stripped)\n'
                '# 3.11 定案理由：cffi cp38 mac 无 arm64 轮子 → miniaudio 不可用；\n'
                '# 3.11 全生态 arm64 原生 + PySide6 abi3(cp38) 兼容 + 支持线到 2027\n'
                '# pip/setuptools = pb-s 自带（未 overlay）；Addons 不装（纯 widgets 方针）\n'
                'pip==26.2.1\n'
                'setuptools==84.0.0\n'
                'wheel==0.45.1\n'
                'pynput==1.8.2\n'
                'six==1.17.0\n'
                'miniaudio==1.61\n'
                'cffi==1.17.1\n'
                'pycparser==2.22\n'
                'manual:PySide6==6.6.3.1\n'
                'manual:shiboken6==6.6.3.1\n'
                'manual:PySide6-Essentials==6.6.3.1\n'
                'manual:pyobjc-core==10.3.2\n'
                'manual:pyobjc-framework-Cocoa==10.3.2\n'
                'manual:pyobjc-framework-Quartz==10.3.2\n'
                'manual:pyobjc-framework-ApplicationServices==10.3.2\n'
                'manual:sitecustomize\n')

    slim_tree(sp)
    _fix_shebang_and_junk(out_dir)

    zip_out = os.path.join(DIST, 'python-darwin-%s.zip' % ARCH)
    zip_tree(out_dir, zip_out)
    log('[py] tree size: %.1f MB | zip: %.1f MB | miniaudio=%s' % (
        dir_size(out_dir) / 1048576.0, os.path.getsize(zip_out) / 1048576.0, mini_used))


def fetch_git():
    os.makedirs(DL, exist_ok=True)
    for label, url, dest_dir, keep in (
            ('mac', GIT_MAC_URL, os.path.join(CROSS, 'git-darwin-arm64'), True),
            ('linux', GIT_LINUX_URL, os.path.join(CROSS, '_x_git_linux'), False)):
        dl = os.path.join(DL, 'git-%s.tar.gz' % label)
        if not os.path.exists(dl):
            http_get(url, dl)
        extract_dir = os.path.join(CROSS, '_x_git_' + label)
        shutil.rmtree(extract_dir, ignore_errors=True)
        made, failed = extract_tar_gz(dl, extract_dir)
        # find the actual root level
        entries = os.listdir(extract_dir)
        if len(entries) == 1 and os.path.isdir(os.path.join(extract_dir, entries[0])):
            extract_dir_src = os.path.join(extract_dir, entries[0])
        else:
            extract_dir_src = extract_dir
        if keep:
            shutil.rmtree(dest_dir, ignore_errors=True)
            shutil.copytree(extract_dir_src, dest_dir, symlinks=True)
            # mac git = universal (Mach-O FAT) → 同时物化 x64 树（两架构共用同一制品）
            _gx64 = os.path.join(CROSS, 'git-darwin-x64')
            shutil.rmtree(_gx64, ignore_errors=True)
            shutil.copytree(dest_dir, _gx64, symlinks=True)
        # report layout (top 2 levels) + git binary magic
        log('--- git-%s layout ---' % label)
        src = dest_dir if keep else extract_dir_src
        for name in sorted(os.listdir(src)):
            full = os.path.join(src, name)
            if os.path.isdir(full):
                sub = sorted(os.listdir(full))[:8]
                log('  %s/  %s' % (name, sub))
            else:
                log('  %s (%d bytes)' % (name, os.path.getsize(full)))
        for cand in ('git', 'bin/git', 'cmd/git.exe', 'cmd/git'):
            p = os.path.join(src, *cand.split('/'))
            if os.path.isfile(p):
                with open(p, 'rb') as fh:
                    head = fh.read(4)
                kind = ('mach-o' if head in MACHO_MAGICS else
                        'elf' if head == ELF_MAGIC else
                        'pe' if head[:2] == b'MZ' else head.hex())
                log('  >> binary candidate: %s [%s] %d bytes' % (cand, kind, os.path.getsize(p)))
        if keep:
            log('[git] tree -> %s (%.1f MB)' % (dest_dir, dir_size(dest_dir) / 1048576.0))
        else:
            shutil.rmtree(extract_dir, ignore_errors=True)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--arch=')]
    cmd = args[0] if args else 'all'
    log('[arch] target = mac %s' % ARCH)
    os.makedirs(CROSS, exist_ok=True)
    if cmd in ('python', 'all'):
        build_python()
    if cmd in ('git', 'all'):
        fetch_git()
    log('[done] cross artifacts under %s' % CROSS)


main()
