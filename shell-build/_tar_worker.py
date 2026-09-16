# -*- coding: utf-8 -*-
# ============================================================================
# _tar_worker.py — mode-aware tar.gz writer (cross-build helper)
#
# WHY: NTFS has no unix exec bit → plain tarfile writes mach-o binaries as
# 0644 → broken .app on macOS. This worker sniffs file magics (Mach-O / ELF /
# shebang) and writes 0755 for executables, 0644 for plain files, 0755 for
# dirs. Symlinks are preserved as real tar symlink entries (relative targets).
#
# usage: python shell-build/_tar_worker.py <src_dir> <out.tar.gz>
# ============================================================================
import os
import sys
import tarfile

EXEC_MAGICS = (
    b'\xcf\xfa\xed\xfe',  # Mach-O 64 LE (arm64/x86_64)
    b'\xce\xfa\xed\xfe',  # Mach-O 32 LE
    b'\xfe\xed\xfa\xcf',  # Mach-O 64 BE
    b'\xfe\xed\xfa\xce',  # Mach-O 32 BE
    b'\xca\xfe\xba\xbe',  # fat binary BE
    b'\xbe\xba\xfe\xca',  # fat binary LE
    b'\x7fELF',           # ELF
    b'#!',                # script shebang
)


def _file_mode(path, name):
    try:
        with open(path, 'rb') as f:
            head = f.read(4)
        for magic in EXEC_MAGICS:
            if head.startswith(magic):
                return 0o755
    except OSError:
        pass
    low = name.lower()
    if low.endswith(('.sh', '.command', '.bash')):
        return 0o755
    return 0o644


def _add(tf, full, arc):
    st = os.lstat(full)
    if os.path.islink(full):
        ti = tarfile.TarInfo(arc)
        ti.type = tarfile.SYMTYPE
        # ★ Windows 宿主机修正：Node fs.symlinkSync 会把目标归一化为反斜杠
        #   （..\..\..\qqqide-data\engines）——tar 内 symlink 目标语义永远是
        #   POSIX 正斜杠，读盘后统一转换（2026-09-16 engines 外置实测）。
        ti.linkname = os.readlink(full).replace('\\', '/')
        ti.mode = 0o777
        ti.mtime = int(st.st_mtime)
        tf.addfile(ti)
        return
    if os.path.isdir(full):
        ti = tarfile.TarInfo(arc + '/')
        ti.type = tarfile.DIRTYPE
        ti.mode = 0o755
        ti.mtime = int(st.st_mtime)
        tf.addfile(ti)
        for name in sorted(os.listdir(full)):
            _add(tf, os.path.join(full, name), arc + '/' + name)
        return
    ti = tarfile.TarInfo(arc)
    ti.size = st.st_size
    ti.mode = _file_mode(full, os.path.basename(arc))
    ti.mtime = int(st.st_mtime)
    with open(full, 'rb') as f:
        tf.addfile(ti, f)


def main():
    if len(sys.argv) < 3:
        print('usage: _tar_worker.py <src_dir> <out.tar.gz>')
        sys.exit(2)
    src, out = sys.argv[1], sys.argv[2]
    if os.path.exists(out):
        os.remove(out)
    with tarfile.open(out, 'w:gz', format=tarfile.PAX_FORMAT) as tf:
        for name in sorted(os.listdir(src)):
            _add(tf, os.path.join(src, name), name)
    print('[tar-worker] %s -> %d bytes' % (out, os.path.getsize(out)))


main()
