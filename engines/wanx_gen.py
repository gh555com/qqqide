"""
wanx_gen.py — 通义万相 文生图 CLI (wanx2.1-t2i-plus)
供 qqq AI 工具 generate_image 调用。

用法:
    python wanx_gen.py --prompt "一只青蛙" --style 插画 --size 1024*1024 --out-dir "E:/out"
    输出 JSON: {"ok": true, "paths": ["E:/out/wanx_xxx.png"], "cached": false, "elapsed": 18.3}

特性:
    - 缓存: 同 prompt+style+size → 复用已有图片，零 API 费用
    - 进度: --verbose 时 stderr 输出轮询状态；返回值含 elapsed 秒数
    - 铁律: stdout 只输出 JSON
"""

import argparse, json, os, sys, time, hashlib
from pathlib import Path
from datetime import datetime

MODEL = "wanx2.1-t2i-plus"
CREATE_EP = "https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis"
TASK_EP  = "https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}"

# 阿里云 DashScope 定价 → ge（1 ge ≈ ¥0.001）
# wanx2.1-t2i-plus: ¥0.12/张(1024*1024) → 120 ge
GE_COST_PER_IMAGE = 120

STYLE_BOOSTERS = {
    "写实": "photorealistic, 8k resolution, professional photography, natural lighting, sharp focus, detailed texture",
    "插画": "digital illustration, vibrant colors, clean lines, storybook style, professional artwork, trending on ArtStation",
    "3d": "3D render, cinema 4D, octane render, ray tracing, high quality 3D, soft lighting, depth of field",
    "二次元": "anime style, manga illustration, cel-shaded, high quality anime artwork, vibrant, clean lineart",
    "水彩": "watercolor painting, soft washes, artistic, dreamy atmosphere, delicate brushwork",
    "国风": "traditional Chinese painting style, ink wash, gufeng, elegant composition, zen atmosphere, silk texture",
    "极简": "minimalist design, clean composition, simple shapes, elegant, lots of negative space, modern aesthetic",
    "电商": "e-commerce product photography, studio lighting, white background, commercial photography, high-end retouching",
    "自然": "nature photography, golden hour, bokeh, organic textures, natural beauty, outdoor lighting",
}


def get_api_key():
    key = os.environ.get("DASHSCOPE_API_KEY", "")
    if key:
        return key
    kf = Path("E:/s/wol/py/gaea/cf/.key_settings.json")
    if kf.exists():
        try:
            ks = json.loads(kf.read_text(encoding="utf-8"))
            key = ks.get("dashscope_api_key", "")
        except Exception:
            pass
    return key


def build_prompt(raw, style):
    parts = [raw.strip()]
    if style and style in STYLE_BOOSTERS:
        parts.append(STYLE_BOOSTERS[style])
    elif style:
        parts.append(style)
    return ", ".join(parts)


def safe_filename(prompt):
    h = hashlib.md5(prompt.encode()).hexdigest()[:6]
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"wanx_{ts}_{h}.png"


def _cache_key(prompt, style, size):
    """生成缓存键"""
    raw = f"{prompt}|{style or ''}|{size}"
    return hashlib.md5(raw.encode()).hexdigest()


def _load_cache(out_dir):
    """加载缓存文件"""
    cf = out_dir / ".wanx_cache.json"
    if cf.exists():
        try:
            return json.loads(cf.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _save_cache(out_dir, cache):
    """写回缓存"""
    cf = out_dir / ".wanx_cache.json"
    try:
        cf.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


def _clean_stale_cache(cache, out_dir):
    """清理缓存中已不存在的文件"""
    stale = [k for k, v in cache.items() if not Path(v["path"]).exists()]
    for k in stale:
        del cache[k]
    if stale:
        _save_cache(out_dir, cache)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--style", default=None)
    ap.add_argument("--size", default="1024*1024")
    ap.add_argument("--n", type=int, default=1)
    ap.add_argument("--out-dir", default=None)
    ap.add_argument("--api-key", default=None)
    ap.add_argument("--no-cache", action="store_true", help="跳过缓存")
    ap.add_argument("--verbose", action="store_true", help="stderr 输出轮询进度")
    args = ap.parse_args()

    api_key = args.api_key or get_api_key()
    if not api_key:
        print(json.dumps({"ok": False, "error": "DASHSCOPE_API_KEY 未设置"}))
        sys.exit(1)

    out_dir = Path(args.out_dir) if args.out_dir else Path.cwd() / "generated"
    out_dir.mkdir(parents=True, exist_ok=True)

    t_start = time.time()

    # ━━━ 缓存检查 ━━━
    if not args.no_cache:
        cache = _load_cache(out_dir)
        _clean_stale_cache(cache, out_dir)
        ck = _cache_key(args.prompt, args.style, args.size)
        if ck in cache and Path(cache[ck]["path"]).exists():
            elapsed = time.time() - t_start
            print(json.dumps({
                "ok": True,
                "paths": [cache[ck]["path"]],
                "cached": True,
                "ge_cost": 0,
                "elapsed": round(elapsed, 1)
            }))
            return

    # ━━━ 构建请求 ━━━
    enhanced = build_prompt(args.prompt, args.style)
    body = {
        "model": MODEL,
        "input": {"prompt": enhanced},
        "parameters": {"size": args.size, "n": args.n},
    }

    import requests
    session = requests.Session()
    session.trust_env = False
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable",
    }

    # 1. 提交任务
    if args.verbose:
        print(f"[wanx] 提交任务...", file=sys.stderr, flush=True)
    resp = session.post(CREATE_EP, headers=headers, json=body, timeout=30)
    if resp.status_code != 200:
        print(json.dumps({"ok": False, "error": f"API {resp.status_code}: {resp.text[:300]}"}))
        sys.exit(1)

    task_id = resp.json().get("output", {}).get("task_id")
    if not task_id:
        print(json.dumps({"ok": False, "error": f"无 task_id: {resp.text[:300]}"}))
        sys.exit(1)

    if args.verbose:
        print(f"[wanx] task_id={task_id}  轮询中...", file=sys.stderr, flush=True)

    # 2. 轮询（带进度）
    task_url = TASK_EP.format(task_id=task_id)
    polls = 0
    for attempt in range(40):
        time.sleep(3)
        polls += 1
        poll = session.get(task_url, headers=headers, timeout=15)
        if poll.status_code != 200:
            if args.verbose:
                print(f"[wanx]   poll {polls}: HTTP {poll.status_code}", file=sys.stderr, flush=True)
            continue
        pd = poll.json()
        status = pd.get("output", {}).get("task_status", "")
        if args.verbose:
            print(f"[wanx]   poll {polls}: {status}", file=sys.stderr, flush=True)

        if status == "SUCCEEDED":
            results = pd["output"].get("results", [])
            paths = []
            for i, r in enumerate(results):
                url = r.get("url", "")
                if not url:
                    continue
                fname = safe_filename(args.prompt) if args.n == 1 else safe_filename(f"{args.prompt}_{i}")
                fpath = out_dir / fname
                if args.verbose:
                    print(f"[wanx]   下载 {url[:80]}...", file=sys.stderr, flush=True)
                img = session.get(url, timeout=60)
                if img.status_code == 200:
                    fpath.write_bytes(img.content)
                    paths.append(str(fpath))

            elapsed = time.time() - t_start

            # 写缓存
            if not args.no_cache and paths:
                cache = _load_cache(out_dir)
                cache[ck] = {"path": paths[0], "ts": datetime.now().isoformat()}
                _save_cache(out_dir, cache)

            print(json.dumps({
                "ok": True,
                "paths": paths,
                "cached": False,
                "ge_cost": GE_COST_PER_IMAGE * len(paths),
                "elapsed": round(elapsed, 1),
                "polls": polls,
            }))
            return

        elif status == "FAILED":
            msg = pd.get("output", {}).get("message", "未知错误")
            print(json.dumps({"ok": False, "error": msg}))
            sys.exit(1)

    elapsed = time.time() - t_start
    print(json.dumps({"ok": False, "error": "任务超时", "elapsed": round(elapsed, 1)}))
    sys.exit(1)


if __name__ == "__main__":
    main()
