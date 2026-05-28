# ============================================================================
# runner.py - Tier-2 spawn fallback for qz subsystem.
# Pure-stdlib (no third-party imports). Reads one JSON brief from stdin,
# spawns the requested process with anti-hang protection, writes one JSON
# result line to stdout, then exits.
#
# Protocol:
#   stdin  : {"cmd","args","cwd","env","timeout","stallMs",
#             "captureOutput","inheritEnv","shell"}\n
#   stdout : {"exitCode","stdout","stderr","killReason"}\n
#
# Anti-hang (per "arc/spawn-protocol" + "我们到底要做什吗" §2.5):
#   - Windows  : CREATE_NEW_PROCESS_GROUP + CREATE_NO_WINDOW;
#                kill the entire process tree on timeout via taskkill /F /T.
#   - POSIX    : start_new_session=True (own pgid); kill the whole pgid.
#   - Triple watchdog: deadline (hard) + stall (no IO) + heartbeat (per 1s).
# ============================================================================

import sys
import os
import io
import json
import subprocess
import threading
import time
import signal

WIN = sys.platform.startswith("win")
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_NO_WINDOW = 0x08000000


def _emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _read_brief():
    try:
        line = sys.stdin.readline()
        if not line:
            return None
        return json.loads(line)
    except Exception as e:
        _emit({"exitCode": -1, "stdout": "", "stderr": "runner_bad_brief: " + repr(e),
               "killReason": "spawn-error"})
        return None


def _kill_tree(pid):
    """Best-effort tree kill across platforms."""
    try:
        if WIN:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                creationflags=CREATE_NO_WINDOW,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=5,
            )
        else:
            try:
                os.killpg(os.getpgid(pid), signal.SIGKILL)
            except Exception:
                try:
                    os.kill(pid, signal.SIGKILL)
                except Exception:
                    pass
    except Exception:
        pass


def _spawn(brief):
    cmd = brief.get("cmd") or ""
    args = brief.get("args") or []
    cwd = brief.get("cwd") or None
    env_extra = brief.get("env") or None
    timeout_ms = int(brief.get("timeout") or 60000)
    stall_ms = int(brief.get("stallMs") or 0)
    capture = bool(brief.get("captureOutput") if brief.get("captureOutput") is not None else True)
    inherit_env = bool(brief.get("inheritEnv") if brief.get("inheritEnv") is not None else True)
    use_shell = bool(brief.get("shell") or False)

    if not cmd:
        return {"exitCode": -1, "stdout": "", "stderr": "runner_no_cmd",
                "killReason": "spawn-error"}

    if inherit_env:
        env = dict(os.environ)
        if env_extra:
            env.update({str(k): str(v) for k, v in env_extra.items()})
    else:
        env = {str(k): str(v) for k, v in (env_extra or {}).items()}

    # Spawn kwargs ---------------------------------------------------------
    popen_kwargs = {
        "cwd": cwd,
        "env": env,
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.PIPE if capture else subprocess.DEVNULL,
        "stderr": subprocess.PIPE if capture else subprocess.DEVNULL,
        "bufsize": 0,
    }
    if WIN:
        popen_kwargs["creationflags"] = CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        if use_shell:
            popen_kwargs["shell"] = True
    else:
        popen_kwargs["start_new_session"] = True
        if use_shell:
            popen_kwargs["shell"] = True

    if use_shell:
        # When shell=True, pass full command as single string.
        full = cmd if not args else (cmd + " " + " ".join(args))
        popen_target = full
    else:
        popen_target = [cmd] + list(args)

    try:
        proc = subprocess.Popen(popen_target, **popen_kwargs)
    except FileNotFoundError as e:
        return {"exitCode": -1, "stdout": "", "stderr": "spawn_not_found: " + str(e),
                "killReason": "spawn-error"}
    except Exception as e:
        return {"exitCode": -1, "stdout": "", "stderr": "spawn_error: " + repr(e),
                "killReason": "spawn-error"}

    # Async reader threads -------------------------------------------------
    out_buf = []
    err_buf = []
    last_io = [time.monotonic()]
    lock = threading.Lock()

    def _pump(stream, buf):
        try:
            while True:
                chunk = stream.read(4096)
                if not chunk:
                    break
                if isinstance(chunk, bytes):
                    try:
                        chunk = chunk.decode("utf-8", errors="replace")
                    except Exception:
                        chunk = repr(chunk)
                with lock:
                    buf.append(chunk)
                    last_io[0] = time.monotonic()
        except Exception:
            pass

    threads = []
    if capture:
        if proc.stdout is not None:
            t1 = threading.Thread(target=_pump, args=(proc.stdout, out_buf), daemon=True)
            t1.start(); threads.append(t1)
        if proc.stderr is not None:
            t2 = threading.Thread(target=_pump, args=(proc.stderr, err_buf), daemon=True)
            t2.start(); threads.append(t2)

    # Watchdog loop --------------------------------------------------------
    deadline = time.monotonic() + (timeout_ms / 1000.0)
    kill_reason = ""
    while True:
        rc = proc.poll()
        if rc is not None:
            break
        now = time.monotonic()
        if now >= deadline:
            kill_reason = "deadline"
            break
        if stall_ms > 0:
            with lock:
                idle = (now - last_io[0]) * 1000.0
            if idle >= stall_ms:
                kill_reason = "stall"
                break
        time.sleep(0.05)

    if kill_reason:
        _kill_tree(proc.pid)
        try:
            proc.wait(timeout=2)
        except Exception:
            pass
        rc = -1

    # Final drain
    for t in threads:
        try: t.join(timeout=1.0)
        except Exception: pass

    return {
        "exitCode": int(rc) if rc is not None else -1,
        "stdout": "".join(out_buf),
        "stderr": "".join(err_buf) + (
            "\n[killed: %s after %dms]" % (kill_reason, int(timeout_ms))
            if kill_reason else ""
        ),
        "killReason": kill_reason,
    }


def main():
    # Force UTF-8 on Windows console
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stdin.reconfigure(encoding="utf-8")
    except Exception:
        pass

    brief = _read_brief()
    if brief is None:
        return 0
    try:
        result = _spawn(brief)
    except Exception as e:
        import traceback
        result = {
            "exitCode": -1, "stdout": "",
            "stderr": "runner_exception: " + repr(e) + "\n" + traceback.format_exc(),
            "killReason": "spawn-error",
        }
    _emit(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
