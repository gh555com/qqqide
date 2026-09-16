#!/usr/bin/env python3
# Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

# ============================================================================
# mac-pasteboard.py — macOS 剪贴板文件列表读取（klipzap readFiles 专用，2026-09-16）
#   调用: python3 -u mac-pasteboard.py files
#   输出: 每行一个 POSIX 绝对路径（UTF-8；无文件 = 空输出）
#   机制: NSPasteboard — NSFilenamesPboardType（Finder 多文件复制经典格式）
#         → 兜底 readObjectsForClasses NSURL（public.file-url / 单文件）
#   对位物: Windows 的 CF_HDROP（ipc-misc.ts readFiles 之 win 分支）
# ============================================================================
import sys


def _read_files():
    paths = []
    try:
        from AppKit import NSPasteboard
        try:
            from AppKit import NSFilenamesPboardType as _FNP
        except Exception:
            _FNP = 'NSFilenamesPboardType'
        pb = NSPasteboard.generalPasteboard()
        # ① 经典文件列表格式（Finder 复制 = 多文件全量）
        try:
            plist = pb.propertyListForType_(_FNP)
            if isinstance(plist, str):
                plist = [plist]
            for item in (plist or []):
                p = str(item)
                if p.startswith('file://'):
                    from urllib.parse import unquote, urlparse
                    p = unquote(urlparse(p).path)
                if p:
                    paths.append(p)
        except Exception:
            pass
        # ② 兜底：NSURL 对象读取（public.file-url 单文件 / 无 ① 数据时）
        if not paths:
            try:
                from AppKit import NSURL
                urls = pb.readObjectsForClasses_options_([NSURL], None)
                for u in (urls or []):
                    try:
                        if u.isFileURL():
                            p = u.path()
                            if p:
                                paths.append(str(p))
                    except Exception:
                        pass
            except Exception:
                pass
    except Exception:
        return []
    # 去重保序
    out, seen = [], set()
    for p in paths:
        if p and p not in seen:
            seen.add(p)
            out.append(p)
    return out


def main():
    argv = sys.argv[1:]
    if not argv or argv[0] != 'files':
        sys.stderr.write('usage: mac-pasteboard.py files\n')
        sys.exit(64)
    files = _read_files()
    if files:
        sys.stdout.write('\n'.join(files) + '\n')
    sys.exit(0)


if __name__ == '__main__':
    main()
