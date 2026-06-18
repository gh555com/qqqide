#!/bin/bash
ssh -o ConnectTimeout=5 q@23.254.248.119 "uname -r && echo '---' && q systemd-detect-virt 2>/dev/null || echo novirt && echo '---' && cat /proc/1/cgroup 2>/dev/null | head -5"
