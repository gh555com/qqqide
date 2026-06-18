#!/bin/bash
echo "=== 1. Container status ==="
q docker ps -a --filter name=searxng

echo ""
echo "=== 2. Host internet ==="
curl -sI --max-time 5 https://lite.duckduckgo.com 2>&1 | head -3

echo ""
echo "=== 3. Host DNS ==="
nslookup google.com 2>&1 | head -5

echo ""
echo "=== 4. Container exec test ==="
q docker exec searxng wget -qO- --timeout=8 https://lite.duckduckgo.com 2>&1 | head -3

echo ""
echo "=== 5. Container DNS test ==="
q docker exec searxng nslookup google.com 2>&1 | head -5

echo ""
echo "=== 6. Container ping test ==="
q docker exec searxng ping -c 2 -W 3 8.8.8.8 2>&1

echo ""
echo "=== 7. Docker network inspect ==="
q docker network inspect bridge 2>&1 | grep -A5 '"Subnet"\|"Gateway"\|"com.docker'

echo ""
echo "=== 8. Host iptables NAT ==="
q iptables -t nat -L POSTROUTING 2>&1 | head -10

echo ""
echo "=== 9. SearXNG logs (last 30 lines) ==="
q docker logs --tail 30 searxng 2>&1

echo ""
echo "=== 10. Host /etc/resolv.conf ==="
cat /etc/resolv.conf

echo ""
echo "=== 11. SearXNG current settings ==="
q docker exec searxng cat /etc/searxng/settings.yml 2>&1
