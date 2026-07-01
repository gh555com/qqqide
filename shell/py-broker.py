#!/usr/bin/env python3
"""py-broker.py — 跨平台窗口管理 broker for qqq IDE.
常驻子进程。stdin 读 JSON 行命令，stdout 返回 JSON 行响应。
日志: 写入 {projectRoot}/new_log/_py_broker.log
"""
import sys
import json
import os
import platform
import traceback
from datetime import datetime

OS = platform.system()
LOG_FILE = None  # 由外部通过 --log-file 参数或环境变量设置


def _log(msg: str):
    """写入日志文件"""
    global LOG_FILE
    if not LOG_FILE:
        return
    try:
        ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"{ts} {msg}\n")
    except Exception:
        pass


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
        if title.startswith("Developer Tools"):
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
                if name of w starts with "Developer Tools" then
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
            if "Developer Tools" in line:
                wid = line.split()[0]
                subprocess.run(["wmctrl", "-i", "-r", wid, "-N", new_title], timeout=5)
                return {"ok": True}
        return {"ok": False, "error": "No DevTools window"}
    except FileNotFoundError:
        return {"ok": False, "error": "wmctrl not installed"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


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

    # 就绪信号
    sys.stdout.write(json.dumps({"type": "ready", "platform": OS}, ensure_ascii=False) + "\n")
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
