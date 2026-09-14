# -*- coding: utf-8 -*-
# ============================================================================
# _unzip_mac.py — symlink-aware zip extractor (cross-build helper)
#
# WHY: extracting the Electron darwin zip with Windows Expand-Archive
# materializes unix symlinks (Electron Framework.framework/Versions/Current,
# top-level framework links, ...) as tiny text files → the .app cannot launch
# on macOS. This worker recreates real symlinks (two-pass: files/dirs first,
# then links, with retry passes for chained links).
#
# usage: python shell-build/_unzip_mac.py <zip> <dest>
# ============================================================================
import os
import stat
import sys
import zipfile


def _extract_files(zf, dest):
    skipped_links = []
    for info in zf.infolist():
        name = info.filename
        if not name:
            continue
        mode = (info.external_attr >> 16) & 0xFFFF
        target = os.path.join(dest, name.replace('/', os.sep))
        # directory entry
        if name.endswith('/'):
            if mode and stat.S_ISLNK(mode):
                skipped_links.append((name.rstrip('/'), zf.read(info).decode('utf-8', 'replace')))
                continue
            os.makedirs(target, exist_ok=True)
            continue
        parent = os.path.dirname(target)
        if parent:
            os.makedirs(parent, exist_ok=True)
        if stat.S_ISLNK(mode):
            skipped_links.append((name, zf.read(info).decode('utf-8', 'replace')))
            continue
        if os.path.lexists(target):
            os.remove(target)
        with zf.open(info) as src, open(target, 'wb') as dst:
            while True:
                buf = src.read(1 << 20)
                if not buf:
                    break
                dst.write(buf)
        try:
            perm = mode & 0o777
            if perm:
                os.chmod(target, perm)
        except OSError:
            pass
    return skipped_links


def _make_links(dest, links):
    pending = list(links)
    made = 0
    for _ in range(4):  # retry passes — chained links resolve on later passes
        if not pending:
            break
        nxt = []
        for name, linkname in pending:
            target = os.path.join(dest, name.replace('/', os.sep))
            parent = os.path.dirname(target)
            if parent:
                os.makedirs(parent, exist_ok=True)
            if os.path.lexists(target):
                made += 1
                continue
            sub = linkname.replace('/', os.sep)
            resolved = os.path.normpath(os.path.join(parent, sub))
            is_dir = os.path.isdir(resolved)
            created = False
            for flag in (is_dir, not is_dir):
                try:
                    # ★ 存储目标必须保持原样（正斜杠）——
                    #   Windows 会把反斜杠原样存进 symlink，macOS 上即死链。
                    os.symlink(linkname, target, target_is_directory=flag)
                    created = True
                    break
                except OSError:
                    if os.path.lexists(target):
                        try:
                            os.remove(target)
                        except OSError:
                            pass
            if created:
                made += 1
            elif os.path.isfile(resolved):
                # last-resort fallback: real copy of the target file
                import shutil
                shutil.copy2(resolved, target)
                made += 1
            else:
                nxt.append((name, linkname))
        pending = nxt
    return made, len(pending)


def main():
    if len(sys.argv) < 3:
        print('usage: _unzip_mac.py <zip> <dest>')
        sys.exit(2)
    zip_path, dest = sys.argv[1], sys.argv[2]
    os.makedirs(dest, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        links = _extract_files(zf, dest)
        made, failed = _make_links(dest, links)
    print('[unzip-mac] %s -> files ok, symlinks created=%d pending=%d' %
          (os.path.basename(zip_path), made, failed))
    if failed:
        print('[unzip-mac] WARNING: %d symlinks could not be created' % failed)
        sys.exit(3)


main()
