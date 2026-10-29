# -*- coding: utf-8 -*-
"""cdp.py — 最小而够用的 CDP 客户端（浏览器原生调试协议）

依赖:  pip install requests websocket-client

端口解析（自动）:
    1. 环境变量 CDP_PORT（显式指定最优先 —— 手工指定的端点用它）
    2. qd 受控浏览器（kit/qdbrowser.py 起）—— 首选默认
       发现顺序 = 报告文件 → 权威 host.json（跨 TEMP 作用域也能找到同一实例）
       （qd 自带内核，零外部依赖；起法见 qdbrowser.py）
    3. 传统默认口 63788（兜底）

★ 身份（档案槽）：一切解析恒带槽位——默认槽 = 环境变量 CDP_PROFILE / 'default'。
  多身份并行时必须在连接前指定槽（否则会连到默认槽的浏览器 = 身份串了，最坏的错法）：
      cdp.use_profile("aliyun-a")     # 本进程后续一切调用恒走该槽
      CDP_PROFILE=aliyun-a python xxx.py
  ★ 槽位不会自动回退到别的槽（宁可直接报错，也不拿错身份操作）。

用法:
    import cdp
    t = cdp.tab_for_url("example.com")        # 按 URL 子串定位页
    tab = cdp.Tab(t["webSocketDebuggerUrl"])
    print(tab.js("document.title"))
    tab.shot("shot.png")

    # 起受控浏览器（若无）：
    import qdbrowser; qdbrowser.ensure_started(profile="aliyun-a")
    cdp.use_profile("aliyun-a")
"""
import os, sys, json, time, base64
import requests
import websocket

_LEGACY_PORT = 63788
PORT = _LEGACY_PORT          # 向后兼容常量（真实端口经 _resolve_port() 动态解析）
WS_TIMEOUT = 60
PROFILE = (os.environ.get("CDP_PROFILE") or "default").strip() or "default"   # 当前身份槽


def use_profile(slot):
    """切本进程的身份槽（后续一切解析恒走该槽）。返回槽名。"""
    global PROFILE
    PROFILE = (slot or "default").strip() or "default"
    return PROFILE


def _resolve_port():
    """自动解析 CDP 端口：env > 本槽受控浏览器 > 传统默认口（★ 不回退到其他槽）。"""
    env = os.environ.get("CDP_PORT")
    if env:
        try:
            return int(env)
        except ValueError:
            pass
    try:
        import qdbrowser
        ep = qdbrowser.read_live_endpoint(profile=PROFILE) or \
            qdbrowser.find_any_live_report(profile=PROFILE)
        if ep and ep.get("cdpPort"):
            return int(ep["cdpPort"])
    except Exception:
        pass
    return _LEGACY_PORT


def _base():
    return "http://127.0.0.1:%d" % _resolve_port()


def _host_endpoint():
    """本槽受控浏览器端点（host.json/报告文件；未运行 -> None）。"""
    try:
        try:
            import qdbrowser
        except Exception:
            _d = os.path.dirname(os.path.abspath(__file__))
            if _d not in sys.path:
                sys.path.insert(0, _d)
            import qdbrowser
        return qdbrowser.read_live_endpoint(profile=PROFILE) or \
            qdbrowser.find_any_live_report(profile=PROFILE)
    except Exception:
        return None


def version():
    """端点内核标识（/json/version 的 Browser；未运行 -> ''）。"""
    try:
        return (requests.get(_base() + "/json/version", timeout=6).json() or {}).get("Browser") or ""
    except Exception:
        return ""


def _endpoint_is_hidden():
    """受控浏览器是否隐藏档（无窗口）——隐藏窗不产帧，截图前需 screencast 唤醒。"""
    ep = _host_endpoint()
    return bool(ep and ep.get("hidden"))


def _host_pid():
    """受控浏览器进程 PID（未运行 → 0）。"""
    ep = _host_endpoint()
    try:
        return int(ep.get("pid")) if ep and ep.get("pid") else 0
    except Exception:
        return 0


def _restore_win(pid):
    """Windows：SetWindowPlacement + SW_SHOWNOACTIVATE 恢复最小化窗口（无焦点；实测三策略后正解）。"""
    try:
        import ctypes
        import ctypes.wintypes as wt
        u = ctypes.windll.user32
        hit = [0]

        class _WP(ctypes.Structure):          # WINDOWPLACEMENT
            _fields_ = [("length", wt.UINT), ("flags", wt.UINT), ("showCmd", wt.UINT),
                        ("ptMinPosition", wt.POINT), ("ptMaxPosition", wt.POINT),
                        ("rcNormalPosition", wt.RECT)]

        @ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
        def _cb(hwnd, lp):
            p = wt.DWORD()
            u.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
            if p.value == pid and u.IsIconic(hwnd):
                # SetWindowPlacement + SW_SHOWNOACTIVATE：恢复但不抢焦点（实测：SW_SHOWNA 不恢复，
                # SW_RESTORE 恢复但抢焦点——三策略对照后的正解）
                wp = _WP()
                wp.length = ctypes.sizeof(_WP)
                u.GetWindowPlacement(hwnd, ctypes.byref(wp))
                wp.showCmd = 4
                u.SetWindowPlacement(hwnd, ctypes.byref(wp))
                if u.IsIconic(hwnd):
                    u.ShowWindow(hwnd, 9)     # 兜底（可能抢焦点，仅异常布局命中）
                hit[0] += 1
            return True

        u.EnumWindows(_cb, 0)
        if hit[0]:
            import time as _t
            _t.sleep(0.6)
    except Exception:
        pass


def _linux_iconic(wid):
    """窗口是否处于最小化（WM_STATE = Iconic；xprop 不可用/查询失败 → False 不动作）。"""
    try:
        import subprocess as _sp
        out = _sp.run(["xprop", "-id", str(wid), "WM_STATE"],
                      stdout=_sp.PIPE, stderr=_sp.DEVNULL, timeout=3).stdout
        return "Iconic" in (out or b"").decode("utf-8", "replace")
    except Exception:
        return False


def _restore_linux(pid):
    """Linux：xdotool 恢复最小化窗口（X11/XWayland；无 xdotool / 无图形会话 → 静默跳过）。
    ★ 真机实测（2026-10-14）：windowmap 不解除 iconic（状态恒 Iconic）——唯一有效解 =
    windowactivate（会带焦点，最小化恢复场景可接受）；先查 WM_STATE 避免对正常窗口多余动作。"""
    try:
        import shutil
        import subprocess as _sp
        if not shutil.which("xdotool"):
            return
        if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
            return
        r = _sp.run(["xdotool", "search", "--pid", str(pid)],
                    stdout=_sp.PIPE, stderr=_sp.DEVNULL, timeout=4)
        for wid in (r.stdout or b"").decode("utf-8", "replace").split():
            if not _linux_iconic(wid):
                continue
            _sp.run(["xdotool", "windowactivate", "--sync", wid],
                    stdout=_sp.DEVNULL, stderr=_sp.DEVNULL, timeout=6)
    except Exception:
        pass


def _restore_mac(pid):
    """macOS：osascript reopen（best-effort；仅快探失败后的重试路径调用——正常截图不抢焦点）。"""
    try:
        import subprocess as _sp
        r = _sp.run(["ps", "-p", str(pid), "-o", "comm="], stdout=_sp.PIPE,
                    stderr=_sp.DEVNULL, timeout=3)
        comm = (r.stdout or b"").decode("utf-8", "replace").strip()
        if ".app/Contents/MacOS/" not in comm:
            return
        app_path = comm.split(".app/Contents/MacOS/")[0] + ".app"
        _sp.run(["osascript", "-e", 'tell application "%s" to reopen' % app_path],
                stdout=_sp.DEVNULL, stderr=_sp.DEVNULL, timeout=6)
    except Exception:
        pass


def _restore_host_windows(include_mac=False):
    """恢复受控浏览器进程被最小化/隐藏的窗口（best-effort；截图前调用）。
    背景：窗口最小化 → 渲染帧停产 → CDP 截图挂起直到超时——截图前先自动恢复。
    平台分派：Windows=Win32 无焦点恢复（安全，可直接预调用）；Linux=xdotool windowmap（无焦点）；
    macOS=osascript reopen（可能抢焦点——仅快探失败后的重试路径传 include_mac=True 调用）。
    失败一律静默——screencast 唤醒兜底（隐藏窗/停帧态通用解药）。"""
    pid = _host_pid()
    if pid <= 0:
        return
    if os.name == "nt":
        _restore_win(pid)
    elif sys.platform == "darwin":
        if include_mac:
            _restore_mac(pid)
    elif sys.platform.startswith("linux"):
        _restore_linux(pid)


def list_tabs():
    """当前所有页（含后台页）。"""
    return requests.get(_base() + "/json/list", timeout=10).json()


def first_page():
    """第一个 page 目标（页面漂移时的兜底取法）。"""
    for t in list_tabs():
        if t.get("type") == "page":
            return t
    return None


def new_tab(url="about:blank"):
    """新开一页。外部内核（Chrome/Edge）原生支持 /json/new；内置受控浏览器不支持——
    内置开页用 qdbrowser.ensure_started(url=...)（新起=加载 / 复用=导航主窗）；已有页换址用 tab.goto。"""
    try:
        r = requests.put(_base() + "/json/new?" + url, timeout=15)
        return r.json()
    except Exception:
        return requests.get(_base() + "/json/new?" + url, timeout=15).json()


def tab_for_url(substr):
    """按 URL 子串找第一个 page 目标；找不到返回 None。
    ★ 永远用它定位页，绝不要按序号（页会漂移）。"""
    for t in list_tabs():
        if t.get("type") == "page" and substr in (t.get("url") or ""):
            return t
    return None


class Tab(object):
    def __init__(self, ws_url, timeout=30):
        self.ws = websocket.create_connection(ws_url, timeout=timeout,
                                              max_size=64 * 1024 * 1024)
        self.ws_url = ws_url
        self.i = 0

    # ---- 原生调用 ----
    def call(self, method, **params):
        self.i += 1
        mid = self.i
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        end = time.time() + WS_TIMEOUT
        while time.time() < end:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError("%s -> %s" % (method, msg["error"]))
                return msg.get("result")
        raise RuntimeError("timeout: " + method)

    # ---- 常用动作 ----
    def js(self, expr, await_promise=False):
        """在页面里执行 JS 并取回值（页面里抛错会抛 RuntimeError）。"""
        r = self.call("Runtime.evaluate", expression=expr, returnByValue=True,
                      awaitPromise=await_promise, userGesture=True)
        if r.get("exceptionDetails"):
            raise RuntimeError(json.dumps(r["exceptionDetails"])[:500])
        return r.get("result", {}).get("value")

    def goto(self, url, wait=3.0):
        self.call("Page.enable")
        self.call("Page.navigate", url=url)
        time.sleep(wait)
        return self.js("location.href")

    def insert_text(self, text):
        """把文字"打"进当前焦点元素 —— 可信事件，React 也认（03-M3 A 档）。"""
        self.call("Input.insertText", text=text)

    def press_key(self, key, vk=None, code=None, modifiers=0):
        p = {"key": key, "modifiers": modifiers}
        if vk is not None:
            p["windowsVirtualKeyCode"] = vk
        if code:
            p["code"] = code
        self.call("Input.dispatchKeyEvent", type="rawKeyDown", **p)
        self.call("Input.dispatchKeyEvent", type="keyUp", **p)

    def paste(self):
        """发一个"粘贴"命令（光标先放进目标软；配合 pin.py 使用，03-M7）。
        mac 用 Cmd+V，其余平台 Ctrl+V（commands 通道为主，修饰键兜底）。"""
        mod = 4 if sys.platform == "darwin" else 2
        self.call("Input.dispatchKeyEvent", type="keyDown", commands=["paste"],
                  key="v", code="KeyV", windowsVirtualKeyCode=86, modifiers=mod)

    def click_xy(self, x, y):
        """真鼠标点击。坐标请先 clamp() 进视口 —— 视口外会静默落空（04-坑1）。"""
        self.call("Input.dispatchMouseEvent", type="mouseMoved", x=x, y=y)
        time.sleep(0.08)
        self.call("Input.dispatchMouseEvent", type="mousePressed", x=x, y=y,
                  button="left", clickCount=1)
        self.call("Input.dispatchMouseEvent", type="mouseReleased", x=x, y=y,
                  button="left", clickCount=1)

    def hover_xy(self, x, y):
        """真鼠标悬停（用于 hover 才挂载的悬浮菜单，04-坑5）。"""
        self.call("Input.dispatchMouseEvent", type="mouseMoved", x=x, y=y)

    def viewport(self):
        return {"w": self.js("innerWidth") or 1280, "h": self.js("innerHeight") or 800}

    def clamp(self, x, y):
        """把坐标钳制进视口（真鼠标事件前必做）。"""
        vp = self.viewport()
        return (min(max(4, x), vp["w"] - 4), min(max(4, y), vp["h"] - 4))

    def _grab(self, params, wake, read_timeout=None):
        """单轮抓图。wake=True 时用 screencast 强制帧生产（隐藏窗/停帧态必需）。
        read_timeout：本轮等待帧的上限（秒）——超时快速放弃，交由外层走唤醒重试。"""
        if wake:
            try:
                self.call("Page.startScreencast", format="jpeg", quality=40,
                          maxWidth=640, maxHeight=480, everyNthFrame=5)
                time.sleep(0.25)
            except Exception:
                pass
        old_to = None
        try:
            if read_timeout:
                try:
                    old_to = self.ws.gettimeout()
                except Exception:
                    old_to = None
                self.ws.settimeout(read_timeout)
            r = self.call("Page.captureScreenshot", **params)
        except Exception:
            return None          # 帧停产/超时——交由外层换新连接重试
        finally:
            if read_timeout and old_to is not None:
                try:
                    self.ws.settimeout(old_to)
                except Exception:
                    pass
        if wake:
            try:
                self.call("Page.stopScreencast")
            except Exception:
                pass
        return r.get("data")

    def shot(self, path, full=False):
        """截图存盘（full=True 为整页）。四重帧保障：
        遮挡/失焦照常出图 → 最小化先自动恢复窗口（平台分派）→ 首轮 4s 快探：
        无帧立即换新连接 + screencast 唤醒重试（隐藏档/停帧态；mac 重试路径另加 osascript 恢复）——
        渲染帧停产是截图唯一的死因；快探保证任何环境下都不再干等长超时。"""
        _restore_host_windows()
        params = {"format": "png"}
        if full:
            params["captureBeyondViewport"] = True
        data = self._grab(params, _endpoint_is_hidden(), read_timeout=4.0)
        if not data:
            _restore_host_windows(include_mac=True)      # 二次机会（首查与拍摄之间才被最小化的窄窗）
            try:
                self.ws.close()
            except Exception:
                pass
            alt = Tab(self.ws_url)
            try:
                data = alt._grab(params, True, read_timeout=15.0)   # 唤醒重试有时限（失败快报，不干等 60s）
            finally:
                try:
                    alt.ws.close()
                except Exception:
                    pass
        if not data:
            raise RuntimeError("截图失败：渲染帧停产（窗口被最小化/隐藏且唤醒未成）"
                               "——恢复窗口后重试")
        open(path, "wb").write(base64.b64decode(data))
        return path

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass
