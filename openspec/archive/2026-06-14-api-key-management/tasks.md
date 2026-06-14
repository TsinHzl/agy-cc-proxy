# 任务清单：api-key-management

## 状态：ARCHIVED

## 任务

- [x] T1: 在 `src/config.js` 的 `DEFAULT_CONFIG` 中添加 `apiKeys: []` 字段；在 `getPublicConfig()` 中遍历 `apiKeys` 数组，将每个元素的 `key` 字段替换为 `agy-****`
- [x] T2: 在 `src/server.js` 中**替换**原有的 `if (!config.apiKey) return next()` 单字段放行语句，改为双字段联合判断：放行条件 `!config.apiKey && (!config.apiKeys || config.apiKeys.length === 0)`；通过条件为 Key 匹配 `config.apiKey` 或 `config.apiKeys` 任意元素的 `key` 字段
- [x] T3: 在 `src/webui/index.js` 中新增三个路由：`GET /api/api-keys`（遮蔽 key）、`POST /api/api-keys`（使用 `crypto.randomBytes(16).toString('hex')` 生成 key，格式 `agy-<32hex>`，仅此响应返回完整值）、`DELETE /api/api-keys/:id`（按 id 删除，通过 `saveConfig({ apiKeys: filteredArray })` 覆盖数组）
- [x] T4: 新建 `public/js/components/api-keys.js`，以 `window.Components.apiKeys = () => ({...})` 模式挂载（与项目现有组件注册约定一致），实现列表展示/创建弹窗含一次性 Key 显示/删除确认
- [x] T5: 前端集成（三处协同）：`public/js/store.js` 的 `validSettingsTabs` 数组添加 `'access'`；`public/views/settings.html` 新增 "Access" Tab 按钮和面板；`public/app.js` 注册 `Alpine.data('apiKeys', window.Components.apiKeys)`

## 验收标准

- [ ] 调用 `POST /api/api-keys` 可生成格式为 `agy-<32hex>` 的 Key，响应中返回完整 key 值
- [ ] 调用 `GET /api/api-keys` 返回 Key 列表，每个元素的 key 字段显示为 `agy-****`
- [ ] 调用 `GET /api/config` 不会在 apiKeys 数组中暴露任何 key 明文（已脱敏）
- [ ] 调用 `DELETE /api/api-keys/:id` 删除指定 Key 后，`GET /api/api-keys` 列表中不再包含该条目
- [ ] 使用新生成的 Key 调用 `POST /v1/messages` 返回正常响应（非 401）
- [ ] 使用已删除的 Key 调用 `POST /v1/messages` 返回 401
- [ ] `config.apiKey` 为空字符串且 `config.apiKeys` 数组为空时，所有 `/v1/*` 请求不受认证限制
- [ ] 旧的单 `config.apiKey`（含 `API_KEY` 环境变量覆盖）仍然有效
- [ ] `webuiPassword` 未设置时，`GET/POST/DELETE /api/api-keys` 无需密码即可访问（与现有 `/api/accounts` 行为一致）
- [ ] 前端 Settings 页面显示 "Access" Tab，URL hash 路由 `#settings/access` 可直接跳转；创建/列出/删除操作无 JS 报错
