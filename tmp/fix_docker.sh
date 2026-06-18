#!/bin/bash
echo "=== Fix Docker cgroup driver ==="
ssh -o ConnectTimeout=5 q@23.254.248.119 "q mkdir -p /etc/docker && cat > /tmp/daemon.json << 'EOF'
{
  \"exec-opts\": [\"native.cgroupdriver=cgroupfs\"],
  \"log-driver\": \"json-file\",
  \"log-opts\": {
    \"max-size\": \"10m\",
    \"max-file\": \"3\"
  }
}
EOF
q cp /tmp/daemon.json /etc/docker/daemon.json && echo config_created"

echo "=== Restart Docker ==="
ssh -o ConnectTimeout=5 q@23.254.248.119 "q systemctl restart docker && sleep 3 && echo restarted"

echo "=== Test Docker ==="
ssh -o ConnectTimeout=5 q@23.254.248.119 "q docker run --rm alpine echo HELLO_DOCKER 2>&1"

echo "=== Clean up old containers ==="
ssh -o ConnectTimeout=5 q@23.254.248.119 "q docker rm -f searxng 2>/dev/null; echo cleaned"

echo "=== Deploy SearXNG ==="
ssh -o ConnectTimeout=5 q@23.254.248.119 "q docker run -d --name searxng --restart unless-stopped -p 8080:8080 -e UWSGI_WORKERS=1 searxng/searxng && echo deployed"
sleep 8

echo "=== Status ==="
ssh -o ConnectTimeout=5 q@23.254.248.119 "q docker ps --filter name=searxng"

echo "=== Logs ==="
ssh -o ConnectTimeout=5 q@23.254.248.119 "q docker logs searxng 2>&1 | tail -15"

echo "=== Test Search ==="
ssh -o ConnectTimeout=5 q@23.254.248.119 "q curl -s 'http://127.0.0.1:8080/search?q=hello&format=json' 2>&1 | q head -c 400"

echo "=== DONE ==="
