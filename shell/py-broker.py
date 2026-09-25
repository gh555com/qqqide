# Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

#!/usr/bin/env python3
"""py-broker.py — 跨平台窗口管理 broker for qqqide.
常驻子进程。stdin 读 JSON 行命令，stdout 返回 JSON 行响应。
职责:
  1. DevTools 窗口改名 (Win: ctypes / Mac: osascript / Linux: wmctrl)
  2. ★ 窗口编队热键 (Win/mac, pynput 全局钩子): Space + {1,2,q,w,a,s,z,x} 召回编队窗口
     Truth: %LOCALAPPDATA%/qqqide/squads.json (Electron 主进程唯一写入者, 本进程只读)
     → 召回结果以 {type:"event", event:"summon"} 主动上报主进程 (播放音效反馈)
日志: 写入 {appRoot}/Data/Logs/_py_broker.log
"""
import sys
import json
import os
import platform
import traceback
import threading
import time
from datetime import datetime

OS = platform.system()
LOG_FILE = None  # 由外部通过 --log-file 参数或环境变量设置


_LOG_MAX_BYTES = 1024 * 1024  # ★ 单文件上限（2026-09-24 轮转：曾无上限 append，客户实例 28MB）
_snap_log_n = 0  # ★ mem-snapshot 日志降频计数器（2026-09-24：每 12 次快照 ≈1 分钟记一行）


def _log(msg: str):
    """写入日志文件（超 1MB 滚为 .old 单代覆盖）"""
    global LOG_FILE
    if not LOG_FILE:
        return
    try:
        ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        try:
            if os.path.getsize(LOG_FILE) > _LOG_MAX_BYTES:
                try:
                    os.remove(LOG_FILE + ".old")
                except OSError:
                    pass
                os.replace(LOG_FILE, LOG_FILE + ".old")
        except OSError:
            pass
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"{ts} {msg}\n")
    except Exception:
        pass


# =============================================================================
#  ★ 启动包集合内存+CPU 快照 — NtQuerySystemInformation (Win) ~7.5ms/次
#   画圈 = 主进程 + 全部后代进程树（递归）: IDE 本体 + py-broker + miniaudio +
#   goods python 全家。Σ 专用工作集（SYSTEM_PROCESS_INFORMATION offset 8
#   LARGE_INTEGER, 任务管理器「内存」列同口径——2026-08-29 实测 8/8 逐字节
#   命中 WMI WorkingSetPrivate）。CPU 差分原料: UserTime @ 0x28 + KernelTime
#   @ 0x30（各 8 字节 LARGE_INTEGER, 100ns ticks, 同结构体链——ImageName
#   @ 0x38/0x40 已实测验证, 前两字段位置必然正确, 2026-08-29 F36 实测 8/8
#   命中任务管理器）。mem-meter 每 5s 调用一次, 差分算利用率。
# =============================================================================
#  ★ v29 通道绝缘（2026-09-09 q209 f76 定案，替代 v28 分类层——废弃即删）：
#    统计圈 = 纯血缘进程树（受管通道圈）。唯一污染源 = win32 打开通道（openExternal/openPath
#    的 ShellExecuteW 由调用进程直接 CreateProcess → 目标 PPID = 主进程永久收养，F75 实测
#    solar-local.html → chrome×38 ≈2GB 入圈）。根治：打开通道全 relay 化（cmd /c start 毫秒
#    退出 → 目标 PPID = 已死 relay → 血缘结构性不可达）；POSIX open/xdg-open 天然同语义。
#    跨平台同一逻辑：受管 = 入圈，打开 = 交给系统（毫秒中转不留后代），零分类零登记。
#    v28 的 own/external exe 路径分类 + 外圈雷达 + pkgRoot 传参整体废弃（2026-09-09）。

def _win_mem_snapshot(root_pid: int):
    """NtQuery 全系统进程表 → root_pid + 全部后代（纯血缘进程树，v29 通道绝缘）。
    返回 {totalMB, nodes, ncpu, rows, nwin} 或 None。rows 的 ws 单位 KB；
    ut/kt = 100ns ticks（mem-meter 差分）。"""
    import ctypes
    import struct as _struct
    ntdll = ctypes.WinDLL('ntdll', use_last_error=True)
    # ★ NTSTATUS 无符号铁律（2026-09-15 实锤）：NtQuerySystemInformation 默认 restype=c_int
    #   → 失败码高位=1 被 ctypes 变负（0xC0000004 → -1073741820），与 Python 正数常量
    #   比较恒不等 → 缓冲不足时永不重试、静默 return None（进程表突破 1MB 后快照全灭，
    #   状态栏恒显示 --）。修复 = 显式 c_ulong + 掩码比较 + 失败落日志（防再静默）。
    ntdll.NtQuerySystemInformation.restype = ctypes.c_ulong
    ntdll.NtQuerySystemInformation.argtypes = [ctypes.c_ulong, ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p]
    STATUS_INFO_LENGTH_MISMATCH = 0xC0000004
    buf = None
    last_status = 0
    for size in (1 << 20, 4 << 20, 16 << 20, 64 << 20):
        b = ctypes.create_string_buffer(size)
        status = ntdll.NtQuerySystemInformation(5, b, size, None)  # 5 = SystemProcessInformation
        if status == 0:
            buf = b
            break
        last_status = status & 0xFFFFFFFF
        if last_status != STATUS_INFO_LENGTH_MISMATCH:
            break
    if buf is None:
        _log(f"mem-snapshot: NtQuery failed status=0x{last_status:08X} (buffers 1/4/16/64MB tried)")
        return None
    raw = buf.raw
    n = len(raw)
    base = ctypes.addressof(b)  # 缓冲区基址（ImageName.Buffer 指针换算偏移用）
    procs = {}
    off = 0
    while off + 8 <= n:
        next_off = _struct.unpack_from('<I', raw, off)[0]
        pid = _struct.unpack_from('<Q', raw, off + 80)[0]
        ppid = _struct.unpack_from('<Q', raw, off + 88)[0]
        if pid:
            # ImageName UNICODE_STRING @ 0x38: Length(2) MaxLen(2) pad(4) Buffer(8)
            name_len = _struct.unpack_from('<H', raw, off + 0x38)[0]
            name_ptr = _struct.unpack_from('<Q', raw, off + 0x40)[0]
            name = ''
            noff = name_ptr - base if name_ptr else -1
            if 0 <= noff < n and name_len > 0:
                try:
                    name = raw[noff:noff + name_len].decode('utf-16-le', 'replace')
                    name = name.split('\\')[-1]
                except Exception:
                    name = ''
            # (ppid, private_ws_bytes, name, ut_ticks, kt_ticks) — ut@0x28 kt@0x30 (100ns)
            procs[pid] = (ppid, _struct.unpack_from('<Q', raw, off + 8)[0], name,
                          _struct.unpack_from('<Q', raw, off + 0x28)[0],
                          _struct.unpack_from('<Q', raw, off + 0x30)[0])
        if not next_off:
            break
        off += next_off
    children = {}
    for pid, (ppid, _ws, _nm, _ut, _kt) in procs.items():
        children.setdefault(ppid, []).append(pid)
    # 单遍 BFS：主进程 + 全部后代（纯血缘——受管通道圈；打开通道已 relay 化 →
    # 外部程序 PPID = 已死 relay 结构性不可达，v28 分类代码已删）
    queue = [root_pid]
    seen = set()
    rows = []
    total = 0
    while queue:
        p = queue.pop(0)
        if p in seen:
            continue
        seen.add(p)
        info = procs.get(p)
        if info:
            ppid, ws, nm, ut, kt = info
            total += ws
            rows.append({'pid': p, 'ppid': ppid, 'ws': ws >> 10, 'n': nm, 'ut': ut, 'kt': kt})  # ws 单位 KB
        for c in children.get(p, []):
            if c not in seen:
                queue.append(c)
    # 窗口数（2026-09-05 q209 f66）: EnumWindows 顶层可见窗口且属主进程 pid——
    # Chromium 全部顶层窗口（IDE 各窗 + DevTools 独立窗）都由 browser 进程创建，
    # pid 过滤天然精确；dock 内嵌 DevTools 非顶层窗不计、隐藏窗 IsWindowVisible 滤掉
    # ——正是「用户能看到的一切窗口」口径（含开发者工具窗口）。~1ms 量级零负担。
    nwin = 0
    try:
        user32 = ctypes.windll.user32
        WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
        holder = [0]

        def _cb_win(hwnd, _lp):
            pid = ctypes.c_ulong()
            user32.GetWindowThreadProcessId(ctypes.c_void_p(hwnd), ctypes.byref(pid))
            if pid.value == root_pid and user32.IsWindowVisible(ctypes.c_void_p(hwnd)):
                holder[0] += 1
            return 1

        user32.EnumWindows(WNDENUMPROC(_cb_win), 0)
        nwin = holder[0]
    except Exception:
        nwin = 0
    total_mb = round(total / 1048576)
    # ★ 降频（2026-09-24）: mem-meter 每 5s 一快照，曾每次全量写日志（28MB 主源之一）→
    #   每 12 次（≈1 分钟）记一行；失败/异常路径日志不降频。
    global _snap_log_n
    _snap_log_n += 1
    if _snap_log_n % 12 == 1:
        _log(f"mem-snapshot: root={root_pid} nodes={len(rows)} total={total_mb}MB nwin={nwin}")
    return {'totalMB': total_mb, 'nodes': len(rows), 'ncpu': os.cpu_count() or 0,
            'rows': rows, 'nwin': nwin}


def _mac_mem_snapshot(root_pid: int):
    """macOS: libproc 全系统快照 → root_pid + 全部后代（纯血缘进程树，与 Win 同口径）。
    - 进程表: proc_listpids(PROC_ALL_PIDS)
    - ppid/名: proc_pidinfo(PROC_PIDTBSDINFO)（实测 sizeof=136: ppid@16 comm@48 name@64）
    - 内存: proc_pid_rusage(RUSAGE_INFO_V2).ri_phys_footprint@72（活动监视器「内存」
      列同口径=去重共享内存）；失败回落 PROC_PIDTASKINFO.pti_resident_size@8
    - CPU 时间: rusage ri_user_time@16 / ri_system_time@24（纳秒，VM busy-loop 实测
      0.93 核/1.0 正确）→ ÷100 换算 100ns ticks（与 Win 差分公式 dt/1e7 同量纲）；
      失败回落 taskinfo pti_total_user/system（同实测纳秒）
    返回 {totalMB, nodes, ncpu, rows, nwin} 或 None；rows 的 ws 单位 KB（与 Win 一致）。
    """
    import ctypes

    class _proc_bsdinfo(ctypes.Structure):
        _fields_ = [('pbi_flags', ctypes.c_uint32), ('pbi_status', ctypes.c_uint32),
                    ('pbi_xstatus', ctypes.c_uint32), ('pbi_pid', ctypes.c_uint32),
                    ('pbi_ppid', ctypes.c_uint32), ('pbi_uid', ctypes.c_uint32),
                    ('pbi_gid', ctypes.c_uint32), ('pbi_ruid', ctypes.c_uint32),
                    ('pbi_rgid', ctypes.c_uint32), ('pbi_svuid', ctypes.c_uint32),
                    ('pbi_svgid', ctypes.c_uint32), ('rfu_1', ctypes.c_uint32),
                    ('pbi_comm', ctypes.c_char * 16), ('pbi_name', ctypes.c_char * 32),
                    ('pbi_nfiles', ctypes.c_uint32), ('pbi_pgid', ctypes.c_uint32),
                    ('pbi_pjobc', ctypes.c_uint32), ('e_tdev', ctypes.c_uint32),
                    ('e_tpgid', ctypes.c_uint32), ('pbi_nice', ctypes.c_int32),
                    ('pbi_start_tvsec', ctypes.c_uint64), ('pbi_start_tvusec', ctypes.c_uint64)]

    class _proc_taskinfo(ctypes.Structure):
        _fields_ = [('pti_virtual_size', ctypes.c_uint64), ('pti_resident_size', ctypes.c_uint64),
                    ('pti_total_user', ctypes.c_uint64), ('pti_total_system', ctypes.c_uint64),
                    ('pti_threads_user', ctypes.c_uint64), ('pti_threads_system', ctypes.c_uint64),
                    ('pti_policy', ctypes.c_int32), ('pti_faults', ctypes.c_int32),
                    ('pti_pageins', ctypes.c_int32), ('pti_cow_faults', ctypes.c_int32),
                    ('pti_messages_sent', ctypes.c_int32), ('pti_messages_received', ctypes.c_int32),
                    ('pti_syscalls_mach', ctypes.c_int32), ('pti_syscalls_unix', ctypes.c_int32),
                    ('pti_csw', ctypes.c_int32), ('pti_threadnum', ctypes.c_int32),
                    ('pti_numrunning', ctypes.c_int32), ('pti_priority', ctypes.c_int32)]

    try:
        libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    except OSError:
        try:
            libproc = ctypes.CDLL('libproc.dylib', use_errno=True)
        except OSError:
            _log("mem-snapshot(mac): libproc.dylib load failed")
            return None

    libproc.proc_listpids.restype = ctypes.c_int
    libproc.proc_listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
    libproc.proc_pidinfo.restype = ctypes.c_int
    libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    libproc.proc_pid_rusage.restype = ctypes.c_int
    libproc.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]

    PROC_ALL_PIDS = 1
    PROC_PIDTBSDINFO = 3
    PROC_PIDTASKINFO = 4
    RUSAGE_INFO_V2 = 2

    # 1) 全部 pid（两段式：先问大小再取表）
    need = libproc.proc_listpids(PROC_ALL_PIDS, 0, None, 0)
    if need <= 0:
        _log("mem-snapshot(mac): proc_listpids size probe failed")
        return None
    cnt = need // ctypes.sizeof(ctypes.c_int) + 64
    arr = (ctypes.c_int * cnt)()
    got = libproc.proc_listpids(PROC_ALL_PIDS, 0, arr, ctypes.sizeof(arr))
    if got <= 0:
        _log("mem-snapshot(mac): proc_listpids fetch failed")
        return None
    pids = [p for p in arr[:min(cnt, got // ctypes.sizeof(ctypes.c_int))] if p > 0]

    # 2) 每进程取 ppid/名 + 内存 + CPU 时间（无权限的（如他人/系统进程）跳过，
    #    血缘树只依赖本方进程——同用户全可读）
    procs = {}
    ru_buf = ctypes.create_string_buffer(2048)  # rusage V2 结构 < 512B，留足余量
    for pid in pids:
        bsd = _proc_bsdinfo()
        if libproc.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ctypes.byref(bsd), ctypes.sizeof(bsd)) <= 0:
            continue
        try:
            nm = bytes(bsd.pbi_name).split(b'\x00', 1)[0].decode('utf-8', 'replace') or \
                 bytes(bsd.pbi_comm).split(b'\x00', 1)[0].decode('utf-8', 'replace')
        except Exception:
            nm = ''
        ws = 0
        ut = 0
        kt = 0
        ok = False
        ctypes.memset(ru_buf, 0, 2048)
        if libproc.proc_pid_rusage(pid, RUSAGE_INFO_V2, ru_buf) == 0:
            raw = ru_buf.raw
            ws = int.from_bytes(raw[72:80], 'little')           # ri_phys_footprint
            ut = int.from_bytes(raw[16:24], 'little') // 100    # ns → 100ns ticks
            kt = int.from_bytes(raw[24:32], 'little') // 100    # ns → 100ns ticks
            ok = True
        if (not ok) or ws <= 0:
            ti = _proc_taskinfo()
            if libproc.proc_pidinfo(pid, PROC_PIDTASKINFO, 0, ctypes.byref(ti), ctypes.sizeof(ti)) > 0:
                if ws <= 0:
                    ws = int(ti.pti_resident_size)
                if not ok:
                    ut = int(ti.pti_total_user) // 100
                    kt = int(ti.pti_total_system) // 100
                ok = True
        if not ok:
            continue
        procs[pid] = (int(bsd.pbi_ppid), ws, nm, ut, kt)

    children = {}
    for pid, (ppid, _ws, _nm, _ut, _kt) in procs.items():
        children.setdefault(ppid, []).append(pid)
    # 单遍 BFS：主进程 + 全部后代（纯血缘——与 v29 通道绝缘定案同语义）
    queue = [root_pid]
    seen = set()
    rows = []
    total = 0
    while queue:
        p = queue.pop(0)
        if p in seen:
            continue
        seen.add(p)
        info = procs.get(p)
        if info:
            ppid, ws, nm, ut, kt = info
            total += ws
            rows.append({'pid': p, 'ppid': ppid, 'ws': ws >> 10, 'n': nm, 'ut': ut, 'kt': kt})
        for c in children.get(p, []):
            if c not in seen:
                queue.append(c)
    # 窗口数：CGWindowList 屏上窗口按属主 pid（Electron 全部顶层窗归 browser 进程）
    nwin = 0
    try:
        from Quartz import CGWindowListCopyWindowInfo, kCGWindowListOptionOnScreenOnly, kCGNullWindowID
        for w in (CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID) or []):
            if w.get('kCGWindowOwnerPID') == root_pid:
                nwin += 1
    except Exception:
        nwin = 0
    total_mb = round(total / 1048576)
    global _snap_log_n   # ★ 降频（2026-09-24，同 Win 版）：每 12 次快照记一行
    _snap_log_n += 1
    if _snap_log_n % 12 == 1:
        _log(f"mem-snapshot(mac): root={root_pid} nodes={len(rows)} total={total_mb}MB nwin={nwin}")
    return {'totalMB': total_mb, 'nodes': len(rows), 'ncpu': os.cpu_count() or 0,
            'rows': rows, 'nwin': nwin}


def _win_rename_devtools(main_hwnd: int, new_title: str) -> dict:
    """
    Windows: EnumWindows 枚举所有顶层窗口 →
    标题以 "Developer Tools" 开头 → SetWindowTextW 改名。
    改名后的窗口不再匹配 "Developer Tools" 前缀，天然多窗口安全。
    额外尝试 GetWindow(GW_OWNER) 精确匹配作为可选过滤（不阻塞）。
    """
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    GW_OWNER = 4
    found = []
    renamed = []
    all_dev = []

    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    @WNDENUMPROC
    def _cb(hwnd, _lparam):
        buf = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(hwnd, buf, 512)
        title = buf.value
        if not title:
            return True
        if title.startswith("Developer Tools") or title.startswith("\u300c\ud83d\udd27\u300d"):
            all_dev.append((hwnd, title))
            # 尝试 GW_OWNER 匹配（可能返回 0 for detached DevTools）
            try:
                owner = user32.GetWindow(hwnd, GW_OWNER)
            except Exception:
                owner = 0
            if owner and owner != 0 and main_hwnd != 0 and owner == main_hwnd:
                found.append((hwnd, owner))
                return True
            # 如果没找到 owner 或 owner 为 0，仍然收集（fallback）
            if not owner or owner == 0:
                found.append((hwnd, 0))
        return True

    user32.EnumWindows(_cb, 0)

    _log(f"EnumWindows: all_dev={len(all_dev)} found={len(found)} mainHwnd={main_hwnd}")
    for hwnd, t in all_dev:
        _log(f"  DT: hwnd={hwnd} title=[{t}]")

    if not found:
        return {"ok": False, "error": f"No matching DevTools window (scanned {len(all_dev)} candidates)"}

    for hwnd, owner in found:
        ok = user32.SetWindowTextW(hwnd, new_title)
        _log(f"  SetWindowTextW hwnd={hwnd} owner={owner} result={ok}")
        if ok:
            renamed.append(hwnd)
        else:
            _log(f"  SetWindowTextW FAILED hwnd={hwnd} — possible permission issue")

    if renamed:
        return {"ok": True, "renamed": len(renamed)}
    return {"ok": False, "error": f"Found {len(found)} windows but SetWindowTextW failed for all"}


def _mac_rename_devtools(new_title: str) -> dict:
    """macOS: osascript 找 Electron 进程的 Developer Tools 窗口改名"""
    import subprocess
    # 双引号内的 new_title 可能含特殊字符，用 base64 传参
    import base64
    encoded = base64.b64encode(new_title.encode("utf-8")).decode()
    script = f'''
tell application "System Events"
    set appList to name of every process whose name contains "Electron"
    repeat with appName in appList
        tell process appName
            repeat with w in windows
                if name of w starts with "Developer Tools" or name of w starts with "「🔧」" then
                    set name of w to (do shell script "echo $(base64 -d <<< '{encoded}')")
                    return "ok"
                end if
            end repeat
        end tell
    end repeat
end tell
return "not found"
'''
    try:
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=10)
        _log(f"osascript: stdout={r.stdout.strip()} stderr={r.stderr.strip()}")
        if "ok" in r.stdout:
            return {"ok": True}
        return {"ok": False, "error": r.stdout.strip() or "No DevTools window"}
    except FileNotFoundError:
        return {"ok": False, "error": "osascript not found"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _linux_rename_devtools(new_title: str) -> dict:
    """Linux: wmctrl 找 Developer Tools 窗口改名"""
    import subprocess
    try:
        r = subprocess.run(["wmctrl", "-l"], capture_output=True, text=True, timeout=5)
        for line in r.stdout.splitlines():
            if "Developer Tools" in line or "「🔧」" in line:
                wid = line.split()[0]
                subprocess.run(["wmctrl", "-i", "-r", wid, "-N", new_title], timeout=5)
                return {"ok": True}
        return {"ok": False, "error": "No DevTools window"}
    except FileNotFoundError:
        return {"ok": False, "error": "wmctrl not installed"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# =============================================================================
#  ★ 窗口编队热键 (pynput) — Space + {1,2,q,w,a,s,z,x} 召回编队窗口
#   Truth: %LOCALAPPDATA%/qqqide/squads.json (Electron 主进程唯一写入者, 本进程只读)
# =============================================================================
_SQUAD_ORDER = ["1", "2", "q", "w", "a", "s", "z", "x"]
_SQUAD_CHARS = set(_SQUAD_ORDER)
_HOTKEY_LISTENER = None
_HOTKEY_PRESSED_KEYS = {}  # {normalized_key_str: press_timestamp_ms}
_HOTKEY_LOCK = threading.Lock()
_HOTKEY_ENABLED = True
_HOTKEY_LAST_TRIGGER = 0
_HOTKEY_DEBOUNCE_MS = 400
_HOTKEY_KEY_TTL_MS = 600  # 超过此时间的按键视为陈旧（漏掉的 release）

try:
    from pynput import keyboard as pynput_keyboard
    _HAS_PYNPUT = True
except Exception:
    _HAS_PYNPUT = False


def _squad_os_base():
    """OS 级目录根 — 与 shell portable-paths.getOsBaseDir() 逐字对齐。
    win: %LOCALAPPDATA% ｜ mac: ~/Library/Application Support ｜ linux: XDG_DATA_HOME 或 ~/.local/share"""
    if sys.platform == "darwin":
        return os.path.join(os.path.expanduser("~"), "Library", "Application Support")
    if sys.platform == "win32":
        return os.path.join(os.path.expanduser("~"), "AppData", "Local")
    return os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")


def _squad_registry_path():
    # 主进程真理源: squad-manager.ts registryPath（= {getOsBaseDir()}/qqqide/squads.json）
    # ★ 旧布局（win 式 ~/AppData/Local）保留兜底：迁移窗口期 / 旧包共存
    # ★ env LOCALAPPDATA 可能被 C 启动器便携层重定向 → 仅作候选，探测存在性优先
    candidates = [os.path.join(_squad_os_base(), "qqqide", "squads.json")]
    if sys.platform == "darwin":
        candidates.append(os.path.join(os.path.expanduser("~"), "AppData", "Local", "qqqide", "squads.json"))
    up = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    candidates.append(os.path.join(up, "AppData", "Local", "qqqide", "squads.json"))
    la = os.environ.get("LOCALAPPDATA")
    if la:
        candidates.append(os.path.join(la, "qqqide", "squads.json"))
    for c in candidates:
        if os.path.exists(c):
            return c
    return candidates[0] if candidates else ""


def _load_squad_registry():
    p = _squad_registry_path()
    if not p or not os.path.exists(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _normalize_key(key):
    """归一化 pynput 按键（win/mac press/release 可能产生不同对象）
    ★ mac: space 可能以 KeyCode(char=' ') 到达 → 先于 name 判定并转 special:space"""
    try:
        if hasattr(key, 'char') and key.char:
            if key.char == ' ':
                return "special:space"
            return "char:" + key.char.lower()
        if hasattr(key, 'name') and key.name:
            return "special:" + key.name
        if hasattr(key, 'vk') and key.vk is not None:
            if key.vk == 32:
                return "special:space"
            return "vk:" + str(key.vk)
    except Exception:
        pass
    return "raw:" + repr(key)


def _activate_window(hwnd):
    """还原最小化 + 绕过前台锁置前 + 聚焦"""
    import ctypes
    user32 = ctypes.windll.user32
    if not user32.IsWindow(hwnd):
        return
    user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    user32.keybd_event(0x12, 0, 0, 0)  # Alt down (bypass foreground lock)
    user32.SetForegroundWindow(hwnd)
    user32.keybd_event(0x12, 0, 2, 0)  # Alt up
    user32.BringWindowToTop(hwnd)


def _is_window_alive(hwnd, pid):
    """hwnd 存活 + 归属 pid 校验（防句柄复用）"""
    import ctypes
    try:
        user32 = ctypes.windll.user32
        if not user32.IsWindow(hwnd):
            return False
        cur = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(cur))
        return cur.value == pid
    except Exception:
        return False


def _find_hwnd_by_title(title, pid):
    """hwnd 失效时按 OS 标题 EnumWindows 找回（含 pid 校验）"""
    import ctypes
    from ctypes import wintypes
    try:
        user32 = ctypes.windll.user32
        found = []

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def _cb(hwnd, _lp):
            buf = ctypes.create_unicode_buffer(512)
            user32.GetWindowTextW(hwnd, buf, 512)
            if buf.value == title:
                cur = ctypes.c_ulong()
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(cur))
                if cur.value == pid:
                    found.append(hwnd)
                    return False
            return True

        user32.EnumWindows(_cb, 0)
        return found[0] if found else 0
    except Exception:
        return 0


def _mac_squad_summon(slot, entry):
    """macOS: NSRunningApplication 激活（应用激活不需辅助功能授权，TCC 不拦）。
    最小化窗口的还原由 Electron 侧 focusWindowBySlot 兜底（summon 事件回传后进程内执行）。"""
    pid = int(entry.get("pid") or 0)
    folder = str(entry.get("folder") or "")
    if pid <= 0:
        return {"ok": False, "folder": folder}
    try:
        os.kill(pid, 0)  # 进程存活校验（信号 0 探测，不发送真实信号）
    except OSError:
        _log(f"[Squad] summon {slot} miss (pid {pid} gone) folder={folder}")
        return {"ok": False, "folder": folder}
    try:
        from AppKit import NSRunningApplication, NSApplicationActivateIgnoringOtherApps
        app = NSRunningApplication.runningApplicationWithProcessIdentifier_(pid)
        if app is None:
            _log(f"[Squad] summon {slot} miss (no NSRunningApplication for pid {pid})")
            return {"ok": False, "folder": folder}
        try:
            if app.isActive():
                return {"ok": False, "folder": folder, "already": True}
        except Exception:
            pass
        try:
            if app.isHidden():
                app.unhide()
        except Exception:
            pass
        ok = bool(app.activateWithOptions_(NSApplicationActivateIgnoringOtherApps))
        if ok:
            _log(f"[Squad] summon {slot} pid={pid} folder={folder}")
            return {"ok": True, "folder": folder}
        _log(f"[Squad] summon {slot} activate returned False pid={pid}")
        return {"ok": False, "folder": folder}
    except Exception as e:
        _log(f"[Squad] mac summon exception: {e}")
        return {"ok": False, "folder": folder}


def _squad_summon(slot):
    """召回 slot 对应编队窗口 → {ok, folder, already}"""
    reg = _load_squad_registry()
    if not reg:
        return {"ok": False}
    slots = reg.get("slots") or {}
    entry = slots.get(slot)
    if not entry:
        return {"ok": False}
    if OS == "Darwin":
        return _mac_squad_summon(slot, entry)
    if OS != "Windows":
        return {"ok": False}
    pid = int(entry.get("pid") or 0)
    folder = str(entry.get("folder") or "")
    title = str(entry.get("title") or "")
    try:
        hwnd = int(entry.get("hwnd") or 0)
    except Exception:
        hwnd = 0
    if hwnd and not _is_window_alive(hwnd, pid):
        hwnd = 0
    if not hwnd and title:
        hwnd = _find_hwnd_by_title(title, pid)
    if not hwnd:
        _log(f"[Squad] summon {slot} miss (window gone) folder={folder}")
        return {"ok": False, "folder": folder}
    import ctypes
    user32 = ctypes.windll.user32
    if user32.GetForegroundWindow() == hwnd:
        return {"ok": False, "folder": folder, "already": True}
    _activate_window(hwnd)
    _log(f"[Squad] summon {slot} hwnd={hwnd} folder={folder}")
    return {"ok": True, "folder": folder, "title": title}


def _hotkey_on_press(key):
    """全局按键回调 — 归一化 + TTL 防幽灵触发 + 防抖"""
    global _HOTKEY_PRESSED_KEYS, _HOTKEY_LAST_TRIGGER
    if not _HOTKEY_ENABLED or not _HAS_PYNPUT:
        return
    now = time.time() * 1000
    norm = _normalize_key(key)
    with _HOTKEY_LOCK:
        _HOTKEY_PRESSED_KEYS[norm] = now
        stale_cutoff = now - _HOTKEY_KEY_TTL_MS
        for k in [k for k, ts in _HOTKEY_PRESSED_KEYS.items() if ts < stale_cutoff]:
            del _HOTKEY_PRESSED_KEYS[k]
        space_ts = _HOTKEY_PRESSED_KEYS.get("special:space")
        if not space_ts:
            return
        for ch in _SQUAD_CHARS:
            ch_ts = _HOTKEY_PRESSED_KEYS.get("char:" + ch)
            if not ch_ts:
                continue
            if abs(space_ts - ch_ts) > _HOTKEY_KEY_TTL_MS:
                continue
            if now - _HOTKEY_LAST_TRIGGER < _HOTKEY_DEBOUNCE_MS:
                return
            _HOTKEY_LAST_TRIGGER = now
            _HOTKEY_PRESSED_KEYS.pop("special:space", None)
            _HOTKEY_PRESSED_KEYS.pop("char:" + ch, None)
            r = _squad_summon(ch)
            try:
                sys.stdout.write(json.dumps({"type": "event", "event": "summon", "squad": ch, "ok": r.get("ok", False), "folder": r.get("folder", "")}, ensure_ascii=False) + "\n")
                sys.stdout.flush()
            except Exception:
                pass
            return


def _hotkey_on_release(key):
    if not _HAS_PYNPUT:
        return
    norm = _normalize_key(key)
    with _HOTKEY_LOCK:
        _HOTKEY_PRESSED_KEYS.pop(norm, None)


# ★ 跨进程互斥（2026-08-10 F15 缺口1）: 热键 = OS 直达的全局监听，dev + 绿色包同跑时
#   两个 pynput 钩子会双重触发召回（双激活 + 双音效）。每用户会话仅一个 broker
#   持有监听权（CreateMutexW Local\ 命名空间）: 先启动者监听，后启动者静默降级
#   为纯改名服务（stdin 职责保留）；持有者退出（mutex 自动释放）→ 让位者 5s 内
#   自动接管监听（_hotkey_guard_loop 自愈，监督者模式同款哲学）。
_HOTKEY_MUTEX_HANDLE = None
_HOTKEY_MUTEX_ACQUIRED = False
_HOTKEY_LISTENING = False
# 测试/会话隔离可经环境变量覆盖（零配置原则: 生产默认硬编码）
_MUTEX_NAME = os.environ.get("QQQIDE_SQUAD_MUTEX") or "Local\\QqqIdeSquadHotkey"


def _try_acquire_hotkey_mutex():
    """Win: CreateMutexW(Local\\QqqIdeSquadHotkey)；mac: /tmp flock — 抢到 True，被占 False"""
    global _HOTKEY_MUTEX_HANDLE, _HOTKEY_MUTEX_ACQUIRED
    if OS != "Windows":
        # ★ mac（2026-09-16）: 文件锁替代命名互斥——flock 随进程退出自动释放，与 mutex
        #   同语义（先启动者监听 / 后启动者改名服务 / 持有者退出 → guard 轮接管）
        try:
            import fcntl
            import tempfile
            lock_path = os.path.join(tempfile.gettempdir(), 'qqqide-squad-hotkey.lock')
            fh = open(lock_path, 'a+')
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            _HOTKEY_MUTEX_HANDLE = fh
            _HOTKEY_MUTEX_ACQUIRED = True
            _log("[Squad] hotkey flock acquired")
            return True
        except Exception as e:
            _log(f"[Squad] hotkey flock busy -> rename-only mode ({e})")
            return False
    import ctypes
    ERROR_ALREADY_EXISTS = 183
    try:
        handle = ctypes.windll.kernel32.CreateMutexW(None, False, _MUTEX_NAME)
        if not handle:
            _log("[Squad] CreateMutexW failed, hotkeys disabled")
            return False
        if ctypes.windll.kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
            ctypes.windll.kernel32.CloseHandle(handle)
            _log("[Squad] hotkey mutex held by another instance -> rename-only mode")
            return False
        _HOTKEY_MUTEX_HANDLE = handle
        _HOTKEY_MUTEX_ACQUIRED = True
        return True
    except Exception as e:
        _log(f"[Squad] mutex exception: {e}")
        return False


def _hotkey_guard_loop():
    """让位者自愈: 持有者退出后 mutex 自动释放 → 5s 轮询抢回并接管监听"""
    global _HOTKEY_MUTEX_ACQUIRED
    while True:
        time.sleep(5)
        if _HOTKEY_MUTEX_ACQUIRED or not _HAS_PYNPUT:
            continue
        if _try_acquire_hotkey_mutex():
            _log("[Squad] mutex acquired after holder exit, taking over listener")
            try:
                _start_hotkey_listener()
            except Exception as e:
                _log(f"[Squad] takeover listener start failed: {e}")


def _start_hotkey_listener():
    global _HOTKEY_LISTENER, _HOTKEY_LISTENING
    if not _HAS_PYNPUT:
        _log("[Squad] pynput not available, hotkeys disabled")
        return {"status": "error", "error": "pynput not installed"}
    if _HOTKEY_LISTENER is not None:
        return {"status": "already_running"}
    try:
        _HOTKEY_LISTENER = pynput_keyboard.Listener(on_press=_hotkey_on_press, on_release=_hotkey_on_release)
        _HOTKEY_LISTENER.daemon = True  # 不阻塞进程退出
        _HOTKEY_LISTENER.start()
        _HOTKEY_LISTENING = True
        _log("[Squad] hotkey listener started (Space+1/2/q/w/a/s/z/x)")
        return {"status": "started"}
    except Exception as e:
        _log(f"[Squad] hotkey listener failed: {e}")
        return {"status": "error", "error": str(e)}


def main():
    global LOG_FILE

    # 日志文件路径：从命令行参数或环境变量取
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--log-file", default=os.environ.get("PY_BROKER_LOG", ""))
    args, _ = ap.parse_known_args()
    if args.log_file:
        LOG_FILE = args.log_file
        # 确保日志目录存在
        d = os.path.dirname(LOG_FILE)
        if d and not os.path.exists(d):
            os.makedirs(d, exist_ok=True)

    # 无缓冲 stdout/stderr
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(line_buffering=True)

    _log("START")
    _log(f"OS={OS} python={sys.version} pid={os.getpid()}")

    # ★ 编队热键抢锁 + 监听（先于就绪信号 — ready.hotkeys 必须反映真实监听状态）
    #   mac（2026-09-16）: pynput 监听需「输入监控」TCC 授权 —— 未授权时 tap 静默无效；
    #   启动预检 + 触发系统授权弹窗（CGRequestListenEventAccess，仅首次）
    if OS in ("Windows", "Darwin"):
        if OS == "Darwin":
            try:
                from Quartz import CGPreflightListenEventAccess, CGRequestListenEventAccess
                granted = bool(CGPreflightListenEventAccess())
                _log(f"[Squad] mac input-monitoring preflight: {granted}")
                if not granted:
                    r = bool(CGRequestListenEventAccess())
                    _log(f"[Squad] mac input-monitoring request -> {r} (System Settings > Privacy > Input Monitoring)")
            except Exception as e:
                _log(f"[Squad] mac permission probe failed: {e}")
        _try_acquire_hotkey_mutex()
        if _HOTKEY_MUTEX_ACQUIRED:
            try:
                _start_hotkey_listener()
            except Exception as e:
                _log(f"[Squad] hotkey start failed: {e}")
        else:
            _log("[Squad] rename-only mode (no hotkey listener)")
            threading.Thread(target=_hotkey_guard_loop, daemon=True).start()

    # 就绪信号（hotkeys: 本实例是否实际持有全局热键监听, false=互斥让位已降级改名服务）
    sys.stdout.write(json.dumps({"type": "ready", "platform": OS, "hotkeys": _HOTKEY_LISTENING}, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    _log("sent ready signal")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError:
            _log(f"BAD JSON: {line[:200]}")
            continue

        action = cmd.get("action", "")
        rid = cmd.get("id", 0)
        result = {"id": rid, "action": action}

        try:
            if action == "ping":
                result["ok"] = True
            elif action == "exit":
                result["ok"] = True
                sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
                sys.stdout.flush()
                _log("EXIT command received")
                break
            elif action == "mem-snapshot":
                root_pid = int(cmd.get("rootPid") or 0)
                r = None
                err = "unsupported platform or missing rootPid"
                if root_pid > 0:
                    if OS == "Windows":
                        r = _win_mem_snapshot(root_pid)  # v29: 纯血缘整树（v28 pkgRoot 分类参数已废弃）
                        err = "NtQuery failed"
                    elif OS == "Darwin":
                        r = _mac_mem_snapshot(root_pid)
                        err = "libproc snapshot failed"
                if r is None:
                    result["ok"] = False
                    result["error"] = err
                else:
                    result["ok"] = True
                    result.update(r)
            elif action == "rename-devtools":
                _log(f"rename-devtools: mainHwnd={cmd.get('mainHwnd')} title={cmd.get('title')}")
                if OS == "Windows":
                    r = _win_rename_devtools(
                        int(cmd.get("mainHwnd", "0")),
                        str(cmd.get("title", "")),
                    )
                elif OS == "Darwin":
                    r = _mac_rename_devtools(str(cmd.get("title", "")))
                else:
                    r = _linux_rename_devtools(str(cmd.get("title", "")))
                result.update(r)
                _log(f"rename-devtools result: {json.dumps(r, ensure_ascii=False)}")
            else:
                result["ok"] = False
                result["error"] = f"Unknown action: {action}"
                _log(f"UNKNOWN action: {action}")
        except Exception:
            result["ok"] = False
            result["error"] = traceback.format_exc()
            _log(f"EXCEPTION: {traceback.format_exc()}")

        sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    _log("EXIT")


if __name__ == "__main__":
    main()
