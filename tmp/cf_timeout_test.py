#!/usr/bin/env python3
"""CF 100s 超时验证 — SSE 延迟服务器
   运行在 23.254.248.119:9999，模拟 130s 的 SSE 流
   通过 CF (gh555.com) 和直连 (direct.gh555.com:8444) 分别测试"""
import http.server
import time
import sys

PORT = 9999
DELAY_S = 130

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Test', 'cf-timeout-test')
        self.end_headers()
        t0 = time.time()
        self.wfile.write(b': test start\n\n')
        self.wfile.flush()
        # 每 17s 发心跳（25s 太接近 CF 100s / 4 周期，17s 保证 7 个心跳）
        for i in range(1, 999):
            elapsed = time.time() - t0
            if elapsed >= DELAY_S:
                break
            time.sleep(17)
            self.wfile.write(f': heartbeat {i} at {elapsed:.0f}s\n\n'.encode())
            self.wfile.flush()
        self.wfile.write(f'data: {{"ok":true,"elapsed":{time.time()-t0:.1f}}}\n\n'.encode())
        self.wfile.flush()

    def log_message(self, format, *args):
        print(f'[{time.strftime("%H:%M:%S")}] {args[0]}', flush=True)

print(f'Test server on :{PORT}, delay={DELAY_S}s')
httpd = http.server.HTTPServer(('127.0.0.1', PORT), Handler)
try:
    httpd.serve_forever()
except KeyboardInterrupt:
    print('\nstopped')
    httpd.server_close()
