# window_there_store.py — OS-level SQLite for window-there layouts
# Path: %USERPROFILE%/AppData/Local/window-there/pz.sq3
# One truth source across all IDE instances and green packs.

import os
import sqlite3
import time

def _get_db_dir():
    home = os.path.expanduser('~')
    return os.path.join(home, 'AppData', 'Local', 'window-there')

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

# Auto-init on import
init_db()
