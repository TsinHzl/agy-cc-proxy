# 技术方案：api-keys-management

## 上下文

设计已与用户确认（`docs/superpowers/specs/2026-09-13-api-keys-management-design.md`，commit d3c0ff6）。现状：`/v1/*` 仅支持单一 `config.apiKey` 主密钥（`src/config.js:13-25`），鉴权中间件位于 `src/server.js:96-120`；usage-log 明细上限 5000 条滑动窗口（`src/modules/usage-log.js:9`）。

## 目标 / 非目标

**目标：** 多 Key CRUD、懒激活有效期、消费额度、/v1 鉴权接入（主密钥零回归）、按 Key 用量统计、WebUI 视图。

**非目标：** 账号绑定、cc-switch 导入、批量操作、自助查询 API、USD 计费、每模型明细。

## 决策

### D1：存储 — 独立文件 + 账号存储模板

`~/.config/antigravity-proxy/api-keys.json`，路径常量 `API_KEYS_PATH` 加入 `src/constants.js`（对齐 `USAGE_LOG_PATH` 惯例）。`src/api-keys/storage.js` 复用 `src/account-manager/storage.js:111-165` 模板：promise 链 writeLock 串行化、写前 `JSON.parse` 校验、tmp+rename 原子写。不选 SQLite（accounts.json/config.json 均为文件存储，保持一致；SQLite 仅 auth 模块使用）。不选塞入 config.json（CRUD 高频写，config.json 是低频配置文件）。

### D2：key 生成 — 复用 `generateApiKey()`

`sk-agy-` + 48 hex（`randomBytes(24)`，`src/config.js:13-15`），全量明文存储，与 config.json 明文存 apiKey 现状一致，不引入哈希存储（避免 reveal 功能失效）。注：设计文档 §2 写 `sk-agy-<64hex>` 为笔误，`generateApiKey()` 实际输出 48 hex，spec 以代码事实为准。

### D3：鉴权 — 主密钥优先的 `verifyApiKeyMulti()`

`src/server.js` 中间件改造为先比主密钥（命中 `id: null` 放行，保证零回归），再 timing-safe 遍历管理 Key。不做哈希查找/`Array.includes` 短路比较——key 数量个位数，逐一遍历 timing-safe 可接受（安全 > 微优化）。禁用/过期返回 401、超额返回 429 `rate_limit_error`——对齐 CLAUDE.md 第 5 条：429 让 Claude Code 自行退避重试。判定顺序固定：enabled → 懒激活 → 过期 → 额度（激活请求即使超额也放行，下一请求才拒）。

### D4：懒激活 — 中间件内判定 + 异步落盘

`checkAndActivate()` 在鉴权路径内判定，激活即首用（本次请求放行）。落盘异步执行（await 会给首用请求加写延迟）。写丢最坏后果是重新计时，可接受（设计文档 §10 已确认）。

### D5：用量权威计数 — manager 冗余字段，非 usage-log 聚合

**决策：后端聚合，权威计数存 manager `usage` 字段。**
- 否决前端从 `/api/usage-log` 聚合：5000 条滑动窗口翻滚后历史丢失，额度判定会漏计
- 否决实时扫描聚合端点：同样受窗口限制
- 明细（新增 `keyId` 字段）仅作「最近活动」展示窗口，二者职责分离（denormalization 为有意决策）
- 计数发生在 `usageLog.record()` 调用点旁（仅成功请求计数）：`src/server.js:928-939`（流式）、`979-990`（非流式）
- isDirty + 60s 周期落盘，复用 `src/modules/usage-log.js` 周期保存模式

### D6：WebUI 端点 — 全部置于鉴权中间件之后

6 个端点（GET/POST /api/keys、PATCH/DELETE /api/keys/:id、reveal、usage）无需白名单调整。列表掩码 `sk-agy-****last4`，仅创建响应返回明文。recent 明细从 `usageLog.getRecords()` 按 `keyId` 过滤（老记录无 keyId 自然排除）。

### D7：前端 — usage-log 视图模板克隆

`api-keys.html` 对齐 `views/usage-log.html` 结构（PageHead/PANEL/table-kit/Empty State/PANEL_FOOT）；`api-keys-manager.js` 克隆 `usage-log-viewer.js` 骨架（init / `$watch activeTab` 刷新 / 轮询 / `agoTick` 心跳 / textarea fallback 复制）。接入点：`store.js:10` validTabs、`app.js:11-17` Alpine.data 注册、`index.html` nav + 视图容器 + script（420 行附近）、translations 五语言追加（漏加不崩溃，`store.js:96` 回退）。

## 风险 / 权衡

| 风险 | 权衡/应对 |
|---|---|
| 明文存储管理 Key | 与现状 config.json 明文存 apiKey 一致，无新增安全降级；掩码仅作用于展示层 |
| WebUI CRUD 与懒激活写盘竞争 | storage 写锁串行化；激活字段写丢 → 重新计时，可接受 |
| usage 冗余计数与明细重复 | 有意 denormalization：额度判定需全量历史，明细仅展示窗口 |
| 额度最终一致（±1 次越过） | 内存判定 + 成功后计数，限界内越过可接受 |
| 429 与上游账号限流混淆 | 语义一致（rate_limit_error），客户端退避行为相同 |
| webuiPassword 未配置的部署 | Key 管理 API 处于无鉴权暴露状态（现状继承，与现有 /api/* 行为一致，非本变更引入） |

## 迁移方案

无迁移：`api-keys.json` 不存在 → 空默认值；usage-log 老记录无 `keyId` → 读取侧 `r.keyId || null` 兜底，文件不动。

## 待决问题

无。
