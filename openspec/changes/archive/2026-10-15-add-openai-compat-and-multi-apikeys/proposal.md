# 变更提案：add-openai-chat-completions

> 修订版 v3：经现状盘点修正。原「多 API Key」功能已在 commit `6afcb7a` 落地
> （`src/api-keys/`、`src/server/middleware.js`、`spendingLimit` 配额、usage-log `keyId`、
> WebUI `api-keys` 页面），本变更范围收窄为 OpenAI chat completions 兼容层，
> 并与既有 Key 体系（`req._apiKeyId`、`getAllowedAccounts`、配额 429）对接。

## 背景

agy-cc-proxy 目前仅暴露 Anthropic Messages API（`/v1/messages`），只能服务 Claude Code 等 Anthropic 协议客户端；大量主流工具（Cursor、Open WebUI、Cline、Cherry Studio 等）使用 OpenAI 协议，无法直接接入。`GET /v1/models` 成功响应已是 OpenAI 格式（`{object:'list', data:[...]}`，但错误响应为 Anthropic 格式），`usage-stats.js` 也已把 `/v1/chat/completions` 列入统计路径，唯独核心对话端点缺失。

## 目标范围

**在范围内：**
- `POST /v1/chat/completions`：流式 SSE + 非流式，支持 messages（system/user/assistant/tool）、tools/tool_choice、图像（data URL）转换
- 复用现有 Cloud Code 管线（`sendMessage`/`sendMessageStream`）与既有不变量（cache 剥离、sessionId、模型 auto-map）
- 与既有命名 Key 体系对接：鉴权、`spendingLimit` 配额 429（含 OpenAI error 格式）、usage 记录带 `keyId`、`allowedAccounts` 生效
- 上游/配额错误映射为 OpenAI error 格式

**不在范围内：**
- `/v1/embeddings`、`/v1/completions` 等其他 OpenAI 端点
- thinking 透传为 `reasoning` 字段（丢弃，后续变更处理）
- `n > 1`、`logprobs`、`response_format`（json_schema 强约束）等高级参数

## 技术方案

- 新模块 `src/openai/`：`converter.js`（纯函数请求/响应/chunk 转换）+ `routes.js`（Express router），挂载于 `src/server/middleware.js` 鉴权之后。
- 请求侧：OpenAI messages → Anthropic 内部表示（system 块、tool_calls→tool_use、role:"tool"→tool_result），tools JSON Schema 直通（下游 `schema-sanitizer.js` 已负责净化），`ANTIGRAVITY_SYSTEM_INSTRUCTION` 由下游 request-builder 照常注入。
- 响应侧：非流式 → `chat.completion`；流式订阅内部事件流重编码为 `chat.completion.chunk`（role → content → tool_calls 按 index 聚合 → finish_reason → `[DONE]`）。
- 配额复用：进入路由前共享中间件已完成 `checkQuota`（429 Anthropic 格式）→ 鉴权中间件按 `req.path` 为 OpenAI 端点切换 error envelope（`error.type/message/code`），一次改动同时覆盖 401/429；上游错误在 routes 层同样映射。
- usage 记录沿用 `keyId: req._apiKeyId` 现有通路。

## 预期影响

- 新增一个公开端点，现有 `/v1/messages`、`/v1/models` 行为零变化。
- `usage-stats.js` 的 `/v1/chat/completions` 统计路径从此有真实流量。
- `package.json` 新增 `test:openai` 脚本。

## 风险

- **工具调用转换兼容性**：并行 tool_calls 按 index 聚合易错 → 以此为核心场景写单元 + 集成测试。
- **流式映射边界**：SSE 事件序列错位破坏客户端解析 → 集成测试验证完整 chunk 序列。
- **鉴权回归**：仅新增路由，不改中间件，回归面小；全量 `npm test` 兜底。
- **`/v1/models` 格式现状**：成功响应 OpenAI 格式、错误响应 Anthropic 格式 → 本变更不动该端点，仅在文档标注差异。
- **中间件 error envelope 改动**：`apiKeyAuth` 为共享路径 → 按 `req.path` 分支切换格式，非 OpenAI 路径输出逐字节不变；以现有 `/v1/messages` 回归测试兜底。
