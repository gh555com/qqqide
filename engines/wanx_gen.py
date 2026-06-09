"""
wanx_gen.py — 通义万相 文生图 CLI (wanx2.1-t2i-plus)
供 qqq AI 工具 generate_image 调用。

用法:
    python wanx_gen.py --prompt "一只青蛙" --style 插画 --size 1024*1024 --out-dir "E:/out"
    输出 JSON: {"ok": true, "paths": ["E:/out/wanx_xxx.png"]}

铁律:
    - 单次调用，stdout 输出 JSON，无其他输出
    - exit 0=成功 1=失败
    - API Key 来源: 环境变量 DASHSCOPE_API_KEY → gaea cf/.key_settings.json
"""

import argparse, json, os, sys, time, hashlib
from pathlib import Path
from datetime import datetime

MODEL = "wanx2.1-t2i-plus"
CREATE_EP = "https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis"
TASK_EP  = "https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}"

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
    # 尝试从 gaea 项目读取
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--style", default=None)
    ap.add_argument("--size", default="1024*1024")
    ap.add_argument("--n", type=int, default=1)
    ap.add_argument("--out-dir", default=None)
    ap.add_argument("--api-key", default=None)
    args = ap.parse_args()

    api_key = args.api_key or get_api_key()
    if not api_key:
        print(json.dumps({"ok": False, "error": "DASHSCOPE_API_KEY 未设置"}))
        sys.exit(1)

    out_dir = Path(args.out_dir) if args.out_dir else Path.cwd() / "generated"
    out_dir.mkdir(parents=True, exist_ok=True)

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
    resp = session.post(CREATE_EP, headers=headers, json=body, timeout=30)
    if resp.status_code != 200:
        print(json.dumps({"ok": False, "error": f"API {resp.status_code}: {resp.text[:300]}"}))
        sys.exit(1)

    task_id = resp.json().get("output", {}).get("task_id")
    if not task_id:
        print(json.dumps({"ok": False, "error": f"无 task_id: {resp.text[:300]}"}))
        sys.exit(1)

    # 2. 轮询
    task_url = TASK_EP.format(task_id=task_id)
    for _ in range(40):
        time.sleep(3)
        poll = session.get(task_url, headers=headers, timeout=15)
        if poll.status_code != 200:
            continue
        pd = poll.json()
        status = pd.get("output", {}).get("task_status", "")
        if status == "SUCCEEDED":
            results = pd["output"].get("results", [])
            paths = []
            for i, r in enumerate(results):
                url = r.get("url", "")
                if not url:
                    continue
                fname = safe_filename(args.prompt) if args.n == 1 else safe_filename(f"{args.prompt}_{i}")
                fpath = out_dir / fname
                img = session.get(url, timeout=60)
                if img.status_code == 200:
                    fpath.write_bytes(img.content)
                    paths.append(str(fpath))
            print(json.dumps({"ok": True, "paths": paths}))
            sys.exit(0)
        elif status == "FAILED":
            msg = pd.get("output", {}).get("message", "未知错误")
            print(json.dumps({"ok": False, "error": msg}))
            sys.exit(1)

    print(json.dumps({"ok": False, "error": "任务超时"}))
    sys.exit(1)


if __name__ == "__main__":
    main()
