# 变更提案：api-key-management

## 背景

当前代理服务器仅支持单个 API Key（`config.apiKey`）用于保护 `/v1/*` 端点。用户无法在 WebUI 中自主创建、管理多个 API Key，这限制了多客户端/多用户场景的使用。

## 目标范围

**在范围内：**
- 后端支持无限数量 API Key（存储在 `config.json` 的 `apiKeys` 数组中）
- 认证中间件同时支持旧的单 `apiKey` 字段（向后兼容）和新的 `apiKeys` 数组
- WebUI 新增 API Key 管理 REST 端点（List/Create/Delete）
- 前端新增 "Access" 设置 Tab，包含完整的 API Key CRUD UI
- 生成格式：`agy-<32位随机十六进制字符>`
- 每个 Key 记录：id、name（可选备注）、key（创建后仅显示一次）、createdAt

**不在范围内：**
- API Key 权限/角色控制（所有 Key 等权访问 /v1/*）
- API Key 过期机制
- API Key 使用量统计（per-key 维度）
- 修改现有单 `apiKey` 字段的存储方式
- 创建后找回完整 Key（设计如此：Key 只在创建响应中出现一次，之后需删除重建）
- i18n 翻译键（UI 文字全部使用硬编码英文，不接入 `$store.global.t()` 体系，保持与 server-config.js 中部分英文硬编码一致）

## 技术方案

### 1. 后端配置层（`src/config.js`）
在 `DEFAULT_CONFIG` 中添加 `apiKeys: []` 字段，每个元素为：
```json
{ "id": "<crypto.randomUUID()>", "name": "My Key", "key": "agy-<32hex>", "createdAt": "ISO8601" }
```
其中 `id` 使用 Node.js 内置 `crypto.randomUUID()`，`key` 使用 `crypto.randomBytes(16).toString('hex')` 加前缀生成。

**Key 持久化**：`key` 字段以**明文**存储在 `config.json`（与现有 `config.apiKey` 保持一致）。需在 `getPublicConfig()` 中对 `apiKeys` 数组里每个元素的 `key` 字段进行脱敏（遮蔽为 `agy-****`），防止通过 `GET /api/config` 旁路泄露。

### 2. 认证中间件（`src/server.js`）
更新 `app.use('/v1', ...)` 中间件，验证逻辑：

**放行条件**（跳过验证）：`!config.apiKey && (!config.apiKeys || config.apiKeys.length === 0)`
> 注：`config.apiKey` 已包含环境变量 `API_KEY` 覆盖（`config.js:125` 在加载时已将 `process.env.API_KEY` 写入 `config.apiKey`），因此无需单独处理环境变量分支。

**通过条件**：满足下列任一 Key 则通过，否则返回 401：
- 请求 Key === `config.apiKey`（向后兼容旧字段及环境变量）
- 请求 Key 匹配 `config.apiKeys` 数组中任意元素的 `key` 字段值

### 3. WebUI API 路由（`src/webui/index.js`）
新增三个路由，均受 `createAuthMiddleware()` 的 `webuiPassword` 保护（`isApiRoute` 为 true）。前端通过 `window.utils.request()` 自动注入 `X-WebUI-Password` 头，行为与现有 API 路由一致。

- `GET /api/api-keys` — 返回 Keys 列表，`key` 字段遮蔽为 `agy-****`
- `POST /api/api-keys` — 生成新 Key，**仅本次响应返回完整 key 值**
- `DELETE /api/api-keys/:id` — 按 `id` 删除指定 Key

**`saveConfig` 数组行为说明**：`deepMerge()` 在 `isObject()` 判断时排除数组（`!Array.isArray(item)`），数组通过 `Object.assign` 直接替换而非合并。因此 `saveConfig({ apiKeys: newArray })` 能正确覆盖整个 `apiKeys` 数组，DELETE 操作不存在合并残留问题。

### 4. 前端（Alpine.js）
分两步完成，保证独立可验证：

**步骤 A — 组件实现**（可先独立开发调试）：
- `public/js/components/api-keys.js` — 完整 API Key 管理 Alpine.js 组件

**步骤 B — 集成注册**（步骤 A 完成后执行，三处协同生效）：
- `public/js/store.js` — `validSettingsTabs` 和 `validSettingsTabs` 数组均添加 `'access'`（URL hash 路由生效）
- `public/views/settings.html` — 新增 "Access" Tab 按钮 + 面板（`x-show="$store.global.settingsTab === 'access'"`）
- `public/app.js` — 注册 `Alpine.data('apiKeys', window.Components.apiKeys)`

## 预期影响

- 向后兼容：现有 `config.apiKey` 字段继续生效，无需迁移
- 新增认证路径不影响 Google OAuth / account-manager 流程
- 前端新增一个 Settings Tab，对其他 Tab 无影响

## 风险

| 风险 | 应对 |
|------|------|
| Key 明文泄露（config.json） | `getPublicConfig()` 脱敏；config.json 本身需用户负责文件系统权限保护 |
| GET /api/config 旁路泄露 | 明确在 `getPublicConfig()` 中对 `apiKeys[*].key` 进行遮蔽（本次变更包含此修复） |
| saveConfig() 并发写冲突 | 现有机制无文件锁，多请求并发可能导致竞态写；本次**接受此风险**（现有 config 所有字段均面临相同问题，不单独处理） |
| 旧版单 Key 迁移 | 保留 `config.apiKey` 验证分支，无需用户操作 |
