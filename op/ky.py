# -*- coding: utf-8 -*-
"""
qqq-shell-v2 运维面板
用法: python op/ky.py
"""

import sys
import os
import json
import time
import re
import copy
import urllib.request
import threading
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

# 项目根: op/ 的上一级
PROJECT_ROOT = Path(__file__).resolve().parent.parent
LOCALES_DIR = PROJECT_ROOT / "server-app" / "locales"
I18N_JS_PATH = PROJECT_ROOT / "server-app" / "core" / "i18n.js"

from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QPushButton, QTextEdit, QLabel, QCheckBox, QComboBox, QGroupBox,
    QProgressBar,
)
from PySide6.QtCore import Qt, Signal, QObject

# ── DashScope 配置 ──
API_KEY = os.environ.get("DASHSCOPE_API_KEY", "sk-3f4295a1305246bd9a398ca174124b60")
BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"

TARGETS = {
    "en":    "English",
    "ja":    "Japanese",
    "ko":    "Korean",
    "de":    "German",
    "fr":    "French",
    "es":    "Spanish",
    "ru":    "Russian",
    "ar":    "Arabic",
    "hi":    "Hindi",
    "vi":    "Vietnamese",
    "pt-BR": "Portuguese (Brazil)",
    "zh-tw": "Traditional Chinese (Taiwan)",
}

TRADEMARKS = ["qqq", "gaea", "DreamGaea", "gh555.com", "gh555", "GH Health"]
_TM_PATTERNS = [(re.compile(re.escape(tm), re.IGNORECASE), tm) for tm in TRADEMARKS]

SYSTEM_PROMPT = """You are a professional UI translator for a desktop application called "qqq".

TASK: Translate the JSON values from Chinese to {lang}.

STRICT RULES:
1. Keep ALL JSON keys EXACTLY as-is — only translate the values.
2. Keep {{placeholder}} placeholders intact (e.g. {{n}}, {{name}}, {{count}}).
3. Keep HTML tags (<b>, <a>, <strong>, etc.), URLs, and special chars unchanged.
4. TRADEMARKS — keep EXACTLY as-is, do NOT translate: "qqq", "gaea", "DreamGaea", "gh555.com", "gh555", "GH Health"
5. Use natural, native {lang} that fits a modern desktop app UI context.
6. Return ONLY valid JSON — no markdown, no explanation, no code fences.
7. The output JSON structure must be IDENTICAL to the input structure."""


# ══════════════ 翻译引擎 ══════════════

def flatten(obj, prefix=""):
    items = {}
    for k, v in obj.items():
        key = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            items.update(flatten(v, key))
        else:
            items[key] = v
    return items


def unflatten(flat):
    result = {}
    for dotkey, value in flat.items():
        parts = dotkey.split(".")
        d = result
        for p in parts[:-1]:
            d = d.setdefault(p, {})
        d[parts[-1]] = value
    return result


def deep_set(obj, dotkey, value):
    parts = dotkey.split(".")
    d = obj
    for p in parts[:-1]:
        d = d.setdefault(p, {})
    d[parts[-1]] = value


def deep_delete(obj, dotkey):
    parts = dotkey.split(".")
    d = obj
    for p in parts[:-1]:
        if p not in d or not isinstance(d[p], dict):
            return
        d = d[p]
    d.pop(parts[-1], None)


def reorder_like(data, template):
    if not isinstance(template, dict) or not isinstance(data, dict):
        return data
    result = {}
    for k in template:
        if k in data:
            result[k] = reorder_like(data[k], template[k])
    for k in data:
        if k not in result:
            result[k] = data[k]
    return result


def call_llm(system, user):
    payload = {
        "model": "qwen3.6-plus",
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "enable_thinking": False,
        "temperature": 0.3,
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(BASE_URL, data=body, method="POST")
    req.add_header("Authorization", f"Bearer {API_KEY}")
    req.add_header("Content-Type", "application/json")
    resp = urllib.request.urlopen(req, timeout=300)
    result = json.loads(resp.read())
    content = result["choices"][0]["message"]["content"]
    usage = result.get("usage", {})
    return content, usage


def clean_json_response(text):
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines)
    return text.strip()


def fix_trademarks(src_text, translated_text):
    if not translated_text or not isinstance(translated_text, str):
        return translated_text
    result = translated_text
    for pat, canonical in _TM_PATTERNS:
        src_match = pat.search(str(src_text)) if src_text else None
        original_form = src_match.group(0) if src_match else canonical
        result = pat.sub(lambda m, f=original_form: f, result)
    return result


def translate_subset(subset_flat, lang_name):
    if not subset_flat:
        return {}
    nested = unflatten(subset_flat)
    json_str = json.dumps(nested, ensure_ascii=False, indent=2)
    sys_prompt = SYSTEM_PROMPT.format(lang=lang_name)
    raw, usage = call_llm(sys_prompt, json_str)
    pt = usage.get("prompt_tokens", 0)
    ct = usage.get("completion_tokens", 0)
    cleaned = clean_json_response(raw)
    translated = json.loads(cleaned)
    translated_flat = flatten(translated)
    for k in translated_flat:
        if k in subset_flat:
            translated_flat[k] = fix_trademarks(str(subset_flat[k]), translated_flat[k])
    return translated_flat, pt, ct


def sync_en_builtin(en_data):
    if not I18N_JS_PATH.exists():
        return False
    with open(I18N_JS_PATH, "r", encoding="utf-8") as f:
        js_content = f.read()
    en_json_compact = json.dumps(en_data, ensure_ascii=False, separators=(',', ':'))
    pattern = r'var _EN_BUILTIN = \{[\s\S]*?\};'
    replacement = f'var _EN_BUILTIN = {en_json_compact};'
    new_content = re.sub(pattern, replacement, js_content)
    if new_content != js_content:
        with open(I18N_JS_PATH, "w", encoding="utf-8") as f:
            f.write(new_content)
        return True
    return False


# ══════════════ GUI 面板 ══════════════

class OutputRedirector(QObject):
    text_written = Signal(str)

    def __init__(self, text_edit):
        super().__init__()
        self.text_edit = text_edit

    def write(self, text):
        self.text_written.emit(text)

    def flush(self):
        pass


class KyPanel(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("qqq-shell-v2 运维面板")
        self.setMinimumSize(700, 520)
        self.setStyleSheet("""
            QMainWindow { background: #1e1e1e; }
            QWidget { font-size: 13px; color: #d4d0c8; }
            QPushButton {
                background: #3a3a3a; border: 1px solid #555; border-radius: 4px;
                padding: 8px 16px; color: #d4d0c8; font-weight: bold;
            }
            QPushButton:hover { background: #4a4a4a; }
            QPushButton#btn_translate {
                background: #b58900; color: #1e1e1e; font-size: 15px;
                border: 1px solid #cb4b16; padding: 10px 24px;
            }
            QPushButton#btn_translate:hover { background: #cb4b16; }
            QGroupBox {
                border: 1px solid #444; border-radius: 4px; margin-top: 8px;
                padding-top: 16px; color: #a8a6a2; font-weight: bold;
            }
            QGroupBox::title { subcontrol-origin: margin; left: 10px; padding: 0 4px; }
            QTextEdit {
                background: #2a2a2a; border: 1px solid #444; border-radius: 4px;
                font-family: "Consolas", "Courier New", monospace; font-size: 12px;
                color: #a8a6a2;
            }
            QCheckBox { color: #a8a6a2; }
            QComboBox {
                background: #3a3a3a; border: 1px solid #555; border-radius: 3px;
                padding: 3px 8px; color: #d4d0c8;
            }
            QLabel { color: #a8a6a2; }
            QProgressBar {
                border: 1px solid #444; border-radius: 3px; background: #2a2a2a;
                text-align: center; color: #d4d0c8;
            }
            QProgressBar::chunk { background: #b58900; }
        """)
        self._setup_ui()
        self._old_stdout = sys.stdout
        self._old_stderr = sys.stderr
        self._redirector = OutputRedirector(self.log)
        self._redirector.text_written.connect(self._append_log)
        sys.stdout = self._redirector
        sys.stderr = self._redirector
        self._check_state()

    def _setup_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        layout = QVBoxLayout(central)
        layout.setSpacing(10)
        layout.setContentsMargins(16, 16, 16, 16)

        title = QLabel("qqq-shell-v2 运维面板")
        title.setStyleSheet("font-size: 16px; font-weight: bold; color: #eee8d5;")
        layout.addWidget(title)

        desc = QLabel("开发者只写 zh.json → 点按钮 → DashScope 自动翻译 12 语言")
        desc.setStyleSheet("color: #777777; font-size: 11px;")
        layout.addWidget(desc)

        opt_group = QGroupBox("翻译选项")
        opt_layout = QVBoxLayout(opt_group)
        row1 = QHBoxLayout()
        self.chk_full = QCheckBox("全量翻译 (不对比快照)")
        self.chk_dry = QCheckBox("仅预览 (--dry)")
        row1.addWidget(self.chk_full)
        row1.addWidget(self.chk_dry)
        row1.addStretch()
        opt_layout.addLayout(row1)

        row2 = QHBoxLayout()
        row2.addWidget(QLabel("单语言:"))
        self.cmb_lang = QComboBox()
        self.cmb_lang.addItem("(全部)", None)
        for code, name in TARGETS.items():
            self.cmb_lang.addItem(f"{code} — {name}", code)
        row2.addWidget(self.cmb_lang)
        row2.addStretch()
        opt_layout.addLayout(row2)
        layout.addWidget(opt_group)

        btn_row = QHBoxLayout()
        self.btn_translate = QPushButton("翻  译")
        self.btn_translate.setObjectName("btn_translate")
        self.btn_translate.clicked.connect(self._on_translate)
        btn_row.addStretch()
        btn_row.addWidget(self.btn_translate)
        btn_row.addStretch()
        layout.addLayout(btn_row)

        self.progress = QProgressBar()
        self.progress.setVisible(False)
        layout.addWidget(self.progress)

        layout.addWidget(QLabel("产出日志:"))
        self.log = QTextEdit()
        self.log.setReadOnly(True)
        layout.addWidget(self.log)

    def _check_state(self):
        zh = LOCALES_DIR / "zh.json"
        if zh.exists():
            with open(zh, "r", encoding="utf-8") as f:
                data = json.load(f)
            count = len(flatten(data))
            self.log.append(f"[就绪] zh.json: {zh}  ({count} keys)\n")
        else:
            self.log.append(f"[警告] zh.json 不存在: {zh}\n")

    def _append_log(self, text):
        cursor = self.log.textCursor()
        cursor.movePosition(cursor.MoveOperation.End)
        cursor.insertText(text)
        self.log.setTextCursor(cursor)

    def _on_translate(self):
        self.btn_translate.setEnabled(False)
        self.btn_translate.setText("翻译中...")
        self.progress.setVisible(True)
        self.progress.setRange(0, 0)
        self.log.append("=" * 60 + "\n")
        self.log.append("开始翻译...\n")

        full = self.chk_full.isChecked()
        dry = self.chk_dry.isChecked()
        only_lang = self.cmb_lang.currentData()

        def run():
            try:
                ok, msg = do_translate(full, dry, only_lang)
                self._redirector.text_written.emit(f"\n--- {msg} ---\n")
            except Exception as e:
                self._redirector.text_written.emit(f"\n--- 异常: {e} ---\n")
            finally:
                sys.stdout = self._old_stdout
                sys.stderr = self._old_stderr

            def restore():
                self.btn_translate.setEnabled(True)
                self.btn_translate.setText("翻  译")
                self.progress.setVisible(False)
            # 延迟到主线程
            self.log.append("")
            restore()

        threading.Thread(target=run, daemon=True).start()

    def closeEvent(self, event):
        sys.stdout = self._old_stdout
        sys.stderr = self._old_stderr
        super().closeEvent(event)


# ══════════════ 翻译主流程 ══════════════

def do_translate(force_full=False, dry_run=False, only_lang=None):
    zh_path = LOCALES_DIR / "zh.json"
    if not zh_path.exists():
        return False, f"ERROR: zh.json not found at {zh_path}"

    with open(zh_path, "r", encoding="utf-8") as f:
        zh_data = json.load(f)
    zh_flat = flatten(zh_data)
    print(f"zh.json: {len(zh_flat)} keys")

    snapshot_path = LOCALES_DIR / ".zh-snapshot.json"
    old_zh_flat = {}
    if snapshot_path.exists() and not force_full:
        with open(snapshot_path, "r", encoding="utf-8") as f:
            old_zh_flat = flatten(json.load(f))

    zh_changed_keys = set()
    for k, v in zh_flat.items():
        if k in old_zh_flat and old_zh_flat[k] != v:
            zh_changed_keys.add(k)
    zh_new_keys = set(zh_flat.keys()) - set(old_zh_flat.keys())
    zh_deleted_keys = set(old_zh_flat.keys()) - set(zh_flat.keys())

    if old_zh_flat:
        print(f"  vs snapshot: +{len(zh_new_keys)} new, ~{len(zh_changed_keys)} changed, -{len(zh_deleted_keys)} deleted")
    else:
        print("  (no snapshot -- first run or --full)")

    total_translated = 0
    total_skipped = 0

    lang_tasks = []
    for lang_code, lang_name in TARGETS.items():
        if only_lang and lang_code != only_lang:
            continue

        print(f"\n{'='*50}")
        print(f"[{lang_code}] {lang_name}")
        print(f"{'='*50}")

        lang_path = LOCALES_DIR / f"{lang_code}.json"
        lang_data = {}
        lang_flat = {}
        if lang_path.exists():
            with open(lang_path, "r", encoding="utf-8") as f:
                lang_data = json.load(f)
            lang_flat = flatten(lang_data)

        if force_full or not lang_flat:
            needs_translate = dict(zh_flat)
            needs_delete = set()
            print(f"  全量翻译: {len(needs_translate)} keys")
        else:
            missing_keys = set(zh_flat.keys()) - set(lang_flat.keys())
            retranslate_keys = zh_changed_keys & set(lang_flat.keys())
            need_keys = missing_keys | retranslate_keys
            needs_translate = {k: zh_flat[k] for k in need_keys}
            needs_delete = zh_deleted_keys & set(lang_flat.keys())
            print(f"  差异: +{len(missing_keys)} missing, ~{len(retranslate_keys)} re-translate, -{len(needs_delete)} delete")

        if not needs_translate and not needs_delete:
            print("  OK 无变更，跳过")
            total_skipped += 1
            continue

        if dry_run:
            if needs_translate:
                print(f"  DRY 需翻译 {len(needs_translate)} keys:")
                for k in sorted(needs_translate.keys())[:10]:
                    print(f"    {k}: {needs_translate[k]}")
                if len(needs_translate) > 10:
                    print(f"    ... +{len(needs_translate)-10} more")
            continue

        lang_tasks.append({
            "lang_code": lang_code,
            "lang_name": lang_name,
            "lang_path": lang_path,
            "lang_data": lang_data,
            "lang_flat": lang_flat,
            "needs_translate": needs_translate,
            "needs_delete": needs_delete,
            "force_full": force_full,
        })

    total_tokens_in = 0
    total_tokens_out = 0

    def do_one(task):
        nonlocal total_tokens_in, total_tokens_out
        lc = task["lang_code"]
        ln = task["lang_name"]
        lp = task["lang_path"]
        ld = task["lang_data"]
        lf = task["lang_flat"]
        nt = task["needs_translate"]
        nd = task["needs_delete"]
        ff = task["force_full"]

        t0 = time.time()
        try:
            if nt:
                translated_flat, pt, ct = translate_subset(nt, ln)
                total_tokens_in += pt
                total_tokens_out += ct
                if ff or not lf:
                    ld = unflatten(translated_flat)
                else:
                    for k, v in translated_flat.items():
                        deep_set(ld, k, v)

            for k in nd:
                deep_delete(ld, k)

            ld = reorder_like(ld, zh_data)

            with open(lp, "w", encoding="utf-8") as f:
                json.dump(ld, f, ensure_ascii=False, indent=4)

            elapsed = time.time() - t0
            return lc, True, f"完成 ({elapsed:.1f}s) -> {lp}", pt, ct
        except json.JSONDecodeError as e:
            return lc, False, f"LLM 返回无效 JSON: {e}", 0, 0
        except Exception as e:
            return lc, False, str(e), 0, 0

    if lang_tasks:
        print(f"\n全并发翻译 {len(lang_tasks)} 种语言...")
        with ThreadPoolExecutor(max_workers=len(lang_tasks)) as pool:
            futures = {pool.submit(do_one, t): t["lang_code"] for t in lang_tasks}
            for future in as_completed(futures):
                lc, ok, msg, pt, ct = future.result()
                if ok:
                    print(f"  [{lc}] OK {msg}")
                    total_translated += 1
                else:
                    print(f"  [{lc}] ERROR {msg}")

    if not dry_run:
        with open(snapshot_path, "w", encoding="utf-8") as f:
            json.dump(zh_data, f, ensure_ascii=False, indent=4)
        print(f"\n[OK] 快照: {snapshot_path}")

        en_path = LOCALES_DIR / "en.json"
        if en_path.exists():
            with open(en_path, "r", encoding="utf-8") as f:
                en_data = json.load(f)
            if sync_en_builtin(en_data):
                print("[OK] i18n.js _EN_BUILTIN 已同步")

    summary = f"完成! 翻译={total_translated}, 跳过={total_skipped}, tokens: in={total_tokens_in} out={total_tokens_out}"
    print(f"\n{summary}")
    return True, summary


def main():
    app = QApplication(sys.argv)
    panel = KyPanel()
    panel.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
