#!/usr/bin/env python3
"""Fix SearXNG v7: host networking with single worker"""
import subprocess, time, socket

def run(cmd, timeout=30):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout + r.stderr
    except Exception as e:
        return -1, str(e)

def port_free(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(('127.0.0.1', port))
        s.close()
        return True
    except:
        return False

out = open("/tmp/fix7_out.txt", "w")

# 1. Find free port
out.write("=== Finding free port ===\n")
free_port = None
for p in [9090, 9191, 9393, 9595, 9797]:
    if port_free(p):
        free_port = p
        break
out.write(f"Using port: {free_port}\n\n")

# 2. Cleanup
out.write("=== Cleanup ===\n")
run("docker stop searxng 2>&1; docker rm -f searxng 2>&1")
run("fuser -k {}/tcp 2>&1".format(free_port))
time.sleep(2)

# 3. Write settings
settings = """use_default_settings: false

server:
  secret_key: "qqq-shell-searxng-2026-v7"
  bind_address: "127.0.0.1"
  port: {port}
  limiter: false
  image_proxy: false

search:
  formats:
    - html
    - json
  safe_search: 0
  autocomplete: ""
  engines:
    - name: duckduckgo
      disabled: false
    - name: google
      disabled: false
    - name: wikipedia
      disabled: false

ui:
  static_use_hash: true
  default_theme: simple
  default_locale: en

outgoing:
  request_timeout: 10.0
  max_request_timeout: 15.0
  useragent_suffix: ""
  pool_connections: 50
  pool_maxsize: 5
  enable_http2: true
""".format(port=free_port)

with open("/opt/searxng/settings.yml", "w") as f:
    f.write(settings)
out.write("settings.yml written\n\n")

# 4. Start with host networking, single worker
cmd = 'docker run -d --name searxng --network host -e SEARXNG_SETTINGS_PATH=/etc/searxng/settings.yml -v /opt/searxng/settings.yml:/etc/searxng/settings.yml:ro searxng/searxng'
out.write(f"=== Start ===\ncmd: {cmd}\n")
code, msg = run(cmd)
out.write(f"exit={code}\n{msg}\n\n")

time.sleep(8)

# 5. Status
out.write("=== Status ===\n")
code, msg = run("docker ps -a --filter name=searxng --format '{{.Status}} {{.Ports}}'")
out.write(f"status: {msg}\n\n")

# 6. Logs
out.write("=== Logs ===\n")
code, msg = run("docker logs --tail 40 searxng 2>&1")
out.write(msg + "\n\n")

# 7. Test
out.write("=== Test search ===\n")
code, msg = run('curl -s --max-time 35 "http://127.0.0.1:{port}/search?q=test&format=json" 2>&1 | head -2000'.format(port=free_port))
out.write(f"exit={code}\n{msg[:2000]}\n\n")

# 8. Test from inside container
out.write("=== Test from inside container ===\n")
code, msg = run("docker exec searxng wget -qO- --timeout=8 https://lite.duckduckgo.com 2>&1 | head -5")
out.write(f"wget ddg: {msg}\n")

out.write("\nDONE\n")
out.close()
print("fix7 complete")
