# Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

# -*- coding: utf-8 -*-
# _singleton.py — goods 单例保护工具
# 用于 allowMultiple=false 的 goods，提供 PID 文件 + 文件锁双保险
#
# 协议 (2026-07-27 加固):
#   ⓪ 全局 OS 级文件锁 (msvcrt.locking) — 跨 IDE 实例第一道防线
#   ① 文件锁 (msvcrt.locking) — per-IDE 第二道防线，原子级，零竞态
#   ② PID 文件 — 第三道防线，跨窗口/跨 IDE 检测
#   ③ atexit + SIGTERM/SIGINT → 清理锁 + PID 文件
#
# 退出码约定:
#   100 = 单例冲突（另一实例已在运行）。gaea-process.ts 据此不删除 PID 文件。
#   0   = 正常退出。
#
# 用法:
#   from goods._singleton import check_and_register
#   check_and_register('kope-a')

import os
import sys
import atexit
import signal
import tempfile

_GOODS_PID_FILE = None
_GOODS_LOCK_FD = None
_GLOBAL_LOCK_FD = None


def _acquire_lock(lock_path):
    """文件锁 — 原子级跨进程互斥。
    Windows 用 msvcrt.locking，其他平台用 fcntl.flock。
    返回 True=获得锁, False=已被其他进程持有。
    """
    global _GOODS_LOCK_FD
    try:
        fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o644)
        if sys.platform == 'win32':
            import msvcrt
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        _GOODS_LOCK_FD = fd
        return True
    except (IOError, OSError, ImportError):
        try:
            os.close(fd)
        except:
            pass
        return False


def _release_lock():
    """释放文件锁（全局 + per-IDE）"""
    global _GOODS_LOCK_FD, _GLOBAL_LOCK_FD

    def _unlock_and_close(fd):
        if fd is None:
            return
        try:
            if sys.platform == 'win32':
                import msvcrt
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)
        except:
            try:
                os.close(fd)
            except:
                pass

    _unlock_and_close(_GOODS_LOCK_FD)
    _GOODS_LOCK_FD = None
    _unlock_and_close(_GLOBAL_LOCK_FD)
    _GLOBAL_LOCK_FD = None


def _is_pid_alive(pid):
    """检查 PID 是否存活（跨平台）"""
    try:
        if sys.platform == 'win32':
            import ctypes
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(0x00100000, False, pid)
            if handle:
                kernel32.CloseHandle(handle)
                return True
            return False
        else:
            os.kill(pid, 0)
            return True
    except Exception:
        return False


def _cleanup_pid_file():
    """清理 PID 文件"""
    global _GOODS_PID_FILE
    if _GOODS_PID_FILE and os.path.exists(_GOODS_PID_FILE):
        try:
            os.remove(_GOODS_PID_FILE)
        except Exception:
            pass


def _cleanup():
    """统一清理：PID 文件 + 文件锁"""
    _cleanup_pid_file()
    _release_lock()


def _on_terminate(signum, frame):
    """SIGTERM/SIGINT 处理器"""
    _cleanup()
    sys.exit(0)


def check_and_register(goods_id):
    """
    检查单例并注册 PID 文件。
    - 若已有实例运行 → print 消息 + sys.exit(100)
    - 否则 → 获得文件锁 + 写 PID 文件 + 注册清理回调
    """
    global _GOODS_PID_FILE, _GLOBAL_LOCK_FD

    # ⓪ ★ 全局 OS 级文件锁 — 跨 IDE 实例防多开（第一道防线）
    #     位置: C:\Users\{用户}\AppData\Local\{goods_id}\.singleton.lock
    #     整个操作系统只允许一个 goods 实例，无论开了多少个 IDE 窗口
    global_lock_dir = os.path.join(os.path.expanduser('~'), 'AppData', 'Local', goods_id)
    os.makedirs(global_lock_dir, exist_ok=True)
    global_lock_file = os.path.join(global_lock_dir, '.singleton.lock')
    try:
        gfd = os.open(global_lock_file, os.O_CREAT | os.O_RDWR, 0o644)
        if sys.platform == 'win32':
            import msvcrt
            msvcrt.locking(gfd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(gfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        _GLOBAL_LOCK_FD = gfd
    except (IOError, OSError, ImportError):
        try:
            os.close(gfd)
        except:
            pass
        print(f'[{goods_id}] Another IDE instance holds the global lock, exiting.')
        sys.exit(100)

    # ① 确定 PID 文件路径
    pid_file = None
    for i, arg in enumerate(sys.argv):
        if arg == '--pid-file' and i + 1 < len(sys.argv):
            pid_file = sys.argv[i + 1]
            break

    if not pid_file:
        pid_file = os.path.join(tempfile.gettempdir(), f'qqqide-goods-{goods_id}.pid')

    # ② 确保父目录存在
    pid_dir = os.path.dirname(pid_file)
    if pid_dir:
        os.makedirs(pid_dir, exist_ok=True)

    lock_file = pid_file + '.lock'

    # ③ ★ 文件锁 — 第二道防线，原子级互斥
    if not _acquire_lock(lock_file):
        # 释放全局锁再退出
        _release_lock()
        print(f'[{goods_id}] Another instance holds the lock, exiting.')
        sys.exit(100)

    # ④ ★ PID 检查 — 第三道防线，检测已有实例
    if os.path.exists(pid_file):
        try:
            with open(pid_file, 'r') as f:
                old_pid = int(f.read().strip().split('\n')[0])
            if old_pid == os.getpid():
                pass
            elif _is_pid_alive(old_pid):
                _release_lock()
                print(f'[{goods_id}] Already running (PID {old_pid}), exiting.')
                sys.exit(100)
            else:
                try:
                    os.remove(pid_file)
                except:
                    pass
        except Exception:
            pass

    # ⑤ 写 PID 文件
    _GOODS_PID_FILE = pid_file
    with open(pid_file, 'w') as f:
        f.write(f'{os.getpid()}\n')

    # ⑥ 注册清理回调
    atexit.register(_cleanup)
    signal.signal(signal.SIGTERM, _on_terminate)
    signal.signal(signal.SIGINT, _on_terminate)

    print(f'[{goods_id}] PID {os.getpid()} → {pid_file} (global: {global_lock_file})')
