# 变更提案：api-keys-management

## 背景

agy-cc-proxy 当前 `/v1/*` 仅支持单一 `config.apiKey` 主密钥鉴权（`src/config.js:18-25`、`src/server.js:96-120`）。参考 kiro2cc-proxy 的 admin-ui，新增多 API Key 管理能力，使不同客户端可使用独立 Key 接入，并支持有效期与消费额度控制。设计已与用户确认（`docs/superpowers/specs/2026-09-13-api-keys-management-design.md`，commit d3c0ff6）。

## 目标范围

**在范围内：**
- 多 API Key CRUD（创建 / 编辑 / 删除 / 启用禁用），列表掩码显示 + reveal 明文
- 有效期：`durationDays` 懒激活模式（首次使用才开始计时），`null` = 永不过期
- 消费额度：`spendingLimit`，metric 支持 `tokens`（input+output 总 token）与 `requests`
- `/v1/*` 鉴权接入：新 Key 与 `config.apiKey` 主密钥并存，均可用；主密钥行为零回归
- 按 Key 用量统计：请求数、input/output token，权威计数存 manager `usage` 冗余字段，usage-log 明细增加 `keyId` 字段作最近活动展示窗口
- 有效期编辑语义：修改已激活 Key 的 `durationDays` 基于**原 activatedAt** 重算 `expiresAt`；改为 null 清空过期时间
- 前端：Alpine.js 新视图 `public/views/api-keys.html`，侧边栏新 tab `apiKeys`
- 存储：独立文件 `~/.config/antigravity-proxy/api-keys.json`（原子写 + 写锁）

**不在范围内：**
- 绑定账号（boundCredentialIds）、账号池路由过滤
- cc-switch 深链接导入
- 批量勾选操作、清除无效 Key
- 面向 Key 持有者的自助查询 API（/api/user/*）
- USD 估算计费（仅 tokens / requests 两种 metric）
- 每模型用量明细表、请求记录归属地解析

## 技术方案

- 新模块 `src/api-keys/manager.js`（生命周期/校验/额度逻辑）+ `src/api-keys/storage.js`（持久化，复用 `src/account-manager/storage.js` 的 promise 链写锁 + 原子写模板）
- `src/constants.js` 新增 `API_KEYS_PATH`（对齐 `USAGE_LOG_PATH` 惯例）
- 鉴权改造 `src/server.js` 中间件：`verifyApiKeyMulti()` 先比主密钥（命中 `id: null` 放行），再 timing-safe 遍历管理 Key；管理 Key 命中后依次判定 enabled → 懒激活 → 过期（401 authentication_error）→ 额度（429 rate_limit_error，让 Claude Code 自行退避）
- `src/modules/usage-log.js` `record()` 增加 `keyId` 字段（老记录读取侧 `r.keyId || null` 兜底，无需迁移）
- 用量计数：`usageLog.record()` 调用点旁调用 `recordUsage()`（仅成功请求计数），manager 60s 周期落盘
- WebUI REST 端点（`src/webui/index.js`，鉴权中间件之后）：`GET/POST /api/keys`、`PATCH/DELETE /api/keys/:id`、`GET /api/keys/:id/reveal`、`GET /api/keys/:id/usage`
- 前端：`public/views/api-keys.html` + `public/js/components/api-keys-manager.js`，接入 `store.js` / `app.js` / `index.html` / translations

## 预期影响

- 老部署升级零迁移：`api-keys.json` 不存在 → 空 keys，鉴权先走主密钥，行为与现状完全一致
- usage-log 文件无需迁移，老记录无 `keyId` 自然归入「主密钥/未知」
- 主密钥流量不纳入额度体系（`keyId: null`）
- 额度判定读内存计数，最终一致（tokens metric 允许单次大请求一次性越过 limit）
- translations 漏词条不崩溃（`t()` 回退 key 名）

## 风险

| 风险 | 应对 |
|---|---|
| 明文存储管理 Key | 与 `config.json` 明文存 `apiKey` 现状一致，不引入新的安全降级 |
| WebUI CRUD 与 /v1 懒激活写盘竞争 | storage promise 链锁串行化；激活字段写丢最坏后果是重新计时，可接受 |
| 429 语义与上游账号限流混淆 | 返回 `rate_limit_error` 语义一致，Claude Code 退避行为相同 |
| 主密钥流量不可统计 | 明细归入「未知」，不纳入额度体系 |
