#!/bin/bash
set -e
echo "=== Deploy SearXNG ==="
q docker rm -f searxng 2>/dev/null || true
echo "Old container removed"

# Create settings
q mkdir -p /opt/searxng
cat > /tmp/searxng_settings.yml << 'EOF'
use_default_settings: true
search:
  formats:
    - html
    - json
server:
  secret_key: "qqq-shell-searxng-2026"
  bind_address: "0.0.0.0"
  limiter: false
engines:
  - name: google
    engine: google
    shortcut: g
    disabled: false
  - name: wikipedia
    engine: wikipedia
    shortcut: wp
    disabled: false
  - name: duckduckgo
    engine: duckduckgo
    shortcut: ddg
    disabled: false
EOF
q cp /tmp/searxng_settings.yml /opt/searxng/settings.yml
echo "Settings created"

q docker run -d --name searxng --restart unless-stopped \
  -p 8080:8080 \
  -v /opt/searxng/settings.yml:/etc/searxng/settings.yml:ro \
  -e UWSGI_WORKERS=1 \
  searxng/searxng
echo "Container started, waiting..."
sleep 8

echo "=== Container Status ==="
q docker ps --filter name=searxng

echo "=== Logs ==="
q docker logs searxng 2>&1 | tail -20

echo "=== Test Search ==="
q curl -s 'http://127.0.0.1:8080/search?q=hello+world&format=json' | q head -c 300

echo "=== Memory ==="
q docker stats --no-stream searxng --format 'CPU: {{.CPUPerc}}  MEM: {{.MemUsage}}'

echo "=== DONE ==="
