#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

# ============================================================================
# win-pasteboard.py — Windows 剪贴板“文件列表”读写器（klipzap 读写两侧快路径专属）
#   调用: python win-pasteboard.py setfiles <base64(utf8-json-[paths])>
#         python win-pasteboard.py getfiles
#   写出: CF_HDROP + FileNameW + FileName —— 与资源管理器 Ctrl+C / PowerShell
#         SetFileDropList 同构（Explorer 可粘贴、Chromium 粘贴事件暴露 Files）。
#   读回: getfiles = 读 CF_HDROP（文件列表的唯一权威格式，n 条全量）→ stdout 输出
#         base64(utf8-json-[paths])。
#         ★ FileNameW 是 Explorer 遗留的单条格式（多选复制时只有一条）——
#           读取主路禁走它（会把 45 个文件读成 1 个，见 ipc-misc readFiles）。
#   退出码: 0=成功；非 0=失败（调用方回落 PowerShell 慢路径）。
#   存在理由: PS 冷启动 1.5~3s → Roam Ctrl+C 后秒粘贴拿到的还是“文本路径”，
#            文件列表尚未落地 → 粘贴出纯文本（用户实测“一会儿好一会儿不行”）。
#            本器冷启动 ~百毫秒级，原子写，消除该竞态窗口。
# ============================================================================
import sys
import json
import base64
import struct
import time


def _set_clipboard(paths):
    import ctypes
    from ctypes import wintypes as wt

    u32 = ctypes.windll.user32
    k32 = ctypes.windll.kernel32

    CF_HDROP = 15
    GMEM_MOVEABLE = 0x0002
    HGLOBAL = ctypes.c_void_p

    k32.GlobalAlloc.argtypes = [wt.UINT, ctypes.c_size_t]
    k32.GlobalAlloc.restype = HGLOBAL
    k32.GlobalLock.argtypes = [HGLOBAL]
    k32.GlobalLock.restype = ctypes.c_void_p
    k32.GlobalUnlock.argtypes = [HGLOBAL]
    k32.GlobalUnlock.restype = wt.BOOL
    k32.GlobalFree.argtypes = [HGLOBAL]
    k32.GlobalFree.restype = HGLOBAL
    u32.OpenClipboard.argtypes = [wt.HWND]
    u32.OpenClipboard.restype = wt.BOOL
    u32.EmptyClipboard.restype = wt.BOOL
    u32.SetClipboardData.argtypes = [wt.UINT, wt.HANDLE]
    u32.SetClipboardData.restype = wt.HANDLE
    u32.RegisterClipboardFormatW.argtypes = [ctypes.c_wchar_p]
    u32.RegisterClipboardFormatW.restype = wt.UINT
    u32.CloseClipboard.restype = wt.BOOL

    wide = ''.join(p + '\x00' for p in paths) + '\x00'
    drop = struct.pack('<IiiII', 20, 0, 0, 0, 1) + wide.encode('utf-16-le')
    fnw = wide.encode('utf-16-le')
    fna = b''
    for p in paths:
        fna += p.encode('mbcs', 'replace') + b'\x00'
    fna += b'\x00'

    # OpenClipboard 重试：剪贴板可能被别的进程短暂占用（经典 intermittent 失败源）
    opened = False
    for _ in range(20):
        if u32.OpenClipboard(None):
            opened = True
            break
        time.sleep(0.05)
    if not opened:
        return False, 'OpenClipboard failed (clipboard busy)'

    try:
        if not u32.EmptyClipboard():
            return False, 'EmptyClipboard failed'

        def _put(fmt, buf):
            if not fmt:
                return True
            h = k32.GlobalAlloc(GMEM_MOVEABLE, len(buf))
            if not h:
                return False
            p = k32.GlobalLock(h)
            if not p:
                k32.GlobalFree(h)
                return False
            ctypes.memmove(p, buf, len(buf))
            k32.GlobalUnlock(h)
            if not u32.SetClipboardData(fmt, h):
                k32.GlobalFree(h)
                return False
            return True   # 成功后句柄归系统所有，禁再 free

        if not _put(CF_HDROP, drop):
            return False, 'SetClipboardData(CF_HDROP) failed'
        _put(u32.RegisterClipboardFormatW('FileNameW'), fnw)
        _put(u32.RegisterClipboardFormatW('FileName'), fna)
        return True, ''
    finally:
        u32.CloseClipboard()


def _get_clipboard_files():
    """读 CF_HDROP → 完整路径列表（存在性过滤交调用方；这里只保证 n 条全量）。"""
    import ctypes
    from ctypes import wintypes as wt

    u32 = ctypes.windll.user32
    k32 = ctypes.windll.kernel32
    shell32 = ctypes.windll.shell32

    CF_HDROP = 15
    u32.OpenClipboard.argtypes = [wt.HWND]
    u32.OpenClipboard.restype = wt.BOOL
    u32.GetClipboardData.argtypes = [wt.UINT]
    u32.GetClipboardData.restype = wt.HANDLE
    u32.CloseClipboard.restype = wt.BOOL
    shell32.DragQueryFileW.argtypes = [wt.HANDLE, wt.UINT, wt.LPWSTR, wt.UINT]
    shell32.DragQueryFileW.restype = wt.UINT

    opened = False
    for _ in range(20):
        if u32.OpenClipboard(None):
            opened = True
            break
        time.sleep(0.05)
    if not opened:
        return None, 'OpenClipboard failed (clipboard busy)'
    try:
        h = u32.GetClipboardData(CF_HDROP)
        if not h:
            return None, 'no CF_HDROP'
        n = shell32.DragQueryFileW(h, 0xFFFFFFFF, None, 0)   # 0xFFFFFFFF = 取条目数
        out = []
        for i in range(n):
            ln = shell32.DragQueryFileW(h, i, None, 0)
            if ln <= 0:
                continue
            buf = ctypes.create_unicode_buffer(ln + 1)
            if shell32.DragQueryFileW(h, i, buf, ln + 1) > 0:
                p = buf.value
                if p:
                    out.append(p)
        return out, ''
    finally:
        u32.CloseClipboard()


def main():
    argv = sys.argv[1:]
    if len(argv) >= 1 and argv[0] == 'getfiles':
        files, err = _get_clipboard_files()
        if files is None:
            sys.stderr.write(err + '\n')
            return 1
        sys.stdout.write(base64.b64encode(json.dumps(files).encode('utf-8')).decode('ascii'))
        return 0
    if len(argv) >= 2 and argv[0] == 'setfiles':
        try:
            paths = json.loads(base64.b64decode(argv[1]).decode('utf-8'))
            paths = [str(p) for p in paths if p]
        except Exception as e:
            sys.stderr.write('bad payload: %s\n' % e)
            return 2
        if not paths:
            return 2
        ok, err = _set_clipboard(paths)
        if not ok:
            sys.stderr.write(err + '\n')
            return 1
        return 0
    sys.stderr.write('usage: win-pasteboard.py setfiles <b64json> | getfiles\n')
    return 64


if __name__ == '__main__':
    sys.exit(main())
