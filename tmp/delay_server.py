from http.server import HTTPServer, BaseHTTPRequestHandler
import time, sys

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain')
        self.send_header('X-Test-Server', 'cf-timeout')
        self.end_headers()
        t0 = time.time()
        for i in range(8):
            time.sleep(17)
            self.wfile.write(f'HB {i} {time.time()-t0:.0f}s\n'.encode())
            self.wfile.flush()
        self.wfile.write(f'DONE {time.time()-t0:.0f}s\n'.encode())
    def log_message(self, f, *a):
        print(f'[{time.strftime("%H:%M:%S")}] {a[0]}', flush=True)

port = int(sys.argv[1]) if len(sys.argv) > 1 else 9999
print(f'listening on :{port}')
HTTPServer(('0.0.0.0', port), H).serve_forever()
