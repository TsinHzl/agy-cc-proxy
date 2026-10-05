# 变更提案：add-claude-code-thinking-text

## 背景

当前代理能够将 Cloud Code 上游的 `part.thought` 转换为 Anthropic `thinking` SSE，但 Claude Code 的终端呈现取决于客户端行为，且现有 SSE 分帧、流尾签名与下游协商路径不足以稳定保证可渲染的完整 thinking 块。用户需要参考 `kiro2cc-proxy`，让 Claude Code 在终端中显示暗色、缩进的深度思考文本，同时不得合成思考内容或伪造签名。

## 目标范围

**在范围内：**
- 新增默认关闭、可通过现有配置 API 与 WebUI 持久化切换的 `thinkingAsText` 开关。
- 仅对流式请求且入站 `User-Agent` 匹配 `/^(?:claude-cli|claude-code)(?:\/|\s|$)/i` 时启用文本化渲染；缺失 Header、普通 SDK、包含但不以前缀匹配的字符串均保持标准 Anthropic `thinking` SSE。
- 仅在同一响应、同一尚未关闭的 thought block 中收到真实且长度不小于现有 `MIN_SIGNATURE_LENGTH` 的 `thoughtSignature` 时输出文本化内容；重复、乱序、跨 block 或流尾缺失签名均 fail-closed，不输出该块且不伪造签名。
- 将已验证 thought 映射为相同 block index 的合法 text SSE：`content_block_start(text)` → 一个或多个 `text_delta` → `content_block_stop`；原 `thinking_delta` 与 `signature_delta` 不下发，相邻 text、tool_use、image 事件顺序和 index 不变。
- 使用精确渲染封装 `\x1b[2m> 💭 Thinking⁣agy-thinking-text-v1⁣\n> …\x1b[0m`：输入统一为 LF，逐行引用，空行输出 `> `，每个渲染块在关闭前 reset ANSI；空 thought 即使有签名也不输出。
- 在下一轮请求进入 Cloud Code 前，仅从 assistant 历史中剥离上述完整机器标记与 ANSI 封装；同一 text block 后的正式回答、普通引用、原生 thinking 与用户文本必须保留。
- 修复流式与非流式 Cloud Code SSE 的完整事件分帧与流尾 flush，使 thought 文本和签名即使跨 `data:` 行、跨 UTF-8 chunk 或缺少末尾换行也能被正确处理；注释、`event:`、`id:` 字段忽略，JSON 解析失败不记录原文且只丢弃当前畸形事件。
- 覆盖 Claude 与 Gemini 的已识别 thinking 模型；跨 family 签名保持既有 fail-closed 行为。

**不在范围内：**
- 不控制 Claude Code 的字体大小、主题、折叠组件或本地 `showThinkingSummaries` 设置。
- 不将代理日志、系统提示、工具结果、普通文本或合成摘要伪装为 thinking。
- 不迁移 Kiro 的 AWS Event Stream 解码、`<thinking>` 标签解析、Kiro 私有模型字段或伪签名机制。
- 不改变非流式 Anthropic 响应的呈现；非流式改动仅限完整解析与真实签名配对。
- 不改变模型选择、账号轮换或上游 thinking budget。

## 技术方案

在保留现有上游 thought/signature 缓存逻辑的基础上，使用共享 SSE 事件聚合器按空行提交完整事件：拼接多条 `data:` 行，结束时 flush `TextDecoder` 和残余事件。流式与非流式路径共同使用该聚合语义，但保持各自现有响应形态。非流式路径只将同一完整 thought 与有效签名恢复为既有 `content[].type = "thinking"`、`thinking`、`signature` 字段；签名-only、无文本或无签名 part 不写入响应内容或缓存，不执行文本化、ANSI 改写或字段扩展。

增加 `src/cloudcode/thinking-text-streamer.js` 作为独立的下游 SSE 事件重写器，并仅包裹 `streamSSEResponse()` 已完成上游解析、签名缓存与原生事件生成后的输出、Express 序列化前的 async event stream。仅在配置开关、流式请求和 Claude Code User-Agent 同时匹配时，该重写器缓冲单个原生 thinking block 的文本；真实有效签名在该 block 关闭前到达后，重写器以原 index 发出文本块。每个块上限为 256 KiB、每个响应累计上限为 1 MiB；任一上限触发时清空该块、停止缓冲后续渲染内容、记录不含原文的诊断，并继续透传非 thinking 事件。重写器不影响上游签名缓存、工具调用或响应错误语义。

历史清理在请求转换入口、任何 `convertContentToParts()` 调用前执行。清理只匹配 assistant 文本开头的完整 ANSI dim + 机器标记 + ANSI reset 片段，删除连续渲染片段后保留后续正式文本；不以自然语言标题或 Markdown 引用作为删除条件。

配置 API 仅接受 JSON 布尔值 `thinkingAsText: true|false`；字符串、数字、对象和数组返回 `400 invalid_request_error` 且不写入配置；字段缺失保持现有值。WebUI 复用现有 Server 设置的乐观更新、失败回滚和刷新模式，并补齐 `en`、`zh`、`pt`、`id`、`tr` 翻译键。

## 预期影响

- 开关关闭、非 Claude Code 客户端和非流式响应保持当前协议行为，不输出 ANSI 或机器标记。
- 开关开启后，Claude Code 可显示真实上游思考的暗色文本；因签名校验与缓冲，思考文本可能在上游签名抵达后集中出现，而非逐 token 出现。
- 文本化后的 thought 不携带下游 `signature_delta`，但上游真实签名缓存与后续工具循环处理保持不变。
- 更完整的 SSE 解析会同时提升流式与非流式 thought/text 的完整性，不改变非流式下游内容类型。

## 风险

- ANSI 渲染依赖 Claude Code 终端解释控制符；功能严格限制为 User-Agent 前缀匹配的流式请求，并在每块 reset，避免影响其他客户端或正文样式。
- 上游可能在响应末尾才提供签名；缓冲策略优先保证签名可信与多轮稳定，牺牲部分实时显示效果。
- 长 thought 会占用内存；块级和响应级上限均执行 fail-closed 清理，不保留或记录原始思考文本。
- 完整上游 thought 会进入终端滚动缓冲、录屏与导出内容；功能默认关闭，需由管理员显式开启。
- 解析器改动覆盖流式核心路径；必须使用离线分帧 fixture 与既有签名、交错工具调用、compact 回归测试验证。