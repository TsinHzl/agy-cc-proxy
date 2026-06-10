## 新增需求

### 需求：用量日志记录
每次 `/v1/messages` 请求完成后，系统自动记录一条用量明细。

#### 场景：流式请求成功
- **WHEN** 客户端发送 `POST /v1/messages` 且 `stream: true`
- **AND** SSE 流成功完成（收到 `message_stop` 事件）
- **THEN** 系统记录一条用量日志，包含：
  - `timestamp`: ISO 8601 时间戳
  - `model`: 请求的模型 ID
  - `apiKey`: 脱敏后的账号邮箱（如 `user***@domain.com`）
  - `inputTokens`: 从 SSE `message_start.usage.input_tokens` 提取（Anthropic 调整值 = promptTokenCount - cachedContentTokenCount，不含缓存部分）
  - `outputTokens`: 从 SSE `message_delta.usage.output_tokens` 提取（对应 Gemini `candidatesTokenCount`）
  - `cacheReadTokens`: 从 SSE `message_start.usage.cache_read_input_tokens` 提取（对应 Gemini `cachedContentTokenCount`）
  - `totalTokens`: inputTokens + outputTokens + cacheReadTokens
  - `totalDuration`: 请求开始到流结束的总耗时（秒，保留 2 位小数）
  - `timeToFirstToken`: 请求开始到首个 `content_block_delta` 事件的耗时（秒，保留 2 位小数）
  - `streaming`: true
  - `credits`: 消费金额，计算公式 `credits = (inputTokens/1M)×inputPrice + (outputTokens/1M)×outputPrice + (cacheReadTokens/1M)×cachePrice`，结果保留 4 位小数。定价表按模型名称前缀匹配（从具体到通用），命中首个匹配规则即停止

#### 场景：非流式请求成功
- **WHEN** 客户端发送 `POST /v1/messages` 且 `stream: false` 或不传
- **AND** 响应成功返回
- **THEN** 系统记录一条用量日志，`streaming: false`，`timeToFirstToken` 为 null（展示为 `-`）

#### 场景：请求失败（流开始前）
- **WHEN** 请求在流开始前失败（如 429 / 400 / 503）
- **THEN** 系统不记录用量日志

#### 场景：流中途失败
- **WHEN** SSE 流已开始但中途出错
- **THEN** 系统不记录用量日志（避免不完整数据）

#### 场景：usageMetadata 字段缺失
- **WHEN** SSE 响应中 `usageMetadata` 或其子字段缺失
- **THEN** 对应 token 字段默认值为 `0`

### 需求：用量日志查询 API
#### 场景：获取用量日志
- **WHEN** 客户端发送 `GET /api/usage-log`
- **THEN** 返回 JSON 数组，按时间倒序排列，最新记录在前
- **AND** 响应格式：`{ status: "ok", records: [...] }`

### 需求：用量日志 WebUI 页面
#### 场景：查看使用日志
- **WHEN** 用户点击侧边栏"使用日志"
- **THEN** 显示用量明细表格，包含 proposal 中定义的所有字段
- **AND** 数据按时间倒序排列

#### 场景：导航位置
- **WHEN** 页面加载
- **THEN** "使用日志"导航项位于侧边栏 System 分组，"运行日志"上方

### 需求：数据持久化
#### 场景：正常退出
- **WHEN** 服务器收到 SIGINT/SIGTERM
- **THEN** 内存中的用量日志写入 `usage-log.json`

#### 场景：定时刷盘
- **WHEN** 服务器运行中
- **THEN** 每 60 秒将内存中的用量日志写入 `usage-log.json`

#### 场景：进程异常崩溃
- **WHEN** 进程被 `kill -9` 或发生未捕获异常崩溃
- **THEN** 最近 60 秒内的用量数据可能丢失（可接受，用量日志非关键业务数据）

#### 场景：数据上限
- **WHEN** 内存中的记录数超过 5000 条
- **THEN** 丢弃最旧的记录，保持最多 5000 条
