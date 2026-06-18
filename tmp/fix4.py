#!/usr/bin/env python3
"""Fix SearXNG v4: pip install directly (no Docker), bypass all Docker networking issues"""
import subprocess, time, os

def run(cmd, timeout=60):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout + r.stderr
    except Exception as e:
        return -1, str(e)

out = open("/tmp/fix4_out.txt", "w")

# 1. Cleanup Docker
out.write("=== 1. Docker cleanup ===\n")
run("docker stop searxng 2>&1; docker rm -f searxng 2>&1")
out.write("docker cleaned\n\n")

# 2. Kill any old searxng process
run("pkill -f searxng 2>&1; pkill -f 'python.*searxng' 2>&1; fuser -k 9999/tcp 2>&1")
time.sleep(2)

# 3. Install SearXNG via pip
out.write("=== 2. Install searxng via pip ===\n")
code, msg = run("pip3 install searxng 2>&1", timeout=120)
out.write(f"exit={code}\n{msg[:500]}\n\n")

# 4. Create config dir
run("mkdir -p /etc/searxng")

# 5. Write settings.yml
settings = """# SearXNG settings — qqq-shell production (pip install)
use_default_settings: false

server:
  secret_key: "qqq-shell-searxng-2026-pip"
  bind_address: "127.0.0.1"
  port: 9999
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
  pool_connections: 100
  pool_maxsize: 10
  enable_http2: true
"""
with open("/etc/searxng/settings.yml", "w") as f:
    f.write(settings)
out.write("settings.yml written\n\n")

# 6. Start SearXNG as background process
out.write("=== 3. Start SearXNG ===\n")
# Use nohup to run in background
env = os.environ.copy()
env["SEARXNG_SETTINGS_PATH"] = "/etc/searxng/settings.yml"
cmd_str = 'nohup python3 -m searxng.run > /var/log/searxng.log 2>&1 &'
code, msg = run(cmd_str)
out.write(f"Start exit={code}\n{msg}\n")
out.write(f"PID: checking...\n\n")

time.sleep(5)

# 7. Check if running
out.write("=== 4. Process check ===\n")
code, msg = run("ps aux | grep -i searx | grep -v grep")
out.write(msg + "\n\n")

# 8. Check port
out.write("=== 5. Port check ===\n")
code, msg = run("ss -tlnp | grep 9999")
out.write(msg + "\n\n")

# 9. Test
out.write("=== 6. Test search ===\n")
code, msg = run('curl -s --max-time 25 "http://127.0.0.1:9999/search?q=test&format=json" 2>&1 | head -1200')
out.write(f"exit={code}\n{msg[:1500]}\n\n")

# 10. Check log
out.write("=== 7. Log ===\n")
try:
    with open("/var/log/searxng.log") as f:
        out.write(f.read()[-3000:])
except:
    out.write("no log yet\n")

out.write("\nDONE\n")
out.close()
print("fix4 complete")
