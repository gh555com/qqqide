# ============================================================================
# miniaudio_bridge.py
# JSON-line stdio wrapper around miniaudio_v16.AudioHub for qqq-shell.
#
# Protocol: read newline-delimited JSON from stdin, write JSON to stdout.
#   request : {"_id": <int>, "action": "<name>", ...params}\n
#   response: {"_id": <int>, "result": <any>}\n        OR  {"_id": <int>, "error": "..."}\n
#   handshake: action="ping" -> {"status":"alive"}
#   ★ 事件推送（无 _id，主动写）: {"event":"audio_state_changed","playing":false,...}
#                                 {"event":"audio_finished"}
#
# Actions:
#   ping                                   -> {status: "alive"}
#   exit                                   -> {ok: true} (优雅退出: 关设备后自退)
#   play_music   {path, count?, intro?, fade?}
#        count: 0/-1 = 无限循环 / 1 = 单次 / >1 = N 次（老 q3 kp.py _play_audio 语义）
#        ★ 电台接管（老语义）: set_radio_status 缓存 live=true 时，play_music 改播电台：
#            count 0/-1 → 无限；count>0 → 随机 5~15 分钟后自动停
#        ★ 2.mp3 自动前奏同目录 a2.mp3（老语义）
#   play_sfx     {path, volume?}           -> {ok: true}
#   prime_sfx    {paths: [...]}            -> {ok: true}
#   set_radio_status {live, m3u8?, stream?}-> {ok: true}（渲染层 5min 轮询下发缓存）
#   get_audio_state                        -> {ok, playing, fileName, loopCount, isRadio, displayLoop}
#   stop_all                               -> {ok: true}
#   stop_music                             -> {ok: true}
#   stop_clipboard                         -> {ok: true}
# ============================================================================

import sys
import os
import json
import random
import threading
import time
import traceback

# add this dir to import path so miniaudio_v16 (next to us) can be loaded.
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

HUB = None
HUB_INIT_ERR = None

# ★ stdout 并发保护（主循环响应 + 监听线程事件推送可能交错写）
_WRITE_LOCK = threading.Lock()

# ★ 电台状态（老 kp.py 全局语义）：渲染层轮询 /radio/status 后经 set_radio_status 下发
_RADIO_LIVE = False
_RADIO_M3U8 = ""
_RADIO_STREAM = ""  # 直推流 URL（优先）

# ★ 当前曲目状态（供 get_audio_state / 换曲 / 停止 / 事件推送）
_CUR = {
    "token": None,
    "looping": False,       # 真实无限循环（含电台无限）
    "display_loop": False,  # UI 显示 "Looping..."（电台普通模式 = False）
    "fileName": None,
    "loopCount": 0,
    "startTime": 0.0,
    "isRadio": False,
}


def write(msg):
    line = json.dumps(msg, ensure_ascii=False) + "\n"
    with _WRITE_LOCK:
        sys.stdout.write(line)
        sys.stdout.flush()


def _emit_event(evt):
    try:
        write(evt)
    except Exception:
        pass


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


# ---------------------------------------------------------------------------
#  Savor 播放机器（老 q3 kp.py _play_radio / _play_audio 语义移植）
# ---------------------------------------------------------------------------

def _clear_cur():
    _CUR["token"] = None
    _CUR["looping"] = False
    _CUR["display_loop"] = False
    _CUR["fileName"] = None
    _CUR["loopCount"] = 0
    _CUR["startTime"] = 0.0
    _CUR["isRadio"] = False


def _emit_stopped():
    _emit_event({
        "event": "audio_state_changed",
        "playing": False, "looping": False,
        "fileName": None, "loopCount": 0, "startTime": 0
    })
    _emit_event({"event": "audio_finished"})


def _stop_current_token():
    tok = _CUR.get("token")
    if tok is not None:
        try:
            tok.stop()
        except Exception:
            pass


def _start_monitor(engine, token):
    """老 kp.py 监视线程移植：非循环播放自然结束时清状态 + 广播停止。
    仅当该 token 仍是当前曲目（未被换曲替换）时才广播——换曲场景由换曲方负责事件。"""
    def run():
        while True:
            if token.stopped:
                break
            try:
                with engine._tokens_lock:
                    if token not in engine._active_tokens:
                        break
            except Exception:
                break
            time.sleep(0.2)
        if token is _CUR.get("token"):
            _clear_cur()
            _emit_stopped()
    t = threading.Thread(target=run, daemon=True)
    t.start()


def _play_radio(timeout_sec=0):
    """老 kp.py _play_radio 移植：直推流优先，fallback HLS。
    timeout_sec>0 = 普通模式（随机 5~15 分钟后自动停）。"""
    engine = HUB.music
    use_stream = bool(_RADIO_STREAM)
    try:
        _stop_current_token()
        _clear_cur()
        if use_stream:
            token = engine.play_radio_stream(_RADIO_STREAM, live_check=lambda: _RADIO_LIVE)
        else:
            token = engine.play_radio_hls(_RADIO_M3U8)
    except Exception as e:
        return {"error": "radio play failed: %s: %s" % (type(e).__name__, e)}

    _CUR.update({
        "token": token, "looping": True, "display_loop": (timeout_sec <= 0),
        "fileName": "Radio", "loopCount": 0, "startTime": time.time(), "isRadio": True,
    })

    if timeout_sec and timeout_sec > 0:
        def _auto_stop():
            try:
                if token is _CUR.get("token") and not token.stopped:
                    token.stop()
            except Exception:
                pass
            if token is _CUR.get("token"):
                _clear_cur()
                _emit_stopped()
        t = threading.Timer(float(timeout_sec), _auto_stop)
        t.daemon = True
        t.start()

    _emit_event({
        "event": "audio_state_changed",
        "playing": True, "looping": True,
        "fileName": "Radio", "loopCount": 0, "startTime": _CUR["startTime"],
        "source": "radio", "displayLoop": _CUR["display_loop"],
    })
    return {"ok": True, "status": "ok", "source": "radio"}


def _play_music_impl(msg):
    path = msg.get("path") or ""
    if not path or not os.path.exists(path):
        return {"error": "file not found: " + str(path)}

    # count 语义：0/-1 无限；未给 count 时兼容旧 loop 参数
    raw_count = msg.get("count", None)
    if raw_count is None:
        count = 0 if bool(msg.get("loop") or False) else 1
    else:
        try:
            count = int(raw_count)
        except Exception:
            count = 1
    raw_fade = msg.get("fade", None)
    try:
        final_fade = float(raw_fade) if raw_fade is not None else 2.0
    except Exception:
        final_fade = 2.0

    # ★ 电台接管（老语义：电台在线 → 播电台，本地文件不播）
    if _RADIO_LIVE and (_RADIO_STREAM or _RADIO_M3U8):
        if count in (0, -1):
            return _play_radio(0)
        return _play_radio(random.randint(300, 900))

    # 前奏：显式 intro 优先；2.mp3 → 同目录 a2.mp3（老语义）
    intro = msg.get("intro") or ""
    if not intro and os.path.basename(path) == "2.mp3":
        cand = os.path.join(os.path.dirname(path), "a2.mp3")
        if os.path.isfile(cand):
            intro = cand
    if intro and not os.path.exists(intro):
        intro = ""

    engine = HUB.music
    try:
        was_playing = _CUR.get("token") is not None
        _stop_current_token()
        _clear_cur()
        if was_playing:
            _emit_stopped()

        if count in (0, -1):
            if intro:
                token = engine.play_with_intro(intro_path=intro, main_path=path, loop=True, trim_silence=True)
            else:
                token = engine.play_sound_file(file_path=path, loop=True, trim_silence=True)
            looping = True
        elif count == 1:
            if intro:
                token = engine.az_with_intro(intro, path, 1, final_fade, True)
            else:
                token = engine.az(path, 1, final_fade, True)
            looping = False
        else:
            if intro:
                token = engine.az_with_intro(intro, path, count, final_fade, True)
            else:
                token = engine.az(path, count, final_fade, True)
            looping = False
    except Exception as e:
        return {"error": "%s: %s" % (type(e).__name__, e)}

    _CUR.update({
        "token": token, "looping": looping, "display_loop": looping,
        "fileName": os.path.basename(path), "loopCount": count,
        "startTime": time.time(), "isRadio": False,
    })
    if not looping:
        _start_monitor(engine, token)

    _emit_event({
        "event": "audio_state_changed",
        "playing": True, "looping": looping,
        "fileName": _CUR["fileName"], "loopCount": count, "startTime": _CUR["startTime"],
        "displayLoop": looping,
    })
    return {"ok": True, "status": "ok", "source": "file"}


def _stop_music_impl():
    was = _CUR.get("token") is not None
    _stop_current_token()
    _clear_cur()
    try:
        HUB.music.stop_all()
    except Exception:
        pass
    if was:
        _emit_stopped()
    return {"ok": True}


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
        return _play_music_impl(msg)
    if action == "set_radio_status":
        global _RADIO_LIVE, _RADIO_M3U8, _RADIO_STREAM
        _RADIO_LIVE = bool(msg.get("live", False))
        _RADIO_M3U8 = str(msg.get("m3u8") or "")
        _RADIO_STREAM = str(msg.get("stream") or "")
        return {"ok": True}
    if action == "get_audio_state":
        tok = _CUR.get("token")
        playing = False
        try:
            playing = bool(tok is not None and not tok.stopped)
        except Exception:
            playing = tok is not None
        return {
            "ok": True, "playing": playing,
            "fileName": _CUR.get("fileName"), "loopCount": _CUR.get("loopCount"),
            "isRadio": bool(_CUR.get("isRadio")), "displayLoop": bool(_CUR.get("display_loop")),
        }
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
        return _stop_music_impl()
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

    # ★ stdin EOF (宿主退出/崩溃, 未收到 exit 命令): 关闭音频设备后自然退出
    #   兜底优雅关闭 — 防孤儿进程 + 防退出时 CFFI 回调报错
    shutdown_hub()


if __name__ == "__main__":
    main()
