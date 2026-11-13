# 变更提案：collapsible-thinking-block

## 背景

当 `thinkingAsText=true` 且请求来自 Claude Code（`isClaudeCode`）时，`transformThinkingAsTextEvents`
会把思考块改写为 dim 文本预览。当前实现（agy-cc-proxy `src/cloudcode/thinking-text-streamer.js`）
在 `content_block_stop` 只输出文本块 + 「💭 Thought for Xs」时长行，思考内容**始终平铺显示**，
无法折叠，长思考会占据大量 CLI 版面。

参照仓库 `cc-proxy` 的 `src/thinking-text.js` 已在思考块结束时在**同一 index** 追加一个
原生 `thinking` 块覆写（`content_block_start(thinking)` + `thinking_delta` + 可选 `signature_delta`
+ stop）。Claude Code 收到该覆写后，会将流式状态机槽位原地替换为原生可折叠 thinking 消息，
默认折叠为「Thought for Xs」，支持 Ctrl+O 展开/折叠。

本变更将该「折叠深度思考文案内容」方案移植到 agy-cc-proxy。

## 目标范围

**在范围内：**
- 在 `content_block_stop` 时，将思考文本预览在同一 index 覆写为原生可折叠 thinking 块。
- 引入请求级 `startedAtMs` 时长锚点（对齐 cc-proxy），替代当前块内 `Date.now()` 墙钟，使
  网关缓冲场景下「Thought for Xs」时长准确。
- 导出 `formatDurationLine`，支持注入 `timeSource` 以便测试（对齐 cc-proxy）。
- 流式文本预览阶段仍保留 dim 时长行，覆写后由 Claude Code 原生折叠标题接管。
- 路由层（`/v1/messages` 与 OpenAI compat）传递 `startedAtMs` 请求级锚点，直接复用路由已
  有的 `streamStartTime = Date.now()`（`routes-messages.js`、`routes-openai.js`），使时长锚点
  与 usage 的 `streamStartTime` 语义对齐为同一请求级时刻；锚点注入固定在路由层（始终存在），
  streamer 内部仅以首个带 type 的 SSE 事件时刻作为**无锚点时的兜底**（防御性，正常路径不触发）。

### `timeSource` 契约
`options.timeSource` 是返回**当前绝对时间戳（epoch ms）的 getter**，默认 `Date.now`。
时长计算恒为 `durationSec = ((options.timeSource?.() ?? Date.now()) - startedAtMs) / 1000`。
测试可注入可控时序的 getter 序列以固定断言「Thought for Xs」数值。

> **多 thinking 块累积效应**：请求级锚点下，第 2+ 个思考块的「Thought for Xs」为「请求到达 →
> 该块 stop」的总耗时，会随前序块累积而变大，属接受的时长语义变化（对齐 cc-proxy）。
> **wire 重传成本**：覆写复用已缓冲文本（不新增内存），但 wire 上会把已推送的思考全文经
> `thinking_delta` 再发送一次（单块上限 256KB、整响应 1MiB），属既有输出量的二次传输，接受。

**不在范围内：**
- 非流式（non-streaming JSON）思考改写路径（`message-handler.js` / `response-converter.js`）不在本次改动——折叠能力仅适用于 SSE 流式原生块。
- 不改 `thinkingAsText=false` 或非 Claude Code 客户端的透传行为。
- 不改 `stripThinkingTextHistory` 剥离历史的正则（新块与旧格式一致，无需扩展）。

## 技术方案

在 `src/cloudcode/thinking-text-streamer.js` 的 `transformThinkingAsTextEvents` stop 分支中，
复用已缓冲的 `pendingBlock.thinking`（完整思考文本）与 `pendingBlock.signature`，在时长行
输出后追加同一 `index` 的事件序列。**仅当块未因字节/响应上限被丢弃且 `pendingBlock.thinking`
非空时**才输出覆写块（复用现有 stop 分支守卫 `!pendingBlock.discarded && pendingBlock.thinking`）；
被丢弃或空白思考块不输出覆写，避免空 thinking + 签名触发 CC 校验失败。

```
content_block_start(index, { type: 'thinking', thinking: '', signature: '' })
content_block_delta(index, { type: 'thinking_delta', thinking: <全文> })
[content_block_delta(index, { type: 'signature_delta', signature: <签名> })]  // 若有
content_block_stop(index)  // 透传原始 stop
```

- `startedAtMs` 从路由请求到达时间传入 `streamOptions`，沿 `sendMessageStream` →
  `transformThinkingAsTextEvents` 传递；无请求级锚点时退回首个 SSE 事件时刻。
- 保留 `pendingLeadingNewline`/末尾换行处理语义，但整体对齐 cc-proxy 的 stop 分支顺序
  （文本+时长行 → 原生覆写）。

## 预期影响

- 对 Claude Code 用户：思考改为默认折叠、可展开，CLI 版面显著精简；时长显示准确。
- **可感知的时长语义变化**：「Thought for Xs」由「思考块自身耗时（块内墙钟）」变为「请求到达
  → stop 的总耗时（含上游排队 / 网关缓冲 / 首个 SSE 拉取等待）」。对于瞬时完成、无网关缓冲的
  普通响应，两者接近相等；对缓冲型网关，新语义更接近真实思考耗时（这是刻意的对齐）。
- 字节/响应上限逻辑（`MAX_THINKING_TEXT_BLOCK_BYTES`/`MAX_THINKING_TEXT_RESPONSE_BYTES`）不作
  改动——覆写复用已缓冲文本，不新增内存。
- 非 CC 客户端、`thinkingAsText=false`：路径完全不变，零影响。
- OpenAI compat 端点（`routes-openai.js`）：同样受益，无需额外逻辑。

## 风险

- **孤儿事件风险**：覆写序列若 index 不与先行 `content_block_start` 对齐，会导致 CC 解析中断
  （表现为"请求成功但无回复"）。对策：反复用 `content_block_start` 先行 + 同 index 覆写，且
  whitespace-only 块不落 stop（沿用现有守卫）。已有集成测试 `test:thinking-as-text` 可回归。
- **同 index 双 `content_block_start` 属非标准 hack**：严格 Claude API 规范要求每个 index 仅一次
  `content_block_start`。本方案刻意重复发射同 index（先 text 块、后 thinking 覆写），依赖 CC
  状态机"原地替换槽位"。此依赖以 `cc-proxy` 同源实现为参照已落地佐证；若目标 CLI 版本收紧
  校验，折叠将优雅退化为平铺 dim 文本（可接受的降级路径，不留孤儿事件）。
- **签名保真**：覆写块必须携带原始 `signature_delta`，否则 multi-turn 修复路径
  （`thinking-utils.js` restreThinkingSignatures）可能失效。对策：仅在有有效签名时输出
  signature_delta，沿用 `MIN_SIGNATURE_LENGTH` 门控。
- **流程改动面**：涉及 `thinking-text-streamer.js`、`streaming-handler.js`、`routes-messages.js`、
  `routes-openai.js` 四文件，属跨模块协同修改；已纳入 OpenSpec，回归走 `t:thinking-as-text` 测试。