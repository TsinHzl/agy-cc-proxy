# 任务清单：collapsible-thinking-block

## 状态：ARCHIVED

## 任务
- [x] T1 改造 `src/cloudcode/thinking-text-streamer.js`：抽 `formatDurationLine` 导出、支持
      `options.timeSource` / `options.startedAtMs` 锚点、stop 分支追加同 index 原生 thinking
      块覆写（thinking + signature_delta + 透传 stop）。
      验证：`node tests/test-thinking-as-text.cjs` 中新增覆写序列断言通过。
- [x] T2 转发请求级锚点：`src/server/routes-messages.js` 与 `src/server/routes-openai.js` 在
      options / pipelineOptions 中复用已有 `streamStartTime` 注入 `startedAtMs`（流式发送前）。
      验证：`node tests/test-thinking-as-text.cjs` 的 messagesRouteSource 断言覆盖 `startedAtMs`。
- [x] T3 同步更新 `tests/test-thinking-as-text.cjs`：新增/调整断言验证 stop 时输出的 thinking
      覆写块序列、时长锚点（注入 timeSource 场景）、非 CC 透传不变。
      验证：`node tests/test-thinking-as-text.cjs` 全部通过。

## 验收标准
- [ ] 对 Claude Code 请求，思考块在 stop 时输出「补充 thinking 块覆写」，可被 CC 折叠展开；
      非 CC 客户端 `user-agent` 透传不变。
- [ ] 思考时长用请求级 `startedAtMs` 锚点计算，网关缓冲场景下「Thought for Xs」准确；该时长语义
      已声明为「请求到达 → stop 的总耗时」（非块内墙钟）。
- [ ] `thinkingAsText=false` 与 `isClaudeCode=false` 路径无行为变化，现有透传测试全绿。
- [ ] OpenSpec sub-agent 独立 Code Review（Completeness + Correctness + Coherence）通过。