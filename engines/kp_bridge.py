# ============================================================================
# kp_bridge.py
# Single-shot JSON-stdin/stdout helper that ports a subset of q3/src/kp.py
# system-info actions for qqq-shell-v2.
#
# Wire format (one JSON object per invocation):
#   stdin : {"action":"<name>", ...params}
#   stdout: {"ok":true, "data": <any>}   OR   {"ok":false, "error":"..."}
#
# Actions:
#   ping                                    -> {alive: true, pid}
#   disk_free_batch  {drives?: [str]}       -> {C: {free,total}, ..., DESKTOP, RECYCLE}
#   get_disk_free    {drive: str}           -> {free, total, success}
#
# Why single-shot (no daemon):
#   - Called every ~30s from updateDriveDisplay; Python cold-start ~150ms is fine
#   - Avoids holding a long-running sidecar just for disk queries
#   - 30s caching lives on the JS side
# ============================================================================

import sys
import os
import json
import platform
import shutil
import traceback

_IS_WINDOWS = platform.system() == "Windows"


# ---------------------------------------------------------------------------
# Helpers (ported from q3/src/kp.py)
# ---------------------------------------------------------------------------

def _get_folder_size_fast(folder_path, max_depth=50):
    """Fast folder size with depth limit; swallows PermissionError/OSError."""
    total = 0
    try:
        for entry in os.scandir(folder_path):
            try:
                if entry.is_file(follow_symlinks=False):
                    total += entry.stat(follow_symlinks=False).st_size
                elif entry.is_dir(follow_symlinks=False) and max_depth > 0:
                    total += _get_folder_size_fast(entry.path, max_depth - 1)
            except (PermissionError, OSError):
                pass
    except (PermissionError, OSError):
        pass
    return total


def _get_desktop_path():
    """Return current user's Desktop path, or None."""
    if _IS_WINDOWS:
        userprofile = os.environ.get('USERPROFILE', '')
        if userprofile:
            d = os.path.join(userprofile, 'Desktop')
            if os.path.isdir(d):
                return d
    d = os.path.expanduser('~/Desktop')
    if os.path.isdir(d):
        return d
    return None


def _get_recycle_bin_size(drives=None):
    """Cross-platform Recycle Bin / Trash size; returns int bytes."""
    total = 0
    if _IS_WINDOWS:
        if drives:
            for drive in drives:
                letter = drive.upper().replace(":", "").replace("\\", "").replace("/", "")
                if not letter:
                    continue
                recycle_path = letter + ":\\$Recycle.Bin"
                if os.path.isdir(recycle_path):
                    total += _get_folder_size_fast(recycle_path)
    elif platform.system() == "Darwin":
        trash_path = os.path.expanduser("~/.Trash")
        if os.path.isdir(trash_path):
            try:
                total += _get_folder_size_fast(trash_path)
            except PermissionError:
                pass
    else:
        trash_path = os.path.expanduser("~/.local/share/Trash/files")
        if os.path.isdir(trash_path):
            total += _get_folder_size_fast(trash_path)
    return total


def _get_disk_free(drive):
    """Use shutil.disk_usage; return {success,free,total,used} or {success:False,error}."""
    if not drive:
        return {"success": False, "error": "empty_drive"}
    probe = drive
    if _IS_WINDOWS:
        if len(probe) == 1 and probe.isalpha():
            probe = probe + ":\\"
        elif probe.endswith(":"):
            probe = probe + "\\"
    try:
        u = shutil.disk_usage(probe)
        return {"success": True, "free": u.free, "total": u.total, "used": u.used}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------

def action_ping(_params):
    return {"alive": True, "pid": os.getpid()}


def action_disk_free_batch(params):
    drives = params.get("drives") or None
    result = {}
    if not drives:
        if _IS_WINDOWS:
            import string
            drives = [d + ":" for d in string.ascii_uppercase if os.path.exists(d + ":\\")]
        else:
            drives = ["/"]

    for drive in drives:
        letter = drive.upper().replace(":", "").replace("\\", "").replace("/", "") or "X"
        info = _get_disk_free(drive)
        if info.get("success"):
            result[letter] = {"free": info["free"], "total": info["total"]}

    desktop_path = _get_desktop_path()
    if desktop_path:
        result["DESKTOP"] = {
            "used": _get_folder_size_fast(desktop_path),
            "path": desktop_path,
        }

    result["RECYCLE"] = {"used": _get_recycle_bin_size(drives)}
    return result


def action_get_disk_free(params):
    return _get_disk_free(params.get("drive") or "")


ACTIONS = {
    "ping": action_ping,
    "disk_free_batch": action_disk_free_batch,
    "get_disk_free": action_get_disk_free,
}


# ---------------------------------------------------------------------------
# Entry
# ---------------------------------------------------------------------------

def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stdin.reconfigure(encoding="utf-8")
    except Exception:
        pass

    raw = sys.stdin.read()
    if not raw or not raw.strip():
        sys.stdout.write(json.dumps({"ok": False, "error": "empty_input"}))
        sys.stdout.flush()
        return

    try:
        msg = json.loads(raw)
    except Exception as e:
        sys.stdout.write(json.dumps({"ok": False, "error": "bad_json: " + str(e)}))
        sys.stdout.flush()
        return

    action = msg.get("action") or ""
    fn = ACTIONS.get(action)
    if not fn:
        sys.stdout.write(json.dumps({"ok": False, "error": "unknown_action: " + action}))
        sys.stdout.flush()
        return

    try:
        data = fn(msg)
        sys.stdout.write(json.dumps({"ok": True, "data": data}, ensure_ascii=False))
    except Exception as e:
        sys.stdout.write(json.dumps({
            "ok": False,
            "error": repr(e),
            "trace": traceback.format_exc(),
        }, ensure_ascii=False))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
