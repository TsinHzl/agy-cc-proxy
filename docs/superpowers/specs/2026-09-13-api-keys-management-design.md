# API Keys 管理页面 — 设计文档

> 日期：2026-09-13
> 状态：已确认（brainstorming 产出）
> 范围：参考 kiro2cc-proxy admin-ui 的 API Keys 功能，在 agy-cc-proxy 的 WebUI 中实现核心子集

## 1. 背景与目标

agy-cc-proxy 当前 `/v1/*` 仅支持单一 `config.apiKey` 主密钥鉴权（`src/config.js:18-25`、`src/server.js:96-120`）。参考 kiro2cc-proxy 的 admin-ui，新增多 API Key 管理能力，使不同客户端可使用独立 Key 接入，并支持有效期与消费额度控制。

### 范围内（In Scope）

- 多 API Key CRUD（创建 / 编辑 / 删除 / 启用禁用），列表掩码显示 + 复制（reveal 后取明文）
- 有效期：`durationDays` 懒激活模式（首次使用才开始计时），可设永不过期
- 消费额度：`spendingLimit`，metric 支持 `tokens`（input+output 总 token）与 `requests`（请求数）
- `/v1/*` 鉴权接入：新 Key 与 `config.apiKey` 主密钥并存，均可用
- 按 Key 用量统计：请求数、input/output token，来自扩展后的 usage-log 明细 + manager 冗余计数
- 前端：Alpine.js 新视图 `public/views/api-keys.html`，侧边栏新 tab `apiKeys`
- 存储：独立文件 `~/.config/antigravity-proxy/api-keys.json`（原子写 + 写锁）

### 范围外（Out of Scope）

- 绑定账号（boundCredentialIds）、账号池路由过滤
- cc-switch 深链接导入
- 批量勾选操作、清除无效 Key
- 面向 Key 持有者的自助查询 API（/api/user/*）
- USD 估算计费（仅 token / requests 两种 metric）
- 每模型用量明细表、请求记录归属地解析

## 2. 数据结构

新建 `src/api-keys/manager.js`（生命周期与校验逻辑）与 `src/api-keys/storage.js`（持久化）。

`~/.config/antigravity-proxy/api-keys.json`：

```json
{
  "version": 1,
  "keys": [
    {
      "id": "k_a1b2c3d4",
      "name": "my-laptop",
      "key": "sk-agy-<64hex>",
      "enabled": true,
      "durationDays": 30,
      "activatedAt": null,
      "expiresAt": null,
      "spendingLimit": { "metric": "tokens", "limit": 10000000 },
      "usage": { "requests": 0, "inputTokens": 0, "outputTokens": 0 },
      "createdAt": "2026-09-13T00:00:00.000Z",
      "lastUsedAt": null,
      "lastUsedIp": null
    }
  ]
}
```

字段约定：

- `id`：`k_` + 8 位 hex，用作 URL 参数与 usage-log 关联
- `key`：`sk-agy-` + 64 hex（复用 `generateApiKey()`，`src/config.js:13-15`），全量明文存储（与 `config.json` 明文存 `apiKey` 的现状一致）
- `durationDays: null` = 永不过期；`spendingLimit: null` = 不限额
- `spendingLimit.metric` 仅 `'tokens' | 'requests'`
- `usage` 为 manager 内存累计、节流落盘的冗余计数，是额度判定与统计的**权威数据源**（usage-log 明细仅作最近活动展示窗口，见 §7）

## 3. 存储层（src/api-keys/storage.js）

复用 `src/account-manager/storage.js:111-165` 的模板：

- promise 链 writeLock 串行化所有写操作
- 写前 `JSON.parse` 校验序列化结果
- 原子写：先写 `.tmp` 再 `rename`
- `loadApiKeys()`：文件不存在 → 返回 `{ version: 1, keys: [] }` 默认值（老部署零迁移）
- `saveApiKeys(data)`：加锁落盘

路径常量在 `src/constants.js` 新增（对齐 `USAGE_LOG_PATH` 惯例，`src/constants.js:147-150` 之后）：

```js
export const API_KEYS_PATH = path.join(os.homedir(), '.config/antigravity-proxy/api-keys.json');
```

## 4. Manager 层（src/api-keys/manager.js）

纯逻辑模块，持有内存态，导出：

- `listKeys()` / `createKey({name, durationDays, spendingLimit})` / `updateKey(id, patch)` / `deleteKey(id)`
- `verifyApiKeyMulti(providedKey)`：先与 `config.apiKey` 主密钥比对（命中返回 `{ id: null }`），再遍历 keys 逐一调用现有 timing-safe `verifyApiKey()`（`src/config.js:18-25`），命中返回该 key 记录；未命中返回 `null`
- `checkAndActivate(key)`：懒激活 + 过期/禁用判定
- `checkQuota(key)`：额度判定
- `recordUsage(keyId, {inputTokens, outputTokens})`：更新 `usage` 冗余计数 + `lastUsedAt/lastUsedIp`，isDirty 标记，60s 周期落盘（复用 `src/modules/usage-log.js` 的周期保存模式）

不比较哈希、不做 `Array.includes` 短路比较；key 数量小（个位数），逐一遍历 timing-safe 比较可接受。

## 5. 鉴权流程（src/server.js:96-120）

现有中间件改造：

1. 提取 key（`Authorization: Bearer` 或 `x-api-key`，不变）
2. `verifyApiKeyMulti(providedKey)`：
   - 未命中 → 401 `{"type":"error","error":{"type":"authentication_error","message":"Invalid or missing API key"}}`（与现状一致）
   - 命中主密钥（`id: null`）→ 放行，`req._apiKeyId = null`，行为与现状完全一致（零回归）
3. 命中管理 Key 后、`next()` 前依次执行：
   - `enabled === false` → 401 `authentication_error`，`message: 'API key has been disabled'`
   - 懒激活：`activatedAt === null && durationDays != null` → 置 `activatedAt = now`、`expiresAt = now + durationDays * 864e5`，异步 save；**本次请求放行**（激活即首用）
   - 过期：`expiresAt !== null && now > expiresAt` → 401 `authentication_error`，`message: 'API key has expired'`
   - 额度：`spendingLimit` 且 `usage[metric] >= limit` → 429 `rate_limit_error`，`message: 'API key spending limit exceeded'`（对齐 CLAUDE.md 第 5 条：429 让 Claude Code 自行退避）
4. 通过 → `req._apiKeyId = key.id`，`req._apiKeyRecord = key`，放行

计数增加发生在 `usageLog.record()` 侧（仅成功请求计数）：`src/server.js:928-939、979-990` 两处 `usageLog.record(...)` 调用点旁调用 `recordUsage()`。额度判定读内存计数，最终一致（允许限界内 ±1 次请求越过，可接受）。

## 6. usage-log 扩展（src/modules/usage-log.js）

- `record()`（`src/modules/usage-log.js:97-129`）增加 `keyId = null` 解构与落盘字段
- `src/server.js` 两处 record 调用点增加 `keyId: req._apiKeyId || null`
- 老记录无 `keyId` → 读取侧 `r.keyId || null` 兜底，归入「主密钥/未知」
- usage-log 文件无需迁移

注：现有记录中 `apiKey` 字段记录的是**后端账号 email**（经 maskEmail 脱敏），与调用方 key 语义不同；新增独立的 `keyId` 字段避免混淆。

## 7. per-key 统计聚合

**决策：后端聚合，权威计数存于 manager 的 `usage` 字段。**

- 否决前端从 `/api/usage-log` 聚合：usage-log 有 5000 条滑动上限（`src/modules/usage-log.js:9`），翻滚后历史丢失，额度判定会漏计
- 否决实时扫描 usage-log 聚合端点：同样受 5000 条窗口限制
- 权衡：`usage` 字段与 usage-log 明细存在重复计数（denormalization）——明细仅作「最近活动」展示窗口，权威计数以 `usage` 字段为准，二者职责分离
- 重置：编辑 Key 时可重置 `usage`（可选，管理动作）

## 8. WebUI REST 端点

全部位于 `createAuthMiddleware`（`src/webui/index.js:179-192`）之后，无需加白名单。在 `src/webui/index.js` 路由区新增：

| 方法/路径 | 请求体 | 响应 |
|---|---|---|
| `GET /api/keys` | — | `{status:'ok', keys:[{id,name,enabled,durationDays,activatedAt,expiresAt,spendingLimit,usage,createdAt,lastUsedAt,keyMasked}]}` |
| `POST /api/keys` | `{name, durationDays?, spendingLimit?}` | `{status:'ok', key: {...record, key: 全量明文}}`（仅创建时返回明文） |
| `PATCH /api/keys/:id` | `{name?, enabled?, durationDays?, spendingLimit?, resetUsage?}` | `{status:'ok', key: masked}` |
| `DELETE /api/keys/:id` | — | `{status:'ok'}` |
| `GET /api/keys/:id/reveal` | — | `{status:'ok', key: 明文}` |
| `GET /api/keys/:id/usage` | — | `{status:'ok', summary:{requests,inputTokens,outputTokens}, recent:[...usage-log 明细]}` |

- 列表默认掩码（`sk-agy-****last4`）
- `GET .../usage` 的 `recent` 从 `usageLog.getRecords()` 按 `keyId` 过滤前 N 条（老记录无 keyId 自然排除）

## 9. 前端视图

新增文件：

- `public/views/api-keys.html` — 结构对齐 `public/views/usage-log.html`：PageHead（标题 + 新建按钮）→ keys 主表（name / 掩码 key / 状态 badge / 有效期 / 额度进度条 / 最近使用 / 操作列：复制·编辑·启停·删除）→ 创建/编辑 `<dialog class="modal">` → 删除确认
- `public/js/components/api-keys-manager.js` — Alpine 组件，复制 `usage-log-viewer.js` 骨架：`init()` 拉数据 + `$watch('$store.global.activeTab')` 刷新 + 轮询 + `agoTick` 心跳

修改文件：

- `public/js/store.js:10` — `validTabs` 追加 `'apiKeys'`
- `public/app.js:11-17` — `Alpine.data('apiKeysManager', window.Components.apiKeysManager)`
- `public/index.html` — 侧边栏 nav 按钮（Accounts 之后）、视图容器 div（`x-show` + `x-load-view`）、`<script>` 引入（420 行附近）
- `public/js/translations/{en,zh,tr,id,pt}.js` — 追加词条（漏加不崩溃，`store.js:96` 回退 key 名）

交互流：

- 创建成功弹一次性明文 key 展示 + 复制按钮（关闭后不可再看，只能 reveal）
- 复制按钮 `navigator.clipboard` + `$store.global.showToast`
- 启停为乐观更新，失败回滚 + toast

## 10. 风险与兼容性

| 风险 | 应对 |
|---|---|
| 老部署升级 | `api-keys.json` 不存在 → 空 keys，鉴权先走主密钥，行为与现状完全一致 |
| usage-log 老记录 | 无 `keyId` 字段，读取侧兜底归入主密钥/未知 |
| translations 漏词条 | `t()` 回退 key 名，不崩溃 |
| WebUI CRUD 与 /v1 懒激活写盘竞争 | storage promise 链锁串行化；激活字段写丢的最坏后果是重新计时，可接受 |
| 主密钥流量不可统计 | 主密钥 `keyId: null`，明细归入「未知」，不纳入额度体系 |

## 11. 待决问题

无。
