# Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

# kope_api.py — SSE 实时推送服务 (仅推送，数据走 IPC Bridge)
# 嵌入 q3.py 进程。监听 127.0.0.1:19820，仅本机可访问。
# 终局架构: Bridge 管数据读写，SSE 仅推送 'change' 事件。

import json
import os
import socket
import threading
import queue
import urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

import kope_store

DEFAULT_PORT = 19820
MAX_PORT_TRIES = 10


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    """多线程 HTTP 服务器 — 支持 N 个 SSE 连接 + N 个 API 调用并发"""
    daemon_threads = True


class KopeRequestHandler(BaseHTTPRequestHandler):
    """轻量 JSON API handler，仅推送端点"""

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

    def _handle_sse(self):
        """SSE 端点 — 推送 'change' 事件给 panel.html。"""
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
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        finally:
            kope_store.unsubscribe(q)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip('/')
        qs = urllib.parse.parse_qs(parsed.query)

        if path == '/events':
            self._handle_sse()
        elif path == '/ping':
            self._send_json({'ok': True, 'version': '1.0.0'})
        elif path == '/stats':
            stats = kope_store.get_stats()
            kope_store.cleanup_if_needed()
            self._send_json(stats)
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
    """启动 SSE 推送服务。返回 (server, port)。"""
    kope_store.init_db()

    port = _find_free_port()
    if port is None:
        print('[kope_api] 无法找到可用端口')
        return None, None

    server = ThreadedHTTPServer(('127.0.0.1', port), KopeRequestHandler)
    thread = threading.Thread(target=server.serve_forever, name='kope-api', daemon=True)
    thread.start()

    port_file = kope_store.get_port_file_path()
    try:
        os.makedirs(os.path.dirname(port_file), exist_ok=True)
        with open(port_file, 'w') as f:
            f.write(str(port))
    except Exception as e:
        print(f'[kope_api] 写入端口文件失败: {e}')

    print(f'[kope_api] SSE 推送服务已启动 http://127.0.0.1:{port}')
    return server, port


def stop_server(server):
    """停止 SSE 推送服务。"""
    if server:
        try:
            server.shutdown()
            server.server_close()
            print('[kope_api] SSE 推送服务已停止')
        except Exception as e:
            print(f'[kope_api] 停止服务异常: {e}')
