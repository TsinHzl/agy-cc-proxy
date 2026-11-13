## ADDED Requirements

### Requirement: Streaming thinking blocks render as native collapsible blocks for Claude Code
当 `thinkingAsText` 启用且请求来自 Claude Code（`isClaudeCode`）时，流式端点 MUST 在思考块
结束时将已缓冲的思考内容在同一内容块 index 覆写为原生 `thinking` 块（含完整 `thinking_delta`
与有效 `signature_delta`），使 Claude Code 将思考渲染为默认折叠、可 Ctrl+O 展开的原生
thinking 消息，而非始终平铺的 dim 文本。

> **适用模型族：** claude / gemini 均适用（转换发生在 Anthropic SSE 事件流层，与上游模型族无关）。
> **适用流式端点：** `POST /v1/messages`（stream=true）与 `POST /v1/chat/completions`（stream=true）。

#### Scenario: Claude Code 收到可折叠 thinking 块
- **GIVEN** `thinkingAsText=true` 且请求 `user-agent` 匹配 Claude Code
- **WHEN** 上游流式响应包含一个思考块（`thinking_delta` + 有效 `signature_delta`），并到达
  `content_block_stop`
- **THEN** 代理先输出 dim 文本预览与时长行，然后输出与预览同一 `index` 的
  `content_block_start(content_block.type='thinking')`、完整 `thinking_delta`、`signature_delta`
  与 `content_block_stop`
- **AND** 该覆写后的 thinking 块在 Claude Code 中默认折叠为「Thought for Xs」，支持展开/折叠
- **AND** 覆写仅在思考块未因字节/响应上限被丢弃且思考文本非空时输出；丢弃或空白块不输出覆写

#### Scenario: 无有效签名时不携带 signature
- **GIVEN** 思考块无有效 `signature_delta`（长度低于 `MIN_SIGNATURE_LENGTH`）
- **WHEN** 到达 `content_block_stop`
- **THEN** 覆写块输出 `thinking` 的 `content_block_start` 与 `thinking_delta`，但不输出
  `signature_delta`

#### Scenario: 非 Claude Code 或 thinkingAsText=false 不受影响
- **GIVEN** `thinkingAsText=false` 或请求 `user-agent` 非 Claude Code
- **WHEN** 上游流式响应含思考块
- **THEN** 事件流原样透传，不输出文本预览亦不输出覆写 thinking 块

### Requirement: Thinking duration uses a request-level anchor
思考时长（渲染为「Thought for Xs」dim 时长行）MUST 从请求到达时间（`startedAtMs`）起算而非
块内墙钟，使第三网关在思考结束前缓存整个响应、`message_start` 之后才一次性突发的场景下，
时长仍反映真实思考耗时。

#### Scenario: 请求级锚点覆盖网关缓冲
- **GIVEN** 请求到达代理后，网关缓冲了整段思考，导致 `content_block_start`/`content_block_stop`
  在真实思考结束后的同一突发中到达
- **WHEN** `content_block_stop` 计算时长行
- **THEN** 时长 = stop 时刻 − 请求到达时刻（`startedAtMs`），而非 stop 时刻 − `content_block_start` 时刻
- **AND** 当无 `startedAtMs` 时，退回首个带 type 的 SSE 事件时刻作为锚点

## MODIFIED Requirements

### Requirement: Stream thinking blocks as text for Claude Code
当 `thinkingAsText` 启用且请求来自 Claude Code 时，流式端点 SHALL 将思考块改写为 dim 文本预览
（`💭 Thinking` 头 + 逐行 dim），并在块结束时注明思考时长。

> 变更点：块结束处的收尾由「仅 dim 时长行」扩展为「dim 时长行 + 同一 index 的原生可折叠
> thinking 块覆写」，使思考内容可在 Claude Code 中折叠。此行为由新增 Requirement
> 「Streaming thinking blocks render as native collapsible blocks」接管，本需求聚焦于
> 现有 dim 文本预览与时长行的既有契约不变（含字节/响应上限、每行 dim、去空行等渲染规则）。

#### Scenario: 思考文本预览仍以 dim 文本流式渲染
- **GIVEN** `thinkingAsText=true` 且 Claude Code 请求
- **WHEN** 思考增量（`thinking_delta`）到达
- **THEN** 代理按行缓冲并流式输出 dim 文本预览块（`content_block_start(type='text')` +
  逐行 `text_delta`），先显示 `💭 Thinking` 头
- **AND** 预览文本块与后续覆写 thinking 块共用同一 index（流式状态机槽位原地替换）