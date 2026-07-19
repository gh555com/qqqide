# -*- coding: utf-8 -*-
# _singleton.py — goods 单例保护工具
# 用于 allowMultiple=false 的 goods，提供 PID 文件协议的 Python 端实现。
#
# 协议 (2026-07-19):
#   ① qqqide spawn 时传 --pid-file <path> → 脚本写 PID 到指定路径
#   ② 外部启动时无 --pid-file → 回退到系统临时目录
#   ③ 启动前检查 PID 文件 → 若进程存活则 sys.exit(0)
#   ④ atexit + SIGTERM/SIGINT → 清理 PID 文件
#
# 用法:
#   from goods._singleton import check_and_register
#   check_and_register('kope-a')  # 若已有实例运行则直接退出

import os
import sys
import atexit
import signal

_GOODS_PID_FILE = None


def _is_pid_alive(pid):
    """检查 PID 是否存活（跨平台）"""
    try:
        if sys.platform == 'win32':
            import ctypes
            kernel32 = ctypes.windll.kernel32
            # SYNCHRONIZE 权限足够检测进程是否存在
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
    """清理 PID 文件（atexit / signal handler）"""
    global _GOODS_PID_FILE
    if _GOODS_PID_FILE and os.path.exists(_GOODS_PID_FILE):
        try:
            os.remove(_GOODS_PID_FILE)
        except Exception:
            pass


def _on_terminate(signum, frame):
    """SIGTERM/SIGINT 处理器"""
    _cleanup_pid_file()
    sys.exit(0)


def check_and_register(goods_id):
    """
    检查单例并注册 PID 文件。
    - 若已有实例运行 → print 消息 + sys.exit(0)
    - 否则 → 写 PID 文件 + 注册清理回调
    """
    global _GOODS_PID_FILE

    # ① 确定 PID 文件路径
    pid_file = None
    for i, arg in enumerate(sys.argv):
        if arg == '--pid-file' and i + 1 < len(sys.argv):
            pid_file = sys.argv[i + 1]
            break

    if not pid_file:
        # 外部启动 → 回退到临时目录
        import tempfile
        pid_file = os.path.join(tempfile.gettempdir(), f'qqqide-goods-{goods_id}.pid')

    # ② 确保父目录存在
    pid_dir = os.path.dirname(pid_file)
    if pid_dir:
        os.makedirs(pid_dir, exist_ok=True)

    # ③ 检查已有实例
    if os.path.exists(pid_file):
        try:
            with open(pid_file, 'r') as f:
                old_pid = int(f.read().strip().split('\n')[0])
            if _is_pid_alive(old_pid):
                print(f'[{goods_id}] Already running (PID {old_pid}), exiting.')
                sys.exit(0)
            else:
                # Stale PID file — clean up
                os.remove(pid_file)
        except Exception:
            pass

    # ④ 写 PID 文件
    _GOODS_PID_FILE = pid_file
    with open(pid_file, 'w') as f:
        f.write(f'{os.getpid()}\n')

    # ⑤ 注册清理回调
    atexit.register(_cleanup_pid_file)
    signal.signal(signal.SIGTERM, _on_terminate)
    signal.signal(signal.SIGINT, _on_terminate)

    print(f'[{goods_id}] PID {os.getpid()} → {pid_file}')
