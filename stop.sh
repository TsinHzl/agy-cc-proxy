#!/bin/bash
cd "$(dirname "$0")"

if pm2 show agy-cc-proxy > /dev/null 2>&1; then
    pm2 stop agy-cc-proxy
    echo "✓ 服务已停止"
else
    echo "服务未在运行"
fi
