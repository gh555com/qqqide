# -*- coding: utf-8 -*-
"""browser_engine.py — 外部内核（Chrome/Edge/Brave/Chromium）发现与启动（仅标准库）

定位：**内核是消耗品，档案是资产。** 本模块只管一件事——在用户机器上找到一颗
够新的 Chromium 内核并把它拉起成 CDP 端点；档案（登录态）由调用方（qdbrowser）
持有的槽位目录决定，与内核完全解耦。

发现顺序（先显式、后系统）：
    ① --browser / 环境变量 CDP_BROWSER（绝对路径，用户指定最高优先）
    ② 系统注册表 App Paths（Windows：chrome.exe / msedge.exe — 这是各安装器必写的键）
    ③ 标准安装路径（Win/mac 常见三处）
    ④ PATH 里的可执行名（Linux 为主）

启动方式：
    --user-data-dir=<槽位目录> + --remote-debugging-port=0
    端口由内核自己写进 {槽位目录}/DevToolsActivePort —— 零竞态，禁扫描猜口。
    （新版内核强制要求 --user-data-dir 非默认目录才允许远程调试；本模块恒给。）

★ 边界（如实）：外部内核只提供「CDP 端点 + 独立档案」。壳层受控浏览器域的那些
  能力（hidden 档语义 / 空闲自退 / 监督进程跟随 / 下载落点策略 / 权限白名单 /
  导航白名单）**在外部内核上不存在**——那是我们内置域独有的。要那些就 --engine=builtin。
"""
import os
import platform
import re
import shutil
import subprocess
import sys
import time

IS_WIN = platform.system() == "Windows"
IS_MAC = platform.system() == "Darwin"
_DETACHED = 0x00000008 | 0x00000200           # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP

_WIN_PATHS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
    r"C:\Program Files\Chromium\Application\chrome.exe",
]
_MAC_PATHS = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
]
_NIX_NAMES = ["google-chrome", "google-chrome-stable", "chromium",
              "chromium-browser", "microsoft-edge", "brave-browser"]

# Windows App Paths（各安装器必写的注册表键；便携版不会写 —— 那类只能用 --browser/CDP_BROWSER）
_WIN_APP_PATHS = [
    ("HKLM", r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"),
    ("HKCU", r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"),
    ("HKLM", r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"),
    ("HKCU", r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"),
    ("HKLM", r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\brave.exe"),
]


def _family_of(p):
    n = os.path.basename(p).lower()
    if "msedge" in n:
        return "edge"
    if "brave" in n:
        return "brave"
    if "chromium" in n:
        return "chromium"
    return "chrome"


def _win_app_path(reg_root, key):
    try:
        import winreg
        root = winreg.HKEY_LOCAL_MACHINE if reg_root == "HKLM" else winreg.HKEY_CURRENT_USER
        with winreg.OpenKey(root, key) as k:
            v, _ = winreg.QueryValueEx(k, "")
            return v or None
    except Exception:
        return None


def find(explicit=None):
    """-> {"path":绝对路径, "family":"chrome|edge|brave|chromium", "source":"..."} 或 None。"""
    tried = []
    # ① 显式
    for cand, src in ((explicit, "--browser"), (os.environ.get("CDP_BROWSER"), "CDP_BROWSER")):
        if cand:
            p = os.path.abspath(os.path.expandvars(cand))
            if os.path.exists(p):
                return {"path": p, "family": _family_of(p), "source": src}
            tried.append("%s=%s（不存在）" % (src, cand))
    # ② 注册表 App Paths（Windows 权威安装位）
    if IS_WIN:
        for reg_root, key in _WIN_APP_PATHS:
            v = _win_app_path(reg_root, key)
            if v and os.path.exists(v):
                return {"path": os.path.abspath(v), "family": _family_of(v), "source": "app-paths"}
    # ③ 标准路径
    for p in (_WIN_PATHS if IS_WIN else (_MAC_PATHS if IS_MAC else [])):
        if os.path.exists(p):
            return {"path": os.path.abspath(p), "family": _family_of(p), "source": "standard"}
    # ④ PATH
    for name in _NIX_NAMES:
        p = shutil.which(name)
        if p:
            return {"path": os.path.abspath(p), "family": _family_of(p), "source": "PATH"}
    return None


def launch(exe, profile_dir, url=None, headless=False, extra_args=None):
    """以调试模式拉起外部内核；返回 Popen 的 pid（仅参考——停止请按端口找进程）。"""
    os.makedirs(profile_dir, exist_ok=True)
    try:
        os.remove(os.path.join(profile_dir, "DevToolsActivePort"))
    except OSError:
        pass
    args = [
        exe,
        "--user-data-dir=" + profile_dir,
        "--remote-debugging-port=0",          # 端口由内核写 DevToolsActivePort（零竞态）
        "--remote-allow-origins=*",           # 新版内核拒收带 Origin 的 WS 连接时需要
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-popup-blocking",
        "--disable-features=TranslateUI,MediaRouter",
    ]
    if headless:
        args.append("--headless=new")
    args.extend(extra_args or [])
    if url:
        args.append(url)
    kwargs = {"close_fds": True, "stdin": subprocess.DEVNULL,
              "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if IS_WIN:
        kwargs["creationflags"] = _DETACHED
    else:
        kwargs["start_new_session"] = True
    p = subprocess.Popen(args, **kwargs)
    return p.pid


def read_active_port(profile_dir, timeout=45.0):
    """读 {profile_dir}/DevToolsActivePort 第一行（内核自报端口）。超时 -> None。"""
    f = os.path.join(profile_dir, "DevToolsActivePort")
    end = time.time() + max(2.0, float(timeout))
    while time.time() < end:
        try:
            with open(f, "r", encoding="utf-8") as fh:
                first = (fh.readline() or "").strip()
            if first:
                port = int(first)
                if 0 < port < 65536:
                    return port
        except Exception:
            pass
        time.sleep(0.3)
    return None


def pid_on_port(port):
    """谁在监听这个端口（停止用）。找不到 -> 0。"""
    port = int(port or 0)
    if port <= 0:
        return 0
    if IS_WIN:
        try:
            out = subprocess.run(["netstat", "-ano"], stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, timeout=8,
                                 creationflags=0x08000000).stdout
            rx = re.compile((":%d(\\s|$)" % port).encode())
            for line in (out or b"").decode("utf-8", "replace").splitlines():
                if "LISTENING" in line and rx.search(line.encode()):
                    tail = line.split()
                    if tail and tail[-1].isdigit():
                        return int(tail[-1])
        except Exception:
            return 0
        return 0
    try:
        out = subprocess.run(["lsof", "-ti", "tcp:%d" % port, "-sTCP:LISTEN"],
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=8).stdout
        for tok in (out or b"").decode("utf-8", "replace").split():
            if tok.isdigit():
                return int(tok)
    except Exception:
        pass
    try:                                   # 最小化 Linux 无 lsof 时用 ss 兜底
        out = subprocess.run(["ss", "-ltnp"], stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, timeout=8).stdout
        for line in (out or b"").decode("utf-8", "replace").splitlines():
            if (":%d " % port) in line or (":%d\t" % port) in line:
                m = re.search(r"pid=(\d+)", line)
                if m:
                    return int(m.group(1))
    except Exception:
        pass
    return 0
