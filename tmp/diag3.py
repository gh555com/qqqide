#!/usr/bin/env python3
import subprocess, sys

def run(cmd, timeout=15):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.stdout + r.stderr
    except Exception as e:
        return str(e)

out = open("/tmp/diag3_out.txt", "w")

out.write("=== Container status ===\n")
out.write(run("docker ps --filter name=searxng"))
out.write("\n\n=== Host internet test ===\n")
out.write(run("curl -sI --max-time 5 https://lite.duckduckgo.com 2>&1 | head -5"))
out.write("\n\n=== Container internet test ===\n")
out.write(run("docker exec searxng wget -qO- --timeout=8 https://lite.duckduckgo.com 2>&1 | head -5"))
out.write("\n\n=== Container DNS ===\n")
out.write(run("docker exec searxng cat /etc/resolv.conf 2>&1"))
out.write("\n\n=== Host DNS ===\n")
out.write(run("cat /etc/resolv.conf"))
out.write("\n\n=== SearXNG logs ===\n")
out.write(run("docker logs --tail 25 searxng 2>&1"))
out.write("\n\n=== IP forward ===\n")
out.write(run("sysctl net.ipv4.ip_forward"))
out.write("\n\n=== Docker bridge ===\n")
out.write(run("docker network inspect bridge 2>&1 | head -30"))
out.write("\n\n=== iptables NAT ===\n")
out.write(run("iptables -t nat -L POSTROUTING 2>&1 | head -15"))
out.write("\nDONE\n")
out.close()
print("diag complete: /tmp/diag3_out.txt")
