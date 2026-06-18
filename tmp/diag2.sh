#!/bin/bash
OUT=/tmp/diag_out.txt
echo "=== Container ===" > $OUT
docker ps --filter name=searxng >> $OUT 2>&1
echo "=== Host curl ===" >> $OUT
curl -sI --max-time 5 https://lite.duckduckgo.com >> $OUT 2>&1
echo "=== Container exec ===" >> $OUT
docker exec searxng wget -qO- --timeout=8 https://lite.duckduckgo.com >> $OUT 2>&1
echo "=== Container DNS ===" >> $OUT
docker exec searxng cat /etc/resolv.conf >> $OUT 2>&1
echo "=== SearXNG logs ===" >> $OUT
docker logs --tail 20 searxng >> $OUT 2>&1
echo "=== Settings ===" >> $OUT
docker exec searxng cat /etc/searxng/settings.yml >> $OUT 2>&1
echo "=== host resolv ===" >> $OUT
cat /etc/resolv.conf >> $OUT 2>&1
echo "=== IP tables NAT ===" >> $OUT
iptables -t nat -L POSTROUTING >> $OUT 2>&1
echo "=== IP forward ===" >> $OUT
sysctl net.ipv4.ip_forward >> $OUT 2>&1
echo DONE >> $OUT
