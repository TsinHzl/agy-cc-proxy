# 变更提案：add-auto-model-routing

## 背景

当前模型降级由 `--fallback` 提供，存在三个结构性限制：

1. **降级关系硬编码**：`src/constants.js` 的 `MODEL_FALLBACK_MAP` 写死 7 条映射。
2. **只降级一次**：`getFallbackModel()` 返回单个模型，handler 递归时强制 `fallbackEnabled=false`，链长恒为 1 跳。
3. **无法表达显式优先级**：用户想要的「优先 Opus，额度不够用 Gemini」无法配置。

### 关键发现（决定方案形态）

经代码核实：

1. `streaming-handler.js:288` / `message-handler.js:262` 抛出的 `QUOTA_EXHAUSTED: ...` 会被同文件 `catch (endpointError)` 经 `isRateLimitError()` 重新抛出，随即被账号级 `catch` 捕获并 `continue` 轮换账号——**错误不会逃到调用方**。
2. 账号轮换耗尽后统一抛 `Max retries exceeded`（:565 / :464），已丢失额度语义。
3. 唯一逃逸的额度错误在 `:105 / :100`（`RESOURCE_EXHAUSTED: Rate limited on <model>`），前提是全账号限流且 `minWaitMs > MAX_WAIT_BEFORE_ERROR_MS`（默认 120s）。该判定之前的短等待路径（`sleep(minWaitMs + 500)` + `attempt--`）会无限重试，永不进入终局；且这两条路径都**不区分限流原因**。
4. **该 `QUOTA_EXHAUSTED:` 抛点并非额度专属**：进入条件是 `smartBackoffMs > DEFAULT_COOLDOWN_MS(10000)`。`parseRateLimitReason()` 对 `RATE_LIMIT_EXCEEDED` 返回 30s、对 `MODEL_CAPACITY_EXHAUSTED` 返回 15s+jitter，**两者同样落到这条分支并抛出 `QUOTA_EXHAUSTED:`**。故单纯按错误前缀判定会把普通限流与容量不足误判为额度耗尽。
5. `isAllRateLimited()` / `getAvailableAccounts()` 的判定依赖 `Date.now()`；`clearExpiredLimits()` 在每次循环顶部执行。
6. 账号级限流状态 `modelRateLimits[model]` 只保存 `isRateLimited` / `resetTime` / `actualResetMs`（`rate-limits.js:130-134`），**不保存限流原因**。因此「账号池在先前请求中已耗尽额度、本次请求无新 429」这一真实场景，在现有状态上与「容量退避」无法区分；若只依据「本请求内捕获到的 429」，auto 请求在该场景下会等待或报错而非切换模型。

结论：必须在 handler 输出**显式且经过原因分类的**额度信号，并需要一个可在无网络条件下验证的纯判定函数。

## 目标范围

**在范围内：**
- 新增内置别名 `auto`。
- 新增配置项 `autoModel: { enabled, models: [{ model, priority }] }`，按 `priority` 升序。
- `modelRateLimits` 增 `reason` 字段（`QUOTA_EXHAUSTED` / `MODEL_CAPACITY_EXHAUSTED` / `RATE_LIMIT_EXCEEDED` / `SERVER_ERROR` / `UNKNOWN`），由 `markRateLimited()` 写入，使「账号池在先前请求已耗尽」可在后续请求中被识别。
- handler 新增 `quotaSignal`（默认关闭）：仅在「`parseRateLimitReason === 'QUOTA_EXHAUSTED'` 且非容量错误」的账号终局被记录；额度判定同时接受两类来源——本请求内新记录的额度耗尽账号，以及该模型下已存额度耗尽限流状态的账号。请求终局时该模型无可用账号才抛 `QuotaExhaustedError`。
- `quotaSignal` 开启时，全账号限流分支**跳过等待**直接抛额度错误（避免每模型最多 120s 阻塞），且该分支置于 `minWaitMs > MAX_WAIT_BEFORE_ERROR_MS` 的既有抛点**之前**，使长短两种等待窗口都走显式类型。
- 判定逻辑抽为纯函数 `shouldSignalQuotaExhaustion()`，可无网络单测。
- `/v1/messages`、`/v1/chat/completions`、`/v1/models`（仅启用且链非空时列出）三处支持。
- WebUI 模型页面板；`GET/POST /api/models/auto`。
- `POST /api/config` 对 `autoModel` 非法输入返回 400；server presets 显式剔除该字段。
- 五语言翻译（en/zh/pt/id/tr）。
- 新增 `tests/test-auto-model.cjs`（自含：纯函数段 + 注入段 + 自起子服务集成段，集成段含 Claude→Gemini 切换实测）。

**不在范围内：**
- 不改动账号选择策略与 quota tracker 评分。
- 不做基于 `account.quota` 快照的预检式切换。
- 不改动非 auto 请求的既有 `--fallback` 行为；`quotaSignal` 默认 `false`。
- 不新增运行时依赖，不改动 `MODEL_FALLBACK_MAP`。
- 不做跨请求链状态记忆。
- 不做运行中请求中断（仅切换前检查一次 `isCancelled`）。

## 技术方案

### 1. 配置模型

```json
{
  "autoModel": {
    "enabled": true,
    "models": [
      { "model": "claude-opus-4-6-thinking", "priority": 1 },
      { "model": "gemini-pro-agent", "priority": 2 }
    ]
  }
}
```

`DEFAULT_CONFIG` 增加 `autoModel: { enabled: false, models: [] }`，`deepMerge` 自动补齐，老配置无需迁移。

### 2. `src/cloudcode/auto-model.js`（纯函数）

- `isAutoModel(name)`：`String(name).trim().toLowerCase() === 'auto'`。
- `normalizeAutoChain(autoModelConfig)`：运行时宽容。
  - `enabled !== true` → `[]`，**不输出 warn**。
  - 逐条过滤：`model` 非空字符串、`priority` 有限数字（向下取整）。
  - 依次应用 `MODEL_MAP` 与用户 `config.modelMapping[name].mapping`（与路由层顺序一致）。
  - 解析结果为 `auto` 的条目剔除（防自引用）。
  - 按 `priority` 升序稳定排序；按解析后名去重（保留优先级最高者）；截断到 `AUTO_MODEL_MAX_CHAIN`（10）。
  - 条目级过滤 `logger.debug`；仅当 `enabled === true` 且规范化后为空时输出一次 `logger.warn`。
- `validateAutoModelConfig(input)`：写入时严格，返回 `{ ok, error, value }`。
  - `enabled` 必须布尔；`models` 必须数组且 ≤ 10。
  - `enabled === true` 要求 ≥ 1 条；`enabled === false` 允许空数组，也允许非空（支持「先配链、后启用」）。
  - 每条：`model` 非空、非 `auto`；`priority` 正整数 ≥ 1；解析后不重复。
- `shouldSignalQuotaExhaustion({ quotaSignal, quotaExhaustedCount, availableCount })`：返回 `quotaSignal === true && quotaExhaustedCount > 0 && availableCount === 0`。

### 3. `src/errors.js`

```js
export class QuotaExhaustedError extends AntigravityError {
    constructor(message) { super(message, 'QUOTA_EXHAUSTED', true); this.name = 'QuotaExhaustedError'; }
}

export function isQuotaExhaustedError(error) {
    return error instanceof QuotaExhaustedError || error?.name === 'QuotaExhaustedError';
}
```

与仓库既有 `isEmptyResponseError()` 完全同构（`instanceof` + `name` 兜底），**不做任何错误文本前缀匹配**。理由：handler 既有的长等待抛点是 `RESOURCE_EXHAUSTED: Rate limited on <model>. ...`，其进入条件是 `minWaitMs > MAX_WAIT_BEFORE_ERROR_MS`，可由 `RATE_LIMIT_EXCEEDED`（30s 基础 × 指数退避）或 `MODEL_CAPACITY_EXHAUSTED`（15s + jitter）在连续失败后触发——按前缀判定会把这两类误判为额度耗尽并错误切换模型。额度信号只能来自 handler 内经原因分类后的显式抛出。

新类与守卫同时加入 `default export`。

### 4. handler 增加 `quotaSignal`（两个文件同构，记录点数不同）

```js
const quotaSignal = options?.quotaSignal === true;
const quotaExhaustedEmails = new Set();

// 记录点（必须带原因分类；streaming-handler 两处、message-handler 一处）：
if (parseRateLimitReason(errorText, response.status) === 'QUOTA_EXHAUSTED' && !isModelCapacityExhausted(errorText)) {
    quotaExhaustedEmails.add(account.email);
}
```

记录点位置：
- `streaming-handler.js`：(a) 长期额度耗尽抛点（`QUOTA_EXHAUSTED` throw 之前）；(b) 空响应重试分支的 429（`429 RESOURCE_EXHAUSTED during retry` 之前）。该文件有 `MAX_EMPTY_RESPONSE_RETRIES` 与 `isEmptyResponseError` 路径。
- `message-handler.js`：**仅 (a)**。该文件不存在空响应重试分支（无 `MAX_EMPTY_RESPONSE_RETRIES`、无 `429 RESOURCE_EXHAUSTED during retry`），行为为 SSE 一次性解析。验收断言按各文件实际记录点数执行，不要求两文件同数量。

```js
// 全账号限流分支：置于 `if (minWaitMs > MAX_WAIT_BEFORE_ERROR_MS)` 之前，长短窗口统一
if (shouldSignalQuotaExhaustion({
    quotaSignal,
    quotaExhaustedCount: quotaExhaustedEmails.size,
    availableCount: 0
})) {
    throw new QuotaExhaustedError(
        `RESOURCE_EXHAUSTED: Rate limited on ${model}. Quota will reset after ${formatDuration(minWaitMs)}. Next available: ${resetTime}`
    );
}
```

```js
// 终局（原 'Max retries exceeded' 之前）
if (shouldSignalQuotaExhaustion({
    quotaSignal,
    quotaExhaustedCount: quotaExhaustedEmails.size,
    availableCount: accountManager.getAvailableAccounts(model, allowedEmails).length
})) {
    throw new QuotaExhaustedError(
        `RESOURCE_EXHAUSTED: Rate limited on ${model}. Quota will reset after ${formatDuration(minWaitMs)}.`
    );
}
```

两处文案与既有长等待抛点（`streaming-handler.js:105-107` / `message-handler.js:100-102`）**形状完全一致**：`Rate limited on <model>.` 使 `/Rate limited on ([^.]+)\./` 提取到的模型名紧邻句号、不含污染；`Quota will reset after <dur>` 使 `/quota will reset after ([\dh\dm\ds]+)/i` 命中并给出正确的 `Retry-After`。**`parse-error.js` 无需任何改动**——这是刻意复用既有格式，而非新增格式。

**跨请求来源**：`quotaExhaustedEmails` 在请求内初始化时，先并入该模型下 `modelRateLimits[model].reason === 'QUOTA_EXHAUSTED'` 的账号邮箱（`modelRateLimits.reason` 由 T1b 新增）。这解决关键发现 6 的场景——账号池在先前请求已耗尽额度、本次无新 429 时仍能正确切换。该预填充同样要求 `quotaSignal === true`，非 auto 调用方不受影响。

`parseRateLimitReason` 与 `isModelCapacityExhausted` 均从 `rate-limit-parser.js` / `rate-limit-state.js` 导入（两者已是同层模块，无循环依赖）。

**`reason` 写入范围**：仅在额度分类分支调用 `markRateLimited(..., reason)`——即 `smartBackoffMs > DEFAULT_COOLDOWN_MS` 分支与空响应重试 429 分支两处。其余既有调用点（容量退避、`RATE_LIMIT_EXCEEDED` 短退避、403、5xx cooldown 等）**不传** `reason`，行为与变更前完全一致。这是为了避免给非额度路径写入语义错误的原因值。

容量退避（503/529 与 429 capacity 分支）**不**记录到 `quotaExhaustedEmails`，故纯容量故障终局仍抛 `Max retries exceeded`。

### 5. 包装层 `src/cloudcode/auto-model-handler.js`

```js
export async function sendMessageAuto(request, accountManager, accountFilter, options = {}, deps = {})
export async function* sendMessageStreamAuto(request, accountManager, accountFilter, streamOptions = {}, deps = {})
```

`deps = { sendMessage?, sendMessageStream? }`，默认取真实实现——测试注入缝。

流程（两个函数同构）：

```
chain = normalizeAutoChain(config.autoModel)
if (chain.length === 0) throw new Error('invalid_request_error: Auto model routing is not configured. Configure it in WebUI → Models.')

for (model of chain) {
    if (streamOptions?.isCancelled?.()) return
    try {
        流式：gen = deps.sendMessageStream({...request, model}, manager, false, filter, {...streamOptions, quotaSignal: true})
             first = await gen.next()
             若 first.done → 记为失败，continue（不产生空 200）
             onModelResolved(model) → yield first.value → yield* gen → return
        非流式：res = await deps.sendMessage({...request, model}, manager, false, filter, {...options, quotaSignal: true})
                onModelResolved(model) → return res      // 仅在成功后回调
    } catch (e) {
        if (isQuotaExhaustedError(e)) { lastQuotaError = e; logger.warn(`[Auto] ${model} → next`); continue }
        throw e
    }
}
throw lastQuotaError ?? new Error('Max retries exceeded')
```

**包装层不执行任何 `resetAllRateLimits()`**：handler 循环顶部已有 `clearExpiredLimits()`；真正「全账号仍限流」即应切换模型，而非反复重置全局状态（既有限流单飞 probe 机制也会被全局重置破坏）。

### 6. 路由接入

`routes-messages.js` 与 `routes-openai.js` 统一顺序：`MODEL_MAP` → `modelMapping` → `isAutoModel` 判定 → auto 路径。

- auto 路径跳过 `resolveModel` / `isValidModel`（`auto` 非真实模型）。
- 调用一次 `accountManager.selectAccount()` 取归属邮箱，供 usage-log 的 `apiKey`（与既有校验路径对齐）。
- `onModelResolved` 捕获实际模型，写入 `usageLog.record({ model })`。
- 流式传 `isCancelled: () => res.writableEnded || req.destroyed`。
- 非 auto 路径零改动。

响应 `model`：Anthropic 端点由 handler 用传入模型填充（即实际执行模型）；OpenAI 端点继续回显 `auto`。

### 7. `/v1/models`

仅当 `autoModel.enabled === true` 且规范化链非空，在 `listModels()` 结果前置：

```json
{ "id": "auto", "object": "model", "created": <ts>, "owned_by": "antigravity-proxy", "description": "Auto model routing chain (N models)" }
```

形状与真实条目一致（`id`/`object`/`created`/`owned_by`/`description`）。不写入 `modelCache.validModels`。

### 8. WebUI

- `validate-config.js` 保持既有「静默丢弃非法字段」语义（server presets 复用）。
- `POST /api/config` 单独处理：`req.body.autoModel !== undefined` 时调用 `validateAutoModelConfig`，非法直接 400 并返回具体原因；合法则写入 `updates.autoModel`。
- `routes/models.js` 新增 `GET/POST /api/models/auto`（严格校验，失败 400 且不落盘）。
- `routes/server-presets.js`：`POST` 与 `PATCH` 均剔除 `autoModel`。
- 前端面板：`public/views/models.html` + `public/js/components/models.js`。
- 翻译：`en.js`、`zh.js`、`pt.js`、`id.js`、`tr.js` 全部补齐。
- 每次请求读取 `config.autoModel`，实时生效。

### 9. 文档

`docs/configuration.md`（权威字段说明）、`docs/api-endpoints.md`（`/api/models/auto`、`/v1/models` 的 auto 条目）、`docs/models.md`（auto 路由语义与切换条件）、`config.example.json`（注释化示例）、`README.md`（入口链接）。

## 预期影响

- **兼容性**：默认 `enabled: false`；`quotaSignal` 默认 `false`，非 auto 调用方错误文本与状态码完全不变。
- **延迟**：`quotaSignal` 下跳过等待，单模型最坏路径约为一次完整账号轮换（每账号 `SWITCH_ACCOUNT_DELAY_MS=5s`）。容量故障不切换，故不会累积容量退避时长。
- **统计口径**：`usage-stats` 中间件按请求体 `model` 计数，auto 请求进入独立 `auto` 桶；usage-log 记录实际执行模型。两者口径不同，属有意设计，写入文档。
- **可观测性**：切换 `logger.warn`（from/to + 原因）；条目过滤 `debug`；空链 warn 仅在 `enabled === true` 时输出。

## 风险

| 风险 | 应对 |
|---|---|
| `QUOTA_EXHAUSTED:` 抛点同时承载普通限流与容量耗尽 | 记录前经 `parseRateLimitReason === 'QUOTA_EXHAUSTED' && !isModelCapacityExhausted` 双重分类；判定抽为纯函数并单测 |
| 全账号限流分支 sleep 导致每模型阻塞最长 120s | `quotaSignal` 开启时该分支直接抛额度错误 |
| 终局判定依赖可变时钟 | 仅在循环自然耗尽时求值；`clearExpiredLimits()` 每轮执行，使判定与最后一轮一致 |
| 容量不足被误判 | 容量路径不记录，纯容量故障终局仍抛 `Max retries exceeded` |
| 流式已写出事件后无法切换 | 切换严格限定在首事件 yield 前 |
| 客户端断连后链继续消耗额度 | 流式每次切换前检查 `isCancelled()`；已启动的单个模型请求不中断（与变更前一致） |
| 包装层全局重置限流会破坏单飞 probe | 包装层不重置；依赖 handler 的 `clearExpiredLimits()` |
| 链内 `auto` 自引用 / 别名不生效 | `normalizeAutoChain` 应用 `MODEL_MAP` + `modelMapping` 双向解析，并剔除 `auto` |
| 链中模型名拼错导致 400 打死整条链 | 400 属客户端错误，按既有 invariant 不重试不切换；错误消息含模型名，用户据此修正 |
| 链过长导致耗时叠加 | 运行时截断 10；保存时超限报错 |
| 跨 Claude/Gemini 的 thinking 签名 | 复用既有 `thinking-utils.js` + `signature-cache.js`（与手动切换模型同一路径）；除既有 `npm run test:crossmodel` 外，集成段另有 auto 链 Claude→Gemini 专项用例 |
| 429 错误文案无法解析模型名 | 两处 `QuotaExhaustedError` 文案复用既有形状 `RESOURCE_EXHAUSTED: Rate limited on <model>. Quota will reset after <dur>.`，命中 `parse-error.js` 既有两个正则，不改动该文件 |
| 前缀兜底把普通限流误判为额度耗尽 | `isQuotaExhaustedError` 只认 `instanceof` / `name`，不做文本匹配 |
| 账号池在先前请求已耗尽、本次无新 429 | `modelRateLimits.reason` 持久化限流原因；`quotaSignal` 初始化时预填充该模型的额度耗尽账号 |
| server presets 意外改写 autoModel | 保存/更新均显式剔除 |
| `/v1/models` 未启用时暴露 auto | 条件化列出 |

## 已知缺口（经用户确认接受）

步骤 4.6 第 2 轮核验残留项已全部按技术收敛修正，以下为**实现层面的固有边界**，经用户显式选择「接受残留并继续」保留，需在提交信息中标注：

1. **跨请求额度识别有前置条件**：`modelRateLimits.reason === 'QUOTA_EXHAUSTED'` 的预填充只在「该模型全部账号均处于未过期限流状态」时被消费（handler 进入全账号限流分支才求值）。若仍有账号可用，请求按既有路径执行；若限流已过期，由 `clearExpiredLimits()` 清除后重新探测。此时若上游仍额度耗尽，本次请求会重新收到 429 并被分类记录，仍可触发切换——即在真实额度耗尽下不漏判，但「先前耗尽 + 本次无 429 + 部分账号恰好解限」的组合会走一次常规探测。
2. **不做跨请求链状态记忆**：每次 auto 请求都从链首开始。链首模型额度仍在耗尽态时会被立即识别并跳过（第 1 项的预填充），不会产生上游请求；但需要一次 handler 进入判定分支的开销。
3. **运行中请求不中断**：客户端断连只在「切换到下一模型之前」被检测（`isCancelled`），已发出的单个模型请求会完成或自然失败。
4. **`quotaSignal` 只对 auto 请求开启**：非 auto 请求的 `RESOURCE_EXHAUSTED` / `Max retries exceeded` 文本与状态码完全不变。

## 测试策略（明确端口与依赖）

- **纯函数段**：`normalizeAutoChain` / `validateAutoModelConfig` / `isQuotaExhaustedError` / `shouldSignalQuotaExhaustion` / `isAutoModel`，无外部依赖。
- **注入段**：包装层通过 `deps` 注入 stub handler，覆盖切换、不切换、空生成器、整链耗尽、取消。
- **集成段**：`tests/test-auto-model.cjs` **自起子进程 server**（临时 `HOME` + 独立端口，默认 `18080`，可由 `AUTO_TEST_PORT` 覆盖），不复用 `:8080` 常驻服务。
- **Claude→Gemini 切换实测**：集成段包含一条 `auto` 链 `[claude 模型, gemini 模型]` 的跨厂商用例——链内含 thinking block 的两轮对话，首模型额度耗尽后由 Gemini 模型完成，断言响应体 thinking block 与 signature 处理未触发 400/签名错误。该用例依赖真实上游额度状态不可控，故实现为：可用时断言成功，不可用时以 `console.warn` 标记 `SKIP (upstream quota unavailable)` 并计入 skipped 计数，避免伪通过；`docs/testing.md` 记录该用例的可选性。
- **不登记进 `tests/run-all.cjs`**：该 runner 假定服务在 `:8080`，自起服务会与其冲突。以 `npm run test:auto` 独立运行，并在 `docs/testing.md` 说明理由。
- **handler `quotaSignal` 分支**：由 `shouldSignalQuotaExhaustion()` 纯函数覆盖判定逻辑；handler 内的记录点以源码断言测试确认「分类条件存在且容量分支不在记录路径上」，并分别按各文件实际记录点数断言（streaming 两处、message 一处），不依赖真实网络与 `sleep`。
- **既有回归**：无服务跑 `test:strategies`、`test:openai-converter`、`test:sanitizer`；有服务（`:8080`）跑 `test:streaming`、`test:multiturn`、`test:openai`。