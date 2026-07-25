# kope_api.py — 本地 HTTP JSON API 服务
# 嵌入 q3.py 进程，提供面板与 Python 端的数据桥梁
# 监听 127.0.0.1:19820，仅本机可访问

import json
import os
import socket
import threading
import queue
import urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler

import kope_store

DEFAULT_PORT = 19820
MAX_PORT_TRIES = 10


class KopeRequestHandler(BaseHTTPRequestHandler):
    """轻量 JSON API handler，无外部依赖"""

    def log_message(self, format, *args):
        pass

    def _send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', len(body))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get('Content-Length', 0))
        if length > 5 * 1024 * 1024:
            return None
        body = self.rfile.read(length).decode('utf-8', errors='replace')
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            return None

    def _handle_sse(self):
        """SSE 端点 — 推送数据变更事件给 panel.html。"""
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'keep-alive')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()

        q = kope_store.subscribe()
        try:
            while True:
                try:
                    msg = q.get(timeout=15)
                    self.wfile.write(f"data: {msg}\n\n".encode('utf-8'))
                    self.wfile.flush()
                except queue.Empty:
                    # 15s 无事件 → 发送 keepalive 注释
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        finally:
            kope_store.unsubscribe(q)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip('/')
        qs = urllib.parse.parse_qs(parsed.query)

        if path == '/events':
            self._handle_sse()
            return

        elif path == '/ping':
            self._send_json({'ok': True, 'version': '1.0.0'})

        elif path == '/history':
            search = qs.get('search', [''])[0]
            limit = min(int(qs.get('limit', [30])[0]), 200)
            offset = int(qs.get('offset', [0])[0])
            items, total = kope_store.get_history(search=search, limit=limit, offset=offset)
            kope_store.cleanup_if_needed()
            self._send_json({'items': items, 'total': total, 'limit': limit, 'offset': offset})

        elif path == '/stats':
            stats = kope_store.get_stats()
            kope_store.cleanup_if_needed()
            self._send_json(stats)

        elif path == '/item':
            item_id = qs.get('id', [None])[0]
            if not item_id:
                self._send_json({'error': 'missing id'}, 400)
                return
            item = kope_store.get_item_by_id(int(item_id))
            if item:
                self._send_json({'item': item})
            else:
                self._send_json({'error': 'not found'}, 404)

        else:
            self._send_json({'error': 'not found'}, 404)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip('/')

        if path == '/add':
            data = self._read_body()
            if not data or 'content' not in data:
                self._send_json({'error': 'missing content'}, 400)
                return
            item = kope_store.add_or_update(
                data['content'],
                data.get('type', 'text')
            )
            if item:
                kope_store.cleanup()
                self._send_json({'item': item})
            else:
                self._send_json({'error': 'empty content'}, 400)

        elif path == '/pin':
            data = self._read_body()
            if not data or 'id' not in data:
                self._send_json({'error': 'missing id'}, 400)
                return
            item = kope_store.toggle_pin(data['id'])
            if item:
                self._send_json({'item': item})
            else:
                self._send_json({'error': 'not found'}, 404)

        elif path == '/delete':
            data = self._read_body()
            if not data or 'id' not in data:
                self._send_json({'error': 'missing id'}, 400)
                return
            ok = kope_store.delete_item(data['id'])
            self._send_json({'ok': ok})

        else:
            self._send_json({'error': 'not found'}, 404)


def _find_free_port(start=DEFAULT_PORT):
    for port in range(start, start + MAX_PORT_TRIES):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(('127.0.0.1', port))
                return port
        except OSError:
            continue
    return None


def start_server():
    """启动 HTTP API 服务。返回 (server, port)。"""
    kope_store.init_db()

    port = _find_free_port()
    if port is None:
        print('[kope_api] 无法找到可用端口')
        return None, None

    server = HTTPServer(('127.0.0.1', port), KopeRequestHandler)
    thread = threading.Thread(target=server.serve_forever, name='kope-api', daemon=True)
    thread.start()

    # 写端口文件供 panel.html 读取
    port_file = kope_store.get_port_file_path()
    try:
        os.makedirs(os.path.dirname(port_file), exist_ok=True)
        with open(port_file, 'w') as f:
            f.write(str(port))
    except Exception as e:
        print(f'[kope_api] 写入端口文件失败: {e}')

    print(f'[kope_api] API 服务已启动 http://127.0.0.1:{port}')
    return server, port


def stop_server(server):
    """停止 API 服务。"""
    if server:
        try:
            server.shutdown()
            server.server_close()
            print('[kope_api] API 服务已停止')
        except Exception as e:
            print(f'[kope_api] 停止服务异常: {e}')
