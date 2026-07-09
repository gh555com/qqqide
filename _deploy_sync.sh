#!/bin/bash
echo "[sync] $(date) CN→US qqqide start"
scp -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=30 -o ServerAliveInterval=15 -r /opt/dgs/web/qqqide/ q@10.0.0.1:$(dirname /opt/dgs/web/qqqide)/
ssh -o StrictHostKeyChecking=no -o BatchMode=yes q@10.0.0.1 "cd /opt/dgs/web/qqqide && [ -f _qqqide.tar.gz ] && cp _qqqide.tar.gz server-app.tar.gz && tar -xzf _qqqide.tar.gz && rm _qqqide.tar.gz; echo ok"
echo "[sync] $(date) done"