# 变更提案：add-usage-log

## 背景
当前系统仅有"运行日志"页面显示服务端实时日志流，缺乏面向终端用户的 API 调用用量明细视图。用户无法直观查看每次 API 请求的 Token 消耗、请求耗时和消费金额，不利于用量审计和成本管控。

## 目标范围

**在范围内：**
- 新增"使用日志"侧边栏导航项，位于"运行日志"上方
- 新增使用日志页面，以表格形式展示每次 API 请求的用量明细
- 服务端新增用量追踪模块，记录每次 `/v1/messages` 请求的详细用量数据
- 字段包括：时间、模型、API 密钥（脱敏）、模型用量（输入/输出/缓存读取/总计 Tokens）、请求耗时（总耗时/首 Token 耗时）、流式标识、消费金额（Credits）
- 内置模型定价表用于 Credits 计算
- 数据持久化到磁盘（`~/.config/antigravity-proxy/usage-log.json`）

**不在范围内：**
- 修改现有的 `usage-stats.js`（Dashboard 用量统计）模块
- 修改 `/v1/chat/completions`（OpenAI 兼容端点）的用量追踪
- 用量数据的导出功能
- 用量数据的筛选/搜索功能（后续迭代）

## 技术方案

### 架构决策
- **新增独立模块** `src/modules/usage-log.js`：与现有 `usage-stats.js` 解耦，专注单次请求的详细用量记录，不修改现有统计逻辑
- **事件拦截模式**：在 `server.js` 的 `POST /v1/messages` 流式处理循环中提取 SSE 事件携带的 `usage` 数据，无需修改 `sse-streamer.js` 的生成器签名
- **内存环形缓冲区 + 定时刷盘**：内存中保留最近 N 条记录（默认 5000），每 60 秒刷盘一次，避免高频 I/O；同时注册 `SIGINT`/`SIGTERM` 处理器在进程退出前紧急刷盘，最小化数据丢失窗口
- **API 路由注册**：`usage-log.js` 导出 `setupRoutes(app)` 函数，由 `server.js` 调用注册 `GET /api/usage-log`，遵循现有 `usage-stats.js` 的模块模式

### 数据流
```
POST /v1/messages
  → 记录 startTime
  → sendMessageStream() 逐事件产出
  → 从 message_start 事件提取 input_tokens / cache_read_input_tokens
  → 从首个 content_block_delta 计算 timeToFirstToken
  → 从 message_delta 事件提取 output_tokens
  → 流结束后计算 totalDuration，查定价表计算 credits
  → usageLog.record({...})
  → 继续正常响应客户端
```

### Gemini usageMetadata → 展示字段映射
用量数据从 SSE 事件的 Anthropic 格式 usage 字段提取（sse-streamer.js 已将 Gemini 原始数据转换为 Anthropic 语义）：
- `message_start.usage.input_tokens` → `inputTokens`（= promptTokenCount - cachedContentTokenCount，不含缓存）
- `message_delta.usage.output_tokens` → `outputTokens`（= candidatesTokenCount）
- `message_start.usage.cache_read_input_tokens` → `cacheReadTokens`（= cachedContentTokenCount）
- `totalTokens = inputTokens + outputTokens + cacheReadTokens`

若 SSE 事件中 usage 字段缺失，对应展示值默认 `0`。

### Credits 计算公式
```
credits = (inputTokens / 1_000_000) × inputPrice
        + (outputTokens / 1_000_000) × outputPrice
        + (cacheReadTokens / 1_000_000) × cacheReadPrice
```
结果保留 4 位小数。定价表按模型名称前缀匹配（从具体到通用），命中首个匹配规则即停止。定价表为静态常量，位于 `src/modules/usage-log.js` 中，后续可通过 `config.json` 扩展覆盖。

### 前端实现
- 使用 Alpine.js 组件模式，与现有 `logs-viewer.js` 风格一致
- 视图模板 `views/usage-log.html` 采用与 `logs.html` 一致的终端风格
- 通过 `GET /api/usage-log` 获取数据
- 支持自动刷新（跟随全局轮询间隔）

### 定价表（Credits 计算）
内置常见模型定价（Credits = input_tokens/1M * input_price + output_tokens/1M * output_price + cache_read_tokens/1M * cache_price）：
- deepseek-v4-pro: input $0.20/M, output $0.80/M, cache $0.02/M
- claude-opus-4-*: input $15.00/M, output $75.00/M, cache $1.50/M
- claude-sonnet-4-*: input $3.00/M, output $15.00/M, cache $0.30/M
- claude-haiku-4-*: input $0.80/M, output $4.00/M, cache $0.08/M
- gemini-*: input $0.075/M, output $0.30/M, cache $0.01/M
- 其他: input $0.50/M, output $2.00/M, cache $0.05/M (fallback)

## 预期影响
- 对现有 API 响应延迟无影响（用量记录在响应完成后异步写入）
- 内存增量约 500KB（5000 条记录 × ~100 字节/条）
- 磁盘增量约 1-2MB（usage-log.json）
- 不影响现有 `/v1/messages` 的 SSE 事件格式

## 风险
- **低风险**：用量数据提取依赖 SSE 事件的 `usage` 字段，若上游格式变更可能导致部分字段为空（已做防御性默认值处理）
- **低风险**：环形缓冲区满后丢弃最旧记录，不会 OOM
- **中风险**：进程异常退出（`kill -9` / 崩溃）时，最近 60 秒内的用量数据可能丢失。已通过 `SIGINT`/`SIGTERM` 处理器覆盖正常退出场景；异常崩溃的数据丢失可接受（用量日志非关键业务数据）
