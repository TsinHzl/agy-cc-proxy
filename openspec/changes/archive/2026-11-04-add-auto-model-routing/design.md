## 上下文

现有降级路径：

```
routes-messages.js
  → sendMessage(Stream)(request, manager, fallbackEnabled)
    → for attempt 循环（账号轮换、端点 fallback、capacity backoff）
    → 全部重试耗尽 或 全账号限流且等待 > MAX_WAIT_BEFORE_ERROR_MS
      → getFallbackModel(model) → 递归一次（fallbackEnabled=false）
```

代码事实（逐条核实）：

1. `getFallbackModel()` 返回单个模型，`MODEL_FALLBACK_MAP` 静态，链长恒为 1 跳。
2. `streaming-handler.js:288` / `message-handler.js:262` 的 `QUOTA_EXHAUSTED` 抛出后被同文件 `catch (endpointError)`（:458 / :361）经 `isRateLimitError()` 重新抛出，随即被账号级 `catch`（:489 / :389）捕获并 `continue`——**不会逃到调用方**。
3. 账号轮换耗尽后统一抛 `Max retries exceeded`（:565 / :464）。
4. 唯一逃逸的额度错误在 :105 / :100，条件是全账号限流且 `minWaitMs > MAX_WAIT_BEFORE_ERROR_MS`（默认 120s）。
5. **该 `QUOTA_EXHAUSTED:` 抛点的进入条件是 `smartBackoffMs > DEFAULT_COOLDOWN_MS(10000)`，并非额度专属**：`calculateSmartBackoff()` 对 `RATE_LIMIT_EXCEEDED` 返回 30s、对 `MODEL_CAPACITY_EXHAUSTED` 返回 15s+jitter，二者同样落入该分支。
6. `parseRateLimitReason(errorText, status)` 已存在于 `rate-limit-parser.js`，按错误体分类为 `QUOTA_EXHAUSTED` / `MODEL_CAPACITY_EXHAUSTED` / `RATE_LIMIT_EXCEEDED` / `SERVER_ERROR` / `UNKNOWN`；`isModelCapacityExhausted(errorText)` 在 `rate-limit-state.js`。
7. `isAllRateLimited()` / `getAvailableAccounts()` 依赖 `Date.now()`；`clearExpiredLimits()` 在每轮循环顶部执行。
8. `resetAllRateLimits()` 会清空全账号全模型的限流状态，与 `rate-limit-state.js` 的 single-flight probe 机制相反。
9. `usage-stats` 中间件按 `req.body.model` 计数；`usage-log` 由路由层显式写入。
10. `saveServerPreset` 快照 `validateConfigFields` 结果；`updateServerPreset` 另有独立白名单，两者本就不一致。
11. `modelRateLimits[model]` 仅存 `isRateLimited` / `resetTime` / `actualResetMs`（`rate-limits.js:130-134` 与 `storage.js:145`），**不存限流原因**；限流状态会随 `saveAccounts()` 持久化到磁盘。
12. `message-handler.js` 无空响应重试分支：无 `MAX_EMPTY_RESPONSE_RETRIES` 导入、无 `429 RESOURCE_EXHAUSTED during retry` 文本。该分支仅存在于 `streaming-handler.js:377-453`。
13. `parse-error.js:29/33` 的正则为 `/quota will reset after ([\dh\dm\ds]+)/i` 与 `/Rate limited on ([^.]+)\./`，后者要求字面句号。
14. `listModels()` 在 `fetchAvailableModels` 返回无 `models` 时提前返回 `{ data: [] }`（`model-api.js:46-48`）。

## 目标 / 非目标

**目标**

- 可配置、有序、可观测的模型优先级链。
- 切换语义明确：仅额度耗尽，且判定经原因分类，不接受「长退避即额度」的近似。
- 不改动账号策略、quota tracker、既有 `--fallback` 的非 auto 行为。

**非目标**

- 预检式切换（基于 `account.quota` 快照）。
- 跨请求链状态记忆。
- 重构 `MODEL_FALLBACK_MAP`。
- 运行中请求中断。

## 决策

### D1：handler 增加经分类的 `quotaSignal`（各约 10 行）

**问题**：事实 5 决定「长退避 → 额度耗尽」的等价不成立。任何依赖错误前缀（`QUOTA_EXHAUSTED:`）的外层判定都会把普通限流与容量耗尽误判为额度耗尽。事实 11 进一步表明：限流状态本身不携带原因，因此「账号池在先前请求已耗尽」在后续请求中与「容量退避」完全无法区分。

**选择**：

(1) `modelRateLimits` 增 `reason` 字段，由 `markRateLimited()` 接收并写入，随 `saveAccounts()` 持久化。取值即 `parseRateLimitReason()` 的返回值。这是最小侵入的状态扩展（`rate-limits.js` + `storage.js` 各 1 行序列化字段），使跨请求识别成为可能。

(2) 在 handler 内按文件实际记录点数做原因分类：

```js
if (parseRateLimitReason(errorText, response.status) === 'QUOTA_EXHAUSTED' && !isModelCapacityExhausted(errorText)) {
    quotaExhaustedEmails.add(account.email);
}
```

记录点：
- `streaming-handler.js` (a) 长期额度耗尽抛点（`QUOTA_EXHAUSTED` throw 之前）——覆盖 `smartBackoffMs > DEFAULT_COOLDOWN_MS` 分支；
- `streaming-handler.js` (b) 空响应重试分支的 429（`429 RESOURCE_EXHAUSTED during retry` 之前）——该路径也是真实额度耗尽，但错误文本被打上 "429 RESOURCE_EXHAUSTED during retry" 前缀，无法被前缀判定捕获，必须在此单独记录；
- `message-handler.js` **仅 (a)**。事实 12 表明该文件不存在空响应重试分支，要求「两文件同构、两处记录点」不可实现。

(3) 请求开始时按跨请求来源预填充集合：

```js
const quotaExhaustedEmails = new Set(
    quotaSignal
        ? accountManager.getAvailableAccounts(null, allowedEmails)
            .filter(a => a.modelRateLimits?.[model]?.reason === 'QUOTA_EXHAUSTED')
            .map(a => a.email)
        : []
);
```

注意：此处用 `getAvailableAccounts(null)` 取全部候选账号再自行按 `modelRateLimits[model]` 过滤——不能直接用 `getAvailableAccounts(model)`，因为后者已排除限流中的账号，正好会把要识别的对象滤掉。

**判定函数抽为纯函数**，可无网络单测：

```js
export function shouldSignalQuotaExhaustion({ quotaSignal, quotaExhaustedCount, availableCount }) {
    return quotaSignal === true && quotaExhaustedCount > 0 && availableCount === 0;
}
```

**代价**：`rate-limits.js` + `storage.js` 各 1 处字段扩展；`streaming-handler.js` 约 12 行、`message-handler.js` 约 10 行增量（1 处记录 + 2 处判定分支 + 1 处预填充）。`quotaSignal` 默认 `false`，非 auto 调用方零影响。这是唯一能在不误判且覆盖跨请求场景的前提下识别额度耗尽的方案。

**被否决**：
- *纯外层包装 + 错误文本*：无法观测（事实 2–3），且前缀不区分容量（事实 5）。
- *外层判定 `Max retries exceeded` + `isAllRateLimited`*：会误判网络/5xx/403。
- *handler 内实现链遍历*：侵入 600+ 行重试逻辑，回归风险远高于收益。

### D2：`quotaSignal` 下跳过等待

**问题**：事实 4 的等待分支在 `minWaitMs <= MAX_WAIT_BEFORE_ERROR_MS` 时执行 `sleep(minWaitMs + 500)` + `attempt--` 重试，永不进入终局。若额度信号只挂在终局，短周期额度会把每个模型拖到最多 120s。另一方面，既有 `minWaitMs > MAX_WAIT_BEFORE_ERROR_MS` 的抛点是 `RESOURCE_EXHAUSTED:` 文本，只能靠前缀兜底，违反「显式类型传播」要求。

**选择**：在全账号限流分支的**最前面**（即 `if (minWaitMs > MAX_WAIT_BEFORE_ERROR_MS)` 之前）插入判定，使长短两种窗口都走显式类型：

```js
if (shouldSignalQuotaExhaustion({
    quotaSignal,
    quotaExhaustedCount: quotaExhaustedEmails.size,
    availableCount: 0
})) {
    throw new QuotaExhaustedError(
        `RESOURCE_EXHAUSTED: Rate limited on ${model} after ${formatDuration(minWaitMs)}.`
    );
}
```

该判定位于 `const resetTime = ...` 之后、`if (minWaitMs > MAX_WAIT_BEFORE_ERROR_MS)` 之前。文案与既有长等待抛点形状一致：`Rate limited on <model>.` 让事实 13 的 `/Rate limited on ([^.]+)\./` 提取到干净模型名，`Quota will reset after <dur>` 让 `/quota will reset after ([\dh\dm\ds]+)/i` 命中并给出正确 `Retry-After`。无需改动 `parse-error.js`。

非 `quotaSignal` 调用方继续走原有 sleep/抛错逻辑，行为不变。

### D3：终局判定用显式可用账号数

**问题**：事实 7 表明 `isAllRateLimited()` 依赖 `Date.now()`，存在「事后重查时账号限流已过期」的竞态。

**选择**：终局用 `accountManager.getAvailableAccounts(model, allowedEmails).length === 0` 而非 `isAllRateLimited()`。后者对 invalid/disabled 账号一律返回 true，前者不会；且二者同为即时查询，语义更精确（「无任何可用账号」正是切换条件）。

不做循环内布尔累加，因为循环可能因等待、重试、`attempt--` 多次回到同一状态，累加值可能与终局真实状态不符。保持「终局即时查询」并接受其与最后一轮循环的一致性——`clearExpiredLimits()` 每轮执行，二者已对齐。

### D4：包装层不加全局重置

**问题**：路由层原有 `if (isAllRateLimited(modelId)) resetAllRateLimits()` 在 auto 路径下因 `modelId === 'auto'` 恒为 `false`，不会执行。

**曾考虑**：在包装层按链内真实模型执行同样的重置。

**否决**：事实 8 表明 `resetAllRateLimits()` 是全局的（清空所有账号所有模型），与 single-flight probe 机制目标相反；链内每个模型都重置会按请求放大重置次数，反而制造上游风暴。handler 每轮已有 `clearExpiredLimits()`，真正的「全账号仍限流」正是应该切换模型的时刻。

因此包装层**不做任何重置**，并在验收中以源码断言固化该约束。

### D5：包装层 + `deps` 注入

**选择**：`auto-model-handler.js` 包装 `deps.sendMessage` / `deps.sendMessageStream`，默认取真实实现。

**理由**：

- 关注点正交（链遍历 vs 重试机制）。
- 真实 handler 内部 `sleep(SWITCH_ACCOUNT_DELAY_MS=5000)`、`CAPACITY_BACKOFF_TIERS_MS` 让单元测试不可控；注入缝让切换逻辑可在毫秒级验证。
- 符合 `project.md`「无 per-request 状态外溢」。

### D6：流式切换点

**选择**：只在「首事件被 `await` 到但尚未 `yield`」的窗口内切换；`first.done === true` 视为失败。

```js
const gen = deps.sendMessageStream({ ...req, model }, manager, false, filter, { ...opts, quotaSignal: true });
let first;
try { first = await gen.next(); }
catch (e) { if (isQuotaExhaustedError(e)) { lastQuota = e; continue; } throw e; }
if (first.done) continue;          // 空生成器：不能当成功
onModelResolved(model);
yield first.value;
yield* gen;
return;
```

理由：首次 `next()` 的拒绝发生在任何 yield 之前，此时路由层尚未 `flushHeaders`，可安全换模型。首事件成功后中途失败，路由层已写出 SSE，拼接两个模型输出会破坏 Anthropic SSE 语义。

### D7：`--fallback` 与 auto 的交互

**选择**：auto 链内固定 `fallbackEnabled=false`。

理由：auto 语义是「用户显式定义顺序」。若内部再走 `MODEL_FALLBACK_MAP`，会出现「auto 第 1 项失败 → 映射表模型 → 与 auto 第 2 项重复或顺序错乱」。非 auto 请求不受影响。

### D8：配置校验双层，接口层语义分离

- **运行时 `normalizeAutoChain()`**：宽容。过滤脏数据、别名双向解析、拒绝自引用、稳定排序、去重、截断。`enabled=false` 静默返回 `[]`；条目级问题 `logger.debug`；仅 `enabled=true` 且规范化后为空时 `logger.warn`。
- **`validateAutoModelConfig()`**：严格。供 `GET/POST /api/models/auto` 与 `POST /api/config` 使用。
- **`validate-config.js` 不加 `autoModel` 分支**：保持其对 server presets 的既有静默丢弃语义，避免「用户看到 200 但变更未生效」。

`enabled === false` 时允许非空链（支持「先配链、后启用」），也允许空数组。

### D9：识别位置与映射优先级

**选择**：在 `MODEL_MAP` 与 `modelMapping` 之后识别 `auto`。

理由：二者是用户可配置入口，先应用意味着用户可双向映射（`my-model → auto` 或 `auto → 具体模型`），行为与既有 alias 顺序一致，且可在文档中明确。

链内条目同样依次应用 `MODEL_MAP` 与 `modelMapping`，与路由层保持同一规则——避免「路由层认别名、链内不认」的不一致。

### D10：实际模型可观测性

**选择**：`onModelResolved(model)`，流式在首事件后调用，非流式在成功后调用。

理由：包装层不依赖路由层。Anthropic 响应的 `model` 由 handler 用传入模型填充，自然正确；OpenAI 响应由路由层用 `openAIModel` 填充，继续回显 `auto`。

`usage-stats` 中间件按请求体 `model` 计为 `auto` 桶、`usage-log` 记录实际模型——口径不同，写入文档。

### D11：`/v1/models` 条件化

仅 `enabled === true` 且规范化链非空时列出 `auto`，形状与其他条目一致（`id`/`object`/`created`/`owned_by`/`description`），`owned_by` 为 `antigravity-proxy`，不写入 `modelCache.validModels`。

理由：默认未启用时列出会让客户端选中一个必然 400 的模型。

实现注意（事实 14）：`listModels()` 在 `fetchAvailableModels` 无 `models` 时提前 `return { object: 'list', data: [] }`。auto 条目构造必须在该早返回**之前**插入，否则上游模型列表为空（token 异常、接口变更）时 auto 也会消失。正确形状为先构造 `autoEntries`，再在早返回分支返回 `{ data: autoEntries }`。

### D12：server presets 排除 `autoModel`

`POST` 与 `PATCH` 均剔除。理由：server presets 是「账号池调优参数快照」（`maxRetries`、`capacityBackoffTiersMs`、`accountSelection`），`autoModel` 是模型路由配置，与调优无关；塞进预设会让「应用预设」意外改写用户模型链。当前 `updateServerPreset` 白名单本就不含该字段，显式剔除保证两条路径一致。

### D13：`isQuotaExhaustedError` 只认类型，不做文本匹配

```js
export function isQuotaExhaustedError(error) {
    return error instanceof QuotaExhaustedError || error?.name === 'QuotaExhaustedError';
}
```

与既有 `isEmptyResponseError()` 完全同构。

**为什么不用前缀兜底**：事实 4 与代码事实共同决定 `RESOURCE_EXHAUSTED: Rate limited on <model>. ...` 不是额度专属——该抛点进入条件是 `minWaitMs > MAX_WAIT_BEFORE_ERROR_MS`，而 `RATE_LIMIT_EXCEEDED`（30s 基础 × 指数退避）与 `MODEL_CAPACITY_EXHAUSTED`（15s + jitter）都能在连续失败后越过 120s 门槛。按前缀匹配会让「普通限流/容量退避」也被判定为额度耗尽并错误切换模型，违背用户已确认的「仅额度耗尽」边界。因此额度信号**只能**来自 handler 内经 `parseRateLimitReason` 分类后的显式抛出，链内没有任何文本路径。

代价：跨模块边界（若将来有 handler 之外的地方需要识别）无法仅凭消息判定。当前不存在这样的调用方，接受该限制。

### D13b：`modelRateLimits.reason` 持久化

**问题**：事实 11 表明限流状态不保存原因，跨请求场景无法识别（偏离项 A8 的根因之一）。

**选择**：`markRateLimited(accounts, email, resetMs, modelId, reason)` 新增可选第 5 参数；`rate-limits.js:130-134` 写入 `reason: reason || null`；`storage.js:145` 与序列化处保留该字段。所有既有调用点省略该参数时行为不变（`reason: null`）。

`AccountManager.markRateLimited(email, resetMs, modelId, reason)` 透传。**仅在额度分类分支**调用时传 `reason`——即 `smartBackoffMs > DEFAULT_COOLDOWN_MS` 分支与空响应重试 429 分支（`streaming-handler.js` 两处、`message-handler.js` 一处）。其余既有调用点（容量退避、短退避、403、5xx cooldown 等）保持原签名不传，行为与变更前一致，避免写入语义错误的原因值。handler 在该分支内本就已算出 `parseRateLimitReason()` 结果，无额外解析成本。

**判定影响**：`quotaSignal` 的跨请求来源只看 `reason === 'QUOTA_EXHAUSTED'`。容量退避写入 `MODEL_CAPACITY_EXHAUSTED`，普通限流写入 `RATE_LIMIT_EXCEEDED`，均不被识别为额度耗尽。`resetAllRateLimits()` 会把状态重置为 `{ isRateLimited: false, resetTime: null }`，`reason` 随之丢失——这正是「乐观重试」的语义（重新探测），无需保留。

**磁盘兼容**：老 `accounts.json` 无 `reason` 字段 → `undefined` → 判定为假，等价于「未知原因不切换」，安全降级。

### D14：取消检测的最小实现

仅在**切换前**调用 `isCancelled()`（路由层传 `() => res.writableEnded || req.destroyed`）。不做已启动请求中断——那需要跨模块传 AbortSignal，超出本次范围。当前实现可避免「客户端已断连后白跑整条链」。

### D15：测试自起服务

集成段**不**复用 `:8080` 常驻服务，而由 `tests/test-auto-model.cjs` 自起子进程 server（临时 `HOME` + `AUTO_TEST_PORT` 默认 18080）。**不登记进 `tests/run-all.cjs`**（该 runner 假定 8080）。理由：常驻服务读真实 `HOME`，无法被测试改写配置；自起进程可完全隔离。

## 风险 / 权衡

| 权衡 | 说明 |
|---|---|
| handler 改动 vs 纯包装 | 必须改动 handler（约 10 行 × 2 文件）才能获得经分类的额度信号。选择最小改动 + 默认关闭，而非侵入式重构。 |
| 跳过等待 vs 尊重上游 | `quotaSignal` 下跳过 `sleep`，意味着 auto 请求不会为单个模型等待额度重置。这是「快速切换」的必然取舍，且对应用户显式选择 auto 的意图。 |
| 延迟 | 单模型最坏约为一次完整账号轮换（每账号 5s）。不累积容量退避。链长上限 10。 |
| 语义严格 vs 覆盖 | 不匹配泛化 429、不匹配容量。代价是偶发不切换（用户看到错误），而非错误切换。 |
| 新增 `reason` 字段 | `accounts.json` 多一个字段；老文件无该字段时安全降级为「未知原因」。 |
| 包装层不透明 | 无法感知 handler 内部账号级进度。排查需结合 handler 日志。 |
| 配置解析两处 | 路由层与链内各自应用 `MODEL_MAP`/`modelMapping`，需保持规则一致（D9）。 |
| 全链路取消 | 未实现，记录为非目标。 |

## 迁移方案

`DEFAULT_CONFIG` 新增 `autoModel: { enabled: false, models: [] }`，`deepMerge` 自动补齐，无需迁移脚本。老配置文件中不存在该键即等价未启用。`quotaSignal` 默认 `false`，handler 既有调用方无需修改，错误文本与状态码不变。

`modelRateLimits.reason` 对老 `accounts.json` 缺失时按 `undefined` 处理（判定为假），无需迁移。`resetAllRateLimits()` 清空限流状态时 `reason` 一并丢失，符合乐观重试语义。

## 待决问题

无。影响任务拆分的决策（优先级表达、切换触发条件、交付范围）已在阶段 0 由用户确认。第 2 轮审查提出的各项已在 D1–D15 中逐条落实或显式记录为非目标。