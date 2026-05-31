# -*- coding: utf-8 -*-
"""
components.py — LSP/组件下载 & 灌装一体化
  • 从 GitHub Releases 下载 → 算 SHA256 → 解压到 userData/components/
  • 可选: 上传到 R2 → 更新 engines/manifest.json（灌装 CDN）

用法:
  python op/components.py ensure lsp/gopls lsp/pyright lsp/clangd lsp/rust-analyzer
  python op/components.py ensure --all          # 全装
  python op/components.py upload lsp/gopls      # 下载+上传R2+更新manifest（灌装）
"""

import sys
import os
import json
import hashlib
import shutil
import tempfile
import zipfile
import tarfile
import urllib.request
from pathlib import Path
from datetime import datetime

PROJECT_ROOT = Path(__file__).resolve().parent.parent
COMPONENTS_DIR = PROJECT_ROOT / "userData" / "components"
MANIFEST_PATH = PROJECT_ROOT / "engines" / "manifest.json"
TEMP_DIR = PROJECT_ROOT / "temp"

# ── R2 / Cloudflare 配置 ──
R2_ACCOUNT_ID = "c5b8d70f2b5a2c5a2c5b8d70f2b5a2c5"  # 从 gaea 配置读取
CF_EMAIL = "a15802858204@gmail.com"
CF_API_KEY = "e9e1a4e4fdf2175c29877b87f182e0baa3f1a"
R2_BUCKET = "gh555-cdn"
R2_PUBLIC_URL = "https://cdn.gh555.com"

# ── 平台检测 ──
def current_platform():
    import platform
    sys = platform.system().lower()
    arch = platform.machine().lower()
    if sys == "windows":
        if arch in ("amd64", "x86_64"):
            return "win32-x64"
        elif arch in ("arm64", "aarch64"):
            return "win32-arm64"
    elif sys == "linux":
        if arch in ("x86_64", "amd64"):
            return "linux-x64"
        elif arch in ("aarch64", "arm64"):
            return "linux-arm64"
    elif sys == "darwin":
        if arch in ("arm64", "aarch64"):
            return "darwin-arm64"
        else:
            return "darwin-x64"
    return "unknown"


# ── GitHub Release URL 映射 (优先于 CDN) ──
# 格式: name → { platform: (url, kind, extract_to, bin, version) }
GITHUB_SOURCES = {
    # gopls: Go 官方不再发布 GitHub 二进制，需用 go install 构建
    # 灌装流程: go install → 打包 zip → 上传 R2 → 更新 manifest
    "lsp/gopls": {
        "win32-x64": (
            None,  # 需 `go install golang.org/x/tools/gopls@v0.22.0` 然后打包
            "go", None, "gopls.exe", "0.22.0"
        ),
    },
    "lsp/clangd": {
        "win32-x64": (
            "https://github.com/clangd/clangd/releases/download/19.1.0/clangd-windows-19.1.0.zip",
            "zip", None, "clangd.exe", "19.1.0"
        ),
        "linux-x64": (
            "https://github.com/clangd/clangd/releases/download/19.1.0/clangd-linux-19.1.0.zip",
            "zip", None, "clangd", "19.1.0"
        ),
        "darwin-arm64": (
            "https://github.com/clangd/clangd/releases/download/19.1.0/clangd-mac-19.1.0.zip",
            "zip", None, "clangd", "19.1.0"
        ),
        "darwin-x64": (
            "https://github.com/clangd/clangd/releases/download/19.1.0/clangd-mac-19.1.0.zip",
            "zip", None, "clangd", "19.1.0"
        ),
    },
    "lsp/rust-analyzer": {
        "win32-x64": (
            "https://github.com/rust-lang/rust-analyzer/releases/download/2026-05-25/rust-analyzer-x86_64-pc-windows-msvc.zip",
            "zip", None, "rust-analyzer.exe", "2026-05-25"
        ),
        "linux-x64": (
            "https://github.com/rust-lang/rust-analyzer/releases/download/2026-05-25/rust-analyzer-x86_64-unknown-linux-gnu.gz",
            "tar.gz", None, "rust-analyzer", "2026-05-25"
        ),
        "darwin-arm64": (
            "https://github.com/rust-lang/rust-analyzer/releases/download/2026-05-25/rust-analyzer-aarch64-apple-darwin.gz",
            "tar.gz", None, "rust-analyzer", "2026-05-25"
        ),
        "darwin-x64": (
            "https://github.com/rust-lang/rust-analyzer/releases/download/2026-05-25/rust-analyzer-x86_64-apple-darwin.gz",
            "tar.gz", None, "rust-analyzer", "2026-05-25"
        ),
    },
    "lsp/pyright": {
        # pyright 没有官方 GitHub 二进制发布，用 npm 打包
        # 这里提供一个自打包版本或标记为需特殊处理
        "win32-x64": (
            None,  # 需 npm install pyright@1.1.390 然后打包
            "npm", "pyright", "index.js", "1.1.390"
        ),
    },
}


# ══════════════════════════════════════════════════════════════════
# 下载 & 安装
# ══════════════════════════════════════════════════════════════════

def ensure_component(name: str):
    """下载并安装单个组件到 userData/components/"""
    plat = current_platform()
    src_map = GITHUB_SOURCES.get(name)
    if not src_map:
        print(f"[X] 未知组件: {name}")
        return False

    entry = src_map.get(plat)
    if not entry:
        print(f"[X] {name} 不支持平台 {plat}")
        return False

    url, kind, extract_to, bin_name, version = entry
    if url is None:
        print(f"[!] {name} 需要特殊安装（{kind}），跳过自动下载")
        if name == "lsp/pyright":
            _install_pyright_npm(name, extract_to, bin_name, version)
        return False

    dir_name = name.replace("/", "_")
    dest = COMPONENTS_DIR / dir_name
    ver_file = dest / ".version"

    # 已安装检查
    if ver_file.exists():
        installed = ver_file.read_text().strip()
        if installed == version:
            print(f"[OK] {name} {version} 已安装")
            return True

    print(f"[DL] {name} {version} - downloading...")
    print(f"   {url}")

    dest.mkdir(parents=True, exist_ok=True)
    tmp_dir = TEMP_DIR / f"{dir_name}-{version}"
    tmp_dir.mkdir(parents=True, exist_ok=True)

    # 下载
    archive_path = tmp_dir / f"archive.{'zip' if kind == 'zip' else 'tar.gz' if kind == 'tar.gz' else 'bin'}"
    try:
        _download(url, archive_path)
    except Exception as e:
        print(f"[X] download failed: {e}")
        return False

    # extract
    print(f"[>>] extract to {dest}...")
    try:
        if kind == "zip":
            _extract_zip(archive_path, dest)
        elif kind == "tar.gz":
            _extract_targz(archive_path, dest)
        elif kind == "binary":
            shutil.copy2(archive_path, dest / bin_name)
        else:
            print(f"[X] unknown format: {kind}")
            return False
    except Exception as e:
        print(f"[X] extract failed: {e}")
        return False

    # write version marker
    ver_file.write_text(version)
    print(f"[OK] {name} {version} -> {dest / bin_name}")

    return True


def _download(url: str, dest: Path):
    """下载文件，带进度条"""
    print(f"   GET {url[:80]}...")
    
    # urllib 需要 User-Agent，否则 GitHub 返回 400
    req = urllib.request.Request(url, headers={
        "User-Agent": "qqq-shell-v2/0.1",
        "Accept": "application/octet-stream",
    })
    
    with urllib.request.urlopen(req, timeout=300) as resp:
        total = int(resp.headers.get("Content-Length", 0))
        downloaded = 0
        with open(dest, 'wb') as f:
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                f.write(chunk)
                downloaded += len(chunk)
                if total > 0:
                    pct = min(downloaded * 100 // total, 100)
                    if pct % 20 == 0:
                        print(f"   {pct}% ({downloaded // 1024}KB / {total // 1024}KB)")
    print(f"   100% — {dest.stat().st_size // 1024}KB")


def _extract_zip(archive: Path, dest: Path):
    """解压 zip，自动去除公共前缀"""
    with zipfile.ZipFile(archive, 'r') as zf:
        # 检测公共前缀
        names = [n for n in zf.namelist() if not n.endswith('/')]
        prefix = _common_prefix(names)
        for name in names:
            rel = name[len(prefix):] if prefix else name
            if not rel:
                continue
            out = dest / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(name) as src, open(out, 'wb') as dst:
                shutil.copyfileobj(src, dst)
        # 处理仅包含单个文件的 zip
        if len(names) == 1:
            rel = names[0][len(prefix):] if prefix else names[0]
            out = dest / (rel or Path(names[0]).name)
            out.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(names[0]) as src, open(out, 'wb') as dst:
                shutil.copyfileobj(src, dst)


def _extract_targz(archive: Path, dest: Path):
    """解压 tar.gz"""
    import gzip
    with gzip.open(archive, 'rb') as gz:
        with tarfile.open(fileobj=gz, mode='r:') as tf:
            names = [m.name for m in tf.getmembers() if m.isfile()]
            prefix = _common_prefix(names)
            for member in tf.getmembers():
                if not member.isfile():
                    continue
                rel = member.name[len(prefix):] if prefix else member.name
                if not rel:
                    continue
                out = dest / rel
                out.parent.mkdir(parents=True, exist_ok=True)
                with tf.extractfile(member) as src, open(out, 'wb') as dst:
                    shutil.copyfileobj(src, dst)


def _common_prefix(names: list) -> str:
    """找公共路径前缀（目录级）"""
    if not names or len(names) == 1:
        return ""
    parts = [n.split('/') for n in names]
    min_len = min(len(p) for p in parts)
    prefix_parts = []
    for i in range(min_len):
        vals = {p[i] for p in parts}
        if len(vals) == 1:
            prefix_parts.append(vals.pop())
        else:
            break
    if prefix_parts:
        return '/'.join(prefix_parts) + '/'
    return ""


# ══════════════════════════════════════════════════════════════════
# Pyright 特殊安装 (npm)
# ══════════════════════════════════════════════════════════════════

def _install_pyright_npm(name: str, extract_to: str, bin_name: str, version: str):
    """通过 npm 安装 pyright 并打包到 components/"""
    import subprocess
    dir_name = name.replace("/", "_")
    dest = COMPONENTS_DIR / dir_name

    print(f"[npm] {name} - install pyright@{version}...")

    tmp = TEMP_DIR / f"pyright-{version}"
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True, exist_ok=True)

    # npm init + install
    pkg_json = tmp / "package.json"
    pkg_json.write_text('{"private": true}')
    try:
        subprocess.run(
            ["npm", "install", f"pyright@{version}", "--prefix", str(tmp), "--no-save"],
            check=True, capture_output=True, text=True,
            cwd=str(tmp),
        )
    except subprocess.CalledProcessError as e:
        print(f"[X] npm install failed: {e.stderr}")
        return False

    # 复制 node_modules/pyright 到 dest
    src = tmp / "node_modules" / "pyright"
    if not src.exists():
        print(f"[X] pyright not found: {src}")
        return False

    dest.mkdir(parents=True, exist_ok=True)
    # 清理目标目录
    for item in dest.iterdir():
        if item.name != ".version":
            if item.is_dir():
                shutil.rmtree(item)
            else:
                item.unlink()

    # 复制所有文件
    for item in src.iterdir():
        target = dest / item.name
        if item.is_dir():
            if target.exists():
                shutil.rmtree(target)
            shutil.copytree(item, target)
        else:
            shutil.copy2(item, target)

    # 写版本
    (dest / ".version").write_text(version)
    print(f"[OK] {name} {version} -> {dest / bin_name}")

    # 清理
    shutil.rmtree(tmp, ignore_errors=True)
    return True


# ══════════════════════════════════════════════════════════════════
# SHA256 & Manifest 更新
# ══════════════════════════════════════════════════════════════════

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


def update_manifest(name: str, url: str, sha256: str, version: str):
    """更新 manifest.json 中某组件的 CDN URL 和 SHA256"""
    if not MANIFEST_PATH.exists():
        print(f"⚠️  manifest.json 不存在: {MANIFEST_PATH}")
        return

    data = json.loads(MANIFEST_PATH.read_text("utf-8"))
    plat = current_platform()

    for comp in data.get("components", []):
        if comp["name"] == name:
            comp["version"] = version
            if plat in comp.get("platforms", {}):
                comp["platforms"][plat]["url"] = url
                comp["platforms"][plat]["sha256"] = sha256
            print(f"📝 manifest: {name} → {url}")
            print(f"   sha256: {sha256}")
            break

    MANIFEST_PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        "utf-8"
    )


# ══════════════════════════════════════════════════════════════════
# R2 上传 (灌装 CDN)
# ══════════════════════════════════════════════════════════════════

def upload_to_r2(local_path: Path, remote_key: str) -> bool:
    """上传文件到 Cloudflare R2"""
    # R2 兼容 S3 API
    # 使用 Cloudflare R2 的自定义域名上传端点
    import ssl

    endpoint = f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com/{R2_BUCKET}/{remote_key}"

    with open(local_path, 'rb') as f:
        data = f.read()

    req = urllib.request.Request(endpoint, data=data, method="PUT")
    req.add_header("Content-Type", "application/octet-stream")
    req.add_header("X-Amz-Content-Sha256", sha256_file(local_path))
    # Cloudflare R2 使用 S3 兼容认证...这需要签名。

    # 简化版：使用 Cloudflare API (Worker 上传或直接 HTTP PUT with token)
    # 实际上 Cloudflare R2 支持 presigned URL 或 Worker-based 上传。
    # 这里我们先用更简单的方式：通过 gaea 的 ky.py 上传。

    print(f"⚠️  R2 上传需要 S3 兼容签名，建议用 gaea cf/ky.py 的 r2_upload_file")
    print(f"   本地文件: {local_path}")
    print(f"   R2 路径:  {remote_key}")
    return False


def upload_component(name: str):
    """灌装单个组件：下载 → 算 SHA256 → 更新 manifest（R2 上传需手动或用 ky.py）"""
    plat = current_platform()
    src_map = GITHUB_SOURCES.get(name)
    if not src_map:
        print(f"❌ 未知组件: {name}")
        return

    entry = src_map.get(plat)
    if not entry or entry[0] is None:
        print(f"❌ {name} 无可用下载源")
        return

    url, kind, extract_to, bin_name, version = entry

    # 下载
    tmp_dir = TEMP_DIR / f"upload-{name.replace('/', '_')}"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    archive_path = tmp_dir / f"package.{kind if kind != 'tar.gz' else 'tar.gz'}"

    print(f"[DL] {name} {version}")
    _download(url, archive_path)

    # SHA256
    print(f"[#] computing SHA256...")
    sha = sha256_file(archive_path)
    print(f"   SHA256: {sha}")

    # 构建 CDN URL
    dir_name = name.replace("/", "_")
    ext = "zip" if kind == "zip" else "tar.gz" if kind == "tar.gz" else "bin"
    cdn_path = f"components/{name}/{version}/{plat}.{ext}"
    cdn_url = f"{R2_PUBLIC_URL}/{cdn_path}"

    # 更新 manifest
    update_manifest(name, cdn_url, sha, version)

    # R2 上传提示
    print(f"\n[>>] need upload to R2:")
    print(f"   源文件: {archive_path}")
    print(f"   CDN URL: {cdn_url}")
    print(f"   使用 gaea cf/ky.py 的 r2_upload_file 或:")
    print(f"   aws s3 cp {archive_path} s3://{R2_BUCKET}/{cdn_path} --endpoint-url https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com")

    print(f"\n[OK] manifest.json updated (SHA256 filled)")


# ══════════════════════════════════════════════════════════════════
# CLI
# ══════════════════════════════════════════════════════════════════

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        print("\n可用的 LSP 组件:")
        for name in GITHUB_SOURCES:
            plat = current_platform()
            entry = GITHUB_SOURCES[name].get(plat)
            if entry:
                _, _, _, bin_name, version = entry
                installed = "✅" if (COMPONENTS_DIR / name.replace("/", "_") / ".version").exists() else "  "
                print(f"  {installed} {name} ({version}) → {bin_name}")
        return

    cmd = sys.argv[1]

    if cmd == "ensure":
        if "--all" in sys.argv:
            names = list(GITHUB_SOURCES.keys())
        else:
            names = sys.argv[2:]
        if not names:
            print("请指定组件名，如: lsp/gopls")
            return
        for name in names:
            ensure_component(name)
            print()

    elif cmd == "upload":
        names = sys.argv[2:]
        if not names:
            print("请指定组件名")
            return
        for name in names:
            upload_component(name)
            print()

    elif cmd == "list":
        plat = current_platform()
        print(f"平台: {plat}\n")
        for name in GITHUB_SOURCES:
            entry = GITHUB_SOURCES[name].get(plat)
            if entry:
                _, _, _, bin_name, version = entry
                installed = (COMPONENTS_DIR / name.replace("/", "_") / ".version").exists()
                mark = "✅" if installed else "  "
                print(f"  {mark} {name} {version} → {bin_name}")

    else:
        print(f"未知命令: {cmd}")
        print("用法: python op/components.py ensure|upload|list [组件名...]")


if __name__ == "__main__":
    main()
