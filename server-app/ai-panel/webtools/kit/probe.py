# -*- coding: utf-8 -*-
"""probe.py — 页面探针：把目标页的结构 dump 出来（按钮/输入框/弹窗/计数/正文开头）。

用法：
    python probe.py <页URL子串>        # 例：python probe.py baike.baidu.com
    python probe.py --open <url>       # 开一页并 dump（受控浏览器：新起=直接加载 / 复用=导航主窗；外部 = 新标签）
    python probe.py <子串> --out xx.json

输出：屏幕 JSON 摘要 + probe_result.json + probe_shot.png（均在当前目录）。
到任何新站的第一步 —— 先看这个，再写脚本。
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

DUMP = r"""(()=>{
const vis = e => { const r = e.getBoundingClientRect(); return r.width>0 && r.height>0; };
const t40 = e => (e.innerText || e.textContent || '').trim().replace(/\s+/g,' ').slice(0,40);
const R = e => Math.round(e.getBoundingClientRect().x) + ',' + Math.round(e.getBoundingClientRect().y);
return JSON.stringify({
  url: location.href,
  title: document.title,
  ready: document.readyState,
  buttons: [...document.querySelectorAll('button,[role=button]')].filter(vis).slice(0,60)
             .map(b => ({t: t40(b), at: R(b)})).filter(b => b.t),
  inputs:  [...document.querySelectorAll('input,textarea,[contenteditable=true]')].filter(vis).slice(0,60)
             .map(i => ({tag: i.tagName.toLowerCase(), type: i.type||'', name: i.name||'',
                         ph: i.placeholder||'', ce: !!i.isContentEditable})),
  dialogs: [...document.querySelectorAll('[role=dialog],.rc-dialog')].filter(vis).length,
  links: document.querySelectorAll('a').length,
  imgs:  document.querySelectorAll('img').length,
  textHead: (document.body.innerText||'').replace(/\n+/g,' | ').slice(0,600)
}, null, 1)})()"""


def _open_page(url):
    """开一页：受控浏览器 = ensure(url) 开新窗；外部浏览器 = /json/new。"""
    try:
        import qdbrowser
        qdbrowser.ensure_started(url=url, profile=cdp.PROFILE)   # 恒跟当前身份槽（CDP_PROFILE）
        time.sleep(3.5)
        host = url.split("//", 1)[-1].split("/")[0]
        t = cdp.tab_for_url(host)
        if t:
            return t
        pages = [x for x in cdp.list_tabs() if x.get("type") == "page"]
        return pages[-1] if pages else None
    except Exception:
        pass
    t = cdp.new_tab(url)
    time.sleep(4)
    return t


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 1
    out_json = "probe_result.json"
    if "--out" in args:
        i = args.index("--out")
        out_json = args[i + 1]
        del args[i:i + 2]

    if args[0] == "--open":
        t = _open_page(args[1])
        if not t:
            print("开页失败:", args[1])
            return 2
        tab = cdp.Tab(t["webSocketDebuggerUrl"])
    else:
        t = cdp.tab_for_url(args[0])
        if not t:
            print("没找到页:", args[0])
            print("（提示：python probe.py --open <url> 直接开一页）")
            return 2
        tab = cdp.Tab(t["webSocketDebuggerUrl"])

    out = tab.js(DUMP)
    print(out)
    open(out_json, "w", encoding="utf-8").write(out or "")
    tab.shot("probe_shot.png")
    print("\nsaved:", out_json, "+ probe_shot.png")
    tab.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
