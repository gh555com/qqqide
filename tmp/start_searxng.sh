#!/bin/bash
echo "=== Starting container ==="
ssh -o ConnectTimeout=10 q@23.254.248.119 "q docker start searxng"
echo "start exit: $?"
sleep 5
echo "=== Status ==="
ssh -o ConnectTimeout=10 q@23.254.248.119 "q docker ps --filter name=searxng"
echo "=== Logs ==="
ssh -o ConnectTimeout=10 q@23.254.248.119 "q docker logs searxng 2>&1"
echo "=== Done ==="
