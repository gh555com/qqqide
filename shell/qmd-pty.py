# -*- coding: utf-8 -*-
# Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

# ============================================================================
# qmd-pty.py — ConPTY 桥（goods qmd 真终端后端，Win10 1809+）
#
# 职责：把 Windows Pseudo Console (ConPTY) 封装成 JSON-line stdio 服务。
#   · 零第三方依赖（ctypes 直调 kernel32），绿色包 python 3.8 直接运行
#   · 会话隔离：每个 qmd tab = 一个本进程（Node 按会话 spawn）
#   · 字节流全程透明透传（不解释编码/不解析 VT）——ConPTY 内部统一 UTF-8，
#     conhost 负责与程序代码页（GBK 等）的双向转换，乱码问题在结构上不存在
#
# 协议（stdin 收指令 / stdout 报事件，JSON lines，UTF-8）:
#   父 → 本: {"type":"spawn","cmd":"C:\\...\\cmd.exe","args":["/d"],
#             "cwd":"...","cols":120,"rows":30}
#             {"type":"write","d":"<base64 字节>"}
#             {"type":"resize","cols":N,"rows":N}
#   本 → 父: {"type":"ready","pid":<shell pid>}
#             {"type":"data","d":"<base64 字节>"}
#             {"type":"exit","code":N}            （shell 退出）
#             {"type":"error","message":"..."}    （spawn 失败，随后退出）
#
# 生命周期:
#   正常：shell 退出 → waiter 线程报 exit → 本进程收尾退出
#   强杀：Node 先 taskkill /T shell 树 → shell 死 → 同上自然退出；
#        Node 再 kill 本进程 → stdin EOF → 收尾退出（双保险）
# ============================================================================

import base64
import ctypes
import json
import os
import sys
import threading
import time

kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)

INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
EXTENDED_STARTUPINFO_PRESENT = 0x00080000
PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016
ERROR_BROKEN_PIPE = 109
ERROR_OPERATION_ABORTED = 995


class COORD(ctypes.Structure):
    _fields_ = [('X', ctypes.c_short), ('Y', ctypes.c_short)]


class SECURITY_ATTRIBUTES(ctypes.Structure):
    _fields_ = [
        ('nLength', ctypes.c_ulong),
        ('lpSecurityDescriptor', ctypes.c_void_p),
        ('bInheritHandle', ctypes.c_int),
    ]


class STARTUPINFO(ctypes.Structure):
    _fields_ = [
        ('cb', ctypes.c_ulong),
        ('lpReserved', ctypes.c_wchar_p),
        ('lpDesktop', ctypes.c_wchar_p),
        ('lpTitle', ctypes.c_wchar_p),
        ('dwX', ctypes.c_ulong),
        ('dwY', ctypes.c_ulong),
        ('dwXSize', ctypes.c_ulong),
        ('dwYSize', ctypes.c_ulong),
        ('dwXCountChars', ctypes.c_ulong),
        ('dwYCountChars', ctypes.c_ulong),
        ('dwFillAttribute', ctypes.c_ulong),
        ('dwFlags', ctypes.c_ulong),
        ('wShowWindow', ctypes.c_ushort),
        ('cbReserved2', ctypes.c_ushort),
        ('lpReserved2', ctypes.c_void_p),
        ('hStdInput', ctypes.c_void_p),
        ('hStdOutput', ctypes.c_void_p),
        ('hStdError', ctypes.c_void_p),
    ]


class STARTUPINFOEXW(ctypes.Structure):
    _fields_ = [
        ('StartupInfo', STARTUPINFO),
        ('lpAttributeList', ctypes.c_void_p),
    ]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [
        ('hProcess', ctypes.c_void_p),
        ('hThread', ctypes.c_void_p),
        ('dwProcessId', ctypes.c_ulong),
        ('dwThreadId', ctypes.c_ulong),
    ]


# ── 全部 API 显式签名（无 argtypes 时 ctypes 把句柄按 c_int 32 位截断 → 64 位下必坏） ──
kernel32.CreatePipe.restype = ctypes.c_int
kernel32.CreatePipe.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
                                ctypes.c_void_p, ctypes.c_ulong]
kernel32.CreatePseudoConsole.restype = ctypes.c_int
kernel32.CreatePseudoConsole.argtypes = [ctypes.POINTER(COORD), ctypes.c_void_p, ctypes.c_void_p,
                                         ctypes.c_ulong, ctypes.POINTER(ctypes.c_void_p)]
kernel32.ClosePseudoConsole.restype = ctypes.c_int
kernel32.ClosePseudoConsole.argtypes = [ctypes.c_void_p]
kernel32.CloseHandle.restype = ctypes.c_int
kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
kernel32.InitializeProcThreadAttributeList.restype = ctypes.c_int
kernel32.InitializeProcThreadAttributeList.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong,
                                                       ctypes.POINTER(ctypes.c_size_t)]
kernel32.UpdateProcThreadAttribute.restype = ctypes.c_int
kernel32.UpdateProcThreadAttribute.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong,
                                               ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p]
kernel32.CreateProcessW.restype = ctypes.c_int
kernel32.CreateProcessW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_void_p, ctypes.c_void_p,
                                    ctypes.c_int, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_wchar_p,
                                    ctypes.POINTER(STARTUPINFOEXW), ctypes.POINTER(PROCESS_INFORMATION)]
kernel32.ResizePseudoConsole.restype = ctypes.c_int
kernel32.ResizePseudoConsole.argtypes = [ctypes.c_void_p, ctypes.POINTER(COORD)]
kernel32.ReadFile.restype = ctypes.c_int
kernel32.ReadFile.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong,
                              ctypes.POINTER(ctypes.c_ulong), ctypes.c_void_p]
kernel32.WriteFile.restype = ctypes.c_int
kernel32.WriteFile.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong,
                               ctypes.POINTER(ctypes.c_ulong), ctypes.c_void_p]
kernel32.WaitForSingleObject.restype = ctypes.c_ulong
kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
kernel32.GetExitCodeProcess.restype = ctypes.c_int
kernel32.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]


# ── 句柄 ──────────────────────────────────────────────────────────────
hInRead = None   # ConPTY 键入读端（无使用者，CreatePseudoConsole 内部持有副本）
hInWrite = None  # 本进程写键盘字节
hOutRead = None  # 本进程读屏幕输出
hOutWrite = None # ConPTY 输出写端（conhost 写入）
hPC = None       # pseudo console
hProc = None
hThread = None
_cleaned = False


def _emit(msg):
    try:
        sys.stdout.buffer.write((json.dumps(msg, ensure_ascii=False) + '\n').encode('utf-8'))
        sys.stdout.buffer.flush()
    except Exception:
        pass


def _fail(message):
    _emit({'type': 'error', 'message': message})
    _cleanup()
    os._exit(1)


def _create_pipe():
    """★ 句柄必须可继承（bInheritHandle=TRUE）：CreatePseudoConsole 内部以继承方式把
    管道端交给 conhost——不可继承时 conhost 拿不到输出端 → ReadFile 109 broken pipe
    + 目标进程 0xC000013A 退出（2026-09-07 实测排雷）"""
    sa = SECURITY_ATTRIBUTES()
    sa.nLength = ctypes.sizeof(SECURITY_ATTRIBUTES)
    sa.lpSecurityDescriptor = None
    sa.bInheritHandle = 1
    h_r = ctypes.c_void_p()
    h_w = ctypes.c_void_p()
    ok = kernel32.CreatePipe(ctypes.byref(h_r), ctypes.byref(h_w), ctypes.byref(sa), 0)
    if not ok:
        _fail('CreatePipe failed: %d' % ctypes.get_last_error())
    return h_r.value, h_w.value


def _cleanup():
    global _cleaned
    if _cleaned:
        return
    _cleaned = True
    for h in (hInWrite, hOutRead, hInRead, hOutWrite):
        if h:
            try:
                kernel32.CloseHandle(ctypes.c_void_p(h))
            except Exception:
                pass
    if hPC:
        try:
            kernel32.ClosePseudoConsole(ctypes.c_void_p(hPC))
        except Exception:
            pass
    if hProc:
        try:
            kernel32.CloseHandle(ctypes.c_void_p(hProc))
        except Exception:
            pass
    if hThread:
        try:
            kernel32.CloseHandle(ctypes.c_void_p(hThread))
        except Exception:
            pass


def _quote_arg(s):
    if s and (' ' in s or '\t' in s):
        return '"' + s.replace('"', '\\"') + '"'
    return s


def _read_loop():
    """读 ConPTY 输出 → data 事件。阻塞 ReadFile，daemon 线程。"""
    import sys as _sys
    def _dbg(m):
        try:
            _sys.stderr.write('[qmd-pty] ' + m + '\n')
            _sys.stderr.flush()
        except Exception:
            pass
    buf = ctypes.create_string_buffer(16384)
    while True:
        n = ctypes.c_ulong(0)
        try:
            ok = kernel32.ReadFile(ctypes.c_void_p(hOutRead), buf, len(buf), ctypes.byref(n), None)
        except Exception as e:
            _dbg('ReadFile exception: %r' % e)
            return
        if not ok:
            err = ctypes.get_last_error()
            _dbg('ReadFile end err=%d' % err)
            # 995 (aborted) / 109 (broken pipe) = 正常收尾
            if err in (ERROR_OPERATION_ABORTED, ERROR_BROKEN_PIPE):
                return
            # 其他错误：继续读会死循环，退出线程（conhost 侧已异常）
            return
        if n.value > 0:
            raw = buf.raw[:n.value]
            _emit({'type': 'data', 'd': base64.b64encode(raw).decode('ascii')})


def _write_all(h, data):
    """WriteFile 全量写（处理部分写）"""
    total = len(data)
    off = 0
    view = ctypes.create_string_buffer(data)
    while off < total:
        n = ctypes.c_ulong(0)
        ok = kernel32.WriteFile(ctypes.c_void_p(h), ctypes.byref(view, off), total - off, ctypes.byref(n), None)
        if not ok:
            return False
        if n.value == 0:
            return False
        off += n.value
    return True


def _waiter_loop(h_process, h_pc):
    """等 shell 退出 → exit 事件 → 收尾退出进程"""
    kernel32.WaitForSingleObject(ctypes.c_void_p(h_process), 0xFFFFFFFF)  # INFINITE
    code = ctypes.c_ulong(0)
    kernel32.GetExitCodeProcess(ctypes.c_void_p(h_process), ctypes.byref(code))
    _emit({'type': 'exit', 'code': int(code.value)})
    _cleanup()
    os._exit(0)


def _spawn(cmd, args, cwd):
    """建 ConPTY 并启动目标 shell"""
    global hInRead, hInWrite, hOutRead, hOutWrite, hPC, hProc, hThread

    # 1. 两个管道：ConPTY 键入管道（我们写）、输出管道（我们读）
    hInRead, hInWrite = _create_pipe()
    hOutRead, hOutWrite = _create_pipe()

    # 2. 伪控制台（大小可后续 resize）——★ CreatePseudoConsole 返回 HRESULT：0=S_OK 成功，
    #    负值才是失败（2026-09-07 实测：曾把 0 当失败 → 误报 122 残留错误，二次排雷）
    size = COORD(120, 30)
    pc = ctypes.c_void_p()
    hr = kernel32.CreatePseudoConsole(ctypes.byref(size), ctypes.c_void_p(hInRead),
                                      ctypes.c_void_p(hOutWrite), 0, ctypes.byref(pc))
    if hr != 0:
        _fail('CreatePseudoConsole failed: 0x%08X (需 Win10 1809+)' % (hr & 0xFFFFFFFF))
    hPC = pc.value

    # 3. STARTUPINFOEXW + attribute list 挂 pseudo console
    si = STARTUPINFOEXW()
    si.StartupInfo.cb = ctypes.sizeof(STARTUPINFOEXW)

    size_attr = ctypes.c_size_t(0)
    kernel32.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size_attr))
    attr_buf = ctypes.create_string_buffer(size_attr.value)
    lp_list = ctypes.cast(attr_buf, ctypes.c_void_p)
    if not kernel32.InitializeProcThreadAttributeList(lp_list, 1, 0, ctypes.byref(size_attr)):
        _fail('InitializeProcThreadAttributeList failed: %d' % ctypes.get_last_error())
    si.lpAttributeList = lp_list.value

    pc_ref = ctypes.c_void_p(hPC)
    ok = kernel32.UpdateProcThreadAttribute(lp_list, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                                            ctypes.byref(pc_ref), ctypes.sizeof(ctypes.c_void_p), None, None)
    if not ok:
        _fail('UpdateProcThreadAttribute failed: %d' % ctypes.get_last_error())

    # 4. CreateProcessW：cmdline 组装 + 继承本进程环境（Node 已在 python env 注入 MSYSTEM 等）
    cmdline_parts = [_quote_arg(cmd)] + [_quote_arg(a) for a in (args or [])]
    cmdline = ctypes.create_unicode_buffer(' '.join(cmdline_parts))
    pi = PROCESS_INFORMATION()
    ok = kernel32.CreateProcessW(
        None, cmdline, None, None, False,
        EXTENDED_STARTUPINFO_PRESENT, None,
        ctypes.c_wchar_p(cwd) if cwd else None,
        ctypes.byref(si), ctypes.byref(pi))
    if not ok:
        _fail('CreateProcessW failed: %d (%s)' % (ctypes.get_last_error(), ' '.join(cmdline_parts)))
    hProc = pi.hProcess
    hThread = pi.hThread

    # 5. 父进程侧关闭 ConPTY 内部持有的管道端副本（我们的读写端保留）
    kernel32.CloseHandle(ctypes.c_void_p(hInRead))
    kernel32.CloseHandle(ctypes.c_void_p(hOutWrite))
    hInRead = None
    hOutWrite = None

    # 6. 属性列表缓冲可释放（CreateProcessW 已消费）
    #    （attr_buf 生命周期保持到函数返回即可；随后不再使用）

    return int(pi.dwProcessId)


def main():
    global hPC, hInWrite, hOutRead

    # 首行 = spawn 指令
    first = sys.stdin.buffer.readline()
    if not first:
        os._exit(0)
    try:
        cfg = json.loads(first.decode('utf-8'))
    except Exception:
        _fail('bad spawn config')
    if not cfg or cfg.get('type') != 'spawn':
        _fail('expected spawn config')

    cols = int(cfg.get('cols') or 120)
    rows = int(cfg.get('rows') or 30)

    # spawn 前先全局建管道时用到的尺寸：CreatePseudoConsole 在 _spawn 内部用默认 120x30，
    # 若指令带尺寸 → 建完后立即 resize 一次（微秒级，用户不可见）
    pid = _spawn(str(cfg.get('cmd') or ''), cfg.get('args') or [], cfg.get('cwd') or '')
    if cols != 120 or rows != 30:
        size = COORD(cols, rows)
        kernel32.ResizePseudoConsole(ctypes.c_void_p(hPC), ctypes.byref(size))

    _emit({'type': 'ready', 'pid': pid})

    # waiter 线程（shell 退出 → exit 事件 → 进程收尾）
    threading.Thread(target=_waiter_loop, args=(hProc, hPC), daemon=True).start()
    # 输出读线程
    threading.Thread(target=_read_loop, daemon=True).start()

    # 主循环：处理 write / resize 指令
    for raw in sys.stdin.buffer:
        if not raw.strip():
            continue
        try:
            msg = json.loads(raw.decode('utf-8'))
        except Exception:
            continue
        mtype = msg.get('type')
        if mtype == 'write':
            try:
                data = base64.b64decode(msg.get('d') or '')
            except Exception:
                continue
            if data and hInWrite:
                try:
                    _write_all(hInWrite, data)
                except Exception:
                    pass
        elif mtype == 'resize':
            try:
                size = COORD(int(msg.get('cols') or 120), int(msg.get('rows') or 30))
                if hPC:
                    kernel32.ResizePseudoConsole(ctypes.c_void_p(hPC), ctypes.byref(size))
            except Exception:
                pass

    # stdin EOF（Node 关闭/kill）→ 收尾（waiter 线程会负责 exit 事件，这里只管清理）
    _cleanup()
    os._exit(0)


if __name__ == '__main__':
    main()
