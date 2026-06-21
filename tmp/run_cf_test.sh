#!/bin/bash
# CF 100s 超时验证脚本 — 在 23.254.248.119 上执行
set -e

echo "=== 1. 启动测试服务器 (130s 延迟) ==="
python3 /tmp/cf_timeout_test.py &
PID=$!
sleep 2
# 验证本地通
curl -s --max-time 3 http://127.0.0.1:9999/ -o /dev/null -w "local: %{http_code}\n" || true

echo "=== 2. 添加临时 nginx 路由 ==="
cp /etc/nginx/sites-enabled/gh555 /tmp/gh555.bak.test
# 在第一个 location / { 前插入
sed -i '/^[[:space:]]*location \/ {/i\
    location /test-timeout {\
        proxy_pass http://127.0.0.1:9999;\
        proxy_read_timeout 200s;\
        proxy_buffering off;\
    }' /etc/nginx/sites-enabled/gh555
nginx -s reload 2>&1 || nginx -t 2>&1
sleep 2

echo "=== 3. 测试直连 (应返回 200, ~130s) ==="
echo "--- DIRECT (direct.gh555.com:8444) ---"
curl -s --max-time 200 -w '\nHTTP %{http_code}  time_total=%{time_total}s\n' https://direct.gh555.com:8444/test-timeout 2>&1 | tail -5 &
DIRECT_PID=$!

echo "=== 4. 测试 CF 代理 (预期被 100s 掐断) ==="
echo "--- CF PROXY (gh555.com) ---"
curl -s --max-time 200 -w '\nHTTP %{http_code}  time_total=%{time_total}s\n' https://gh555.com/test-timeout 2>&1 | tail -5 &
CF_PID=$!

echo "Waiting for both tests (max 200s)..."
wait $DIRECT_PID 2>/dev/null
wait $CF_PID 2>/dev/null

echo "=== 5. 清理 ==="
kill $PID 2>/dev/null || true
cp /tmp/gh555.bak.test /etc/nginx/sites-enabled/gh555
nginx -s reload 2>&1
echo "Done. Check results above."
