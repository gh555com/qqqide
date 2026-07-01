#!/usr/bin/env python3
"""py-broker.py — 跨平台窗口管理 broker for qqq IDE.
常驻子进程。stdin 读 JSON 行命令，stdout 返回 JSON 行响应。
启动时输出 {"type":"ready","platform":"..."} 告知就绪。
"""
import sys
import json
import os
import platform
import traceback

OS = platform.system()


def _win_rename_devtools(main_hwnd: int, new_title: str) -> dict:
    """Windows: EnumWindows + GW_OWNER 精确匹配 → SetWindowTextW"""
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    GW_OWNER = 4
    found = []

    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    @WNDENUMPROC
    def _cb(hwnd, _lparam):
        buf = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(hwnd, buf, 512)
        title = buf.value
        if title and title.startswith("Developer Tools"):
            owner = user32.GetWindow(hwnd, GW_OWNER)
            if owner == main_hwnd:
                found.append(hwnd)
        return True

    user32.EnumWindows(_cb, 0)

    if not found:
        return {"ok": False, "error": "No matching DevTools window for this main window"}

    for hwnd in found:
        ok = user32.SetWindowTextW(hwnd, new_title)
        if not ok:
            return {"ok": False, "error": f"SetWindowTextW failed hwnd={hwnd}"}

    return {"ok": True, "renamed": len(found)}


def _mac_rename_devtools(new_title: str) -> dict:
    """macOS: osascript 遍历 Electron 进程窗口改名"""
    script = f'''
tell application "System Events"
    set appList to name of every process whose name contains "Electron"
    repeat with appName in appList
        tell process appName
            repeat with w in windows
                if name of w starts with "Developer Tools" then
                    set name of w to "{new_title}"
                    return "ok"
                end if
            end repeat
        end tell
    end repeat
end tell
return "not found"
'''
    try:
        import subprocess
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=5)
        if "ok" in r.stdout:
            return {"ok": True}
        return {"ok": False, "error": r.stdout.strip() or "No DevTools window"}
    except FileNotFoundError:
        return {"ok": False, "error": "osascript not found"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _linux_rename_devtools(new_title: str) -> dict:
    """Linux: wmctrl 找 Developer Tools 窗口改名"""
    try:
        import subprocess
        r = subprocess.run(["wmctrl", "-l"], capture_output=True, text=True, timeout=5)
        for line in r.stdout.splitlines():
            if "Developer Tools" in line:
                wid = line.split()[0]
                subprocess.run(["wmctrl", "-i", "-r", wid, "-N", new_title], timeout=5)
                return {"ok": True}
        return {"ok": False, "error": "No DevTools window found"}
    except FileNotFoundError:
        return {"ok": False, "error": "wmctrl not installed"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── 命令分发 ──
_HANDLERS = {}

if OS == "Windows":
    _HANDLERS["rename-devtools"] = lambda c: _win_rename_devtools(
        int(c.get("mainHwnd", "0")),
        str(c.get("title", "")),
    )
elif OS == "Darwin":
    _HANDLERS["rename-devtools"] = lambda c: _mac_rename_devtools(
        str(c.get("title", "")),
    )
else:
    _HANDLERS["rename-devtools"] = lambda c: _linux_rename_devtools(
        str(c.get("title", "")),
    )


def main():
    # 确保 stdout 无缓冲
    sys.stdout.reconfigure(line_buffering=True) if hasattr(sys.stdout, "reconfigure") else None
    sys.stderr.reconfigure(line_buffering=True) if hasattr(sys.stderr, "reconfigure") else None

    # 启动就绪信号
    sys.stdout.write(json.dumps({"type": "ready", "platform": OS}, ensure_ascii=False) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError:
            sys.stderr.write(f"[py-broker] bad json: {line}\n")
            sys.stderr.flush()
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
                break
            elif action in _HANDLERS:
                r = _HANDLERS[action](cmd)
                result.update(r)
            else:
                result["ok"] = False
                result["error"] = f"Unknown action: {action}"
        except Exception:
            result["ok"] = False
            result["error"] = traceback.format_exc()

        sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
