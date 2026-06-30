#!/bin/bash
# Cloudflare IPv4 ranges → allow HTTPS+HTTP on US origin
CF_IPS=(
  "173.245.48.0/20" "103.21.244.0/22" "103.22.200.0/22" "103.31.4.0/22"
  "141.101.64.0/18" "108.162.192.0/18" "190.93.240.0/20" "188.114.96.0/20"
  "197.234.240.0/22" "198.41.128.0/17" "162.158.0.0/15" "104.16.0.0/13"
  "104.24.0.0/14" "172.64.0.0/13" "131.0.72.0/22"
)

for ip in "${CF_IPS[@]}"; do
  iptables -C INPUT -s "$ip" -p tcp -m multiport --dports 80,443 -j ACCEPT 2>/dev/null || \
    iptables -I INPUT 3 -s "$ip" -p tcp -m multiport --dports 80,443 -j ACCEPT -m comment --comment "cf-origin"
done

echo "=== DONE ==="
iptables -L INPUT -n --line-numbers | head -25
