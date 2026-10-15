# Design — add-openai-compat-and-multi-apikeys

## 上下文
- 管线现状：`/v1/messages` 由 `src/server/routes-messages.js` 处理，鉴权在 `src/server/middleware.js`（`findKeyBySecret` → enabled/激活/过期/`checkQuota` 检查 → `req._apiKeyId`）。
- 多 API Key 已落地（commit `6afcb7a`）：`src/api-keys/manager.js`（`spendingLimit`、usage 计数 60s flush、`allowedAccounts`）、`src/webui/routes/api-keys.js`、`public/views/api-keys.html`、usage-log `keyId` 字段。
- `GET /v1/models` 成功响应为 OpenAI 格式（`{object:'list', data:[...]}`），错误响应为 Anthropic 格式（`routes-misc.js`）；`usage-stats.js` 已把 `/v1/chat/completions` 列入 TRACKED_PATHS。
- SSE 翻译：内部管线 `sendMessageStream` 产出 Anthropic 风格事件流（`message_start`/`content_block_delta`/`message_delta`/`message_stop`），`sse-streamer.js` 负责上游 Google SSE → 该事件流。

## 目标 / 非目标
**目标：** OpenAI 客户端经 `/v1/chat/completions` 完成对话与工具调用；错误以 OpenAI error 格式返回；与既有 Key 体系无缝对接；默认路径零回归。
**非目标：** reasoning/thinking 透传、`n>1`、`response_format` 强约束、基于 Key 的模型白名单、多实例配额一致性。

## 决策

### D1: 模块位置 — 新建 `src/openai/`（converter.js + routes.js）
`routes.js` 导出 `registerOpenAIRoutes(app, deps)`，在 `src/server.js` 中于鉴权中间件之后挂载。converter 为纯函数集合，便于独立单元测试（不启动服务器）。

### D2: 请求转换 — 先转 Anthropic 再进管线
- `system`（字符串或数组）→ Anthropic `system`；messages 逐条映射：`tool_calls` → `tool_use` 块，`role:"tool"` → `tool_result` 块（`tool_call_id` 匹配）。
- tools JSON Schema 直通（净化职责归下游 `schema-sanitizer.js`）；`tool_choice: "auto"|"none"|{function}` → Anthropic 对应形式。
- 图像：`image_url` data URL → image block；http(s) URL 透传给现有 content-converter 逻辑（其已处理或拒绝，行为与 /v1/messages 一致）。
- 参数映射：`max_tokens`（缺省取下游默认）、`temperature`、`top_p`、`stop`；`ANTIGRAVITY_SYSTEM_INSTRUCTION` 由 request-builder 照常注入，OpenAI 层不感知。
- 模型名走现有 `resolveModel` auto-map。

### D3: 响应转换 — 非流式与流式
- 非流式：内部响应 → `chat.completion`；thinking 块丢弃；`tool_use` → `tool_calls`；usage 取 `input_tokens`/`output_tokens`（cache read 计入 prompt_tokens，与 usage-stats 口径一致）。
- 流式：订阅 `sendMessageStream` 事件：`message_start` → role chunk；`content_block_start`(tool_use) → 注册 index 槽位；`content_block_delta`(text_delta) → content chunk；(input_json_delta) → 按 index 聚合 `tool_calls[].function.arguments` 增量 chunk；`message_delta` → finish_reason（`stop`/`tool_calls`/`length`）+ usage chunk；`message_stop` → `data: [DONE]`。
- thinking 增量 delta 直接丢弃，不发空 content chunk。

### D4: 错误映射 — 统一 OpenAI error 格式
`{error: {type, message, code}}`：上游 4xx/5xx 透传状态码（429 保持 429）；Anthropic 格式 `type: authentication_error/rate_limit_error/api_error` 映射为 OpenAI `invalid_api_key/rate_limit_exceeded/server_error` 等。流式中途错误：已发 chunk 后输出一条带 error 信息的 chunk（`finish_reason` 缺省），再发 `[DONE]` 或直接终止连接（选择：输出 error chunk + 结束流，客户端 SDK 均可解析）。

### D5: 错误 envelope — 中间件按路径切换 + 路由内统一出口
配额 429 / 鉴权 401 由共享 `apiKeyAuth` 中间件产生，早于 routes 执行，routes 层无法拦截。改法：`middleware.js` 中将 401/429 错误体构造抽为 `sendAuthError(req, res, status, type, message)`，按 `req.path === '/v1/chat/completions'` 切换 envelope：
- OpenAI 路径：`{error: {message, type: 'invalid_api_key'|'rate_limit_exceeded'|..., code}}`
- 其他路径：现有 Anthropic 格式逐字节不变
routes 层（上游错误、参数 400、流式中途错误）走统一错误出口函数 `sendOpenAIError(res, status, type, message, code)`，同一套映射表。

### D6: usage 与统计
usage-log 记录 `keyId`（既有通路）；`usage-stats.js` 的 TRACKED_PATHS 已含本路径，无需改动。

## 风险 / 权衡
- 并行 tool_calls index 聚合是最高风险点，单测 + 集成双覆盖。
- 中间件 error envelope 按 `req.path` 分支：非 OpenAI 路径输出必须逐字节不变，以现有回归测试断言。
- 流式 thinking 丢弃后，纯 thinking 响应可能长时间无 chunk（首 text delta 前静默）——与上游行为一致，接受。

## 迁移方案
无需迁移。`package.json` 新增 `test:openai`；`tests/run-all.cjs` 注册新套件。

## 待决问题
无。
