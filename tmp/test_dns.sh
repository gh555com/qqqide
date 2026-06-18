#!/bin/bash
echo "=== resolv.conf ==="
docker exec searxng cat /etc/resolv.conf 2>&1

echo "=== DNS test ==="
docker exec searxng python3 -c 'import socket; print(socket.getaddrinfo("google.com", 80))' 2>&1

echo "=== ping ==="
docker exec searxng ping -c 2 -W 3 8.8.8.8 2>&1

echo "=== curl test ==="
docker exec searxng wget -qO- --timeout=10 https://lite.duckduckgo.com 2>&1 | head -5
