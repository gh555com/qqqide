"""
wanx_vision.py — qwen-vl 视觉理解 CLI
供 qqq AI 工具 analyze_image 调用。

用法:
    python wanx_vision.py --image "E:/img/frog.png" --action describe --detail brief
    python wanx_vision.py --image "E:/img/frog.png" --action locate --targets 青蛙,荷花
    python wanx_vision.py --image "E:/img/frog.png" --action ask --question "这是什么"

    输出 JSON: {"ok": true, "data": ...}
"""

import argparse, json, os, sys, base64
from pathlib import Path

VISION_MODEL = "qwen-vl-max"
VISION_EP = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"

# 阿里云 DashScope 定价 → ge（1 ge ≈ ¥0.001）
# qwen-vl-max: input ¥0.003/K tokens → 3 ge/K tokens, output ¥0.012/K tokens → 12 ge/K tokens
GE_PER_1K_INPUT = 3
GE_PER_1K_OUTPUT = 12


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


def image_to_data_url(path):
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"图片不存在: {path}")
    ext = p.suffix.lower().lstrip(".")
    mime_map = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                "webp": "image/webp", "gif": "image/gif"}
    mime = mime_map.get(ext, "image/png")
    b64 = base64.b64encode(p.read_bytes()).decode()
    return f"data:{mime};base64,{b64}"


def call_vision(api_key, data_url, question):
    import requests
    session = requests.Session()
    session.trust_env = False
    body = {
        "model": VISION_MODEL,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": data_url}},
                {"type": "text", "text": question},
            ],
        }],
        "temperature": 0.3,
        "max_tokens": 2000,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    resp = session.post(VISION_EP, headers=headers, json=body, timeout=60)
    if resp.status_code != 200:
        raise RuntimeError(f"Vision API {resp.status_code}: {resp.text[:300]}")
    data = resp.json()
    content = data["choices"][0]["message"]["content"]
    # 提取 usage → ge_cost
    usage = data.get("usage", {})
    pt = usage.get("prompt_tokens", 0)
    ct = usage.get("completion_tokens", 0)
    ge_cost = round(pt * GE_PER_1K_INPUT / 1000 + ct * GE_PER_1K_OUTPUT / 1000)
    return content, ge_cost


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True, help="图片路径")
    ap.add_argument("--action", required=True, choices=["describe", "locate", "ask"])
    ap.add_argument("--detail", default="standard", choices=["brief", "standard", "detailed"])
    ap.add_argument("--targets", default=None, help="定位目标，逗号分隔，如 青蛙,荷花")
    ap.add_argument("--question", default=None, help="自由问题")
    ap.add_argument("--api-key", default=None)
    args = ap.parse_args()

    api_key = args.api_key or get_api_key()
    if not api_key:
        print(json.dumps({"ok": False, "error": "DASHSCOPE_API_KEY 未设置"}))
        sys.exit(1)

    try:
        data_url = image_to_data_url(args.image)

        if args.action == "describe":
            prompts = {
                "brief": "用一句话描述这张图片的内容。",
                "standard": "描述这张图片的主要内容、风格和构图。",
                "detailed": "详细描述这张图片：画面元素、色彩、光影、构图、风格、氛围。",
            }
            question = prompts.get(args.detail, prompts["standard"])
            result, ge_cost = call_vision(api_key, data_url, question)
            print(json.dumps({"ok": True, "data": result, "ge_cost": ge_cost}, ensure_ascii=False))

        elif args.action == "locate":
            targets = [t.strip() for t in (args.targets or "").split(",") if t.strip()]
            if not targets:
                print(json.dumps({"ok": False, "error": "需要 --targets 参数"}))
                sys.exit(1)
            targets_str = "、".join(targets)
            question = (
                f"在这张图片中找到以下物体：{targets_str}。"
                "对每个物体，估算它的像素边界框 [x1, y1, x2, y2]。"
                "x1,y1 是左上角，x2,y2 是右下角。"
                "返回严格的 JSON 数组，格式："
                '[{"label": "物体名", "box": [x1, y1, x2, y2]}]'
                "只返回 JSON，不要任何解释文字。"
            )
            raw, ge_cost = call_vision(api_key, data_url, question)
            # 清洗 markdown 围栅
            raw = raw.strip()
            if raw.startswith("```"):
                lines = raw.split("\n")
                raw = "\n".join(lines[1:-1] if lines[-1].startswith("```") else lines[1:])
            try:
                boxes = json.loads(raw)
            except json.JSONDecodeError:
                import re
                match = re.search(r'\[.*\]', raw, re.DOTALL)
                if match:
                    boxes = json.loads(match.group())
                else:
                    raise RuntimeError(f"无法解析定位结果: {raw[:300]}")
            print(json.dumps({"ok": True, "data": boxes, "ge_cost": ge_cost}, ensure_ascii=False))

        elif args.action == "ask":
            if not args.question:
                print(json.dumps({"ok": False, "error": "需要 --question 参数"}))
                sys.exit(1)
            result, ge_cost = call_vision(api_key, data_url, args.question)
            print(json.dumps({"ok": True, "data": result, "ge_cost": ge_cost}, ensure_ascii=False))

    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
