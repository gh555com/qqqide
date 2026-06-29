import json

with open("/usr/local/x-ui/bin/config.json") as f:
    d = json.load(f)

d["dns"] = {"servers": ["1.1.1.1", "8.8.8.8"]}
for o in d.get("outbounds", []):
    if o.get("protocol") == "freedom":
        o["settings"]["domainStrategy"] = "UseIPv4"

with open("/usr/local/x-ui/bin/config.json", "w") as f:
    json.dump(d, f, indent=2)
print("done")
