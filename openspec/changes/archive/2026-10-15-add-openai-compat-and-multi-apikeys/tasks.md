# 任务清单：add-openai-compat-and-multi-apikeys

## 状态：ARCHIVED

> 修订版 v3：多 API Key 功能已由 commit `6afcb7a` 落地，本清单收窄为 OpenAI
> chat completions 兼容层；原功能 2 各项已存在实现，仅在收尾回归中覆盖。

## 任务

### OpenAI 兼容层
- [x] 创建 `src/openai/converter.js`：OpenAI chat 请求（messages/tools/tool_choice/system/图像 data URL）→ 内部 Anthropic 表示；响应（非流式 JSON 与 SSE chunk）反向映射；tool_calls 按 index 聚合；不支持的参数（n>1、logprobs）返回 400。验证：`tests/test-openai-converter.cjs` 独立单元测试通过。
- [x] 创建 `src/openai/routes.js`：`POST /v1/chat/completions`（stream 参数分流至 `sendMessageStream`/`sendMessage`，SSE 输出 `chat.completion.chunk` 序列 + `[DONE]`），挂载至 `src/server.js`；usage 记录沿用 `keyId: req._apiKeyId` 通路。验证：对 :8080 活动服务器非流式 curl 返回合法 OpenAI JSON。
- [x] 鉴权中间件 error envelope 切换：`src/server/middleware.js` 的 `apiKeyAuth` 按 `req.path === '/v1/chat/completions'` 将 401/429 错误体改为 OpenAI error 格式（`error.type/message/code`），其他路径输出逐字节不变。验证：新增中间件级单测断言两种路径的 401/429 格式；现有 `/v1/messages` 回归不破。
- [x] 错误映射：上游 4xx/5xx 映射为 OpenAI error 格式，429 保持 429；流式中途错误输出 error chunk 后终止。验证：伪造上游错误（dev-mode 或断网路径）观察响应格式。
- [x] `package.json` 增加 `test:openai` 脚本 + `tests/run-all.cjs` 注册 `test-openai-endpoint`。验证：`npm run test:openai` 可独立执行。（复验待 T6 测试文件落地）
- [x] 集成测试 `tests/test-openai-endpoint.cjs` 五场景：非流式对话、流式 chunk 序列（role→content→finish_reason→[DONE]）、并行 tool_calls 聚合、错误格式、命名 Key 配额 429（OpenAI error 格式 + usage 记录 `keyId` 落库断言）。验证：`npm run test:openai` 全部通过。

### 收尾
- [x] 更新 `README.md` 与 `CLAUDE.md`：新端点、OpenAI 客户端接入示例、新测试脚本。验证：文档与实际行为一致。
- [x] 全量回归：`npm test`（:8080 活动服务器）全部套件通过，覆盖既有命名 Key / 配额 / usage-log 路径。验证：run-all 输出 0 fail。

## 验收标准
- [x] OpenAI 协议客户端（curl 模拟）可通过 `/v1/chat/completions` 完成流式与非流式对话，工具调用往返成功。
- [x] 流式响应 chunk 序列合法（以 `data: [DONE]` 结束）。
- [x] 错误场景返回 OpenAI error 格式，429 保持 429；命名 Key 配额超限场景在集成测试中有显式断言（格式 + keyId 落库）。
- [x] 既有 `/v1/messages`、`/v1/models`、命名 Key 配额行为零变化（全量回归 0 fail）。
