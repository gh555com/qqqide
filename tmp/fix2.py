#!/usr/bin/env python3
"""Fix SearXNG v2: check ports, use free port, host networking"""
import subprocess, time

def run(cmd, timeout=30):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout + r.stderr
    except Exception as e:
        return -1, str(e)

out = open("/tmp/fix2_out.txt", "w")

# 1. Check what's using ports
out.write("=== 1. Port usage ===\n")
code, msg = run("ss -tlnp | grep -E ':(8080|8088|8888|9090)' 2>&1")
out.write(f"{msg}\n\n")

# 2. Stop any searxng container
out.write("=== 2. Cleanup ===\n")
run("docker stop searxng 2>&1; docker rm searxng 2>&1")
out.write("cleanup done\n\n")

# 3. Use port 8888 this time
out.write("=== 3. Write settings.yml (port 8888) ===\n")
settings = """use_default_settings: true
server:
  secret_key: "qqq-searxng-2026"
  bind_address: "127.0.0.1"
  port: 8888
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
with open("/opt/searxng/settings.yml", "w") as f:
    f.write(settings)
out.write("settings.yml written\n\n")

# 4. Start with host networking on 8888
out.write("=== 4. Starting SearXNG ===\n")
cmd = 'docker run -d --name searxng --network host -e "SEARXNG_BIND_ADDRESS=127.0.0.1:8888" -v /opt/searxng/settings.yml:/etc/searxng/settings.yml:ro searxng/searxng'
code, msg = run(cmd)
out.write(f"exit={code}\n{msg}\n\n")

time.sleep(5)

# 5. Check status
out.write("=== 5. Container status ===\n")
code, msg = run("docker ps --filter name=searxng")
out.write(msg + "\n\n")

# 6. Check logs
out.write("=== 6. Logs ===\n")
code, msg = run("docker logs --tail 20 searxng 2>&1")
out.write(msg + "\n\n")

# 7. Test search
out.write("=== 7. Test search ===\n")
code, msg = run('curl -s --max-time 20 "http://127.0.0.1:8888/search?q=python+asyncio&format=json" 2>&1 | head -800')
out.write(f"exit={code}\n{msg}\n\n")

out.write("DONE\n")
out.close()
print("fix2 complete")
