# ============================================================================
# miniaudio_bridge.py
# JSON-line stdio wrapper around miniaudio_v16.AudioHub for qqq-shell.
#
# Protocol: read newline-delimited JSON from stdin, write JSON to stdout.
#   request : {"_id": <int>, "action": "<name>", ...params}\n
#   response: {"_id": <int>, "result": <any>}\n        OR  {"_id": <int>, "error": "..."}\n
#   handshake: action="ping" -> {"status":"alive"}
#
# Actions:
#   ping                                   -> {status: "alive"}
#   exit                                   -> {ok: true} (优雅退出: 关设备后自退)
#   play_music   {path, loop?, fade?}      -> {ok: true}
#   play_sfx     {path, volume?}           -> {ok: true}
#   prime_sfx    {paths: [...]}            -> {ok: true}
#   stop_all                               -> {ok: true}
#   stop_music                             -> {ok: true}
#   stop_clipboard                         -> {ok: true}
# ============================================================================

import sys
import os
import json
import traceback

# add this dir to import path so miniaudio_v16 (next to us) can be loaded.
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

HUB = None
HUB_INIT_ERR = None


def write(msg):
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def init_hub(asset_folder="assets"):
    global HUB, HUB_INIT_ERR
    if HUB is not None:
        return True
    try:
        # lazy-import so handshake works even if miniaudio import is slow / fails
        from miniaudio_v16 import AudioHub
        HUB = AudioHub(asset_folder=asset_folder, silent=True)
        return True
    except Exception as e:
        HUB_INIT_ERR = repr(e) + "\n" + traceback.format_exc()
        return False


def shutdown_hub():
    """Close audio devices cleanly (avoids CFFI callback noise on exit)."""
    global HUB
    if HUB is None:
        return
    try:
        HUB.close()
    except Exception:
        pass
    HUB = None


def handle(msg):
    action = msg.get("action") or ""
    if action == "ping":
        return {"status": "alive"}
    if action == "exit":
        return {"ok": True, "__exit__": True}
    # init hub on first non-ping request
    if HUB is None:
        ok = init_hub(msg.get("asset_folder") or "assets")
        if not ok:
            return {"error": "audio_hub_init_failed: " + (HUB_INIT_ERR or "unknown")}

    if action == "play_music":
        path = msg.get("path") or ""
        loop = bool(msg.get("loop") or False)
        fade = float(msg.get("fade") or 0.0)
        play_range = msg.get("play_range")
        HUB.play_music_file(path, play_range=play_range, fade_out_seconds=fade, loop=loop)
        return {"ok": True}
    if action == "play_sfx":
        path = msg.get("path") or ""
        volume = float(msg.get("volume") or 1.0)
        HUB.play_sfx(path, volume)
        return {"ok": True}
    if action == "prime_sfx":
        paths = msg.get("paths") or []
        if isinstance(paths, str):
            paths = [paths]
        paths = [p for p in paths if isinstance(p, str) and p]
        HUB.prime_sfx(paths)
        return {"ok": True}
    if action == "stop_all":
        try:
            HUB.music.stop_all()
        except Exception:
            pass
        try:
            if HUB.sfx is not None:
                HUB.sfx.stop_all()
        except Exception:
            pass
        return {"ok": True}
    if action == "stop_music":
        try:
            HUB.music.stop_all()
        except Exception:
            pass
        return {"ok": True}
    if action == "stop_clipboard":
        try:
            HUB.stop_clipboard()
        except Exception:
            pass
        return {"ok": True}
    return {"error": "unknown_action: " + action}


def main():
    # On Windows, ensure utf-8 stdout to avoid mojibake.
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stdin.reconfigure(encoding="utf-8")
    except Exception:
        pass

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception as e:
            write({"error": "bad_json: " + str(e)})
            continue
        rid = msg.get("_id")
        try:
            res = handle(msg)
        except Exception as e:
            res = {"error": repr(e)}
        if rid is not None:
            res["_id"] = rid
        write(res)
        # ★ 优雅退出: 回复已发出, 关闭音频设备后自退, 避免退出时 CFFI 回调报错
        if res.get("__exit__"):
            shutdown_hub()
            return


if __name__ == "__main__":
    main()
