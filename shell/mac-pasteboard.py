#!/usr/bin/env python3
# Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

# ============================================================================
# mac-pasteboard.py — macOS 剪贴板文件列表读写（klipzap readFiles / writeFiles 专用）
#   读: python3 -u mac-pasteboard.py files
#       输出: 每行一个 POSIX 绝对路径（UTF-8；无文件 = 空输出）
#       机制: NSPasteboard — NSFilenamesPboardType（Finder 多文件复制经典格式）
#             → 兜底 readObjectsForClasses NSURL（public.file-url / 单文件）
#   写: python3 -u mac-pasteboard.py setfiles <base64(JSON路径数组)>
#       机制: writeObjects NSURL（public.file-url 现代格式）+ addTypes NSFilenamesPboardType（经典兼容）
#       退出码: 0=成功 / 1=写入失败 / 64=用法错 / 65=载荷错
#   对位物: Windows 的 CF_HDROP（ipc-misc.ts readFiles/writeFiles 之 win 分支）
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


def _set_files(paths):
    """写剪贴板文件列表（Finder 可粘贴）。返回 bool。"""
    try:
        from AppKit import NSPasteboard, NSURL, NSFilenamesPboardType
    except Exception:
        return False
    try:
        pb = NSPasteboard.generalPasteboard()
        urls = [NSURL.fileURLWithPath_(str(p)) for p in paths]
        pb.clearContents()
        ok = bool(pb.writeObjects_(urls))
        # 追加经典格式（Finder 老式粘贴路径仍吃 NSFilenamesPboardType）
        try:
            pb.addTypes_owner_([NSFilenamesPboardType], None)
            pb.setPropertyList_forType_(list(paths), NSFilenamesPboardType)
        except Exception:
            pass
        return ok
    except Exception:
        return False


def _usage():
    sys.stderr.write('usage: mac-pasteboard.py files | setfiles <b64-json>\n')
    sys.exit(64)


def main():
    argv = sys.argv[1:]
    if not argv:
        _usage()
    if argv[0] == 'files':
        files = _read_files()
        if files:
            sys.stdout.write('\n'.join(files) + '\n')
        sys.exit(0)
    if argv[0] == 'setfiles':
        import base64, json
        try:
            raw = base64.b64decode(argv[1]).decode('utf-8') if len(argv) > 1 else ''
            data = json.loads(raw)
        except Exception:
            sys.stderr.write('bad payload\n')
            sys.exit(65)
        if not isinstance(data, list) or not data:
            sys.stderr.write('bad payload\n')
            sys.exit(65)
        clean = [str(x) for x in data if isinstance(x, str) and x]
        if not clean:
            sys.exit(65)
        sys.exit(0 if _set_files(clean) else 1)
    _usage()


if __name__ == '__main__':
    main()
