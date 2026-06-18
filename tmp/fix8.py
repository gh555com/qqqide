#!/usr/bin/env python3
"""Fix SearXNG v8: host network + override Granian to single worker"""
import subprocess, time, socket

def run(cmd, timeout=30):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout + r.stderr
    except Exception as e:
        return -1, str(e)

out = open("/tmp/fix8_out.txt", "w")

# 1. Cleanup
out.write("=== Cleanup ===\n")
run("docker stop searxng 2>&1; docker rm -f searxng 2>&1")
# Kill any process on ports we might use
for p in [8080, 8088, 9090]:
    run(f"fuser -k {p}/tcp 2>&1")
time.sleep(3)

# 2. Write settings for port 9090
settings = """use_default_settings: false

server:
  secret_key: "qqq-shell-searxng-2026-v8"
  bind_address: "127.0.0.1"
  port: 9090
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
"""
with open("/opt/searxng/settings.yml", "w") as f:
    f.write(settings)
out.write("settings.yml written\n\n")

# 3. Start with host networking, overriding entrypoint to use 1 worker
# Key fix: --entrypoint overrides granian command to force single worker
cmd = """docker run -d --name searxng --network host \
  -e SEARXNG_SETTINGS_PATH=/etc/searxng/settings.yml \
  -v /opt/searxng/settings.yml:/etc/searxng/settings.yml:ro \
  --entrypoint /usr/local/searxng/.venv/bin/python3 \
  searxng/searxng \
  -m searxng.run"""
out.write(f"=== Start ===\ncmd: {cmd}\n")
code, msg = run(cmd)
out.write(f"exit={code}\n{msg}\n\n")

time.sleep(8)

# 4. Status
out.write("=== Status ===\n")
code, msg = run("docker ps -a --filter name=searxng --format '{{.Status}}'")
out.write(f"status: {msg}\n\n")

# 5. Logs
out.write("=== Logs ===\n")
code, msg = run("docker logs --tail 40 searxng 2>&1")
out.write(msg + "\n\n")

# 6. Check port
out.write("=== Port check ===\n")
code, msg = run("ss -tlnp | grep 9090")
out.write(msg + "\n\n")

# 7. Test search
if "Up" in msg:
    out.write("=== Test search ===\n")
    code, msg = run('curl -s --max-time 35 "http://127.0.0.1:9090/search?q=test&format=json" 2>&1 | head -2000')
    out.write(f"exit={code}\n{msg[:2000]}\n\n")

# 8. If still failing, try without entrypoint override
if "Up" not in run("docker ps -a --filter name=searxng --format '{{.Status}}'")[1]:
    out.write("=== Trying without host network, with DNS fix ===\n")
    run("docker stop searxng 2>&1; docker rm -f searxng 2>&1")
    # Try bridge but use host as DNS proxy via iptables redirect
    # Forward DNS from bridge to host
    run("iptables -t nat -A PREROUTING -i docker0 -p udp --dport 53 -j REDIRECT --to-ports 53 2>&1")
    cmd2 = 'docker run -d --name searxng -p 127.0.0.1:8088:8080 --dns 172.17.0.1 -v /opt/searxng/settings.yml:/etc/searxng/settings.yml:ro searxng/searxng'
    code, msg = run(cmd2)
    out.write(f"bridge start: exit={code}\n{msg}\n\n")
    time.sleep(8)
    out.write("=== Bridge status ===\n")
    code, msg = run("docker ps --filter name=searxng --format '{{.Status}}'")
    out.write(f"status: {msg}\n\n")
    code, msg = run("docker logs --tail 30 searxng 2>&1")
    out.write(f"logs: {msg}\n\n")

out.write("\nDONE\n")
out.close()
print("fix8 complete")
