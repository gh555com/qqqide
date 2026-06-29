import json, subprocess, os, time

# Stop x-ui
subprocess.run(["systemctl", "stop", "x-ui"], capture_output=True)
time.sleep(1)

# Clean up broken hooks
for f in ["/usr/local/x-ui/inject-dns.sh", "/etc/systemd/system/x-ui.service.d/dns-inject.conf"]:
    if os.path.exists(f):
        os.remove(f)
        print(f"removed {f}")

# Patch config
with open("/usr/local/x-ui/bin/config.json") as f:
    d = json.load(f)
d["dns"] = {"servers": ["1.1.1.1", "8.8.8.8"]}
for o in d.get("outbounds", []):
    if o.get("protocol") == "freedom":
        o["settings"]["domainStrategy"] = "UseIPv4"
with open("/usr/local/x-ui/bin/config.json", "w") as f:
    json.dump(d, f, indent=2)
print("config patched")

# Start xray directly
subprocess.Popen(["/usr/local/x-ui/bin/xray-linux-amd64", "-c", "/usr/local/x-ui/bin/config.json"],
                 stdout=open("/tmp/xray3.log", "w"), stderr=subprocess.STDOUT)
time.sleep(2)
print("xray started")
print(open("/tmp/xray3.log").read()[:500])
