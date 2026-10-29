# -*- coding: utf-8 -*-
"""selftest.py — 受控浏览器端到端自检（真机验收：Windows / macOS / Linux 通用）

覆盖：① 可见档（起→导航→JS→可信打字→截图）② 隐藏档（无窗口截图·帧唤醒）
③ 二次实例复用（报告 reused:true，不弹窗）④ 空闲自退（无客户端自退 / 有客户端保活→断开自退）
⑤ exit-with 跟随（监督方死→浏览器跟随退出）⑨ 收尾。

用法：
    python selftest.py            # 全部（约 4 分钟）
    python selftest.py 1,2        # 只跑指定步骤
    QQQIDE_SHELL=<内核> python selftest.py 1     # 显式指定内核（开发树/多包环境）

产物：当前目录 e2e_visible.png / e2e_hidden.png；退出码 0=全绿。
"""
import json
import os
import subprocess
import sys
import tempfile
import time

KIT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, KIT)
# ★ 本自检只验收**内置内核域**（壳层 browser-host 的窗口/隐藏档/空闲自退/exit-with 语义——
#   外部内核（Chrome/Edge）没有这些实例级能力）。钉住内置内核，不受 --engine auto 影响。
os.environ["QQQIDE_BROWSER_ENGINE"] = "builtin"
os.environ.pop("CDP_PROFILE", None)
import qdbrowser  # noqa: E402
import cdp  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

FAILED = []


def step(msg):
    line = "[%s] %s" % (time.strftime("%H:%M:%S"), msg)
    print(line, flush=True)


def check(cond, msg):
    step(("OK   " if cond else "FAIL ") + msg)
    if not cond:
        FAILED.append(msg)
    return bool(cond)


def _shell_cmd():
    shell_bin, extra = qdbrowser.resolve_shell()
    return [shell_bin] + list(extra)


def _shot_time(tab, path):
    t0 = time.time()
    tab.shot(path)
    size = os.path.getsize(path) if os.path.exists(path) else -1
    return time.time() - t0, size


def s1_visible():
    step("== 1 可见档 ==")
    ep = qdbrowser.ensure_started(wait=60)
    check(bool(ep.get("cdpPort")),
          "ensure visible  pid=%s port=%s reused=%s" % (ep.get("pid"), ep.get("cdpPort"), ep.get("reused")))
    check(not ep.get("hidden"), "visible instance hidden=%r" % ep.get("hidden"))
    t = cdp.first_page()
    check(bool(t), "found page target")
    if not t:
        return
    tab = cdp.Tab(t["webSocketDebuggerUrl"])
    tab.goto("https://example.com", wait=4)
    check(bool(tab.js("document.title")), "title=%r" % tab.js("document.title"))
    tab.js("(function(){var d=document.createElement('div');d.id='pin';d.contentEditable='true';"
           "d.style.cssText='position:fixed;left:8px;top:8px;background:#fff;color:#000;padding:6px;z-index:99999';"
           "document.body.appendChild(d);d.focus();return 'ok';})()")
    tab.insert_text("hello 世界 qqq")
    time.sleep(0.3)
    rb = tab.js("document.getElementById('pin') ? document.getElementById('pin').innerText : ''")
    check((rb or "").strip() == "hello 世界 qqq", "insertText 读回=%r（可信打字）" % rb)
    dt, size = _shot_time(tab, os.path.abspath("e2e_visible.png"))
    check(size > 1000, "可见档截图 %.2fs %d bytes" % (dt, size))
    tab.close()


def s2_hidden():
    step("== 2 隐藏档（无窗口） ==")
    qdbrowser.stop()
    time.sleep(1.5)
    ep = qdbrowser.ensure_started(hidden=True, wait=60)
    check(bool(ep.get("hidden")), "hidden ensure  pid=%s hidden=%r" % (ep.get("pid"), ep.get("hidden")))
    t = cdp.first_page()
    check(bool(t), "found page target (hidden)")
    if not t:
        return
    tab = cdp.Tab(t["webSocketDebuggerUrl"])
    tab.goto("https://example.org", wait=4)
    dt, size = _shot_time(tab, os.path.abspath("e2e_hidden.png"))
    check(size > 1000, "隐藏档截图 %.2fs %d bytes（帧唤醒）" % (dt, size))
    tab.close()


def s3_second():
    step("== 3 二次实例（复用 + 报告） ==")
    rep = os.path.join(tempfile.gettempdir(), "e2e_second_selftest.json")
    try:
        os.remove(rep)
    except OSError:
        pass
    cmd = _shell_cmd() + ["--qqqide-browser", "--qqqide-browser-report=" + rep,
                          "--qqqide-browser-hidden", "--qqqide-browser-url=https://example.com"]
    p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        p.wait(timeout=40)
    except Exception:
        step("二次实例进程未按时退出（继续观察报告）")
    time.sleep(2)
    try:
        j = json.load(open(rep, encoding="utf-8"))
        check(j.get("ok") is True and j.get("reused") is True,
              "报告 ok=%s reused=%s（复用而非另起）" % (j.get("ok"), j.get("reused")))
    except Exception as e:
        check(False, "二次实例报告缺失: %s" % e)
    check(bool(qdbrowser.read_live_endpoint()), "实例仍存活（复用语义）")


def s4_idle():
    step("== 4 空闲自退 ==")
    qdbrowser.stop()
    time.sleep(1.5)
    # A：无客户端 → 自退（0.3 分钟 = 18s 阈值）
    ep = qdbrowser.ensure_started(hidden=True, idle_exit=0.3, wait=60)
    step("A: pid=%s（无客户端，期待 ~18-60s 自退）" % ep.get("pid"))
    gone = False
    deadline = time.time() + 100
    while time.time() < deadline:
        time.sleep(3)
        if not qdbrowser.read_live_endpoint():
            gone = True
            break
    check(gone, "A: 无客户端 → 自退")
    # B：有客户端 → 保活；断开后自退
    ep = qdbrowser.ensure_started(hidden=True, idle_exit=0.3, wait=60)
    step("B: pid=%s（带客户端，期待保活）" % ep.get("pid"))
    t = cdp.first_page()
    tab = cdp.Tab(t["webSocketDebuggerUrl"])
    tab.js("1")
    alive = True
    for _ in range(8):          # ~24s > 18s 阈值
        time.sleep(3)
        if not qdbrowser.read_live_endpoint():
            alive = False
            break
    check(alive, "B: 有客户端 → 保活")
    try:
        tab.close()
    except Exception:
        pass
    gone2 = False
    deadline = time.time() + 100
    while time.time() < deadline:
        time.sleep(3)
        if not qdbrowser.read_live_endpoint():
            gone2 = True
            break
    check(gone2, "B: 客户端断开 → 自退")


def s5_exitwith():
    step("== 5 exit-with 跟随 ==")
    qdbrowser.stop()
    time.sleep(1.5)
    sup = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(600)"])
    ep = qdbrowser.ensure_started(hidden=True, exit_with=sup.pid, idle_exit=0, wait=60)
    step("监督 pid=%s 浏览器 pid=%s" % (sup.pid, ep.get("pid")))
    sup.kill()
    try:
        sup.wait(timeout=5)      # 收割子进程（POSIX：不收割 = 僵尸；真机实测此时浏览器按设计也能识别）
    except Exception:
        pass
    gone = False
    deadline = time.time() + 40
    while time.time() < deadline:
        time.sleep(2)
        if not qdbrowser.read_live_endpoint():
            gone = True
            break
    check(gone, "监督方退出 → 浏览器跟随退出")


def s9_stop():
    step("== 9 收尾 ==")
    qdbrowser.stop()
    time.sleep(1)
    check(not qdbrowser.read_live_endpoint(), "已停止且端点消失")


STEPS = {"1": s1_visible, "2": s2_hidden, "3": s3_second,
         "4": s4_idle, "5": s5_exitwith, "9": s9_stop}


def main():
    sel = sys.argv[1] if len(sys.argv) > 1 else "all"
    ids = ["1", "2", "3", "4", "5", "9"] if sel == "all" else [s.strip() for s in sel.split(",") if s.strip()]
    step("platform=%s  python=%s" % (sys.platform, sys.version.split()[0]))
    try:
        step("resolve_shell = %r" % (qdbrowser.resolve_shell(),))
    except Exception as e:
        step("resolve_shell 失败: %s" % e)
    for i in ids:
        fn = STEPS.get(i)
        if not fn:
            continue
        try:
            fn()
        except Exception as e:
            step("EXC in step %s: %r" % (i, e))
            FAILED.append("step %s exception: %r" % (i, e))
    step("======== SUMMARY ========")
    if FAILED:
        step("FAILED %d:" % len(FAILED))
        for f in FAILED:
            step("  - " + f)
    else:
        step("ALL GREEN")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
