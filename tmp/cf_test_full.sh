#!/bin/bash
# 自包含测试：CF 100s 超时验证
# 全部写文件，最后 cat 结果
set -e
OUT=/tmp/cf_test_result.txt
echo "=== CF TIMEOUT TEST $(date) ===" > $OUT

# 1. 启动延迟服务器 (130s, 每17s心跳)
kill $(lsof -ti :9999) 2>/dev/null || true
python3 /tmp/delay_server.py 9999 &>/tmp/delay9999.log &
sleep 2
echo "server PID=$!" >> $OUT

# 2. 测试直连 (localhost, 确认 130s 能跑完)
echo "--- DIRECT LOCAL ---" >> $OUT
curl -s --max-time 200 -w "\nHTTP:%{http_code} time:%{time_total}s\n" http://127.0.0.1:9999/ >> $OUT 2>&1 &
DIR_PID=$!

# 3. 备份并修改 nginx
cp /etc/nginx/sites-enabled/gh555 /tmp/gh555.bak.test2
python3 -c "
c = open('/etc/nginx/sites-enabled/gh555').read()
b = '    location /test-timeout {\n        proxy_pass http://127.0.0.1:9999;\n        proxy_read_timeout 200s;\n        proxy_buffering off;\n    }\n'
# 插入到 8444 ssl server 块的 location / { 之前
# 找到 listen 8444 后的第一个 location / {
import re
parts = c.split('    location / {')
# parts[0] 是 listen 80 server + 8444 server 的前半部分
# parts[1] 是 8444 server 的第一个 location / 之后
# 在第一个 location / { 前插入
c = parts[0] + b + '    location / {' + '    location / {'.join(parts[1:])
open('/etc/nginx/sites-enabled/gh555','w').write(c)
print('nginx patched')
" >> $OUT 2>&1
nginx -t >> $OUT 2>&1 && nginx -s reload >> $OUT 2>&1
echo "nginx reloaded" >> $OUT

# 4. 测试 CF 代理
echo "--- CF PROXY ---" >> $OUT
curl -s --max-time 200 -w "\nHTTP:%{http_code} time:%{time_total}s\n" https://gh555.com/test-timeout >> $OUT 2>&1 &
CF_PID=$!

# 5. 测试直连 8444
echo "--- DIRECT 8444 ---" >> $OUT
curl -s --max-time 200 -w "\nHTTP:%{http_code} time:%{time_total}s\n" https://direct.gh555.com:8444/test-timeout >> $OUT 2>&1 &
D8444_PID=$!

# 6. 等待 (直连本地很快，CF和8444要等130s+)
wait $DIR_PID 2>/dev/null
echo "local done" >> $OUT
wait $CF_PID 2>/dev/null
echo "CF done" >> $OUT
wait $D8444_PID 2>/dev/null
echo "8444 done" >> $OUT

# 7. 清理
cp /tmp/gh555.bak.test2 /etc/nginx/sites-enabled/gh555
nginx -s reload >> $OUT 2>&1
kill $(lsof -ti :9999) 2>/dev/null || true

echo "=== TEST COMPLETE ===" >> $OUT
cat $OUT
