# 任务清单：api-keys-management

## 状态：ARCHIVED

## 任务

- [x] 任务 1：constants.js 新增 `API_KEYS_PATH` 常量（验证：node -e import 后打印路径）
- [x] 任务 2：新建 `src/api-keys/storage.js` —— `loadApiKeys()`（文件不存在返回 `{version:1, keys:[]}` 默认值）/ `saveApiKeys()`（promise 链写锁 + JSON 校验 + tmp/rename 原子写），复用 `src/account-manager/storage.js:111-165` 模板（验证：node 脚本 load→save→load round-trip）
- [x] 任务 3：新建 `src/api-keys/manager.js` —— `listKeys()` / `createKey({name,durationDays,spendingLimit})` / `updateKey(id,patch)` / `deleteKey(id)` / `verifyApiKeyMulti(providedKey)`（主密钥→`{id:null}`，timing-safe 遍历）/ `checkAndActivate(key)` / `checkQuota(key)` / `recordUsage(keyId,{inputTokens,outputTokens})`（isDirty + 60s 周期落盘）（验证：node 脚本逐 API 断言）
- [x] 任务 4：`src/server.js` /v1 鉴权中间件改造 —— 接入 `verifyApiKeyMulti()`，管理 Key 依次判定 disabled(401) → 懒激活 → 过期(401) → 额度(429)，`req._apiKeyId` / `req._apiKeyRecord` 挂载；主密钥路径行为零回归（验证：curl 主密钥 200 / 无效 401 / 禁用 401 / 过期 401 / 超额 429）
- [x] 任务 5：`src/modules/usage-log.js` `record()` 增加 `keyId` 字段；`src/server.js` 两处 `usageLog.record()` 调用点（流式 928-939、非流式 979-990）追加 `keyId: req._apiKeyId || null` 并调用 `recordUsage()`（验证：curl 一次请求后检查 usage-log.json 记录含 keyId 且 manager usage 计数 +1）
- [x] 任务 6：`src/webui/index.js` 新增 REST 端点 —— `GET /api/keys`（掩码列表）/ `POST /api/keys`（创建返回一次性明文）/ `PATCH /api/keys/:id`（编辑/启停/resetUsage）/ `DELETE /api/keys/:id` / `GET /api/keys/:id/reveal` / `GET /api/keys/:id/usage`（summary + recent 明细）（验证：curl 全部 6 端点 happy path + 404）
- [x] 任务 7：前端新视图 `public/views/api-keys.html` + `public/js/components/api-keys-manager.js`（结构对齐 usage-log.html / usage-log-viewer.js 模板；PageHead + 新建按钮、主表 name/掩码/状态 badge/有效期/额度进度条/最近使用/操作列、创建/编辑 modal、一次性明文展示+复制、删除确认、启停乐观更新）（验证：浏览器手测 CRUD 全流程）
- [x] 任务 8：前端接入 —— `public/js/store.js:10` validTabs 追加 `'apiKeys'`、`public/app.js` 注册 `Alpine.data('apiKeysManager', ...)`、`public/index.html` 侧边栏 nav + 视图容器 div + script 引入、`public/js/translations/{en,zh,tr,id,pt}.js` 追加词条（验证：浏览器切换 tab 正常渲染、切换语言无崩溃）
- [x] 任务 9：集成验证 —— 重启服务跑手测矩阵：老部署升级场景（删除 api-keys.json 后重启，主密钥照常）、/v1 五种鉴权分支、按 Key 用量统计与额度触发、WebUI 全 CRUD。手测清单：
  1. 删除 api-keys.json → 重启 → 主密钥 curl /v1/messages 200
  2. 无效 key → 401 authentication_error；禁用 key → 401（'API key has been disabled'）
  3. durationDays=0（立即过期）或 expiresAt 已过 → 401（'API key has expired'）
  4. spendingLimit tokens 与 requests 两种 metric 分别设小值 → 各触发 429（'API key spending limit exceeded'）
  5. WebUI 创建 Key → 明文弹窗 + 复制 → 列表掩码 → reveal 明文一致
  6. WebUI 编辑 durationDays（已激活 Key）→ expiresAt 重算正确
  7. WebUI 启停 → /v1 立即生效（停用 401 / 启用恢复）
  8. usage-log.json 新记录含 keyId；manager usage 计数与 /api/keys/:id/usage summary 一致
  9. 删除 Key → /v1 该 key 401；WebUI 五语言切换无崩溃

## 验收标准

- [x] 老部署升级零迁移：无 api-keys.json 时主密钥鉴权行为与现状完全一致（curl 200）
- [x] /v1 鉴权五分支正确：主密钥 200、无效 401 authentication_error、禁用 401、过期 401、超额 429 rate_limit_error
- [x] durationDays 懒激活：创建后未使用不计时，首次 /v1 调用激活并写 expiresAt
- [x] spendingLimit 额度：tokens 与 requests 两种 metric 均能触发 429
- [x] usage-log 新记录含 keyId，manager usage 冗余计数与明细一致
- [x] WebUI 六个 REST 端点全部可用，列表默认掩码、仅创建响应返回明文
- [x] 前端 apiKeys tab 完整 CRUD + 复制 + 启停 + 删除确认，五语言无崩溃
