#!/usr/bin/env python3
# ============================================================================
# auto_version.py — 正常关闭 IDE 时自动递增 patch 版本号
#
# 开关: 若 Data/auto-version-off 文件存在 → 跳过（关闭自动递增）
#       不存在 → 执行递增（默认开启）
#
# 修改文件:
#   1. shell/version.ts       (源码)
#   2. shell-out/main.js      (编译产物)
#   3. package.json           (版本字段)
#   4. Data/shell-version     (运行时版本标记)
#   5. Data/webapp-version    (运行时版本标记)
#
# 用法:
#   python shell/auto_version.py <项目根目录>
#   python shell/auto_version.py E:/s/wol/py/qqq-shell-v2
# ============================================================================

import sys
import os
import re
import json
from pathlib import Path


def find_version_in_file(filepath: str) -> tuple[str, int, int, int] | None:
    """在文件中查找版本号，返回 (完整匹配文本, 行号, major, minor, patch)"""
    if not os.path.exists(filepath):
        return None

    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # 匹配 APP_VERSION = 'X.Y.Z' 或 var APP_VERSION = "X.Y.Z"
    patterns = [
        (r"(export const APP_VERSION\s*=\s*')(\d+)\.(\d+)\.(\d+)(')", 'ts'),
        (r'(var APP_VERSION\s*=\s*")(\d+)\.(\d+)\.(\d+)(")', 'js'),
        (r'("version"\s*:\s*")(\d+)\.(\d+)\.(\d+)(")', 'json'),
    ]

    for pattern, fmt in patterns:
        m = re.search(pattern, content)
        if m:
            major, minor, patch = int(m.group(2)), int(m.group(3)), int(m.group(4))
            return (m.group(0), m.start(), m.end(), major, minor, patch, fmt)

    return None


def bump_version_in_file(filepath: str, dry_run: bool = False) -> tuple[str, str] | None:
    """递增文件中的版本号，返回 (旧版本, 新版本)"""
    if not os.path.exists(filepath):
        return None

    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # 匹配多种格式的版本号
    patterns = [
        # shell/version.ts: export const APP_VERSION = 'X.Y.Z'
        (r"(export const APP_VERSION\s*=\s*)'(\d+)\.(\d+)\.(\d+)(')", "'{major}.{minor}.{patch}'"),
        # shell-out/main.js: var APP_VERSION = "X.Y.Z"
        (r'(var APP_VERSION\s*=\s*)"(\d+)\.(\d+)\.(\d+)(")', '"{major}.{minor}.{patch}"'),
        # package.json: "version": "X.Y.Z"
        (r'("version"\s*:\s*)"(\d+)\.(\d+)\.(\d+)(")', '"{major}.{minor}.{patch}"'),
    ]

    for pattern, replacement_tpl in patterns:
        m = re.search(pattern, content)
        if m:
            major, minor, patch = int(m.group(2)), int(m.group(3)), int(m.group(4))
            old_ver = f"{major}.{minor}.{patch}"
            new_patch = patch + 1
            new_ver = f"{major}.{minor}.{new_patch}"
            replacement = replacement_tpl.format(major=major, minor=minor, patch=new_patch)
            new_line = m.group(1) + replacement
            new_content = content[:m.start()] + new_line + content[m.end():]

            if not dry_run:
                with open(filepath, 'w', encoding='utf-8') as f:
                    f.write(new_content)

            return (old_ver, new_ver)

    return None


def main():
    if len(sys.argv) < 2:
        print("用法: python auto_version.py <项目根目录>", file=sys.stderr)
        sys.exit(1)

    root = Path(sys.argv[1]).resolve()
    if not root.is_dir():
        print(f"错误: 目录不存在 {root}", file=sys.stderr)
        sys.exit(1)

    # ── 开关检查 ──
    toggle_off = root / "Data" / "auto-version-off"
    if toggle_off.exists():
        print(f"[auto_version] 开关关闭 (检测到 {toggle_off})，跳过")
        sys.exit(0)

    # ── 读取当前版本 (以 version.ts 为唯一真理源) ──
    version_ts = root / "shell" / "version.ts"
    old_ver = None

    if version_ts.exists():
        with open(version_ts, 'r', encoding='utf-8') as f:
            content = f.read()
        m = re.search(r"export const APP_VERSION\s*=\s*'(\d+)\.(\d+)\.(\d+)'", content)
        if m:
            old_ver = f"{m.group(1)}.{m.group(2)}.{m.group(3)}"

    if not old_ver:
        print("[auto_version] 无法读取当前版本号，跳过", file=sys.stderr)
        sys.exit(1)

    # ── 执行递增 ──
    print(f"[auto_version] 当前版本: {old_ver}")

    files_to_update = [
        root / "shell" / "version.ts",
        root / "shell-out" / "main.js",
        root / "package.json",
    ]

    new_ver = None
    for fp in files_to_update:
        result = bump_version_in_file(str(fp))
        if result:
            new_ver = result[1]
            print(f"[auto_version] {fp.name}: {result[0]} → {result[1]}")
        else:
            print(f"[auto_version] {fp.name}: 未找到版本号，跳过")

    if new_ver is None:
        print("[auto_version] 未成功更新任何文件", file=sys.stderr)
        sys.exit(1)

    # ── 更新运行时版本标记 (Data/shell-version, Data/webapp-version) ──
    data_dir = root / "Data"
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
        (data_dir / "shell-version").write_text(new_ver, encoding='utf-8')
        (data_dir / "webapp-version").write_text(new_ver, encoding='utf-8')
        print(f"[auto_version] Data/shell-version → {new_ver}")
        print(f"[auto_version] Data/webapp-version → {new_ver}")
    except Exception as e:
        print(f"[auto_version] 写入版本标记失败: {e}", file=sys.stderr)

    print(f"[auto_version] 完成: {old_ver} → {new_ver}")


if __name__ == '__main__':
    main()
