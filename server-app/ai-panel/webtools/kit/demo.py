# -*- coding: utf-8 -*-
"""demo.py — 30 秒验通：受控浏览器就绪 → 列出页 → 开 example.com → 读回 → 截图。

使用：python demo.py       # 自动：qd 受控浏览器优先（无则即起）；不可用则回退已运行的外部调试浏览器
输出：demo_shot.png（当前目录）
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def main():
    # ① qd 受控浏览器（首选）：没有就起；起不来 → 回退已有调试浏览器
    try:
        import qdbrowser
        ep = qdbrowser.ensure_started(profile=cdp.PROFILE)   # 恒跟当前身份槽（CDP_PROFILE）
        print("[0] 受控浏览器: pid=%s cdpPort=%s %s" %
              (ep.get("pid"), ep.get("cdpPort"), "（复用）" if ep.get("reused") else "（新起）"))
    except Exception as e:
        print("[i] 受控浏览器不可用（%s）——回退：已运行的调试浏览器" % e)

    tabs = cdp.list_tabs()
    print("[1] 当前页数:", len(tabs))
    for t in tabs[:8]:
        print("   ", t.get("type"), "|", (t.get("title") or "")[:40],
              "|", (t.get("url") or "")[:80])

    # ② 在现有页上导航（受控浏览器不支持 /json/new；外部浏览器上同式）
    t = cdp.tab_for_url("example.com") or cdp.first_page()
    if not t:
        print("[x] 没有可用页 —— 先确保有浏览器在跑")
        return 2
    tab = cdp.Tab(t["webSocketDebuggerUrl"])
    tab.goto("https://example.com", wait=4)
    print("[2] 标题:", tab.js("document.title"))
    print("[3] URL:", tab.js("location.href"))
    head = (tab.js("document.body.innerText") or "").split("\n")[0][:60]
    print("[4] 正文开头:", head)

    out = os.path.abspath("demo_shot.png")
    tab.shot(out)
    print("[5] 截图:", out)
    print("OK —— 链路全通。接下来读 03-操作模式库，写你自己的场景脚本。")
    tab.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
