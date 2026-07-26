# Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

# kope_store.py — 剪切板历史 OS 级 SQLite 存储
# 唯一真理源: %LOCALAPPDATA%/kope-a/kope.sq3
# 整台电脑所有 IDE 窗口 + 独立 Python 进程共享同一个数据库

import sqlite3
import os
import hashlib
import time
import threading
import random
import queue

def _get_db_dir():
    # ★ 不用 LOCALAPPDATA 环境变量 (Electron 便携模式会劫持到 <app>/Data/LocalAppData)
    # 直接用 expanduser('~') 拿到真实 Windows 路径，保证所有窗口/进程共享同一个 kope.sq3
    localappdata = os.path.join(os.path.expanduser('~'), 'AppData', 'Local')
    db_dir = os.path.join(localappdata, 'kope-a')
    os.makedirs(db_dir, exist_ok=True)
    return db_dir

def get_db_path():
    return os.path.join(_get_db_dir(), 'kope.sq3')

def get_port_file_path():
    return os.path.join(_get_db_dir(), 'api.port')

_db_lock = threading.Lock()

def _get_conn():
    conn = sqlite3.connect(get_db_path(), check_same_thread=False)
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA busy_timeout=3000')
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with _db_lock:
        conn = _get_conn()
        conn.execute('''CREATE TABLE IF NOT EXISTS clipboard_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            content_hash TEXT NOT NULL UNIQUE,
            preview TEXT NOT NULL DEFAULT '',
            size_bytes INTEGER DEFAULT 0,
            content_type TEXT DEFAULT 'text',
            pinned INTEGER DEFAULT 0,
            pinned_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        )''')
        conn.execute('''CREATE INDEX IF NOT EXISTS idx_history_sort
            ON clipboard_history(pinned DESC, pinned_at DESC, updated_at DESC)''')
        conn.execute('''CREATE INDEX IF NOT EXISTS idx_history_hash
            ON clipboard_history(content_hash)''')
        conn.commit()
        conn.close()

def _hash_content(content):
    return hashlib.md5(content.encode('utf-8', errors='replace')).hexdigest()

def _make_preview(content, max_len=200):
    s = content.strip().replace('\n', ' ').replace('\r', ' ')
    if len(s) > max_len:
        s = s[:max_len] + '...'
    return s

# ── 写入去重缓存：2s 内同 hash 跳过（防 Ctrl+C 连击）──
_dedup_cache = {}  # hash → timestamp
_dedup_lock = threading.Lock()

# ── SSE 事件推送 ──
_subscribers = []
_subscribers_lock = threading.Lock()


def subscribe():
    """返回一个 queue.Queue，当数据变更时收到 'change' 消息。"""
    q = queue.Queue(maxsize=8)
    with _subscribers_lock:
        _subscribers.append(q)
    return q


def unsubscribe(q):
    with _subscribers_lock:
        if q in _subscribers:
            _subscribers.remove(q)


def _notify_change():
    """通知所有 SSE 订阅者数据已变更。"""
    with _subscribers_lock:
        dead = []
        for q in _subscribers:
            try:
                q.put_nowait('change')
            except queue.Full:
                dead.append(q)
        for q in dead:
            _subscribers.remove(q)


# === 写入操作 ===

def add_or_update(content, content_type='text'):
    """添加或更新剪贴板条目。已存在(同hash)→更新时间戳；不存在→插入。返回完整 item。"""
    if not content or not content.strip():
        return None

    content_hash = _hash_content(content)
    now_ts = time.time()

    # 2s 内同 hash 跳过（防 Ctrl+C 连击抖动）
    with _dedup_lock:
        last_ts = _dedup_cache.get(content_hash, 0)
        if now_ts - last_ts < 2.0:
            return get_item_by_hash(content_hash)
        _dedup_cache[content_hash] = now_ts
        stale = [h for h, t in _dedup_cache.items() if now_ts - t > 10]
        for h in stale:
            del _dedup_cache[h]

    preview = _make_preview(content)
    size_bytes = len(content.encode('utf-8', errors='replace'))
    now_str = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime())

    result = _write_with_retry(content, content_hash, preview, size_bytes, content_type, now_str)
    _notify_change()
    return result


def toggle_pin(item_id):
    """切换置顶状态。置顶时记录 pinned_at，取消置顶时清空。返回更新后的 item。"""
    with _db_lock:
        conn = _get_conn()
        cur = conn.execute('SELECT pinned FROM clipboard_history WHERE id = ?', (item_id,))
        row = cur.fetchone()
        if not row:
            conn.close()
            return None

        new_pinned = 1 if not row['pinned'] else 0
        pinned_at = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime()) if new_pinned else None
        conn.execute('''UPDATE clipboard_history
            SET pinned = ?, pinned_at = ?, updated_at = ?
            WHERE id = ?''',
            (new_pinned, pinned_at, time.strftime('%Y-%m-%d %H:%M:%S', time.localtime()), item_id))
        conn.commit()

        cur = conn.execute('SELECT * FROM clipboard_history WHERE id = ?', (item_id,))
        item = dict(cur.fetchone())
        conn.close()
        _notify_change()
        return item


def delete_item(item_id):
    """删除条目。返回是否成功。"""
    with _db_lock:
        conn = _get_conn()
        conn.execute('DELETE FROM clipboard_history WHERE id = ?', (item_id,))
        conn.commit()
        affected = conn.total_changes
        conn.close()
        if affected > 0:
            _notify_change()
        return affected > 0


# ── 写入重试 ──
def _write_with_retry(content, content_hash, preview, size_bytes, content_type, now_str, max_retries=3):
    """带重试的原子写入。SQLite locked/busy 时最多重试 3 次。"""
    last_err = None
    for attempt in range(max_retries):
        try:
            with _db_lock:
                conn = _get_conn()
                cur = conn.execute('SELECT id, pinned FROM clipboard_history WHERE content_hash = ?', (content_hash,))
                row = cur.fetchone()
                if row:
                    conn.execute('''UPDATE clipboard_history
                        SET content = ?, preview = ?, size_bytes = ?, updated_at = ?
                        WHERE id = ?''',
                        (content, preview, size_bytes, now_str, row['id']))
                    conn.commit()
                    item_id = row['id']
                else:
                    cur = conn.execute('''INSERT INTO clipboard_history
                        (content, content_hash, preview, size_bytes, content_type, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)''',
                        (content, content_hash, preview, size_bytes, content_type, now_str, now_str))
                    conn.commit()
                    item_id = cur.lastrowid
                cur = conn.execute('SELECT * FROM clipboard_history WHERE id = ?', (item_id,))
                item = dict(cur.fetchone())
                conn.close()
                return item
        except sqlite3.OperationalError as e:
            last_err = e
            if 'locked' in str(e).lower() or 'busy' in str(e).lower():
                time.sleep(0.05 * (attempt + 1))
                continue
            raise
    raise last_err


def get_item_by_hash(content_hash):
    """通过 hash 查询 item（去重缓存用）。"""
    with _db_lock:
        conn = _get_conn()
        cur = conn.execute('SELECT * FROM clipboard_history WHERE content_hash = ?', (content_hash,))
        row = cur.fetchone()
        conn.close()
        return dict(row) if row else None


# === 查询操作 ===

def get_history(search='', limit=30, offset=0):
    """查询历史列表。排序: 置顶优先(按pinned_at倒序) → 非置顶按updated_at倒序。"""
    with _db_lock:
        conn = _get_conn()
        if search:
            params = tuple('%' + kw + '%' for kw in search.split())
            where = ' AND '.join(['(content LIKE ? OR preview LIKE ?)' for _ in params])
            flat_params = tuple(p for pair in [(p, p) for p in params] for p in pair)
            count_sql = f'SELECT COUNT(*) as cnt FROM clipboard_history WHERE {where}'
            data_sql = f'''SELECT * FROM clipboard_history WHERE {where}
                ORDER BY pinned DESC, pinned_at DESC, updated_at DESC
                LIMIT ? OFFSET ?'''
            total = conn.execute(count_sql, flat_params).fetchone()['cnt']
            rows = conn.execute(data_sql, flat_params + (limit, offset)).fetchall()
        else:
            total = conn.execute('SELECT COUNT(*) as cnt FROM clipboard_history').fetchone()['cnt']
            rows = conn.execute('''SELECT * FROM clipboard_history
                ORDER BY pinned DESC, pinned_at DESC, updated_at DESC
                LIMIT ? OFFSET ?''', (limit, offset)).fetchall()

        items = [dict(r) for r in rows]
        conn.close()
        return items, total


def get_item_by_id(item_id):
    with _db_lock:
        conn = _get_conn()
        cur = conn.execute('SELECT * FROM clipboard_history WHERE id = ?', (item_id,))
        row = cur.fetchone()
        conn.close()
        return dict(row) if row else None


def get_stats():
    """返回统计: total, pinned, max_updated_at"""
    with _db_lock:
        conn = _get_conn()
        total = conn.execute('SELECT COUNT(*) as cnt FROM clipboard_history').fetchone()['cnt']
        pinned = conn.execute('SELECT COUNT(*) as cnt FROM clipboard_history WHERE pinned = 1').fetchone()['cnt']
        max_ts = conn.execute('SELECT MAX(updated_at) as ts FROM clipboard_history').fetchone()['ts']
        conn.close()
        return {'total': total, 'pinned': pinned, 'max_updated_at': max_ts or ''}


def cleanup(max_items=2000):
    """删除超出上限的最旧非置顶条目。"""
    with _db_lock:
        conn = _get_conn()
        total = conn.execute('SELECT COUNT(*) as cnt FROM clipboard_history').fetchone()['cnt']
        if total > max_items:
            excess = total - max_items
            conn.execute('''DELETE FROM clipboard_history WHERE id IN (
                SELECT id FROM clipboard_history WHERE pinned = 0
                ORDER BY updated_at ASC LIMIT ?
            )''', (excess,))
            conn.commit()
        conn.close()


_last_cleanup_ts = 0
_cleanup_lock = threading.Lock()


def cleanup_if_needed(max_items=2000, prob=0.05, min_interval_s=300):
    """概率性触发清理（5% 概率，最少间隔 5 分钟）。
    在 GET /history 等读路径调用，确保只读不写时也会清理。
    """
    global _last_cleanup_ts
    if random.random() > prob:
        return
    now = time.time()
    with _cleanup_lock:
        if now - _last_cleanup_ts < min_interval_s:
            return
        _last_cleanup_ts = now
    cleanup(max_items)
