#!/bin/bash
cd "$(dirname "$0")"

# 1) 清理环境：杀掉占用服务端口的残留进程，避免 EADDRINUSE
#    （默认 12345，可用 PORT 环境变量覆盖，与 ecosystem.config.cjs 一致）
PORT="${PORT:-12345}"
PIDS=$(lsof -ti tcp:"$PORT" 2>/dev/null)
if [ -n "$PIDS" ]; then
    echo "发现占用端口 $PORT 的残留进程: $PIDS，正在结束..."
    kill $PIDS 2>/dev/null
    sleep 1
    PIDS=$(lsof -ti tcp:"$PORT" 2>/dev/null)
    if [ -n "$PIDS" ]; then
        echo "进程未响应 SIGTERM，强制结束..."
        kill -9 $PIDS 2>/dev/null
        sleep 1
    fi
fi

# 2) 启动 pm2 实例（已存在则重启，加载最新代码）
if pm2 show agy-cc-proxy > /dev/null 2>&1; then
    echo "服务已在 pm2 中注册，重启中..."
    pm2 restart agy-cc-proxy --update-env
else
    echo "启动 agy-cc-proxy..."
    pm2 start ecosystem.config.cjs
fi

pm2 save

# 3) 健康检查：等待端口监听并确认 pm2 状态为 online，失败则报错退出（非 0）
echo "等待服务启动..."
for i in $(seq 1 15); do
    sleep 1
    STATUS=$(pm2 jlist 2>/dev/null | node -e '
        let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
            try{const l=JSON.parse(d);const p=l.find(x=>x.name==="agy-cc-proxy");
            console.log(p&&p.pm2_env?p.pm2_env.status:"unknown");}catch(e){console.log("unknown");}
        });')
    if [ "$STATUS" = "online" ] && curl -sf "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
        echo "✓ 服务已启动，端口: $PORT，健康检查通过"
        pm2 show agy-cc-proxy | head -n 30
        exit 0
    fi
done

echo "✗ 服务启动失败或健康检查未通过，请查看日志: pm2 logs agy-cc-proxy" >&2
pm2 show agy-cc-proxy
exit 1
