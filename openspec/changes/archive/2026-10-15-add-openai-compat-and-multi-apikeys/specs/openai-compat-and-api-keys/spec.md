# Delta Spec — add-openai-compat-and-multi-apikeys

## Purpose
提供 OpenAI chat completions 兼容端点，使 OpenAI 协议客户端（Cursor、Open WebUI、Cline 等）可直接使用代理；复用现有 Cloud Code 管线与既有命名 API Key 体系（鉴权、配额、用量归属），不改变现有 `/v1/messages` 与 `/v1/models` 行为。

## ADDED Requirements

### Requirement: OpenAI chat completions 端点
The system SHALL 在 `POST /v1/chat/completions` 接受 OpenAI Chat Completion 请求（messages、tools、tool_choice、stream），复用现有 Cloud Code 管线执行并按 OpenAI 响应格式返回；该端点同时适用于 claude 与 gemini 模型家族。

#### Scenario: 非流式对话
- **WHEN** 客户端发送 `{"model": "<可用模型>", "messages": [{"role":"user","content":"hi"}], "stream": false}`
- **THEN** 返回 `chat.completion` 对象，`choices[0].message.content` 含助手回复文本，`usage` 含 prompt/completion token 数

#### Scenario: 流式响应
- **WHEN** 客户端发送 `stream: true` 的合法请求
- **THEN** 返回 SSE 流，事件为 `chat.completion.chunk`，序列包含 role delta、content delta、`finish_reason`，并以 `data: [DONE]` 结束

#### Scenario: 工具调用
- **GIVEN** 请求包含 tools 定义
- **WHEN** 模型决定调用工具
- **THEN** 非流式响应的 `choices[0].message.tool_calls` 按模型输出顺序列出（`id`/`function.name`/`function.arguments`）；流式响应按 index 聚合 tool_calls 增量，`finish_reason` 为 `tool_calls`

#### Scenario: 不支持参数
- **WHEN** 请求包含 `n > 1`
- **THEN** 返回 400 与 OpenAI error 格式错误信息

### Requirement: OpenAI 端点鉴权与配额
The system SHALL 对 `/v1/chat/completions` 应用与 `/v1/messages` 相同的鉴权中间件、命名 Key `spendingLimit` 配额与 `allowedAccounts` 账号绑定约束；本端点产生的错误 SHALL 以 OpenAI error 格式（`error.type`/`error.message`/`error.code`）返回，限流保持 HTTP 429。

#### Scenario: 命名 Key 配额超限
- **GIVEN** 某命名 Key 的 spendingLimit 已达上限
- **WHEN** 该 Key 调用 `/v1/chat/completions`
- **THEN** 收到 HTTP 429，响应体为 OpenAI error 格式，且 usage 记录/拦截不产生新的用量计数

#### Scenario: 默认 Key 零回归
- **GIVEN** 既有客户端用原默认 Key 调用 `/v1/messages`
- **WHEN** 本次变更部署后重复相同请求
- **THEN** 行为与部署前完全一致

### Requirement: 用量记录按 Key 归属
The system SHALL 在 `/v1/chat/completions` 产生的用量记录中沿用既有 `keyId` 归属通路（`req._apiKeyId`），与 `/v1/messages` 记录格式一致。

#### Scenario: 记录归属
- **WHEN** 命名 Key 发起 `/v1/chat/completions` 请求并产生用量
- **THEN** 对应 usage 记录的 `keyId` 为该 Key 的 id
