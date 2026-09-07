#!/bin/bash
cd "$(dirname "$0")"

STOPPED=0

# 1) 停止 pm2 管理的实例（如存在）
if pm2 show agy-cc-proxy > /dev/null 2>&1; then
    pm2 stop agy-cc-proxy
    STOPPED=1
fi

# 2) 兜底：查找并结束占用服务端口（默认 12345，可被 config.json DEFAULT_PORT 覆盖）的残留进程，
#    防止孤儿进程抢占端口导致 pm2 实例 EADDRINUSE crash-loop
PORT="${PORT:-12345}"
PIDS=$(lsof -ti tcp:"$PORT" 2>/dev/null)
if [ -n "$PIDS" ]; then
    echo "发现占用端口 $PORT 的残留进程: $PIDS，正在结束..."
    kill $PIDS 2>/dev/null
    sleep 1
    # 仍未退出则强制结束
    PIDS=$(lsof -ti tcp:"$PORT" 2>/dev/null)
    if [ -n "$PIDS" ]; then
        echo "进程未响应 SIGTERM，强制结束..."
        kill -9 $PIDS 2>/dev/null
        sleep 1
    fi
    STOPPED=1
fi

if [ "$STOPPED" -eq 1 ]; then
    echo "✓ 服务已停止"
else
    echo "服务未在运行"
fi
