# api-keys 能力规范

## Purpose

api-keys 能力为 agy-cc-proxy 提供多 API Key 管理：不同客户端可使用独立 Key 通过 `/v1/*` 接入，支持启用禁用、懒激活有效期（durationDays）与消费额度（spendingLimit），并按 Key 统计请求数与 token 用量。主密钥 `config.apiKey` 与管理 Key 并存，主密钥行为保持零回归。

## 负责模块

- `src/api-keys/manager.js` — 生命周期、校验、额度判定、用量冗余计数
- `src/api-keys/storage.js` — `~/.config/antigravity-proxy/api-keys.json` 持久化（写锁 + 原子写）
- `src/server.js` — `/v1/*` 鉴权中间件接入
- `src/modules/usage-log.js` — 明细记录 `keyId` 字段
- `src/webui/index.js` — WebUI REST 端点
- `public/views/api-keys.html` + `public/js/components/api-keys-manager.js` — 前端视图

## 适用模型族

本能力作用于 `/v1/*` 鉴权层，与模型族无关（claude / gemini 均适用）。

## 新增需求

### 需求：多 Key 数据模型与持久化

系统 SHALL 将管理 API Key 持久化于 `~/.config/antigravity-proxy/api-keys.json`，每条记录 MUST 包含 `id`（`k_`+8hex）、`name`、`key`（`sk-agy-`+48hex，复用 `generateApiKey()` 输出格式）、`enabled`、`durationDays`（null=永不过期）、`activatedAt`、`expiresAt`、`spendingLimit`（null=不限额，`metric` 仅 `'tokens'|'requests'`）、`usage`（requests/inputTokens/outputTokens）、`createdAt`、`lastUsedAt`、`lastUsedIp` 字段；写入 MUST 串行化（promise 链锁）且原子替换（tmp+rename）；文件不存在时 MUST 返回 `{version:1, keys:[]}` 默认值（零迁移）。

#### 场景：老部署首次启动
- **WHEN** `api-keys.json` 不存在时服务启动
- **THEN** storage 返回空 keys 默认值，不创建文件、不报错
- **AND** 主密钥鉴权行为与升级前完全一致

#### 场景：并发写入串行化
- **WHEN** WebUI 保存操作与 /v1 懒激活落盘同时发生
- **THEN** 两次写入经写锁串行执行，文件内容始终为完整合法 JSON

### 需求：/v1 多 Key 鉴权

`/v1/*` 鉴权中间件 SHALL 先将提供的 key（Bearer 或 x-api-key）与主密钥比对（timing-safe，命中 `id: null` 放行，行为与现状一致），未命中再遍历管理 Key 逐一 timing-safe 比对；均未命中 MUST 返回 401 `authentication_error`。命中管理 Key 后 MUST 按以下顺序判定：`enabled === false` → 401（message: 'API key has been disabled'）；懒激活（`activatedAt === null && durationDays != null` → 置 activatedAt/expiresAt 并放行本次请求）；`expiresAt` 已过 → 401（message: 'API key has expired'）；`spendingLimit` 且 `usage[metric] >= limit` → 429 `rate_limit_error`（message: 'API key spending limit exceeded'）。判定顺序 MUST 保持 enabled → 懒激活 → 过期 → 额度。通过后 MUST 在 `req._apiKeyId` / `req._apiKeyRecord` 挂载 Key 标识。

#### 场景：主密钥零回归
- **WHEN** 使用 `config.apiKey` 主密钥调用 `/v1/messages`
- **THEN** 请求放行，`req._apiKeyId` 为 null，响应与升级前一致

#### 场景：无效 Key 拒绝
- **WHEN** 提供 neither 主密钥 nor 任何管理 Key 匹配的 key
- **THEN** 返回 401 `{"type":"error","error":{"type":"authentication_error","message":"Invalid or missing API key"}}`

#### 场景：禁用 Key 拒绝
- **WHEN** 使用 `enabled: false` 的管理 Key 调用
- **THEN** 返回 401 authentication_error，message 为 'API key has been disabled'

#### 场景：懒激活首用计时
- **WHEN** 使用 `durationDays: 30` 且 `activatedAt: null` 的管理 Key 首次调用
- **THEN** 本次请求放行，`activatedAt` 置为当前时间，`expiresAt = activatedAt + 30 天`，异步落盘

#### 场景：已激活未过期放行
- **WHEN** 使用已激活且 `now < expiresAt` 的管理 Key 调用
- **THEN** 请求放行，activatedAt/expiresAt 不变

#### 场景：过期 Key 拒绝
- **WHEN** 使用 `now > expiresAt` 的管理 Key 调用
- **THEN** 返回 401 authentication_error，message 为 'API key has expired'

#### 场景：超额 Key 限流
- **WHEN** 管理 Key 的 `usage[metric] >= spendingLimit.limit`（如 `spendingLimit: {metric:'tokens', limit:100}` 且累计已达 100）时新请求到达
- **THEN** 返回 429 rate_limit_error，message 为 'API key spending limit exceeded'
- **AND** tokens metric 下允许单次大请求使总量一次性越过 limit（最终一致，不做预扣）

#### 场景：编辑 durationDays 重算有效期
- **WHEN** 已激活（activatedAt 非 null）的 Key 被 PATCH 修改 `durationDays`（如 30 → 7）
- **THEN** `expiresAt` 基于**原 activatedAt** 重算为 `activatedAt + 新 durationDays`，activatedAt 不变
- **AND** 修改为 `null`（永不过期）时清空 `expiresAt`；修改未激活 Key 的 durationDays 不影响 activatedAt/expiresAt（仍为 null，等首用激活）

### 需求：按 Key 用量记录与统计

系统 SHALL 仅对成功的 `/v1` 请求按 Key 记录用量：usage-log 明细 `record()` 增加 `keyId` 字段（主密钥/未知为 null，老记录读取侧兜底 null），同时更新 manager `usage` 冗余计数（requests +1，inputTokens/outputTokens 累加）并刷新 `lastUsedAt`/`lastUsedIp`，isDirty 标记 60s 周期落盘。manager `usage` 为额度判定与统计的权威数据源；usage-log 明细仅作最近活动展示窗口。

#### 场景：成功请求计数
- **WHEN** 使用管理 Key 的 `/v1/messages` 请求成功完成
- **THEN** usage-log 新记录含 `keyId`，manager `usage.requests` +1、token 计数累加

#### 场景：失败请求不计数
- **WHEN** 管理 Key 的请求因上游错误失败（401/429/5xx）
- **THEN** `usage` 计数不增加

#### 场景：老记录兜底
- **WHEN** 读取升级前的 usage-log 记录
- **THEN** 无 `keyId` 字段的记录按 null 处理，归入「主密钥/未知」，不报错

### 需求：WebUI Key 管理 REST 端点

WebUI（`createAuthMiddleware` 之后）SHALL 提供：`GET /api/keys`（列表，key 默认掩码 `sk-agy-****last4`）；`POST /api/keys`（创建，body `{name, durationDays?, spendingLimit?}`，仅创建响应返回全量明文）；`PATCH /api/keys/:id`（编辑 name/enabled/durationDays/spendingLimit，支持 `resetUsage: true` 重置 usage）；`DELETE /api/keys/:id`；`GET /api/keys/:id/reveal`（返回明文）；`GET /api/keys/:id/usage`（返回 `{summary, recent}`，recent 为 usage-log 按 keyId 过滤的最近明细）。不存在的 id MUST 返回 404。

#### 场景：创建返回一次性明文
- **WHEN** POST /api/keys 创建成功
- **THEN** 响应含全量明文 key；后续 GET /api/keys 列表中该 Key 仅显示掩码

#### 场景：列表掩码
- **WHEN** GET /api/keys
- **THEN** 每条记录的 key 字段为 `sk-agy-****<last4>` 掩码，不含明文

#### 场景：重置用量
- **WHEN** PATCH /api/keys/:id 传 `{resetUsage: true}`
- **THEN** 该 Key 的 usage 三项计数归零

#### 场景：删除与 404
- **WHEN** DELETE /api/keys/:id 后再次访问该 id 的任意端点
- **THEN** 删除返回 `{status:'ok'}`，后续访问返回 404

### 需求：WebUI apiKeys 前端视图

前端 SHALL 在侧边栏新增 `apiKeys` tab，视图包含：Key 主表（name / 掩码 key / 状态 badge / 有效期 / 额度进度条 / 最近使用 / 操作列：复制·编辑·启停·删除）、创建/编辑 modal、创建成功后的一次性明文展示（关闭后仅能 reveal 再看）、删除确认。启停为乐观更新，失败回滚并 toast。视图 MUST 遵循现有 Alpine.js 响应式模式（usage-log 视图模板），translations 五语言（en/zh/tr/id/pt）词条缺失时回退 key 名不崩溃。

#### 场景：创建后一次性明文展示
- **WHEN** 用户在 WebUI 创建新 Key
- **THEN** 弹窗展示完整明文并提供复制按钮，关闭后列表仅显示掩码

#### 场景：tab 切换渲染
- **WHEN** 用户点击侧边栏 apiKeys tab
- **THEN** 视图加载并展示 Key 列表，切换其他语言后界面不崩溃
