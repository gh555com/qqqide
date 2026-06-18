#!/bin/bash
echo "=== CHECK ==="
ssh -o ConnectTimeout=10 q@23.254.248.119 "q docker ps -a"
echo "EXIT: $?"
