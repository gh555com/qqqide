# -*- coding: utf-8 -*-
# Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.
"""
_goods_i18n.py — PySide2 goods 共享翻译助手（kope-a / window-there）

语言决议（与 IDE i18n.js 同源，优先级）:
  ① env QQQIDE_LANG（调试覆盖）
  ② IDE 权威库 global.sq3 → state 表 ns='qqq.i18n' / key='lang'（JSON 字符串）
  ③ OS 语言（locale）→ 13 语言映射
  ④ 'en' 兜底

词表: 从本文件所在目录（goods/）向上逐级找 locales/{lang}.json
  （绿色包 Data/webapp 运行副本 / resources/app/server-app / 开发态 server-app 皆命中）。
刷新: 语言 5s TTL 复查 —— 用户切语言后，新建的弹窗/卡片立即用新语言；
      已打开的常驻窗口在下次打开/重建时生效。
"""
import json
import os
import re
import sqlite3
import threading
import time

_BASE = os.path.dirname(os.path.abspath(__file__))

_ALL_LANGS = ('zh', 'zh-tw', 'en', 'ja', 'de', 'ko', 'ru', 'ar', 'es', 'fr', 'pt-BR', 'hi', 'vi')

_lock = threading.Lock()
_lang = None
_dict = None
_en = None
_last_check = 0.0
_TTL = 5.0


def _up(candidates):
    """从 goods/ 向上逐级探测候选相对路径，返回第一个存在的绝对路径。"""
    p = _BASE
    for _ in range(8):
        for rel in candidates:
            cand = os.path.join(p, rel)
            if os.path.exists(cand):
                return cand
        parent = os.path.dirname(p)
        if not parent or parent == p:
            break
        p = parent
    return None


def _read_env():
    v = (os.environ.get('QQQIDE_LANG') or '').strip()
    return v if v in _ALL_LANGS else None


def _read_sq3():
    """直接读 IDE 权威库 global.sq3（kope-a 读音量同款范式）。"""
    db = _up((os.path.join('Data', 'alphal', 'global.sq3'),))
    if not db:
        return None
    try:
        uri = 'file:' + db.replace('\\', '/') + '?mode=ro'
        conn = sqlite3.connect(uri, uri=True, timeout=1)
        try:
            row = conn.execute(
                "SELECT value FROM state WHERE ns=? AND key=?", ('qqq.i18n', 'lang')
            ).fetchone()
        finally:
            conn.close()
        if row and row[0]:
            try:
                v = json.loads(row[0])
            except Exception:
                v = str(row[0]).strip('"')
            if isinstance(v, str) and v in _ALL_LANGS:
                return v
    except Exception:
        pass
    return None


def _read_os():
    try:
        loc = ''
        try:
            import locale
            loc = locale.getdefaultlocale()[0] or ''
        except Exception:
            pass
        if not loc:
            loc = os.environ.get('LANG', '') or ''
        loc = loc.lower()
        if not loc:
            return None
        if loc.startswith('zh'):
            if 'tw' in loc or 'hk' in loc or 'hant' in loc:
                return 'zh-tw'
            return 'zh'
        if loc.startswith('pt'):
            return 'pt-BR'
        prefix = re.split(r'[-_.]', loc)[0]
        for lang in _ALL_LANGS:
            if lang.lower().split('-')[0] == prefix:
                return lang
    except Exception:
        pass
    return None


def _load_dict(lang):
    path = _up((os.path.join('locales', lang + '.json'),))
    if not path:
        return None
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _resolve_lang():
    for fn in (_read_env, _read_sq3, _read_os):
        try:
            v = fn()
            if v:
                return v
        except Exception:
            pass
    return 'en'


def _ensure_locked():
    """调用方必须已持有 _lock。"""
    global _lang, _dict, _last_check
    now = time.time()
    if _dict is not None and (now - _last_check) < _TTL:
        return
    new_lang = _resolve_lang()
    if new_lang == _lang and _dict is not None:
        _last_check = now
        return
    new_dict = _load_dict(new_lang)
    if new_dict is None and new_lang != 'en':
        if _dict is not None:
            _last_check = now
            return
        new_lang, new_dict = 'en', _load_dict('en')
    _lang = new_lang
    _dict = new_dict if new_dict is not None else {}
    _last_check = now


def _lookup(d, key):
    cur = d
    for part in key.split('.'):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur if isinstance(cur, str) else None


def get_lang():
    with _lock:
        _ensure_locked()
    return _lang or 'en'


def t(key, fallback=None, **params):
    """取翻译串。key 为点分路径（如 goods.kopea.screenshot）；
    缺翻译按 en 词表兜底，仍缺则用 fallback（源码中文原文）。"""
    global _en
    with _lock:
        _ensure_locked()
        val = _lookup(_dict, key)
        if val is None and _lang not in (None, 'zh', 'en'):
            if _en is None:
                _en = _load_dict('en') or {}
            val = _lookup(_en, key)
    if val is None:
        val = fallback if fallback is not None else key
    if params:
        for k, v in params.items():
            val = val.replace('{' + str(k) + '}', str(v))
    return val
