# 技术方案：collapsible-thinking-block

## 上下文

- agy-cc-proxy `src/cloudcode/thinking-text-streamer.js` 的 `transformThinkingAsTextEvents` 负责
  将思考块改写为 dim 文本预览（`thinkingAsText=true && isClaudeCode`）。
- 参照仓库 `cc-proxy/src/thinking-text.js` 已在 stop 时用**同一 index** 覆写原生可折叠
  thinking 块（`content_block_start(thinking, '', '')` → `thinking_delta(全文)` → 可选
  `signature_delta` → 透传 stop）。Claude Code 收到后原地替换流式状态机槽位，默认折叠。
- 关键差异：cc-proxy 用请求级 `startedAtMs` 锚点 + 可注入 `timeSource` 计算「Thought for Xs」，
  agy-cc-proxy 当前用块内 `Date.now()` 墙钟，网关缓冲场景时长失真。

## 目标 / 非目标

**目标：** 完全照搬 cc-proxy 的 stop 覆写方案 + 请求级时长锚点，使 Claude Code 获得可折叠
思考块。
**非目标：** 不改非流式路径、不改 `thinkingAsText=false` 透传、不改历史剥离正则、不引入新依赖。

## 决策

### D1：stop 时同 index 覆写原生 thinking 块
在 `transformThinkingAsTextEvents` 的 `isMatchingStop` 分支，文本+时长行输出后追加：

```
yield { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } };
yield { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: pendingBlock.thinking } };
if (pendingBlock.signature) yield { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: pendingBlock.signature } };
yield event; // 透传原 content_block_stop
```

- 复用已缓冲的 `pendingBlock.thinking`（完整正文）与 `pendingBlock.signature`，零额外内存。
- `signature` 仅在 `len >= MIN_SIGNATURE_LENGTH` 时输出（沿用现有门控）。
- whitespace-only 块沿用现有守卫（不落 stop），避免孤儿事件。

### D2：请求级 `startedAtMs` 时长锚点 + `timeSource`
- `formatDurationLine(seconds)` 抽为导出函数（对齐 cc-proxy 同一函数）。
- stop 分支时长 = `(now() - anchorMs) / 1000`；`anchorMs` 优先 `options.startedAtMs`，否则首个
  带 type 的流内事件时刻。
- **锚点注入固定在路由层**：`routes-messages.js` 与 `routes-openai.js` 在流式发送前复用已有
  `streamStartTime = Date.now()` 作为 `options.startedAtMs`（与 usage 锚点同一时刻）；streamer
  内部仅以首个 SSE 事件时刻作为**无锚点兜底**（正常路径因路由始终注入而不触发）。
- **`options.timeSource` 契约**：返回当前绝对时间戳（epoch ms）的 getter，默认 `Date.now`；
  `durationSec = ((options.timeSource?.() ?? Date.now()) - startedAtMs) / 1000`（注意括号：
  `??` 优先级低于 `-`，须整体取当前时刻再减锚点）。测试注入可控 getter 序列固定
  「Thought for Xs」断言。
- 时长行保留在**流式文本预览**阶段（claude 折叠标题由 CC 端渲染，代理不发自定义时长行给原生
  折叠块）。
- 覆写块仅在 `!pendingBlock.discarded && pendingBlock.thinking` 时输出（复用现有 stop 守卫）：
  丢弃或空白块不覆写，避免空 thinking + 签名触发 CC 校验失败。
- 多思考块时长累积 + wire 全文二次传输，属接受的输出语义，见 proposal 影响/风险节。

## 风险 / 权衡

| 风险 | 对策 |
|---|---|
| 覆写 index 未对齐 → CC 解析中断（无回复） | 同 index 覆写 + whitespace 不落 stop；回归 `test:thinking-as-text` 的 e2e 断言「startedIndexes 覆盖 delta/stop」 |
| 签名丢失 → multi-turn 修复失效 | 有效签名才输出 signature_delta，沿用 `MIN_SIGNATURE_LENGTH` |
| 现有 `test:thinking-as-text.cjs` 断言输出为纯文本块 + 时长行，覆写后多出 thinking 块 → 需更新该测试 | 同步更新测试文件断言覆写序列 |

## 待决问题

无 —— 方案已与用户确认（完整照搬 cc-proxy + 原生折叠标题）。