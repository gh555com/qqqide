#!/bin/bash
echo "=== Kill stuck docker ==="
ssh -o ConnectTimeout=5 q@23.254.248.119 "q pkill -9 docker 2>/dev/null; q pkill -9 containerd 2>/dev/null; echo killed"
sleep 2
echo "=== Restart docker ==="
ssh -o ConnectTimeout=5 q@23.254.248.119 "q systemctl restart docker && echo restarted"
sleep 3
echo "=== Check ==="
ssh -o ConnectTimeout=5 q@23.254.248.119 "q docker info 2>&1 | head -5"
echo "=== Done ==="
