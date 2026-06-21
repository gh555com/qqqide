# insert nginx test route
with open('/etc/nginx/sites-enabled/gh555') as f:
    cfg = f.read()
test_block = '    location /test-timeout {\n        proxy_pass http://127.0.0.1:9999;\n        proxy_read_timeout 200s;\n        proxy_buffering off;\n    }\n'
cfg = cfg.replace('    location / {', test_block + '    location / {', 1)
with open('/etc/nginx/sites-enabled/gh555', 'w') as f:
    f.write(cfg)
print('OK')
