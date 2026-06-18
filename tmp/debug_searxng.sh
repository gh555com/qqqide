#!/bin/bash
echo "=== Remove old ==="
ssh -o ConnectTimeout=10 q@23.254.248.119 "q docker rm -f searxng 2>/dev/null; echo removed"

echo "=== Run foreground (20s timeout) ==="
ssh -o ConnectTimeout=10 q@23.254.248.119 "timeout 25 q docker run --rm --name searxng -p 8080:8080 -e UWSGI_WORKERS=1 searxng/searxng 2>&1 || true"

echo "=== Done ==="
