#!/usr/bin/env python3
"""Fix SearXNG: switch to host networking (bridge DNS broken on SolusVM)"""
import subprocess, sys, time

def run(cmd, timeout=30):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout + r.stderr
    except Exception as e:
        return -1, str(e)

out = open("/tmp/fix_searxng_out.txt", "w")

# 1. Stop and remove old container
out.write("=== 1. Stopping old container ===\n")
code, msg = run("docker stop searxng 2>&1; docker rm searxng 2>&1")
out.write(f"exit={code}\n{msg}\n\n")

# 2. Update settings.yml to use port 8088
out.write("=== 2. Updating settings.yml ===\n")
settings = """use_default_settings: true
server:
  secret_key: "qqq-searxng-2026"
  bind_address: "127.0.0.1"
  port: 8088
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
    - name: github
      disabled: true
    - name: stackoverflow
      disabled: true
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
try:
    with open("/opt/searxng/settings.yml", "w") as f:
        f.write(settings)
    out.write("settings.yml updated\n\n")
except Exception as e:
    out.write(f"ERROR: {e}\n\n")

# 3. Run SearXNG with host networking, port 8088
out.write("=== 3. Starting SearXNG with --network host ===\n")
cmd = 'docker run -d --name searxng --network host -e "SEARXNG_BIND_ADDRESS=127.0.0.1:8088" -v /opt/searxng/settings.yml:/etc/searxng/settings.yml:ro searxng/searxng'
code, msg = run(cmd)
out.write(f"exit={code}\n{msg}\n\n")

time.sleep(3)

# 4. Verify container running
out.write("=== 4. Container status ===\n")
code, msg = run("docker ps --filter name=searxng")
out.write(msg + "\n")

# 5. Test from host (localhost:8088)
out.write("=== 5. Test search from host ===\n")
code, msg = run('curl -s --max-time 15 "http://127.0.0.1:8088/search?q=test&format=json" 2>&1 | head -500')
out.write(f"exit={code}\n{msg}\n\n")

# 6. Check logs
out.write("=== 6. SearXNG logs ===\n")
code, msg = run("docker logs --tail 30 searxng 2>&1")
out.write(msg + "\n")

out.write("\nDONE\n")
out.close()
print("fix complete: /tmp/fix_searxng_out.txt")
