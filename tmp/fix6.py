#!/usr/bin/env python3
"""Fix Docker bridge: disable rp_filter, enable forwarding, restart SearXNG"""
import subprocess, time

def run(cmd, timeout=30):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout + r.stderr
    except Exception as e:
        return -1, str(e)

out = open("/tmp/fix6_out.txt", "w")

# 1. Check rp_filter
out.write("=== rp_filter before ===\n")
for iface in ["all", "default", "eth0", "docker0", "ens3", "venet0"]:
    code, msg = run(f"sysctl net.ipv4.conf.{iface}.rp_filter 2>&1")
    if code == 0 and msg.strip():
        out.write(f"{iface}: {msg}")

# 2. Disable rp_filter (the fix!)
out.write("\n=== Disabling rp_filter ===\n")
for iface in ["all", "default", "docker0"]:
    code, msg = run(f"sysctl -w net.ipv4.conf.{iface}.rp_filter=0 2>&1")
    out.write(f"{iface}: {msg}")

# Also try to find the main external interface and fix it
code, msg = run("ip route show default 2>&1 | awk '{print $5}'")
main_if = msg.strip()
out.write(f"Main interface: {main_if}\n")
if main_if:
    code, msg = run(f"sysctl -w net.ipv4.conf.{main_if}.rp_filter=0 2>&1")
    out.write(f"{main_if}: {msg}")

# 3. Ensure forwarding is on
run("sysctl -w net.ipv4.ip_forward=1 2>&1")

# 4. Test connectivity with alpine
out.write("\n=== Test after rp_filter fix ===\n")
run("docker rm -f testnet2 2>&1")
code, msg = run("docker run -d --rm --name testnet2 alpine sleep 60")
out.write(f"start: {msg}")
time.sleep(2)

code, msg = run("docker exec testnet2 ping -c 2 -W 3 8.8.8.8 2>&1")
out.write(f"ping 8.8.8.8: {msg}\n")

code, msg = run("docker exec testnet2 wget -qO- --timeout=5 http://example.com 2>&1 | head -5")
out.write(f"wget example.com: {msg}\n")

run("docker rm -f testnet2 2>&1")

# 5. If ping works, restart SearXNG with bridge networking
out.write("\n=== Restarting SearXNG ===\n")
run("docker stop searxng 2>&1; docker rm -f searxng 2>&1")

cmd = 'docker run -d --name searxng -p 127.0.0.1:8088:8080 --restart unless-stopped -v /opt/searxng/settings.yml:/etc/searxng/settings.yml:ro searxng/searxng'
code, msg = run(cmd)
out.write(f"start: exit={code}\n{msg}\n\n")

time.sleep(5)

# 6. Check
out.write("=== Status ===\n")
code, msg = run("docker ps --filter name=searxng")
out.write(msg + "\n")

# 7. Test search
out.write("=== Test search ===\n")
code, msg = run('curl -s --max-time 30 "http://127.0.0.1:8088/search?q=test&format=json" 2>&1 | head -800')
out.write(f"exit={code}\n{msg[:1500]}\n\n")

# 8. Make rp_filter persistent
out.write("=== Making persistent ===\n")
sysctl_conf = """
# Docker bridge fix — disable rp_filter for Docker networking
net.ipv4.conf.all.rp_filter=0
net.ipv4.conf.default.rp_filter=0
net.ipv4.conf.docker0.rp_filter=0
"""
try:
    with open("/etc/sysctl.d/99-docker-rpfilter.conf", "w") as f:
        f.write(sysctl_conf)
    run("sysctl -p /etc/sysctl.d/99-docker-rpfilter.conf 2>&1")
    out.write("persistent config written\n")
except Exception as e:
    out.write(f"persist error: {e}\n")

out.write("\nDONE\n")
out.close()
print("fix6 complete")
