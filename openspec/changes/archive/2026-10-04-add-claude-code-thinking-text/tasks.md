# 任务清单：add-claude-code-thinking-text

## 状态：ARCHIVED

## 任务
- [x] 为 `src/cloudcode/sse-streamer.js` 与 `src/cloudcode/sse-parser.js` 提取共享完整 SSE 事件聚合语义：空行提交、多 `data:` 拼接、UTF-8 跨 chunk、流尾 flush，并忽略注释/`event:`/`id:`；新增 `tests/test-sse-thinking.cjs` fixture 验证有效事件与畸形 JSON 隔离。
- [x] 在流式与非流式 thought 转换中完成同 block 的 text/signature 配对：仅接受关闭前、同响应且长度达到 `MIN_SIGNATURE_LENGTH` 的真实签名；非流式仅恢复既有 `content[].thinking/signature`，不做 ANSI 或 text 改写；在 `tests/test-sse-thinking.cjs` 验证重复、乱序、签名-only、跨 block 与流尾缺失签名的 fail-closed 行为。
- [x] 在 `src/config.js`、`src/webui/routes/config.js` 与 `config.example.json` 增加默认 `false` 的 `thinkingAsText`；在 `tests/test-thinking-as-text.cjs` 验证仅 JSON 布尔值更新和持久化，非法类型返回 `400 invalid_request_error` 且配置不变。
- [x] 在 `public/views/settings.html`、`public/js/components/server-config.js` 与 `public/js/translations/{en,zh,pt,id,tr}.js` 增加 Server 设置开关；验证乐观更新成功刷新、失败回滚、五语言键完整及 `npm run build:css` 成功。
- [x] 在 `src/server/routes-messages.js` 以 `/^(?:claude-cli|claude-code)(?:\/|\s|$)/i` 识别入站 User-Agent，并经 `src/cloudcode/streaming-handler.js` 向本次流传递开关状态；在 `tests/test-thinking-as-text.cjs` 验证缺失 Header、普通 SDK、包含性伪匹配、`claude-cli/2.x` 和 `claude-code 2.x` 的隔离。
- [x] 新增 `src/cloudcode/thinking-text-streamer.js`，并在 `streamSSEResponse()` 生成原生 Anthropic 事件、完成签名缓存后且 Express 写 SSE 前包裹该 event stream：仅在 `thinkingAsText`、流式响应与 Claude Code 客户端三重条件成立时，缓冲每个 thought 至真实有效签名到达，再以相同 index 输出 `content_block_start(text)`、带精确 ANSI dim/reset 与机器标记的逐行 `text_delta`、`content_block_stop`；在 `tests/test-thinking-as-text.cjs` 验证相邻 text/tool_use/image 顺序不变、原 signature 不下发、空 thought 不输出。
- [x] 为文本化缓冲实现每块 256 KiB、每响应 1 MiB 上限；在 `tests/test-thinking-as-text.cjs` 验证超限块被清空且不输出、后续非 thinking 事件继续、诊断不包含 thought 原文、内存状态在 block stop、流尾和错误路径释放。
- [x] 在 `src/format/request-converter.js` 前置调用历史清理函数；在 `tests/test-thinking-as-text.cjs` 验证仅剥离 assistant 内容中完整 ANSI + 机器标记渲染片段，独立块被移除、合并块保留后续正式回答、普通引用、用户文本和原生 thinking 均不变。
- [x] 完成回归验证：`node tests/test-sse-thinking.cjs`（9 passed）、`node tests/test-thinking-as-text.cjs`（通过）、`npm run test:compact`（21 passed）与 `npm run test:request-builder`（7 passed）通过；`npm run test:signatures`、`npm run test:streaming` 因本地 `:8080` 未启动而 `ECONNREFUSED`，未执行真实凭据链路。

## 验收标准
- [x] 启用 `thinkingAsText` 后，只有 `claude-cli` 或 `claude-code` 的流式请求会将有效签名的上游 thought 输出为原 index 的 text 块；事件顺序为 `content_block_start(text) → text_delta+ → content_block_stop`，不出现 `thinking_delta` 或 `signature_delta`。
- [x] 无签名 thought、空 thought、重复或乱序签名、跨 block 签名、流尾仍缺签名及仅收到签名的块，均不输出 text、签名或 ANSI；正文、工具调用、图片、错误事件与终止语义仍可继续传递。
- [x] 渲染文本精确使用 `\x1b[2m> 💭 Thinking⁣agy-thinking-text-v1⁣` 前缀，将 CRLF 规范为 LF、每个空行输出 `> `、每个非空行使用 `> ` 引用，并以 `\x1b[0m` 结尾；历史清理仅移除该机器封装，保留所有非封装内容。
- [x] 开关关闭、非目标 User-Agent 和非流式响应保持原生协议，且不得出现 ANSI 控制符或机器标记；非流式完整配对仅影响既有 `content[].thinking/signature` 的保留，不增加 text 或新字段。
- [x] 多 `data:` 行、UTF-8 分块、无末尾换行和签名与 thought 分离时，`tests/test-sse-thinking.cjs` 仍产生完整可验证的 Anthropic thinking 结果。
- [x] `tests/test-thinking-as-text.cjs` 覆盖 SSE 文本化、签名乱序/流尾、缓冲超限、User-Agent 隔离和历史清理边界；所有新增离线测试与受影响的 `npm run test:*` 脚本通过，真实服务依赖测试仅在可用凭据与 `:8080` 服务存在时执行。
