#!/usr/bin/env python3
"""Fix SearXNG v3: clean settings (no use_default_settings), high port"""
import subprocess, time

def run(cmd, timeout=30):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout + r.stderr
    except Exception as e:
        return -1, str(e)

out = open("/tmp/fix3_out.txt", "w")

# 1. Cleanup
out.write("=== Cleanup ===\n")
run("docker stop searxng 2>&1; docker rm -f searxng 2>&1")
out.write("cleanup done\n\n")

# 2. Kill anything on 9999 just in case
run("fuser -k 9999/tcp 2>&1")

# 3. Write clean settings (NO use_default_settings)
settings = """# SearXNG settings — qqq-shell production
# Host networking, manual config only
server:
  secret_key: "qqq-shell-searxng-2026"
  bind_address: "127.0.0.1"
  port: 9999
  limiter: false
  image_proxy: false
  http_protocol_version: "1.1"

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
  pool_connections: 100
  pool_maxsize: 10
  enable_http2: true
"""
with open("/opt/searxng/settings.yml", "w") as f:
    f.write(settings)
out.write("settings.yml written\n\n")

# 4. Start with host networking
cmd = 'docker run -d --name searxng --network host -e SEARXNG_SETTINGS_PATH=/etc/searxng/settings.yml -v /opt/searxng/settings.yml:/etc/searxng/settings.yml:ro searxng/searxng'
out.write(f"=== Start ===\ncmd: {cmd}\n")
code, msg = run(cmd)
out.write(f"exit={code}\n{msg}\n\n")

time.sleep(6)

# 5. Status
out.write("=== Status ===\n")
code, msg = run("docker ps -a --filter name=searxng --format '{{.Status}}'")
out.write(f"status: {msg}\n\n")

# 6. Logs
out.write("=== Logs ===\n")
code, msg = run("docker logs --tail 30 searxng 2>&1")
out.write(msg + "\n\n")

# 7. Check port
out.write("=== Port check ===\n")
code, msg = run("ss -tlnp | grep 9999")
out.write(msg + "\n\n")

# 8. Test
out.write("=== Test search ===\n")
code, msg = run('curl -s --max-time 20 "http://127.0.0.1:9999/search?q=test&format=json" 2>&1 | head -1000')
out.write(f"exit={code}\n{msg[:2000]}\n\n")

out.write("DONE\n")
out.close()
print("fix3 complete")
