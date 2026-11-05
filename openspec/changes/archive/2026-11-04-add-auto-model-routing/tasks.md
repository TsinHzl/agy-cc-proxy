# 任务清单：add-auto-model-routing

## 状态：ARCHIVED

## 任务

- [x] T1 配置默认值与常量：`src/config.js` 的 `DEFAULT_CONFIG` 增 `autoModel: { enabled: false, models: [] }`；`src/constants.js` 增 `AUTO_MODEL_NAME = 'auto'`、`AUTO_MODEL_MAX_CHAIN = 10`。验证：源码断言 `npm run test:auto -- --unit-only` 中检查 `src/config.js` 文本含 `autoModel` 默认值（不读取本机真实配置）。

- [x] T1b 限流原因持久化：`src/account-manager/rate-limits.js` 的 `markRateLimited()` 增可选第 5 参数 `reason`，写入 `modelRateLimits[modelId] = { isRateLimited, resetTime, actualResetMs, reason: nextReason }`；`src/account-manager/storage.js` 的 `saveAccounts()` 序列化该字段；`src/account-manager/index.js` 的 `markRateLimited(email, resetMs, modelId, reason)` 透传。**仅在 T4/T5 的额度分类分支传入 `reason`，其余既有调用点不传。** 验证：单元断言——带 reason 调用后状态含该值；省略 reason（`undefined`）保留旧分类、显式 `null` 清除；`clearExpiredLimits()` / `resetAllRateLimits()` 后 `reason === null`；既有调用点（`npm run test:strategies`）无回归。

- [x] T2 `src/cloudcode/auto-model.js` 纯函数：`isAutoModel`、`normalizeAutoChain`（`MODEL_MAP` + 用户 `modelMapping` 双重解析、剔除 `auto`、稳定排序、去重、截断、`enabled=false` 静默、空链 warn 仅限 `enabled=true`）、`validateAutoModelConfig`（严格，含 `enabled=false` 允许非空链）、`shouldSignalQuotaExhaustion`。验证：`npm run test:auto -- --unit-only` 纯函数用例全绿。

- [x] T3 `src/errors.js`：新增 `QuotaExhaustedError` 与 `isQuotaExhaustedError`（仅 `instanceof` + `error?.name === 'QuotaExhaustedError'`，与既有 `isEmptyResponseError` 同构，**无文本前缀匹配**），同时加入 `default export`。验证：单元断言 `new QuotaExhaustedError('x')` 为 true；`new Error('RESOURCE_EXHAUSTED: Rate limited on m. Quota will reset after 30s.')`、`new Error('QUOTA_EXHAUSTED: x')`、`new Error('429 RESOURCE_EXHAUSTED during retry: x')`、`new Error('Max retries exceeded')`、`new Error('CAPACITY_EXHAUSTED: x')` 均为 false。

- [x] T3b 错误文案正则兼容：两处 `QuotaExhaustedError` 文案统一为既有形状 `RESOURCE_EXHAUSTED: Rate limited on ${model}. Quota will reset after ${formatDuration(minWaitMs)}.`（终局处可省略 `Next available`）。验证：单元断言 `parseError(new QuotaExhaustedError('RESOURCE_EXHAUSTED: Rate limited on gemini-pro-agent. Quota will reset after 30s. Next available: 2026-01-01T00:00:00.000Z'))` 的 `errorMessage` 含 `gemini-pro-agent` 且不含污染词，`retryAfterMs === 30000`；`parseError(new QuotaExhaustedError('RESOURCE_EXHAUSTED: Rate limited on claude-opus-4-6-thinking. Quota will reset after 2m30s.'))` 的 `errorMessage` 含该模型名与 `2m30s`，`retryAfterMs === 150000`。**MUST NOT 修改 `src/server/parse-error.js`。**

- [x] T4 `src/cloudcode/streaming-handler.js` 增 `options.quotaSignal`：初始化时按跨请求来源预填充 `quotaExhaustedEmails`（该模型 `modelRateLimits[model].reason === 'QUOTA_EXHAUSTED'` 的账号，经 `getAvailableAccounts(null, allowedEmails)` 取全量后自行过滤）；两处记录点（长期额度抛点、空响应重试 429）经 `parseRateLimitReason(errorText, response.status) === 'QUOTA_EXHAUSTED' && !isModelCapacityExhausted(errorText)` 分类后 `add(email)`；调用 `markRateLimited` 时传入已算出的 reason；全账号限流分支在 `shouldSignalQuotaExhaustion` 为真时于 `minWaitMs > MAX_WAIT_BEFORE_ERROR_MS` 判定**之前**抛 `QuotaExhaustedError`（跳过 sleep）；终局前用 `getAvailableAccounts(model, allowedEmails).length` 判定并抛 `QuotaExhaustedError`。默认关闭。验证：源码断言两处记录点均含分类条件、容量分支不含 `countActiveQuotaExhausted(`、限流判定位于 `MAX_WAIT_BEFORE_ERROR_MS` 之前；`npm run test:streaming` 无回归。（CR 第 1 轮：每请求 `quotaExhaustedEmails` 集合改为 `countActiveQuotaExhausted()` 实时读取账号池，同时校验 `isRateLimited`、`reason === 'QUOTA_EXHAUSTED'`、`resetTime > now`。）

- [x] T5 `src/cloudcode/message-handler.js` 同 T4，但**仅一处记录点**（该文件无空响应重试分支，事实见 design.md D1）。`options` 为第 5 参数。验证：源码断言该文件恰好一处记录点且含分类条件、限流判定位于 `MAX_WAIT_BEFORE_ERROR_MS` 之前；`npm run test:multiturn` 无回归。（同 T4：CR 第 1 轮改为实时计数，无每请求集合。）

- [x] T6 `src/cloudcode/auto-model-handler.js`：`sendMessageAuto` / `sendMessageStreamAuto`，`deps` 注入、`onModelResolved`（流式在首事件后、非流式在成功后）、`isCancelled`、`first.done` 视为失败、整链耗尽抛 `QuotaExhaustedError`、**不做 resetAllRateLimits**。验证：注入段用例——切换成功、503/400 不切、空生成器继续、整链耗尽、取消中止、未配置抛 `invalid_request_error`。

- [x] T7 `src/cloudcode/index.js` 导出 `sendMessageAuto`、`sendMessageStreamAuto`、`isAutoModel`、`normalizeAutoChain`、`QuotaExhaustedError`。验证：`node -e` 断言五个导出的 `typeof`。

- [x] T8 `/v1/messages` 接入：`src/server/routes-messages.js` 在 `MODEL_MAP` 与 `modelMapping` 之后判定 `auto`；跳过模型校验；`selectAccount()` 取归属邮箱；`onModelResolved` 写 usage-log；流式传 `isCancelled`。验证：集成段请求 `model: "auto"` 返回 200，usage-log 最近记录 `model` 为实际执行模型。

- [x] T9 `/v1/chat/completions` 接入：`src/server/routes-openai.js` 同 T8。验证：集成段返回 200 且响应 `model === "auto"`。

- [x] T10 `/v1/models` 条件化：`src/cloudcode/model-api.js` 的 `listModels()` 在 `enabled === true` 且链非空时前置追加 auto 条目（形状与其他条目一致，`owned_by: 'antigravity-proxy'`），不写入 `modelCache.validModels`；auto 条目构造置于 `if (!data || !data.models) return { data: [] }` **之前**，使上游列表为空时 auto 仍出现。验证：集成段断言未启用时不出现、启用后首条为 auto；单测断言上游返回空时仍含 auto。

- [x] T11 `POST /api/config` 与 server presets：`src/webui/routes/config.js` 对 `req.body.autoModel` 单独严格校验（非法返回 400 + 具体原因）；`src/webui/routes/server-presets.js` 的 POST/PATCH 均剔除 `autoModel`；`validate-config.js` **不**增加该字段分支（保持 server presets 的既有静默语义）。验证：`node -e` 断言非法 `autoModel` 的 HTTP 路径返回 400；预设 JSON 不含 `autoModel`。

- [x] T12 WebUI API：`src/webui/routes/models.js` 新增 `GET/POST /api/models/auto`。验证：POST 合法返回 `{"status":"ok"}` 且 GET 回读一致；POST 非法返回 400 且配置文件不变。

- [x] T13 前端面板与五语言文案：`public/views/models.html`、`public/js/components/models.js`、`public/js/translations/{en,zh,pt,id,tr}.js`。验证：`npm run build:css` 成功；五个 locale 均含新键（源码断言）；浏览器往返验证**未执行**（无浏览器环境），由 T14 的 `POST/GET /api/models/auto` 集成用例覆盖同等读写路径。

- [x] T14 测试与脚本：新增 `tests/test-auto-model.cjs`（`--unit-only` 纯函数段含 T1b/T3b 断言 + 注入段；默认含**自起子进程 server**（临时 `HOME` + 默认向系统申请空闲端口，`AUTO_TEST_PORT` 仅作显式覆盖）的集成段，其中含 **Claude→Gemini 跨厂商切换用例**——含 thinking 的两轮对话，上游额度不可用时以 `console.warn` 标记 `SKIP` 并计入 skipped，不伪造通过）；`package.json` 增 `"test:auto"`；**不**加入 `tests/run-all.cjs`；`docs/testing.md` 说明独立运行原因与该用例的可选性。验证：`npm run test:auto -- --unit-only` 无服务通过（33 passed / 0 failed / 0 skipped）；`npm run test:auto` 独立通过（39 passed / 0 failed / 3 skipped，跳过项为需要真实上游额度的 LIVE 用例）且不占用 `:8080`。

- [x] T15 文档：`docs/configuration.md`、`docs/api-endpoints.md`、`docs/models.md`、`docs/testing.md`、`config.example.json`、`README.md` 入口链接。验证：`config.example.json` JSON 解析通过；六个文件均含 `autoModel` / `auto` 相关说明。

## 验收标准

**纯函数（无服务）**
- [x] `npm run test:auto -- --unit-only` 全绿（33 passed / 0 failed / 0 skipped）。
- [x] `npm run test:strategies`、`npm run test:openai-converter`、`npm run test:sanitizer` 无回归（89 / 26 / 18 passed，均 0 failed）。
- [x] 优先级乱序 `[3,1,2]` → 1→2→3；同 priority 保持数组序。
- [x] 去重保留最小 priority；链内 `auto` 剔除；非法条目过滤；超 10 条截断；`MODEL_MAP` 与 `modelMapping` 别名均生效。
- [x] `enabled=false` 时规范化结果为空且**不**输出 warn；`enabled=true` 且空链输出一次 warn。
- [x] `validateAutoModelConfig` 拒绝：非布尔 enabled、`enabled=true` 空链、空模型名、非正整数 priority、别名解析后重复、链含 auto、超 10 条；接受 `enabled=false` + 空数组 + 非空链。
- [x] `isQuotaExhaustedError` 仅对 `QuotaExhaustedError` 实例与同名 `error` 为真；`RESOURCE_EXHAUSTED:` / `QUOTA_EXHAUSTED:` 文本错误、`Max retries exceeded`、`CAPACITY_EXHAUSTED:` 均为 false。
- [x] `parseError` 对两处新文案提取出干净模型名与正确 `Retry-After`，且 `src/server/parse-error.js` 未被修改（`git diff HEAD -- src/server/parse-error.js` 为空）。
- [x] `shouldSignalQuotaExhaustion` 真值表：`quotaSignal=false` → false；`quotaExhaustedCount=0` → false；`availableCount>0` → false；三者满足 → true。

**handler 改动（源码断言 + 既有回归）**
- [x] `streaming-handler.js` 两处记录点、`message-handler.js` 一处记录点，均含 `parseRateLimitReason(...) === 'QUOTA_EXHAUSTED'` 与 `!isModelCapacityExhausted(...)`。
- [x] 容量退避分支（429 capacity、503/529）不含额度计数调用（源码 0 处 `quotaExhaustedEmails` 残留，容量调用窗口内无 `countActiveQuotaExhausted(`）。
- [x] 全账号限流分支的额度判定位于 `MAX_WAIT_BEFORE_ERROR_MS` 判定**之前**，且 `quotaSignal` 为真时于 `sleep(` 之前抛出。
- [x] 两文件均在 `quotaSignal` 为真时经 `countActiveQuotaExhausted()` 实时读取 `modelRateLimits[model].reason === 'QUOTA_EXHAUSTED'` 的账号，无每请求集合（源码 0 处 `quotaExhaustedEmails`）。
- [x] `markRateLimited` 仅在额度分类分支传入 `reason`：源码断言「带 reason 的调用点数」与记录点数一致（streaming 2 / message 1），其余调用点无第 5 参数；`npm run test:strategies` 无回归。
- [ ] `npm run test:streaming`、`npm run test:multiturn` 无回归。**未执行：需 :8080 实服务与真实上游账号。**

**包装层（注入 deps）**
- [x] 链首额度耗尽 → 第二模型完成，`onModelResolved` 收到第二模型名。
- [x] 链首 503 → 不切换；链首 400 → 不切换。
- [x] 流式 `first.done === true` → 尝试下一模型，客户端不收空 200。
- [x] 整链耗尽 → 抛 `QuotaExhaustedError`，消息包含最后模型名。
- [x] `enabled=false` / 空链 → 抛含 `invalid_request_error` 与配置指引的消息。
- [x] `isCancelled()` 为 true 时中止，不再请求下一模型。
- [x] 包装层源码不含 `resetAllRateLimits`。

**集成（自起子服务）**
- [ ] `/v1/messages` `model: "auto"` 返回 200；usage-log `model` 为实际执行模型。**未执行：LIVE 用例需 `AUTO_TEST_LIVE=1` 与真实上游额度。**
- [ ] `/v1/chat/completions` `model: "auto"` 返回 200 且响应 `model === "auto"`。**未执行：同上。**
- [x] `/v1/models`：未启用无 `auto`；启用后首条为 `auto`；上游模型列表为空时仍含 `auto`（undici `MockAgent` 拦截上游）。
- [ ] 非 auto 请求与变更前一致；`--fallback` 行为不变。**未执行：需 :8080 实服务；`src/fallback-config.js` 与 `routes-messages.js` 的非 auto 分支零改动可佐证。**
- [ ] **跨厂商切换**：auto 链 `[claude, gemini]`，含 thinking 的两轮对话，首模型额度耗尽后由 Gemini 完成且无签名错误（上游额度不可用时标记 SKIP，不伪造通过）。**未执行：LIVE 用例需真实额度耗尽。**
- [x] 链全部耗尽时 429 错误消息含真实模型名与 reset 时长，`Retry-After` 非固定默认值（`parseError` 单测覆盖两处文案；包装层用例覆盖整链耗尽抛 `QuotaExhaustedError`）。
- [x] `POST /api/models/auto` 合法落盘即时生效；非法 400 且配置不变。
- [x] `POST /api/config` 非法 `autoModel` 返回 400（整体拒绝，无部分写入）。
- [x] server preset 保存/更新后 `autoModel` 不变。
- [ ] WebUI 页面配置往返。**未执行：无浏览器环境；`GET/POST /api/models/auto` 集成用例覆盖同等读写路径。**
- [x] `npm run test:auto` 使用独立端口，不与 `:8080` 冲突（本次运行占用 55487）。