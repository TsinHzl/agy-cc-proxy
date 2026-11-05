# auto-model-routing 能力规范

## Purpose

Auto 模型路由让客户端用单一别名 `auto` 请求模型，由服务端按用户配置的优先级链依次尝试，在当前模型额度耗尽时自动切换到下一优先级模型，从而在 Claude / Gemini 混合模型池中最大化可用性。

## 负责模块

- `src/cloudcode/auto-model.js` — 纯函数：`isAutoModel`、`normalizeAutoChain`、`validateAutoModelConfig`、`shouldSignalQuotaExhaustion`、`countActiveQuotaExhausted`
- `src/cloudcode/auto-model-handler.js` — 链包装层：`sendMessageAuto` / `sendMessageStreamAuto`
- `src/cloudcode/streaming-handler.js` / `message-handler.js` — `options.quotaSignal` 与额度终局抛点
- `src/server/routes-messages.js` / `src/server/routes-openai.js` — `/v1/messages` 与 `/v1/chat/completions` 的 auto 接入
- `src/webui/routes/models.js` — `GET/POST /api/models/auto`
- `public/views/models.html` + `public/js/components/models.js` — WebUI 配置面板

## 适用模型族

同时适用于 claude 与 gemini：auto 链可混合两者，切换仅由额度耗尽触发。

## Requirements

### Requirement: auto 别名识别与配置解析
服务端 SHALL 将经 `MODEL_MAP` 与 `modelMapping` 解析后的模型名 `auto`（忽略大小写与首尾空白）识别为 auto 路由请求，并按 `config.autoModel.models` 的 `priority` 升序构造执行链；`priority` 相同者 SHALL 保持配置文件中的数组顺序。

#### Scenario: 请求 auto 且配置了三条链
- **GIVEN** `config.autoModel = { enabled: true, models: [{ model: "claude-opus-4-6-thinking", priority: 1 }, { model: "gemini-pro-agent", priority: 2 }, { model: "gemini-3-flash", priority: 3 }] }`
- **WHEN** 客户端发送 `POST /v1/messages`，body 中 `"model": "auto"`
- **THEN** 服务端依次尝试 `claude-opus-4-6-thinking` → `gemini-pro-agent` → `gemini-3-flash`
- **AND** 第一个成功的模型完成整个响应

#### Scenario: priority 乱序配置
- **GIVEN** `models` 为 `[{ model: "a", priority: 3 }, { model: "b", priority: 1 }, { model: "c", priority: 2 }]`
- **WHEN** 客户端请求 `auto`
- **THEN** 执行顺序为 `b` → `c` → `a`

#### Scenario: 相同 priority 保持数组顺序
- **GIVEN** `models` 为 `[{ model: "a", priority: 1 }, { model: "b", priority: 1 }]`
- **WHEN** 客户端请求 `auto`
- **THEN** 执行顺序为 `a` → `b`

#### Scenario: 大小写与空白不敏感
- **WHEN** 客户端发送 `"model": "AUTO"`、`"Auto"` 或 `" auto "`
- **THEN** 与 `"auto"` 行为完全一致

#### Scenario: 用户 modelMapping 映射到 auto
- **GIVEN** `config.modelMapping = { "my-model": { mapping: "auto" } }`
- **WHEN** 客户端请求 `"model": "my-model"`
- **THEN** 按 auto 路由处理
- **AND** `MODEL_MAP` 与 `modelMapping` 的既有优先级顺序保持不变

#### Scenario: 链内条目使用别名
- **GIVEN** `models` 含 `{ model: "gemini-3.1-pro-high", priority: 1 }`
- **WHEN** 构造执行链
- **THEN** 该条目解析为 `MODEL_MAP` 映射后的 `gemini-pro-agent`
- **AND** 若用户 `modelMapping` 对该结果另有映射，则以 `modelMapping` 结果为准（与路由层顺序一致）

#### Scenario: 链内条目为 auto 自身
- **GIVEN** `models` 含 `{ model: "auto", priority: 1 }`
- **WHEN** 构造执行链
- **THEN** 该条目被剔除，不产生自引用或递归

### Requirement: auto 链仅在额度耗尽时切换模型
auto 链 SHALL 仅在当前模型返回「额度耗尽」终局信号时切换到下一优先级模型；容量不足、普通限流、账号级 403、网络错误、客户端请求错误 MUST NOT 触发模型切换。

「额度耗尽」的服务端判定 SHALL 同时满足：
1. 至少有一个账号被归入额度耗尽集合。该集合由两类来源构成：
   - **本请求内**：`429` 响应被 `parseRateLimitReason` 分类为 `QUOTA_EXHAUSTED`，且不是容量耗尽（`isModelCapacityExhausted` 为假）；
   - **跨请求**：该账号在该模型下已存在的限流状态其 `reason === 'QUOTA_EXHAUSTED'`（由 `markRateLimited()` 写入并持久化）。
2. 请求终局时该模型无任何可用账号。

允许跨请求来源，是因为账号池可能在先前请求中已耗尽额度，本次请求不会再收到新的 `429`；若只认可本请求内的 `429`，该场景将退化为等待或报错而非切换模型。

服务端 MUST 通过显式错误类型 `QuotaExhaustedError` 传播该信号。识别 MUST 基于 `instanceof` / `error.name`，MUST NOT 依赖错误文本前缀——既有长等待抛点 `RESOURCE_EXHAUSTED: Rate limited on <model>. ...` 可由普通限流或容量退避在连续失败后触发，按文本匹配会误判。

#### Scenario: 额度耗尽切换
- **GIVEN** auto 链为 `[opus(1), gemini-pro-agent(2)]`，opus 的全部账号额度耗尽
- **WHEN** opus 请求进入终局
- **THEN** 服务端抛出 `QuotaExhaustedError`
- **AND** 改用 `gemini-pro-agent` 重新发起同一请求
- **AND** 客户端最终收到 200 响应

#### Scenario: 429 容量耗尽不切换
- **GIVEN** 上游返回 `429` 且错误体含 `MODEL_CAPACITY_EXHAUSTED`
- **WHEN** 容量重试耗尽
- **THEN** 该响应 MUST NOT 被计入额度耗尽集合
- **AND** 服务端 MUST NOT 切换到下一优先级模型

#### Scenario: 503/529 容量不足不切换
- **WHEN** 链首模型返回 503/529 `MODEL_CAPACITY_EXHAUSTED` 并耗尽 `MAX_CAPACITY_RETRIES`
- **THEN** 服务端 MUST NOT 切换模型
- **AND** 客户端收到与变更前一致的错误响应

#### Scenario: 普通限流不切换
- **GIVEN** 上游 429 被 `parseRateLimitReason` 分类为 `RATE_LIMIT_EXCEEDED`
- **WHEN** handler 内部等待后成功
- **THEN** 请求由该模型完成，MUST NOT 切换

#### Scenario: 全账号限流时不再等待（长等待窗口）
- **GIVEN** auto 请求开启 `quotaSignal`，该模型全部账号限流，已记录过额度耗尽，且 `minWaitMs > MAX_WAIT_BEFORE_ERROR_MS`
- **WHEN** handler 进入全账号限流分支
- **THEN** 服务端 SHALL 立即抛出 `QuotaExhaustedError`，MUST NOT 执行 `sleep(minWaitMs + 500)`

#### Scenario: 全账号限流时不再等待（短等待窗口）
- **GIVEN** auto 请求开启 `quotaSignal`，该模型全部账号限流，已记录过额度耗尽，且 `minWaitMs <= MAX_WAIT_BEFORE_ERROR_MS`
- **WHEN** handler 进入全账号限流分支
- **THEN** 服务端 SHALL 立即抛出 `QuotaExhaustedError`，MUST NOT 执行 `sleep(minWaitMs + 500)` 与 `attempt--` 重试

#### Scenario: 账号池在先前请求已耗尽
- **GIVEN** 某模型**全部**账号的限流状态 `reason === 'QUOTA_EXHAUSTED'` 且 `resetTime` 未过期（均由先前请求写入）；本次 auto 请求未收到任何新的 `429`
- **WHEN** handler 进入全账号限流分支
- **THEN** 服务端 SHALL 抛出 `QuotaExhaustedError`
- **AND** auto 包装层切换到下一优先级模型，MUST NOT 等待额度重置

#### Scenario: 部分账号仍可用
- **GIVEN** 某模型部分账号的限流状态 `reason === 'QUOTA_EXHAUSTED'`，但另有账号未限流
- **WHEN** 请求执行
- **THEN** 服务端 SHALL 用可用账号完成请求，MUST NOT 切换模型
- **AND** 发生在账号池全部限流且过期后的常规路径维持既有 `Max retries exceeded` 语义

#### Scenario: 先前请求是容量退避而非额度耗尽
- **GIVEN** 某模型全部账号的限流状态 `reason === 'MODEL_CAPACITY_EXHAUSTED'`，本次请求未收到新的 `429`
- **WHEN** handler 进入全账号限流分支或终局
- **THEN** 服务端 MUST NOT 抛出 `QuotaExhaustedError`
- **AND** 客户端收到与变更前一致的错误响应

#### Scenario: 额度错误响应文案可解析
- **WHEN** auto 链全部耗尽并返回 429
- **THEN** 错误消息 SHALL 包含真实模型名与 reset 时长
- **AND** `Retry-After` 头 SHALL 由 `parseError` 按既有正则给出，而非固定默认值
- **AND** 文案 SHALL 复用既有形状 `RESOURCE_EXHAUSTED: Rate limited on <model>. Quota will reset after <dur>.`，`src/server/parse-error.js` MUST NOT 被修改

#### Scenario: 客户端请求错误不切换
- **WHEN** 链首模型返回 400 `invalid_request_error: ...`
- **THEN** 服务端 MUST NOT 切换模型，错误直接回传客户端

#### Scenario: 全部账号无效不切换
- **WHEN** 链首模型因全部账号 `isInvalid` 抛出 `All accounts are invalid: ...`
- **THEN** 服务端 MUST NOT 切换模型，错误直接回传客户端

#### Scenario: 非 auto 请求不受影响
- **GIVEN** 客户端请求具体模型且全部账号额度耗尽
- **WHEN** handler 进入终局
- **THEN** 客户端收到与变更前一致的 `Max retries exceeded` 派生错误
- **AND** MUST NOT 抛出 `QuotaExhaustedError`

#### Scenario: 链全部耗尽
- **GIVEN** auto 链为 `[a(1), b(2)]`
- **WHEN** `a` 与 `b` 均抛出 `QuotaExhaustedError`
- **THEN** 客户端收到 429 响应
- **AND** 响应 `Retry-After` 按既有 `parseError` 规则给出

#### Scenario: 跨厂商切换的 thinking 兼容
- **GIVEN** auto 链为 `[claude-thinking 模型, gemini 模型]`，请求体含 thinking 配置且对话历史含 thinking block
- **WHEN** 链首 Claude 模型额度耗尽，由 Gemini 模型完成该请求
- **THEN** 响应 SHALL 成功（无 `INVALID_ARGUMENT` / 签名校验 400）
- **AND** 既有 `thinking-utils.js` 与 `signature-cache.js` 的跨模型签名处理路径被复用

### Requirement: auto 流式响应仅在任何事件输出前切换
对于流式请求，auto 链 SHALL 仅在尚未向客户端写出任何 SSE 事件时切换模型；一旦首个 SSE 事件已写出，后续错误 MUST 按既有 SSE `error` 事件语义处理，MUST NOT 切换模型。

#### Scenario: 链首模型首事件即额度耗尽
- **WHEN** 服务端拉取首个事件时收到 `QuotaExhaustedError`
- **THEN** 服务端 MUST NOT 写出任何 SSE 事件
- **AND** 改用下一优先级模型，客户端最终收到来自第二个模型的完整 SSE 流

#### Scenario: 流中途错误
- **GIVEN** 链首模型已成功写出 `message_start`
- **WHEN** 后续上游返回额度耗尽
- **THEN** 服务端写出 `event: error` 并结束响应
- **AND** MUST NOT 切换到下一优先级模型

#### Scenario: 首事件前生成器即结束
- **WHEN** 某链模型的生成器在产出任何事件前结束
- **THEN** 服务端 SHALL 视为该模型失败并尝试下一优先级模型
- **AND** 客户端 MUST NOT 收到空的 200 响应

#### Scenario: 客户端已断连
- **WHEN** 在切换到下一优先级模型之前检测到客户端已断开
- **THEN** 服务端 SHALL 中止 auto 链，不再发起新的上游请求

### Requirement: auto 配置缺失时的错误语义
当 `autoModel.enabled` 不为 `true` 或规范化后的链为空时，`auto` 请求 MUST 返回 400 `invalid_request_error`，消息 SHALL 指明需要在 WebUI 配置 auto 模型。

#### Scenario: 未启用 auto
- **WHEN** 客户端请求 `"model": "auto"` 且 `enabled: false`
- **THEN** 客户端收到 400 `invalid_request_error`
- **AND** 错误消息包含 "auto model" 与配置指引

#### Scenario: 已启用但链为空
- **GIVEN** `enabled: true` 且 `models: []`
- **THEN** 行为与未启用一致

#### Scenario: 已启用但全部条目非法
- **GIVEN** `enabled: true` 且所有条目均为脏数据
- **THEN** 规范化结果为空，返回 400
- **AND** 服务端输出一次 warn 级别的空链提示

### Requirement: auto 与端点覆盖
`auto` 别名 SHALL 在 `POST /v1/messages` 与 `POST /v1/chat/completions` 两个端点均生效；`GET /v1/models` 仅当 `autoModel.enabled === true` 且规范化链非空时 SHALL 列出 `auto`。

#### Scenario: OpenAI 兼容端点
- **WHEN** 客户端发送 `POST /v1/chat/completions`，`"model": "auto"`
- **THEN** auto 链生效，返回 OpenAI 格式响应
- **AND** 响应 `model` 字段回显 `"auto"`

#### Scenario: 模型列表（已启用）
- **GIVEN** `enabled === true` 且链非空
- **WHEN** `GET /v1/models`
- **THEN** 响应 `data` 首条为 `{ "id": "auto", "object": "model", "owned_by": "antigravity-proxy", ... }`
- **AND** 该条目不进入真实模型的校验缓存

#### Scenario: 模型列表（已启用但上游模型列表为空）
- **GIVEN** `enabled === true` 且链非空，但 `fetchAvailableModels` 未返回任何模型（`listModels()` 原本会提前返回空数组）
- **WHEN** `GET /v1/models`
- **THEN** 响应 `data` SHALL 仍包含 `auto` 条目
- **AND** 其余真实模型条目为空

#### Scenario: 模型列表（未启用）
- **GIVEN** `enabled === false` 或链为空
- **WHEN** `GET /v1/models`
- **THEN** 响应 `data` MUST NOT 出现 `auto`

#### Scenario: 非 auto 请求不受影响
- **WHEN** 客户端请求具体模型
- **THEN** 行为与变更前完全一致

### Requirement: 实际执行模型可观测
auto 请求的最终执行模型 SHALL 被记录到 usage log 的 `model` 字段（仅在成功后），并 SHALL 在每次切换时输出包含源模型与目标模型的日志。

#### Scenario: usage log 记录实际模型
- **GIVEN** 链首额度耗尽后由第二个模型完成
- **WHEN** 响应结束后写入 usage log
- **THEN** 该条记录的 `model` 字段为第二个模型名

#### Scenario: 失败不写实际模型
- **WHEN** 链内某模型抛非额度错误
- **THEN** MUST NOT 为其调用模型回报，错误直接回传

#### Scenario: 切换日志
- **WHEN** auto 链从 A 切换到 B
- **THEN** 服务端日志包含 A 到 B 的切换记录及触发原因

#### Scenario: 流量统计口径
- **GIVEN** 请求体 `model` 为 `auto`
- **WHEN** usage-stats 中间件统计该请求
- **THEN** 计入独立的 `auto` 条目
- **AND** 该行为在文档中明确为有意设计

### Requirement: auto 配置管理界面与 API
WebUI SHALL 提供 auto 配置的读取与保存接口，保存时 SHALL 严格校验；非法配置 MUST 被拒绝且 MUST NOT 写入 `config.json`。`POST /api/config` 遇到非法 `autoModel` MUST 返回 400。server presets MUST NOT 捕获或应用 `autoModel`。

#### Scenario: 保存合法配置
- **WHEN** 通过 WebUI 提交 `{ enabled: true, models: [{ model: "gemini-pro-agent", priority: 1 }] }`
- **THEN** 接口返回成功，`config.json` 更新
- **AND** 后续 auto 请求立即使用新配置，无需重启

#### Scenario: 保存非法配置
- **WHEN** 提交非布尔 `enabled`、`enabled=true` 且空链、空模型名、非正整数 `priority`、重复模型、链含 `auto`、或超过 10 条
- **THEN** 接口返回 400 并说明具体错误
- **AND** `config.json` 保持原值

#### Scenario: POST /api/config 非法 autoModel
- **WHEN** 请求体含非法 `autoModel` 与其他合法字段
- **THEN** 整体返回 400，MUST NOT 部分写入

#### Scenario: 禁用但保留链
- **WHEN** 提交 `{ enabled: false, models: [ {...}, {...} ] }`
- **THEN** 保存成功，链被保留（便于后续重新启用）

#### Scenario: server preset 不影响 autoModel
- **WHEN** 保存或更新 server preset
- **THEN** preset 中 MUST NOT 包含 `autoModel`
- **AND** 应用 preset 后当前 `autoModel` 保持不变

#### Scenario: 默认不启用
- **WHEN** 服务首次启动且用户未配置
- **THEN** `config.autoModel` 为 `{ enabled: false, models: [] }`
- **AND** 所有非 auto 请求行为与变更前一致