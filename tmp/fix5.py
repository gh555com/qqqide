#!/usr/bin/env python3
"""Check iptables FORWARD chain + fix bridge networking"""
import subprocess, time

def run(cmd, timeout=30):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout + r.stderr
    except Exception as e:
        return -1, str(e)

out = open("/tmp/fix5_out.txt", "w")

# 1. Check full iptables
out.write("=== iptables FORWARD ===\n")
code, msg = run("iptables -L FORWARD -n -v 2>&1")
out.write(msg + "\n\n")

out.write("=== iptables FORWARD policy ===\n")
code, msg = run("iptables -L FORWARD 2>&1 | head -3")
out.write(msg + "\n\n")

# 2. Check if bridge can ping host's gateway
out.write("=== Docker bridge info ===\n")
code, msg = run("ip addr show docker0 2>&1")
out.write(msg + "\n\n")

# 3. Check if conntrack is working
out.write("=== conntrack ===\n")
code, msg = run("lsmod | grep -i conntrack 2>&1; cat /proc/sys/net/netfilter/nf_conntrack_max 2>&1")
out.write(msg + "\n\n")

# 4. Start a test alpine container and check connectivity
out.write("=== Test alpine connectivity ===\n")
run("docker rm -f testnet 2>&1")
code, msg = run("docker run -d --rm --name testnet alpine sleep 60")
out.write(f"start: {msg}\n")
time.sleep(2)

code, msg = run("docker exec testnet wget -qO- --timeout=5 http://example.com 2>&1 | head -5")
out.write(f"wget example.com: {msg}\n\n")

code, msg = run("docker exec testnet ping -c 2 -W 3 8.8.8.8 2>&1")
out.write(f"ping 8.8.8.8: {msg}\n\n")

code, msg = run("docker exec testnet ping -c 2 -W 3 172.17.0.1 2>&1")
out.write(f"ping gateway: {msg}\n\n")

code, msg = run("docker exec testnet cat /etc/resolv.conf")
out.write(f"resolv.conf: {msg}\n\n")

run("docker rm -f testnet 2>&1")

# 5. Check if Docker bridge traffic works at all
# Try adding explicit SNAT rule
out.write("=== Adding explicit SNAT ===\n")
host_ip = run("hostname -I 2>&1 | awk '{print $1}'")[1].strip()
out.write(f"Host IP: {host_ip}\n")
code, msg = run(f"iptables -t nat -A POSTROUTING -s 172.17.0.0/16 ! -o docker0 -j SNAT --to-source {host_ip} 2>&1")
out.write(f"SNAT add: {code} {msg}\n\n")

# 6. Test again with a new container
out.write("=== Test after SNAT ===\n")
code, msg = run("docker run --rm alpine wget -qO- --timeout=8 http://example.com 2>&1 | head -5")
out.write(f"wget example.com: {msg}\n\n")

out.write("DONE\n")
out.close()
print("fix5 complete")
