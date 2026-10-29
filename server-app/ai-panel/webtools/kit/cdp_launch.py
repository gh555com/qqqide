# -*- coding: utf-8 -*-
"""cdp_launch.py — 外部内核（Chrome/Edge/Brave/Chromium）启动入口（兼容壳）

★ 本文件现在只是一层命令行兼容壳——内核发现与启动的唯一实现已合并进：
    browser_engine.py（发现/启动） + qdbrowser.py（档案槽/端点/生命周期）
  禁在本文件另写第二套发现逻辑（历史版本曾有一份，两套会各自找到不同浏览器）。

它做什么：把「外部内核 + 本槽档案」拉起为一个 CDP 端点，与 qd 内置受控浏览器
用同一套端点契约（{档案目录}/host.json）——cdp.py 无需任何额外配置即可连上。

用法：
    python cdp_launch.py                        # 默认槽 + 外部内核（自动发现）
    python cdp_launch.py --slot aliyun-a        # 指定档案槽（多身份并行）
    python cdp_launch.py --url https://www.baidu.com
    python cdp_launch.py --attach-only          # 只检查（已在跑就打印端点，不起新的）
    python cdp_launch.py --browser "D:\\Chrome\\chrome.exe"
    python cdp_launch.py --headless             # 无头（不建议：风控易触发 / 人看不见）
    python cdp_launch.py --engine builtin       # 改用 qd 自带内核（零依赖）

重复运行是安全的：同槽同内核已在跑 → 直接复用并打印端点。
"""
import argparse
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import qdbrowser  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def main():
    ap = argparse.ArgumentParser(description="启动外部调试浏览器（档案槽 + 自动发现内核）")
    ap.add_argument("--slot", "--profile", dest="slot", default=None,
                    help="档案槽名（默认 default；--profile 为同义别名）")
    ap.add_argument("--engine", default="external", choices=["external", "builtin", "auto"],
                    help="内核（默认 external；builtin = qd 自带内核）")
    ap.add_argument("--url", default=None)
    ap.add_argument("--browser", default=None, help="浏览器可执行文件路径（默认自动发现）")
    ap.add_argument("--attach-only", action="store_true", help="只检查，不启动")
    ap.add_argument("--headless", action="store_true", help="无头模式（不建议）")
    ap.add_argument("--data-root", default=None)
    args = ap.parse_args()

    slot = args.slot or "default"

    if args.attach_only:
        ep = qdbrowser.read_live_endpoint(profile=slot, data_root=args.data_root)
        if not ep:
            print("[--] 没有检测到该槽的受控浏览器（槽 %s）" % slot)
            return 1
        print("[ok] 已在运行: %s" % (ep.get("kernel") or ""))
        print(json.dumps(ep, ensure_ascii=False))
        return 0

    try:
        ep = qdbrowser.ensure_started(hidden=args.headless, url=args.url, profile=slot,
                                      engine=args.engine, browser=args.browser,
                                      data_root=args.data_root, wait=60.0)
    except Exception as e:
        print("[x] " + str(e))
        return 2
    print("[ok] 已就绪: %s" % (ep.get("kernel") or "?"))
    print("     槽=%s  内核=%s  cdpPort=%s  %s" % (
        ep.get("slot"), ep.get("engine"), ep.get("cdpPort"),
        "(复用现有实例)" if ep.get("reused") else ""))
    print("[i] 首次使用：在弹出的窗口里把目标网站登录一遍 —— 登录态留在该槽档案里，长期保留。")
    print("[i] 脚本连它：设置 CDP_PORT=%s 或 CDP_PROFILE=%s（cdp.py 自动发现，通常不用设）。" %
          (ep.get("cdpPort"), slot))
    return 0


if __name__ == "__main__":
    sys.exit(main())
