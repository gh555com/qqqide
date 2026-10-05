# Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.
"""qqqide_evdev.py — Linux 原生按键源（/dev/input 内核级读取）

为什么需要它：X11 监听（XRecord/pynput）在 Wayland 会话下只能看到「X11 窗口获焦」时的
按键；Wayland 原生窗口获焦时按键不经 Xwayland → 全局热键（编队召回 / 3W 3X）天然失聪。
内核 evdev 通道与焦点、合成器无关，读到的是物理按键事件本身（X11/Wayland 通用）。

权限（一次性）：需可读 /dev/input/event*（桌面默认 root:input 0660）。
安装 uaccess 规则后，活动会话用户自动获得 ACL（无需重登录）：
  /etc/udev/rules.d/71-qqqide-input.rules
    SUBSYSTEM=="input", ENV{ID_INPUT_KEYBOARD}=="1", TAG+="uaccess"
  生效：udevadm control --reload-rules && udevadm trigger --subsystem-match=input

行为：只观测、不抓取（不吞键、不影响输入）；读取全部 event 设备（非关注键码自然过滤）；静默容忍热插拔。
API：
  probe() -> dict           诊断（设备列表/可读性）
  available() -> bool       是否已有可读键盘设备
  permission_hint() -> str  无权限时的安装提示（写日志用）
  KeySource(on_press, on_release)   .start() / .stop()
    回调收到规范键名：'space' / 'w' / 'x' / 'shift_l' / 'shift_r' / '1'..'0' / 'a'..'z'
    按下与内核 autorepeat 均按「按下」上报；释放为 'release'。
"""
import errno
import glob
import os
import select
import struct
import threading
import time

_EVENT_STRUCT = struct.Struct("=qqHHi")  # struct input_event（64 位平台 24 字节）
_EV_SIZE = _EVENT_STRUCT.size
_EV_KEY = 1

# 需要关注的键码（linux/input-event-codes.h）
_KEY_NAMES = {
    2: '1', 3: '2', 4: '3', 5: '4', 6: '5', 7: '6', 8: '7', 9: '8', 10: '9', 11: '0',
    16: 'q', 17: 'w', 18: 'e', 19: 'r', 20: 't', 21: 'y', 22: 'u', 23: 'i', 24: 'o', 25: 'p',
    30: 'a', 31: 's', 32: 'd', 33: 'f', 34: 'g', 35: 'h', 36: 'j', 37: 'k', 38: 'l',
    44: 'z', 45: 'x', 46: 'c', 47: 'v', 48: 'b', 49: 'n', 50: 'm',
    42: 'shift_l', 54: 'shift_r', 57: 'space',
}


def _candidate_devices():
    """全部 event 设备（不依赖 /proc 分类——uinput/虚拟键盘同样覆盖；非关注键码自然过滤）"""
    return sorted(glob.glob('/dev/input/event*'))


def _try_open(path):
    try:
        return os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    except OSError:
        return None


def probe():
    """{devices, readable, ok} — 诊断用"""
    devs = _candidate_devices()
    readable = []
    for d in devs:
        fd = _try_open(d)
        if fd is not None:
            readable.append(d)
            try:
                os.close(fd)
            except OSError:
                pass
    return {"devices": devs, "readable": readable, "ok": bool(readable)}


def available():
    return probe()["ok"]


def permission_hint():
    return ("no read access to /dev/input/event* — install one-time udev rule: "
            "SUBSYSTEM==\"input\", ENV{ID_INPUT_KEYBOARD}==\"1\", TAG+=\"uaccess\" "
            "-> /etc/udev/rules.d/71-qqqide-input.rules, then: "
            "udevadm control --reload-rules && udevadm trigger --subsystem-match=input")


class KeySource:
    """后台线程读取全部键盘设备的 evdev 事件流（静默容忍设备热插拔）"""

    def __init__(self, on_press=None, on_release=None):
        self._on_press = on_press
        self._on_release = on_release
        self._stop = threading.Event()
        self._thread = None
        self._fds = {}   # path -> fd
        self._bufs = {}  # path -> bytes

    def start(self):
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="qqqide-evdev", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _open_new(self):
        for path in _candidate_devices():
            if path in self._fds:
                continue
            fd = _try_open(path)
            if fd is not None:
                self._fds[path] = fd
                self._bufs[path] = b''

    def _drop(self, path):
        fd = self._fds.pop(path, None)
        self._bufs.pop(path, None)
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass

    def _run(self):
        rescan_at = 0.0
        while not self._stop.is_set():
            now = time.monotonic()
            if now >= rescan_at:
                rescan_at = now + 5.0
                self._open_new()
            if not self._fds:
                self._stop.wait(1.0)
                continue
            try:
                ready, _, _ = select.select(list(self._fds.values()), [], [], 1.0)
            except (OSError, ValueError):
                for p in list(self._fds):
                    self._drop(p)
                continue
            for fd in ready:
                path = None
                for p, f in self._fds.items():
                    if f == fd:
                        path = p
                        break
                if path is None:
                    continue
                try:
                    data = os.read(fd, _EV_SIZE * 128)
                except OSError as e:
                    if e.errno in (errno.ENODEV, errno.EIO, errno.EBADF, errno.EPERM, errno.EACCES):
                        self._drop(path)
                    continue
                if not data:
                    continue
                buf = self._bufs.get(path, b'') + data
                n = (len(buf) // _EV_SIZE) * _EV_SIZE
                self._bufs[path] = buf[n:]
                for off in range(0, n, _EV_SIZE):
                    try:
                        _s, _us, etype, code, value = _EVENT_STRUCT.unpack_from(buf, off)
                    except struct.error:
                        break
                    if etype != _EV_KEY:
                        continue
                    name = _KEY_NAMES.get(code)
                    if name is None:
                        continue
                    try:
                        if value == 0:
                            if self._on_release:
                                self._on_release(name)
                        else:
                            # value 1=按下 2=内核 autorepeat —— 均按「按下」上报（消费者自行区分用途）
                            if self._on_press:
                                self._on_press(name)
                    except Exception:
                        pass
