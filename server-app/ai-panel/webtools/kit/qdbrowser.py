# -*- coding: utf-8 -*-
"""qdbrowser.py — qd 受控浏览器：档案槽 × 内核（确保就绪 / 查询 / 停止 / 列举）

★ 核心模型（一句话）：**内核是消耗品，档案是资产。**
    档案槽（slot）= 身份 —— 登录态、cookie、storage 全在这里；落在 {Data} 下，
                   可备份、可迁移、可离线、不上云。
    内核（engine）= 跑这份档案的引擎 —— builtin（qd 自带 Electron 内核：零依赖兜底、
                   Win7 可用、受控最严）或 external（用户机器已装的 Chrome/Edge/Brave/
                   Chromium：内核够新，主流站点零兼容债）。
    两者解耦：换内核不换槽、换槽不换内核。**但登录态不跨内核通用**（cookie 存储布局
    不同）——所以槽位首次使用后即钉住内核，换内核须显式 --rebind（换内核＝换档案）。

命令:
    python qdbrowser.py ensure [--profile <槽>] [--engine auto|builtin|external] [--url <url>]
    python qdbrowser.py ensure --hidden            # 静默档（仅内置内核；外部内核=headless）
    python qdbrowser.py status   [--profile <槽>]  # 当前端点；未运行 → 退出码 1
    python qdbrowser.py stop     [--profile <槽>]  # 停止（登录态保留在档案里）
    python qdbrowser.py list                        # 所有槽位（内核 / 端点 / 是否在跑）
    python qdbrowser.py label <槽> "<备注>"          # 给槽位起个人类可读标签

档案布局（{Data} = 装包数据根；默认槽的内置档案保留历史路径）:
    {Data}/browser-host/                        ← 槽 default + 引擎 builtin（历史路径，永不搬）
    {Data}/browser-profiles/<槽>/slot.json      ← 槽元数据 {v,slot,label,active,engines}
    {Data}/browser-profiles/<槽>/builtin/       ← 内置内核档案（Electron userData）
    {Data}/browser-profiles/<槽>/external/      ← 外部内核档案（Chrome --user-data-dir）
    {Data}/browser-profiles/default/external/   ← 默认槽 + 外部内核

端点发现（唯一契约）：{档案目录}/host.json
    内置 → 壳层每 4s 心跳写；外部 → kit 启动时写（存活由 CDP 探测裁决）。
    cdp.py / 场景脚本据此自动找到实例——跨 TEMP 作用域、多槽多实例并存。

找内核（内置，默认自动）:
    QQQIDE_PYTHON_DIR（环境变量，回退注册表）→ 推导
      Windows 打包  <pack>/gh555.com/resources/app/engines/python → <pack>/gh555.com/joker.exe
      macOS   打包  qqqide.app/Contents/**/engines/python 或 qqqide-data/engines/python
                    → qqqide.app/Contents/MacOS/qqqide
      Linux   打包  <容器>/resources/app/engines/python 或 qqqide-data/engines/python → <容器>/qqqide
      开发树        <root>/engines/python → <root>/node_modules/electron/dist/electron[.exe]
    也可显式指定: --shell <内核路径> [--app <应用目录>]

作为库:
    import qdbrowser
    ep = qdbrowser.ensure_started()                        # 默认槽 → {"pid","cdpPort","engine",...}
    ep = qdbrowser.ensure_started(profile="aliyun-a")      # 身份槽（两账号并行）
    ep = qdbrowser.read_live_endpoint(profile="aliyun-a")  # 只读现状（未运行 -> None）
    qdbrowser.stop(profile="aliyun-a")
"""
import argparse
import glob as _glob
import hashlib
import json
import os
import platform
import re
import subprocess
import sys
import tempfile
import time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import browser_engine  # noqa: E402  （外部内核发现/启动；同目录）

IS_WIN = platform.system() == "Windows"
IS_MAC = platform.system() == "Darwin"
_NO_WINDOW = 0x08000000                     # CREATE_NO_WINDOW（taskkill 用）
_DETACHED = 0x00000008 | 0x00000200         # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP

# 能力探测词：只存在于「受控浏览器」壳层里（browser-host 的 --qqqide-browser-report）。
# ★ 不可用 'qqqide-browser'——旧包日志文件名（qqqide-browser-launch.log）会撞出假阳性，
#   导致老版本 qd 被误启动成 IDE（实测实锤）。
_PROBE_WORD = b"qqqide-browser-report"
# 档案槽能力词：老壳层没有 --qqqide-browser-profile 开关——具名槽必须在它上面明确报错，
# 否则会静默落回默认档案（= 两个身份共用一个 cookie 罐，最坏的错法）。
_PROBE_PROFILE = b"qqqide-browser-profile"

ENGINES = ("builtin", "external")
_SLOT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$")


def _norm(p):
    return os.path.normpath(p) if p else p


def _slot_of(profile=None):
    """槽名（None/空 -> 环境变量 CDP_PROFILE -> 'default'）。非法 -> RuntimeError。"""
    s = (profile or os.environ.get("CDP_PROFILE") or "default").strip()
    if not _SLOT_RE.match(s):
        raise RuntimeError("档案槽名非法: %r（只允许字母数字开头 + [A-Za-z0-9._-]，≤32 字符）" % s)
    return s


def _read_win_registry_pydir():
    if not IS_WIN:
        return None
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as k:
            v, _ = winreg.QueryValueEx(k, "QQQIDE_PYTHON_DIR")
            return v or None
    except Exception:
        return None


# ── 内置内核解析（跨平台） ──

def _mac_app_exe(bundle):
    """mac .app → Contents/MacOS 可执行体（优先 qqqide，另外 glob 兜底）。"""
    macos = os.path.join(bundle, "Contents", "MacOS")
    pref = os.path.join(macos, "qqqide")
    if os.path.exists(pref):
        return _norm(pref)
    try:
        for p in sorted(_glob.glob(os.path.join(macos, "*"))):
            if os.path.isfile(p) and os.access(p, os.X_OK):
                return _norm(p)
    except Exception:
        pass
    return None


def _mac_app_exe_in(container):
    """容器目录下的 .app（优先 qqqide.app）→ 可执行体。"""
    b = os.path.join(container, "qqqide.app")
    if os.path.isdir(b):
        e = _mac_app_exe(b)
        if e:
            return e
    try:
        for app in sorted(_glob.glob(os.path.join(container, "*.app"))):
            e = _mac_app_exe(app)
            if e:
                return e
    except Exception:
        pass
    return None


def _kernel_candidates(py):
    """从 python 目录推导内核候选 [(exe, extra[])]（存在性已判定；首个命中的用）。"""
    out = []
    py = os.path.abspath(py)
    nb = py.replace("\\", "/")

    # ① 开发树：<root>/engines/python → node_modules/electron/dist/*
    if "/node_modules/electron/" not in nb.lower():
        dev_root = os.path.dirname(os.path.dirname(py))
        if IS_WIN:
            rel = "node_modules/electron/dist/electron.exe"
        elif IS_MAC:
            rel = "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
        else:
            rel = "node_modules/electron/dist/electron"
        dev_bin = os.path.join(dev_root, *rel.split("/"))
        if os.path.exists(dev_bin):
            out.append((_norm(dev_bin), [_norm(dev_root)]))

    # ② macOS 打包：…/qqqide.app/Contents/**engines/python 或 …/qqqide-data/engines/python
    m = re.search(r"^(.*\.app)/Contents/(?:Resources/app/)?engines/python$", nb, re.I)
    if m:
        e = _mac_app_exe(_norm(m.group(1)))
        if e:
            out.append((e, []))
    m2 = re.search(r"^(.*)/qqqide-data/engines/python$", nb)
    if m2:
        container = _norm(m2.group(1))
        if IS_MAC:
            e = _mac_app_exe_in(container)
            if e:
                out.append((e, []))
        else:
            for name in ("qqqide", "qqqide-bin"):
                p = os.path.join(container, name)
                if os.path.exists(p):
                    out.append((_norm(p), []))
                    break

    # ③ Windows 打包：<pack>/gh555.com/resources/app/engines/python → joker.exe
    if IS_WIN:
        sh = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(py)))), "joker.exe")
        if os.path.exists(sh):
            out.append((_norm(sh), []))
    return out


def _autodetect_dev_app(exe):
    """显式 --shell 指向 electron 内核且未给 --app 时：向上找 <root>（package.json +
    node_modules/electron 双命中）——防「electron 裸启默认 app」；找不到 → None。"""
    base = os.path.basename(exe).lower()
    if not base.startswith("electron"):
        return None
    d = os.path.dirname(os.path.abspath(exe))
    for _ in range(6):
        try:
            if (os.path.exists(os.path.join(d, "package.json")) and
                    os.path.isdir(os.path.join(d, "node_modules", "electron"))):
                return _norm(d)
        except Exception:
            pass
        nd = os.path.dirname(d)
        if nd == d:
            break
        d = nd
    return None


def _self_candidates():
    """从本文件位置推导内核候选 [(exe, extra[])]——装包内运行（运行副本/资源副本）、开发树均适用。
    mac/linux 没有 QQQIDE_PYTHON_DIR 注册表广播（那是 Windows 启动器写的）→ 本函数是主发现路径；
    Windows 下作为兜底（env 缺失/指向失效时仍可用）。"""
    out = []
    try:
        nb = os.path.abspath(__file__).replace("\\", "/")
        chain = []
        d = os.path.dirname(os.path.abspath(__file__))
        for _ in range(14):
            chain.append(d)
            nd = os.path.dirname(d)
            if nd == d:
                break
            d = nd
        in_app_bundle = ".app/contents/" in nb.lower()

        # ① 开发树：…/<root>/server-app/ai-panel/webtools/kit → node_modules/electron
        for d in chain:
            if os.path.basename(d) == "server-app":
                root = os.path.dirname(d)
                rel = ("node_modules/electron/dist/electron.exe" if IS_WIN else
                       "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" if IS_MAC else
                       "node_modules/electron/dist/electron")
                p = os.path.join(root, *rel.split("/"))
                if os.path.exists(p):
                    out.append((_norm(p), [_norm(root)]))
                break

        # ② macOS 资源副本：…/X.app/Contents/Resources/app/webapp/…
        for d in chain:
            if d.endswith(".app") and os.path.isdir(os.path.join(d, "Contents", "MacOS")):
                e = _mac_app_exe(d)
                if e:
                    out.append((e, []))
                break

        # ③ 托管数据根：…/qqqide-data/Data/webapp/…（mac/linux 运行副本）；
        #    Windows 运行副本：…/gh555.com/Data/webapp/…（Data 父目录带 joker.exe）
        for d in chain:
            base = os.path.basename(d)
            parent = os.path.dirname(d)
            if base == "qqqide-data":
                if IS_MAC:
                    e = _mac_app_exe_in(parent)
                    if e:
                        out.append((e, []))
                elif not IS_WIN:
                    for name in ("qqqide", "qqqide-bin"):
                        p = os.path.join(parent, name)
                        if os.path.exists(p):
                            out.append((_norm(p), []))
                            break
                break
            if base == "Data" and IS_WIN and os.path.exists(os.path.join(parent, "joker.exe")):
                out.append((_norm(os.path.join(parent, "joker.exe")), []))
                break

        # ④ 容器资源副本：<容器>/resources/app/webapp/…（win/linux；mac 已被 ② 覆盖）
        if not in_app_bundle:
            for d in chain:
                if os.path.basename(d).lower() == "resources" and \
                        os.path.basename(os.path.dirname(d)).lower() != "contents":
                    cont = os.path.dirname(d)
                    if IS_WIN and os.path.exists(os.path.join(cont, "joker.exe")):
                        out.append((_norm(os.path.join(cont, "joker.exe")), []))
                    elif not IS_WIN:
                        for name in ("qqqide", "qqqide-bin"):
                            p = os.path.join(cont, name)
                            if os.path.exists(p):
                                out.append((_norm(p), []))
                                break
                    break
    except Exception:
        pass
    return out


def _bundle_main_js(bin_path, extra):
    """包壳层 bundle 路径（能力探测用；不存在 → None）。"""
    if extra:      # 开发树：app 根 = extra[0]
        p = os.path.join(extra[0], "shell-out", "main.js")
        return _norm(p) if os.path.exists(p) else None
    nb = os.path.abspath(bin_path).replace("\\", "/")
    m = re.match(r"^(.*\.app)/Contents/MacOS/[^/]+$", nb, re.I)
    if m:          # mac 打包：资源在 …app/Contents/Resources/app
        p = os.path.join(_norm(m.group(1)), "Contents", "Resources", "app", "shell-out", "main.js")
    else:          # win/linux：<宿主>/resources/app
        p = os.path.join(os.path.dirname(bin_path), "resources", "app", "shell-out", "main.js")
    return _norm(p) if os.path.exists(p) else None


def _supports_browser_host(bin_path, extra, need_profile=False):
    """能力探测：包内壳层 bundle 是否含受控浏览器能力（need_profile=还要档案槽能力）。
    旧包明确报错，而不是拉起旧内核傻等超时。布局未知（bundle 不存在）→ 放行尝试（超时提示兜底）。"""
    try:
        bundle = _bundle_main_js(bin_path, extra)
        if not bundle:
            return True
        with open(bundle, "rb") as f:
            blob = f.read()
        if _PROBE_WORD not in blob:
            return False
        return (not need_profile) or (_PROBE_PROFILE in blob)
    except Exception:
        return True


def shell_data_root(shell_bin, extra=None):
    """壳层所属安装的 {Data} 目录（同装判定用）——与 kit 侧 resolve_data_root() 同口径。"""
    nb = os.path.abspath(shell_bin).replace("\\", "/")
    low = nb.lower()
    if "/node_modules/electron/" in low or "/electron/dist/" in low:
        root = _norm(extra[0]) if extra else _norm(nb.split("/node_modules/", 1)[0])
        return _norm(os.path.join(root, "Data"))
    m = re.match(r"^(.*\.app)/Contents/MacOS/[^/]+$", nb, re.I)
    if m:
        container = _norm(os.path.dirname(_norm(m.group(1))))
        return _norm(os.path.join(container, "qqqide-data", "Data"))
    d = os.path.dirname(os.path.abspath(shell_bin))
    if os.path.isdir(os.path.join(d, "qqqide-data")):
        return _norm(os.path.join(d, "qqqide-data", "Data"))
    return _norm(os.path.join(d, "Data"))


def resolve_shell(shell=None, app=None):
    """-> (内核路径, 附加参数[])。找不到抛 RuntimeError（含指引）。
    ★ 同装优先：本工具链只驱动【与自己同一个安装】的壳层——启动器广播的 QQQIDE_PYTHON_DIR
      与 kit 自身位置推导出的壳层可能属于不同安装（开发树 + 已装绿色包共存时的常见情形），
      此时以「{Data} 与本 kit 一致」的那个候选为准，否则会出现「开发树的数据 + 绿色包的壳层」。"""
    if shell:
        exe = _norm(shell)
        if not os.path.exists(exe):
            raise RuntimeError("--shell 指向的内核不存在: " + exe)
        if app:
            return exe, [_norm(app)]
        auto = _autodetect_dev_app(exe)
        return exe, ([auto] if auto else [])

    tried = []
    # ① 显式环境覆写（服务/脚本场景；跨平台）
    env_shell = os.environ.get("QQQIDE_SHELL")
    if env_shell:
        exe = _norm(env_shell)
        if os.path.exists(exe):
            if app:
                return exe, [_norm(app)]
            auto = _autodetect_dev_app(exe)
            return exe, ([auto] if auto else [])
        tried.append("QQQIDE_SHELL=" + env_shell + "（路径不存在）")
    # 候选集：② 启动器广播推导（QQQIDE_PYTHON_DIR） ③ 自身位置推导（装包运行/资源副本、开发树）
    cands = []
    pydir = os.environ.get("QQQIDE_PYTHON_DIR") or _read_win_registry_pydir()
    if pydir:
        py = _norm(pydir)
        tried.append(py)
        cands.extend(_kernel_candidates(py))
    cands.extend(_self_candidates())

    try:
        mine = os.path.normcase(resolve_data_root())
    except Exception:
        mine = None
    others = []
    for cand, extra in cands:
        if not os.path.exists(cand):
            continue
        if mine is None:
            return cand, extra
        try:
            same = os.path.normcase(shell_data_root(cand, extra)) == mine
        except Exception:
            same = False
        if same:
            return cand, extra                      # 同装命中（优先）
        others.append((cand, extra))
    if others:
        return others[0]                            # 跨装兜底（总比找不到强）
    raise RuntimeError(
        "未找到 qd 内核（joker/qqqide）。已尝试: " + ("; ".join(tried) if tried else "无环境线索") +
        "\n请用 --shell 指定，或设置环境变量 QQQIDE_SHELL；例: --shell \"<装包>\\gh555.com\\joker.exe\"")


# ── 数据根 / 档案槽 ──

def data_root_candidates():
    """{Data} 目录的候选（按优先级，纯位置推导；四布局：开发树 / 运行副本 / 资源副本 / mac·linux 托管）。
    ★ 不依赖内核路径——外部内核场景下根本没有 qd 壳层。"""
    out = []
    try:
        chain = []
        d = os.path.dirname(os.path.abspath(__file__))
        for _ in range(16):
            chain.append(d)
            nd = os.path.dirname(d)
            if nd == d:
                break
            d = nd
        for d in chain:
            base = os.path.basename(d)
            # ① 运行副本：…/Data/webapp/ai-panel/webtools/kit
            if base == "webapp" and os.path.basename(os.path.dirname(d)) == "Data":
                out.append(_norm(os.path.dirname(d)))
                break
            # ② server-app（开发树 <root>/server-app；资源副本 <容器>/resources/app/server-app）
            if base == "server-app":
                app_dir = os.path.dirname(d)                       # <root> | <容器>/resources/app
                parent = os.path.dirname(app_dir)
                if os.path.basename(app_dir).lower() == "app" and os.path.basename(parent).lower() == "resources":
                    cont = os.path.dirname(parent)                 # <容器> | <X.app>/Contents
                    if os.path.basename(cont) == "Contents":       # mac bundle
                        cont = os.path.dirname(os.path.dirname(cont))
                        out.append(_norm(os.path.join(cont, "qqqide-data", "Data")))
                    else:
                        alt = os.path.join(cont, "qqqide-data", "Data")
                        out.append(_norm(alt if os.path.isdir(os.path.join(cont, "qqqide-data")) else os.path.join(cont, "Data")))
                else:
                    out.append(_norm(os.path.join(app_dir, "Data")))
                break
    except Exception:
        pass
    return out


def resolve_data_root(data_root=None):
    """{Data} 绝对路径。显式 --data-root > QQQIDE_DATA_DIR > 位置推导 > 报错。"""
    for cand in (data_root, os.environ.get("QQQIDE_DATA_DIR")):
        if cand:
            return _norm(os.path.abspath(os.path.expandvars(cand)))
    cands = data_root_candidates()
    for c in cands:
        if os.path.isdir(c):
            return c
    if cands:
        return cands[0]
    raise RuntimeError("未能推导 qd 数据根（Data 目录）——请用 --data-root 显式指定")


def profile_dir(slot="default", engine="builtin", data_root=None):
    """档案目录（绝对路径）。默认槽 + 内置内核 → 历史路径 {Data}/browser-host（登录态原地保留）。"""
    dr = resolve_data_root(data_root)
    slot = _slot_of(slot)
    if engine not in ENGINES:
        raise RuntimeError("未知内核: %r（可选 %s）" % (engine, "/".join(ENGINES)))
    if slot == "default" and engine == "builtin":
        return os.path.join(dr, "browser-host")
    return os.path.join(dr, "browser-profiles", slot, engine)


def _slot_meta_path(slot, data_root=None):
    return os.path.join(resolve_data_root(data_root), "browser-profiles", _slot_of(slot), "slot.json")


def _read_slot_meta(slot, data_root=None):
    try:
        with open(_slot_meta_path(slot, data_root), "r", encoding="utf-8") as f:
            m = json.load(f)
        return m if isinstance(m, dict) else {}
    except Exception:
        return {}


def _write_slot_meta(slot, data_root=None, **patch):
    p = _slot_meta_path(slot, data_root)
    m = _read_slot_meta(slot, data_root)
    m.setdefault("v", 1)
    m["slot"] = _slot_of(slot)
    m.setdefault("createdAt", int(time.time() * 1000))
    m.update({k: v for k, v in patch.items() if v is not None})
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = p + ".%d.tmp" % os.getpid()
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(m, f, ensure_ascii=False)
        os.replace(tmp, p)
    except Exception:
        pass
    return m


def _used_engines(slot, data_root=None):
    return [e for e in ENGINES if os.path.isdir(profile_dir(slot, e, data_root))]


def _candidate_engines(slot, data_root=None):
    """发现/停止时的引擎优先级：槽记录的活动内核 > 有档案的内核 > builtin 兜底。"""
    used = _used_engines(slot, data_root)
    meta = _read_slot_meta(slot, data_root)
    order = []
    for e in ([meta.get("active")] + used + ["builtin"]):
        if e in ENGINES and e not in order:
            order.append(e)
    return order


def resolve_slot_engine(slot, engine=None, data_root=None, rebind=False):
    """裁决本次用哪颗内核。auto = 槽有档案按档案；新槽 → 有外部内核用外部（内核新鲜度优先），
    否则内置（零依赖兜底）。槽已钉住另一颗内核时，显式换内核必须 rebind（换内核＝换档案）。"""
    req = (engine or os.environ.get("QQQIDE_BROWSER_ENGINE") or "auto").strip().lower()
    if req not in ("auto",) + ENGINES:
        raise RuntimeError("未知 --engine: %r（可选 auto/builtin/external）" % req)
    used = _used_engines(slot, data_root)
    meta = _read_slot_meta(slot, data_root)
    if req == "auto":
        act = meta.get("active")
        if act in used:
            return act
        if used:
            return used[-1]
        return "external" if browser_engine.find() else "builtin"
    if used and req not in used and not rebind:
        raise RuntimeError(
            "档案槽 %r 已在 %s 内核下建档；换内核＝换档案（登录态不跨内核通用）。\n"
            "确需换：加 --rebind（旧档案原样保留，可随时换回），或换一个槽名（--profile <新槽>）。"
            % (slot, "/".join(used)))
    return req


# ── 端点发现 ──

def default_report_path(shell_bin=None, profile=None, engine="builtin", data_root=None):
    """报告文件路径（按 [内核+槽+引擎] 定名 → 同机多装包/多槽互不串）。"""
    h = hashlib.sha1(("%s|%s|%s" % (os.path.abspath(shell_bin or "qd").lower(),
                                    _slot_of(profile), engine)).encode("utf-8", "replace")).hexdigest()[:8]
    return os.path.join(tempfile.gettempdir(), "qqq-browser-report-%s.json" % h)


def _probe(port, timeout=2.5):
    try:
        import urllib.request
        with urllib.request.urlopen("http://127.0.0.1:%d/json/version" % int(port), timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8", "replace"))
            return data if isinstance(data, dict) else None
    except Exception:
        return None


def _pid_alive(pid):
    try:
        pid = int(pid)
    except Exception:
        return True
    if pid <= 0:
        return True
    try:
        if IS_WIN:
            out = subprocess.run(["tasklist", "/FI", "PID eq %d" % pid, "/NH"],
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=6,
                                 creationflags=_NO_WINDOW).stdout
            return str(pid) in (out or b"").decode("utf-8", "replace")
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def _read_report_file(p):
    try:
        with open(p, "r", encoding="utf-8") as f:
            ep = json.load(f)
    except Exception:
        return None
    if not isinstance(ep, dict) or not ep.get("ok") or not ep.get("cdpPort"):
        return None
    if not _probe(ep["cdpPort"]):
        return None
    return ep


def _ws_id(ver):
    """内核实例身份（/json/version 里 webSocketDebuggerUrl 末尾的 UUID）——每次启动都不同，
    是「这个端口是不是我那个内核」零成本强验证（端口被别的进程/别的槽重新占上时必失配）。"""
    try:
        return ((ver or {}).get("webSocketDebuggerUrl") or "").rsplit("/", 1)[-1]
    except Exception:
        return ""


def _endpoint_for(slot, engine, data_root=None):
    """某槽某引擎的活端点（真相 = host.json 心跳 + CDP 探测应答 + 实例身份）。未运行 -> None。
    ★ 身份不得串：端口可能被别的进程/别的槽重新占上——
       内置按 pid 验（Electron 的 process.pid 就是内核进程）；
       外部按 wsId 验（Chrome 的启动器进程与实际浏览器进程常不同 pid，不可靠）。"""
    try:
        pd = profile_dir(slot, engine, data_root)
    except Exception:
        return None
    hj = os.path.join(pd, "host.json")
    try:
        with open(hj, "r", encoding="utf-8") as f:
            h = json.load(f)
    except Exception:
        return None
    if not isinstance(h, dict) or not h.get("cdpPort"):
        return None
    if engine == "builtin" and h.get("pid") and not _pid_alive(h.get("pid")):
        return None
    ver = _probe(h.get("cdpPort"), 1.2)
    if not ver:
        return None
    if h.get("wsId") and _ws_id(ver) != h.get("wsId"):
        return None
    ep = dict(h)
    ep.update({
        "ok": True, "mode": "browser-host",
        "engine": engine, "slot": _slot_of(slot),
        "dataDir": pd, "hostJson": hj,
        "kernel": ver.get("Browser") or "",
    })
    return ep


def read_canonical_endpoint(slot="default", engine="builtin", data_root=None):
    """权威端点（TEMP 无关）：{档案目录}/host.json。IDE 内跑的 kit 与终端跑的 kit 互见同一实例。"""
    return _endpoint_for(slot, engine, data_root)


def read_live_endpoint(report=None, shell_bin=None, app=None, profile=None, engine=None, data_root=None):
    """读端点（真相 = CDP 探测应答）。未运行 -> None。
    engine=auto（默认）→ 按槽的引擎优先级逐个查（活动内核优先），返回第一个活的。
    显式 report 时以报告文件为准。"""
    slot = _slot_of(profile)
    if report:
        ep = _read_report_file(report)
        if ep:
            ep.setdefault("slot", slot)
            return ep
    req = (engine or os.environ.get("QQQIDE_BROWSER_ENGINE") or "auto").strip().lower()
    engines = _candidate_engines(slot, data_root) if req == "auto" else [req]
    for e in engines:
        if e not in ENGINES:
            continue
        ep = _endpoint_for(slot, e, data_root)
        if ep:
            return ep
    return None


def find_any_live_report(shell_bin=None, app=None, profile=None, engine=None, data_root=None):
    """扫描临时目录全部报告，返回仍在本槽运行的端点（★ 恒按槽过滤——身份绝不串）。
    同包优先：能判定本包预期档案目录时只接受同一档案目录的实例。"""
    slot = _slot_of(profile)
    expected = None
    try:
        req = (engine or os.environ.get("QQQIDE_BROWSER_ENGINE") or "auto").strip().lower()
        want = [profile_dir(slot, req, data_root)] if req != "auto" else \
            [profile_dir(slot, e, data_root) for e in ENGINES]
    except Exception:
        return None                      # 算不出本槽档案目录 → 宁可不猜（禁跨槽误认）
    for p in sorted(_glob.glob(os.path.join(tempfile.gettempdir(), "qqq-browser-report-*.json"))):
        ep = _read_report_file(p)
        if not ep:
            continue
        dd = ep.get("dataDir")
        if not dd or not any(_same_dir(dd, w) for w in want):
            continue                     # ★ 只接受本槽档案目录的实例（身份绝不串）
        ep["reportPath"] = p
        return ep
    return None


def _same_dir(a, b):
    try:
        return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))
    except Exception:
        return False


def list_slots(data_root=None):
    """所有档案槽（含默认槽）+ 每个引擎档案的存活状态。"""
    dr = resolve_data_root(data_root)
    names = set()
    base = os.path.join(dr, "browser-profiles")
    try:
        for n in os.listdir(base):
            if os.path.isdir(os.path.join(base, n)) and _SLOT_RE.match(n):
                names.add(n)
    except Exception:
        pass
    if os.path.isdir(os.path.join(dr, "browser-host")):
        names.add("default")
    out = []
    for slot in sorted(names):
        meta = _read_slot_meta(slot, dr)
        engines = []
        for e in ENGINES:
            pd = profile_dir(slot, e, dr)
            if not os.path.isdir(pd):
                continue
            ep = _endpoint_for(slot, e, dr)
            engines.append({
                "engine": e, "dataDir": pd, "running": bool(ep),
                "cdpPort": (ep or {}).get("cdpPort"), "pid": (ep or {}).get("pid"),
                "kernel": (ep or {}).get("kernel") or "",
            })
        if not engines:
            continue
        out.append({"slot": slot, "label": meta.get("label") or "",
                    "active": meta.get("active") or "", "engines": engines})
    return out


# ── 启动 ──

def _spawn_detached(cmd, log_path):
    kwargs = {"cwd": os.path.dirname(cmd[0]) or None, "close_fds": True}
    if IS_WIN:
        kwargs["creationflags"] = _DETACHED
    else:
        kwargs["start_new_session"] = True
    with open(log_path, "ab") as logf:
        return subprocess.Popen(cmd, stdout=logf, stderr=subprocess.STDOUT, **kwargs)


class _LaunchLock(object):
    """跨槽启动串行（防并发 ensure 抢同一批 CDP 端口 / 抢同一份档案锁）。
    原子建文件 + 陈旧接管（90s）；拿不到 → RuntimeError（绝不无限等待）。"""

    def __init__(self, data_root, wait=120.0, stale=90.0):
        self.path = os.path.join(resolve_data_root(data_root), "browser-profiles", ".ensure.lock")
        self.wait = wait
        self.stale = stale
        self.fd = None

    def __enter__(self):
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
        except Exception:
            return self
        end = time.time() + self.wait
        while time.time() < end:
            try:
                self.fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                try:
                    os.write(self.fd, str(os.getpid()).encode())
                except Exception:
                    pass
                return self
            except FileExistsError:
                try:
                    if time.time() - os.path.getmtime(self.path) > self.stale:
                        os.remove(self.path)
                        continue
                except Exception:
                    pass
                time.sleep(0.25)
            except Exception:
                return self          # 无写权限等 → 退化为不加锁（不阻塞主流程）
        raise RuntimeError("启动锁等待超时（%s）——另一个 ensure 长时间未完成？" % self.path)

    def __exit__(self, *exc):
        if self.fd is not None:
            try:
                os.close(self.fd)
            except Exception:
                pass
            try:
                os.remove(self.path)
            except Exception:
                pass
        return False


def _dispatch_navigate(shell_bin, extra, rep, slot, rel, url, hidden=False, wait_sec=8.0):
    """内置内核复用路径的 --url：派发一次二次实例导航（fire-and-forget + 轻等待目标页出现）。
    隐藏档实例不会被弹窗（壳层保证）；可见实例会被带到前台。"""
    cmd = [shell_bin] + list(extra) + ["--qqqide-browser", "--qqqide-browser-slot=" + slot,
                                       "--qqqide-browser-profile=" + rel,
                                       "--qqqide-browser-report=" + rep,
                                       "--qqqide-browser-url=" + url]
    if hidden:
        cmd.append("--qqqide-browser-hidden")
    try:
        _spawn_detached(cmd, rep + ".log")
    except Exception:
        return False
    if not wait_sec:
        return True
    try:
        from urllib.parse import urlsplit
        host = (urlsplit(url).netloc or "").split("@")[-1].split(":")[0]
    except Exception:
        host = ""
    if not host:
        return True
    end = time.time() + wait_sec
    while time.time() < end:
        try:
            import urllib.request
            ep = read_live_endpoint(profile=slot, engine="builtin")
            if not ep:
                return True
            with urllib.request.urlopen("http://127.0.0.1:%d/json/list" % int(ep["cdpPort"]), timeout=2.0) as r:
                tabs = json.loads(r.read().decode("utf-8", "replace"))
            if any(isinstance(t, dict) and host in (t.get("url") or "") for t in tabs):
                return True
        except Exception:
            pass
        time.sleep(0.4)
    return True


def _ensure_builtin(slot, prof, data_root, hidden, url, shell, app, report, wait,
                    exit_with, idle_exit):
    shell_bin, extra = resolve_shell(shell, app)
    rel = os.path.relpath(prof, resolve_data_root(data_root)).replace("\\", "/")
    need_profile = (rel != "browser-host")
    if not _supports_browser_host(shell_bin, extra, need_profile):
        if need_profile:
            raise RuntimeError("这个 qd 版本还不含「档案槽」能力（壳层未升级）——具名槽无法使用。\n"
                               "请升级 qd 到最新版；或改用内置默认槽（--profile default）。")
        raise RuntimeError("这个 qd 版本还不含「受控浏览器」能力（壳层未升级）。\n"
                           "请升级 qd 到最新版；或临时指定外部内核: --engine external")
    rep = report or default_report_path(shell_bin, slot, "builtin", data_root)
    try:
        os.remove(rep)
    except OSError:
        pass
    cmd = [shell_bin] + list(extra) + ["--qqqide-browser", "--qqqide-browser-slot=" + slot,
                                       "--qqqide-browser-profile=" + rel,
                                       "--qqqide-browser-report=" + rep]
    if hidden:
        cmd.append("--qqqide-browser-hidden")
    if url:
        cmd.append("--qqqide-browser-url=" + url)
    if exit_with:
        cmd.append("--qqqide-browser-exit-with=%d" % int(exit_with))
    if idle_exit is not None:
        cmd.append("--qqqide-browser-idle-exit=%g" % float(idle_exit))
    log_path = rep + ".log"
    _spawn_detached(cmd, log_path)

    end = time.time() + max(5.0, float(wait))
    while time.time() < end:
        time.sleep(0.4)
        try:
            with open(rep, "r", encoding="utf-8") as f:
                j = json.load(f)
        except Exception:
            j = None
        if isinstance(j, dict) and j.get("ok") is False:
            raise RuntimeError("受控浏览器启动失败: %s（日志: %s）" % (j.get("error"), log_path))
        ep = _endpoint_for(slot, "builtin", data_root)
        if ep:
            ep.setdefault("reused", False)
            ep["logFile"] = log_path
            ep["engine"] = "builtin"
            return ep
    raise RuntimeError("等待受控浏览器就绪超时。日志: %s" % log_path)


def _ensure_external(slot, prof, data_root, hidden, url, wait, browser=None):
    info = browser_engine.find(browser)
    if not info:
        raise RuntimeError(
            "未找到外部 Chromium 内核（Chrome/Edge/Brave/Chromium）。\n"
            "请用 --browser <路径> 指定，或设环境变量 CDP_BROWSER；\n"
            "或改用内置内核: --engine builtin（零依赖，任何机器可用）。")
    os.makedirs(prof, exist_ok=True)
    pid = browser_engine.launch(info["path"], prof, url=url, headless=bool(hidden))
    port = browser_engine.read_active_port(prof, timeout=max(8.0, float(wait)))
    if not port:
        try:
            if IS_WIN:
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               creationflags=_NO_WINDOW)
            else:
                os.kill(pid, 15)
        except Exception:
            pass
        raise RuntimeError(
            "外部内核未就绪（%s）。常见原因：该档案槽已被另一个窗口占用（同一 user-data-dir 只能一个实例）。\n"
            "槽目录: %s" % (info["path"], prof))
    ver = _probe(port, 3.0) or {}
    owner = browser_engine.pid_on_port(port) or pid     # 端口真实拥有者（启动器进程 ≠ 浏览器进程）
    ep = {
        "ok": True, "ver": 1, "mode": "browser-host", "reused": False,
        "engine": "external", "slot": slot, "pid": owner,
        "cdpPort": port, "dataDir": prof, "wsId": _ws_id(ver),
        "hostJson": os.path.join(prof, "host.json"),
        "hidden": bool(hidden), "ts": int(time.time() * 1000),
        "kernel": ver.get("Browser") or "", "kernelPath": info["path"], "kernelSrc": info["source"],
    }
    beat = {"v": 1, "engine": "external", "slot": slot, "pid": owner,
            "cdpPort": port, "hidden": bool(hidden), "ts": ep["ts"],
            "wsId": ep["wsId"], "kernel": ep["kernel"],
            "userData": prof, "startedAt": ep["ts"]}
    try:
        tmp = ep["hostJson"] + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(beat, f, ensure_ascii=False)
        os.replace(tmp, ep["hostJson"])
    except Exception as e:
        raise RuntimeError("外部内核已就绪但端点心跳写盘失败（%s）——该槽无法被发现: %s"
                           % (ep["hostJson"], e))
    return ep


def ensure_started(hidden=False, url=None, shell=None, app=None, report=None, wait=45.0,
                   exit_with=None, idle_exit=None, profile=None, engine=None,
                   data_root=None, rebind=False, label=None, browser=None):
    """确保受控浏览器就绪；返回端点 dict（含 pid/cdpPort/engine/slot）。已在跑 → 复用。
    ★ 复用路径：给了 url 则派发一次导航（内置=导航主窗，外部=新开标签页）。
    exit_with / idle_exit / hidden 的完整语义仅内置内核具备（外部=--headless=new 近似）。"""
    dr = resolve_data_root(data_root)
    slot = _slot_of(profile)
    eng = resolve_slot_engine(slot, engine, dr, rebind=rebind)
    prof = profile_dir(slot, eng, dr)

    ep = _endpoint_for(slot, eng, dr)
    if ep:
        ep["reused"] = True
        _write_slot_meta(slot, dr, active=eng, label=label)
        if url and str(url).lower().startswith(("http:", "https:")):
            if eng == "builtin":
                rep = report or default_report_path(None, slot, "builtin", dr)
                try:
                    shell_bin, extra = resolve_shell(shell, app)
                    rel = os.path.relpath(prof, dr).replace("\\", "/")
                    _dispatch_navigate(shell_bin, extra, rep, slot, rel, url, hidden)
                except Exception:
                    pass
            else:
                _external_open_tab(ep["cdpPort"], url)
        return ep

    with _LaunchLock(dr):
        ep = _endpoint_for(slot, eng, dr)          # 双检（并发 ensure 的另一半已经起来了）
        if ep:
            ep["reused"] = True
            _write_slot_meta(slot, dr, active=eng, label=label)
            return ep
        if eng == "builtin":
            ep = _ensure_builtin(slot, prof, dr, hidden, url, shell, app, report, wait,
                                 exit_with, idle_exit)
        else:
            ep = _ensure_external(slot, prof, dr, hidden, url, wait, browser)
        _write_slot_meta(slot, dr, active=eng, label=label)
        return ep


def _external_open_tab(port, url):
    """外部内核复用语义：新开一个标签页（Chrome 原生；不夺用户正看着的那一页）。"""
    try:
        import urllib.request
        req = urllib.request.Request("http://127.0.0.1:%d/json/new?%s" % (int(port), url), method="PUT")
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except Exception:
        return None


def stop(report=None, shell=None, app=None, profile=None, data_root=None, engine=None):
    """停止该槽的受控浏览器（关窗即退出；登录态保留在档案）。返回是否真的停了。"""
    dr = resolve_data_root(data_root)
    slot = _slot_of(profile)
    req = (engine or os.environ.get("QQQIDE_BROWSER_ENGINE") or "auto").strip().lower()
    targets = [req] if req in ENGINES else _candidate_engines(slot, dr)
    stopped = False
    for e in targets:
        ep = _endpoint_for(slot, e, dr)
        if not ep:
            continue
        pid = int(ep.get("pid") or 0)
        if e == "external":
            pid = browser_engine.pid_on_port(ep.get("cdpPort")) or pid
        if pid > 0:
            if IS_WIN:
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               creationflags=_NO_WINDOW)
            else:
                import signal as _s
                try:
                    os.killpg(os.getpgid(pid), _s.SIGTERM)
                except Exception:
                    try:
                        os.kill(pid, _s.SIGTERM)
                    except Exception:
                        pass
            end = time.time() + 8
            while time.time() < end and _probe(ep.get("cdpPort"), 1.0):
                time.sleep(0.4)
        try:
            os.remove(ep.get("hostJson") or "")
        except OSError:
            pass
        stopped = True
    if report:
        try:
            os.remove(report)
        except OSError:
            pass
    else:
        try:
            shell_bin = resolve_shell(shell, app)[0]
        except Exception:
            shell_bin = None
        if shell_bin:
            try:
                os.remove(default_report_path(shell_bin, slot, "builtin", dr))
            except OSError:
                pass
    return stopped


# ── CLI ──

def main(argv=None):
    ap = argparse.ArgumentParser(description="qd 受控浏览器：档案槽 × 内核（确保/查询/停止/列举）")
    sub = ap.add_subparsers(dest="cmd")
    common = [
        (["--profile"], dict(default=None, help="档案槽名（默认 default；别名 CDP_PROFILE）")),
        (["--data-root"], dict(default=None, help="qd 数据根（默认位置推导；别名 QQQIDE_DATA_DIR）")),
        (["--shell"], dict(default=None, help="内置内核路径（默认自动从装包推导）")),
        (["--app"], dict(default=None, help="应用目录（开发树用）")),
        (["--report"], dict(default=None, help="报告文件路径（默认按内核+槽定名）")),
    ]

    def _add(p, extra):
        for a, kw in common + (extra or []):
            p.add_argument(*a, **kw)

    pe = sub.add_parser("ensure", help="确保在跑（就绪即复用）")
    _add(pe, [
        (["--engine"], dict(default=None, choices=["auto", "builtin", "external"], help="内核（默认 auto）")),
        (["--rebind"], dict(action="store_true", help="确认换内核（＝换档案；旧档案保留）")),
        (["--browser"], dict(default=None, help="外部内核路径（默认自动发现；别名 CDP_BROWSER）")),
        (["--hidden"], dict(action="store_true", help="静默档（内置=无可见窗；外部=headless）")),
        (["--url"], dict(default=None, help="目标网址（新起=直接加载；复用=导航/新开标签页）")),
        (["--exit-with"], dict(default=None, type=int, help="跟随监督进程 PID（仅内置、仅新起）")),
        (["--idle-exit"], dict(default=None, type=float, help="空闲自退分钟数（仅内置、仅新起；0=关）")),
        (["--label"], dict(default=None, help="槽位人类可读标签（如 \"阿里云 divaci\"）")),
        (["--wait"], dict(default=45.0, type=float, help="就绪等待上限（秒）")),
    ])
    pst = sub.add_parser("status", help="打印当前端点（未运行 = 退出码 1）")
    _add(pst, [(["--engine"], dict(default=None, choices=["auto", "builtin", "external"]))])
    psp = sub.add_parser("stop", help="停止（关闭浏览器）")
    _add(psp, [(["--engine"], dict(default=None, choices=["auto", "builtin", "external"]))])
    pl = sub.add_parser("list", help="列举所有档案槽")
    _add(pl, [])
    plb = sub.add_parser("label", help="给槽位起标签")
    plb.add_argument("slot")
    plb.add_argument("label")
    plb.add_argument("--data-root", default=None)
    ap.add_argument("--json", action="store_true", default=None, help="只输出 JSON（位置自由）")
    args = ap.parse_args(argv)

    if not args.cmd:
        ap.print_help()
        return 1

    try:
        if args.cmd == "ensure":
            ep = ensure_started(hidden=args.hidden, url=args.url, shell=args.shell, app=args.app,
                                report=args.report, wait=args.wait, exit_with=args.exit_with,
                                idle_exit=args.idle_exit, profile=args.profile, engine=args.engine,
                                data_root=args.data_root, rebind=args.rebind, label=args.label,
                                browser=args.browser)
            if not args.json:
                print("[ok] 受控浏览器就绪  slot=%s  engine=%s  pid=%s  cdpPort=%s  %s" % (
                    ep.get("slot"), ep.get("engine"), ep.get("pid"), ep.get("cdpPort"),
                    "(复用现有实例)" if ep.get("reused") else ""))
                if ep.get("kernel"):
                    print("     内核 %s" % ep["kernel"])
            print(json.dumps(ep, ensure_ascii=False))
            return 0
        if args.cmd == "status":
            ep = read_live_endpoint(profile=args.profile, engine=args.engine, data_root=args.data_root) \
                or find_any_live_report(profile=args.profile, engine=args.engine, data_root=args.data_root)
            if not ep:
                print(json.dumps({"running": False}) if args.json else "[--] 受控浏览器未在运行")
                return 1
            if not args.json:
                print("[ok] 运行中  slot=%s  engine=%s  pid=%s  cdpPort=%s" % (
                    ep.get("slot"), ep.get("engine"), ep.get("pid"), ep.get("cdpPort")))
            print(json.dumps(ep, ensure_ascii=False))
            return 0
        if args.cmd == "stop":
            ok = stop(report=args.report, shell=args.shell, app=args.app, profile=args.profile,
                      data_root=args.data_root, engine=args.engine)
            print(json.dumps({"stopped": ok}) if args.json else ("[ok] 已停止" if ok else "[--] 本来就没在运行"))
            return 0
        if args.cmd == "list":
            rows = list_slots(args.data_root)
            if args.json:
                print(json.dumps(rows, ensure_ascii=False))
                return 0
            if not rows:
                print("[--] 没有任何档案槽")
                return 0
            for r in rows:
                print("槽 %-14s %s" % (r["slot"], ("「%s」" % r["label"]) if r["label"] else ""))
                for e in r["engines"]:
                    print("   %-9s %-6s %s%s" % (
                        e["engine"],
                        ("运行中" if e["running"] else "未运行"),
                        ("cdpPort=%s  " % e["cdpPort"]) if e["running"] else "",
                        (e["kernel"] or "")))
                print("   %s" % r["engines"][0]["dataDir"])
            return 0
        if args.cmd == "label":
            _write_slot_meta(args.slot, args.data_root, label=args.label)
            print("[ok] 槽 %s 标签 = %s" % (args.slot, args.label))
            return 0
    except Exception as e:
        print("[x] " + str(e), file=sys.stderr)
        return 2
    return 1


if __name__ == "__main__":
    sys.exit(main())
