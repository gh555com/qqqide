# window_there_store.py — OS-level SQLite for window-there layouts
# Path: %USERPROFILE%/AppData/Local/window-there/pz.sq3
# One truth source across all IDE instances and green packs.

import json
import os
import sqlite3
import sys
import time

def _get_db_dir():
    # OS 级根与 shell portable-paths.getOsBaseDir 对齐：mac → Library/Application Support
    home = os.path.expanduser('~')
    if sys.platform == 'darwin':
        base = os.path.join(home, 'Library', 'Application Support')
    else:
        base = os.path.join(home, 'AppData', 'Local')
    return os.path.join(base, 'window-there')

def _get_db_path():
    return os.path.join(_get_db_dir(), 'pz.sq3')

_db_path = _get_db_path()

def _get_conn():
    os.makedirs(_get_db_dir(), exist_ok=True)
    conn = sqlite3.connect(_db_path)
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA busy_timeout=3000')
    return conn

def init_db():
    conn = _get_conn()
    conn.execute('''CREATE TABLE IF NOT EXISTS layouts (
        ts TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        class_name TEXT NOT NULL DEFAULT '',
        x INTEGER DEFAULT 0,
        y INTEGER DEFAULT 0,
        width INTEGER DEFAULT 100,
        height INTEGER DEFAULT 100,
        desktop_width INTEGER DEFAULT 0,
        desktop_height INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )''')
    conn.commit()
    conn.close()

def save_layout(window_info):
    """Save a window layout. Returns ts key on success, None on failure."""
    try:
        ts = f"{time.strftime('%Y%m%d%H%M%S')}{int(time.time() * 1000) % 1000:03d}"
        conn = _get_conn()
        conn.execute('''INSERT OR REPLACE INTO layouts (ts, title, class_name, x, y, width, height, desktop_width, desktop_height)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)''', (
            ts,
            window_info.get('title', ''),
            window_info.get('class_name', ''),
            window_info.get('x', 0),
            window_info.get('y', 0),
            window_info.get('width', 100),
            window_info.get('height', 100),
            window_info.get('desktop_width', 0),
            window_info.get('desktop_height', 0)
        ))
        conn.commit()
        conn.close()
        bump_stat('save')   # VIG 履历：3W 保存计数
        return ts
    except Exception as e:
        print(f'[window-there] save_layout failed: {e}')
        return None

def load_layouts(class_name, current_dw, current_dh):
    """Load layouts matching class_name and desktop resolution. Returns list sorted newest first."""
    try:
        conn = _get_conn()
        c = conn.execute('''SELECT ts, title, x, y, width, height, desktop_width, desktop_height
            FROM layouts WHERE class_name = ? ORDER BY ts DESC''', (class_name,))
        rows = c.fetchall()
        conn.close()
        layouts = []
        for row in rows:
            ldw, ldh = row[6], row[7]
            if ldw != current_dw or ldh != current_dh:
                continue
            layouts.append({
                'key': row[0],
                'title': row[1],
                'x': row[2],
                'y': row[3],
                'width': row[4],
                'height': row[5],
                'desktop_width': ldw,
                'desktop_height': ldh
            })
        return layouts
    except Exception as e:
        print(f'[window-there] load_layouts failed: {e}')
        return []

def delete_layout(key):
    """Delete a layout by ts key. Returns True on success."""
    try:
        conn = _get_conn()
        conn.execute('DELETE FROM layouts WHERE ts = ?', (key,))
        conn.commit()
        conn.close()
        refresh_stats()   # VIG 履历：布局总数刷新（不计数）
        return True
    except Exception as e:
        print(f'[window-there] delete_layout failed: {e}')
        return False

def get_stats():
    """Return {total, ...} for health checks."""
    try:
        conn = _get_conn()
        c = conn.execute('SELECT COUNT(*) FROM layouts')
        total = c.fetchone()[0]
        conn.close()
        return {'total': total}
    except:
        return {'total': 0}

# ── VIG 履历计数（3W 保存 / 3X 还原 / 布局总数）────────────────────────────
# OS 级 stats.json，window-there 进程为唯一写入者（原子 tmp+rename）；
# 壳层 wq-ping 每次上报时读取（跨实例、跨绿色包共享，同 card.count 动态回读模式）。
_stats_path = os.path.join(_get_db_dir(), 'stats.json')

def _read_stats():
    try:
        with open(_stats_path, 'r', encoding='utf-8') as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}

def _write_stats(d):
    tmp = _stats_path + '.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(d, f)
        os.replace(tmp, _stats_path)
    except Exception as e:
        print(f'[window-there] stats write failed: {e}')
        try:
            os.remove(tmp)
        except Exception:
            pass

def _sync_layout_count(d):
    try:
        conn = _get_conn()
        c = conn.execute('SELECT COUNT(*) FROM layouts')
        d['layouts'] = int(c.fetchone()[0])
        conn.close()
    except Exception:
        pass

def bump_stat(key, add=1):
    """履历计数：save（3W 保存成功）/ restore（3X 还原点击）。写后刷新布局总数。"""
    try:
        d = _read_stats()
        if key:
            d[key] = int(d.get(key, 0)) + add
        if not d.get('t0'):
            d['t0'] = int(time.time())
        _sync_layout_count(d)
        _write_stats(d)
        return d
    except Exception as e:
        print(f'[window-there] bump_stat failed: {e}')
        return None

def refresh_stats():
    """仅重算布局总数（删除布局后调用），不增计数。"""
    try:
        d = _read_stats()
        if not d.get('t0'):
            d['t0'] = int(time.time())
        _sync_layout_count(d)
        _write_stats(d)
    except Exception:
        pass

# Auto-init on import
init_db()
