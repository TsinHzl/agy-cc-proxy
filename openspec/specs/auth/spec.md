# Auth Spec：webui-auth-hardening

## 适用模型族：N/A（WebUI 认证，与 Claude/Gemini 无关）
## 负责模块：`src/webui/index.js`, `src/config.js`

---

## 新增需求

### 需求：Session-based WebUI 认证

#### 场景：未设置密码时访问 WebUI
- **WHEN** `config.webuiPassword` 为空
- **THEN** 所有请求直接放行，无需登录

#### 场景：登录成功
- **WHEN** POST `/api/auth/login` 携带正确密码（`{ password: "xxx" }`）
- **THEN** 返回 200，Set-Cookie: `webui_session=<32字节随机hex>; HttpOnly; SameSite=Strict; Path=/`，响应体 `{ status: "ok" }`

#### 场景：登录失败
- **WHEN** POST `/api/auth/login` 携带错误密码
- **THEN** 返回 401，响应体 `{ status: "error", error: "Invalid password" }`，不泄露任何密码信息

#### 场景：已登录访问 API
- **WHEN** 请求携带有效未过期的 `webui_session` cookie
- **THEN** 请求正常通过，返回正常数据

#### 场景：未登录访问 API
- **WHEN** 请求不携带 `webui_session` cookie，且路径为 `/api/*`（除豁免路径）
- **THEN** 返回 401，`{ status: "error", error: "Unauthorized" }`

#### 场景：未登录访问静态页面
- **WHEN** 请求 `GET /`、`GET /index.html` 或其他非豁免静态路径，且无有效 session
- **THEN** 302 重定向到 `/login.html`

#### 场景：Session 过期
- **WHEN** `webui_session` cookie 存在，但 token 对应的 `expiresAt < Date.now()`
- **THEN** 清除 cookie，返回 401（API）或重定向 `/login.html`（页面）

#### 场景：登出
- **WHEN** POST `/api/auth/logout`（无需携带密码，只需有效 session）
- **THEN** 从内存 Map 中删除 token，清除 cookie，返回 `{ status: "ok" }`

---

### 需求：密码哈希存储

#### 场景：首次设置密码（POST /api/config/password）
- **WHEN** 当前无密码，POST `/api/config/password` 携带 `{ newPassword: "xxx" }`
- **THEN** 用 scrypt 哈希后，以 `scrypt:<salt_base64>:<hash_base64>` 格式写入 config

#### 场景：修改密码
- **WHEN** 当前已有哈希密码，POST `/api/config/password` 携带 `{ oldPassword: "xxx", newPassword: "yyy" }`
- **THEN** 先 scrypt 验证 `oldPassword`，通过后哈希 `newPassword` 写入 config

#### 场景：旧明文密码迁移
- **WHEN** 服务启动时，`config.webuiPassword` 存在但不以 `scrypt:` 开头
- **THEN** 打印 warn 日志提示用户通过 WebUI 重新设置密码；密码验证时仍支持明文比较（向后兼容，直到用户主动修改）

---

### 豁免路径（无需 session）

| 路径 | 方法 | 原因 |
|------|------|------|
| `/api/auth/login` | POST | 登录入口 |
| `/api/auth/url` | GET | OAuth 流程需要 |
| `/api/auth/complete` | POST | OAuth 回调完成 |
| `/api/auth/logout` | POST | 멱等操作，无需有效 session |
| `/api/config` | GET | 前端初始化读取配置 |
| `/login.html` | GET | 登录页面本体 |
| `/js/*`, `/css/*`, `/favicon*` | GET | 登录页面依赖的静态资源 |
