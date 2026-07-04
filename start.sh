#!/bin/bash
cd "$(dirname "$0")"

if pm2 show agy-cc-proxy > /dev/null 2>&1; then
    echo "服务已在运行，重启中..."
    pm2 restart agy-cc-proxy
else
    echo "启动 agy-cc-proxy..."
    pm2 start ecosystem.config.cjs
fi

pm2 save
echo "✓ 服务已启动，端口: 12345"
pm2 show agy-cc-proxy
