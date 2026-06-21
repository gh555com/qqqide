#!/usr/bin/env python3
"""自包含 CF 100s 超时测试 — 全部在服务器上跑，结果写文件"""
import subprocess, time, os, sys

OUT = '/tmp/cf_test_result.txt'
open(OUT, 'w').write(f'=== CF TIMEOUT TEST {time.ctime()} ===\n')

def log(msg):
    print(msg, flush=True)
    open(OUT, 'a').write(msg + '\n')

# 1. 启动延迟服务器
log('1. starting delay server on :9999')
subprocess.run(['kill', '-9'] + subprocess.getoutput('lsof -ti :9999').split(), capture_output=True)
srv = subprocess.Popen([sys.executable, '/tmp/delay_server.py', '9999'],
                       stdout=open('/tmp/delay9999.log','w'), stderr=subprocess.STDOUT)
time.sleep(2)

# 2. 测试本地直连
log('2. testing local direct (should take ~136s)')
t0 = time.time()
r = subprocess.run(['curl', '-s', '--max-time', '200', '-w', '\nHTTP:%{http_code} time:%{time_total}s',
                    'http://127.0.0.1:9999/'], capture_output=True, text=True, timeout=200)
local_time = time.time() - t0
log(f'local result: {r.returncode} in {local_time:.0f}s')
log(r.stdout[-500:] if len(r.stdout) > 500 else r.stdout)

# 3. 修改 nginx
log('3. patching nginx')
subprocess.run(['cp', '/etc/nginx/sites-enabled/gh555', '/tmp/gh555.bak.test3'], check=True)
cfg = open('/etc/nginx/sites-enabled/gh555').read()

# 在 listen 8444 后的第一个 location / { 前插入
lines = cfg.split('\n')
new_lines = []
in_8444 = False
inserted = False
for line in lines:
    new_lines.append(line)
    if 'listen 8444' in line:
        in_8444 = True
    if in_8444 and not inserted and line.strip() == 'location / {':
        # 在这一行之前插入
        new_lines.pop()  # 移除刚加的 location / {
        new_lines.append('    location /test-timeout {')
        new_lines.append('        proxy_pass http://127.0.0.1:9999;')
        new_lines.append('        proxy_read_timeout 200s;')
        new_lines.append('        proxy_buffering off;')
        new_lines.append('    }')
        new_lines.append('')
        new_lines.append(line)  # 恢复 location / {
        inserted = True

open('/etc/nginx/sites-enabled/gh555', 'w').write('\n'.join(new_lines))
log(f'nginx patched, test-timeout inserted={inserted}')

# 4. Reload nginx
r = subprocess.run(['nginx', '-t'], capture_output=True, text=True)
log(f'nginx -t: {r.returncode}')
if r.returncode != 0:
    log(r.stderr)
    sys.exit(1)
subprocess.run(['nginx', '-s', 'reload'], check=True)
log('nginx reloaded')
time.sleep(2)

# 5. 测试直连 8444
log('5. testing direct 8444 (should take ~136s)')
t0 = time.time()
r = subprocess.run(['curl', '-s', '--max-time', '200', '-w', '\nHTTP:%{http_code} time:%{time_total}s',
                    'https://direct.gh555.com:8444/test-timeout'],
                   capture_output=True, text=True, timeout=200)
direct_time = time.time() - t0
log(f'direct 8444 result: HTTP={r.returncode} in {direct_time:.0f}s')
log(r.stdout[-500:] if len(r.stdout) > 500 else r.stdout)

# 6. 测试 CF 代理
log('6. testing CF proxy (expected ~100s cutoff)')
t0 = time.time()
r = subprocess.run(['curl', '-s', '--max-time', '200', '-w', '\nHTTP:%{http_code} time:%{time_total}s',
                    'https://gh555.com/test-timeout'],
                   capture_output=True, text=True, timeout=200)
cf_time = time.time() - t0
log(f'CF proxy result: HTTP={r.returncode} in {cf_time:.0f}s')
log(r.stdout[-500:] if len(r.stdout) > 500 else r.stdout)

# 7. 清理
log('7. cleanup')
subprocess.run(['cp', '/tmp/gh555.bak.test3', '/etc/nginx/sites-enabled/gh555'], check=True)
subprocess.run(['nginx', '-s', 'reload'], check=True)
srv.kill()
srv.wait()

# 8. 总结
log('')
log('=== SUMMARY ===')
log(f'direct 8444: {direct_time:.0f}s (expected ~136s)')
log(f'CF proxy:    {cf_time:.0f}s (expected ~100s if CF cuts)')
if cf_time < 110 and direct_time > 120:
    log('CONCLUSION: CF does cut at ~100s. Confirmed.')
else:
    log(f'UNEXPECTED: CF={cf_time:.0f}s direct={direct_time:.0f}s')

print('\n=== FULL RESULT ===')
print(open(OUT).read())
