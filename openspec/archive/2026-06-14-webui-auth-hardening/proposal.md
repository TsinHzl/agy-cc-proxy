# 变更提案：webui-auth-hardening

## 背景

当前 WebUI 密码保护机制在公网部署环境下存在多项安全漏洞：
- 密码以明文存储在 config.json，比较时直接 `===` 无哈希
- SSE 流（日志、用量日志）通过 `?password=` URL 参数传递密码，会写入服务器 access log
- 密码持久化在 localStorage，易被 XSS 读取
- 每次 API 请求都在 header 中携带密码明文（`x-webui-password`）
- 静态 HTML 页面本体无需密码即可访问

## 目标范围

**在范围内：**
- 引入 session token 机制（登录一次，颁发 httpOnly cookie）
- 密码使用 Node.js 内置 `crypto.scrypt` 哈希存储（无新依赖）
- 新增专用登录页面 `public/login.html`
- 静态页面访问时检查 session，未登录重定向到 `/login.html`
- SSE 流改用 cookie 鉴权，去掉 `?password=` URL 参数
- 去掉前端 `x-webui-password` header 传递逻辑
- 前端去掉 `webuiPassword` localStorage 存储
- 旧密码格式（明文）自动检测并提示重新设置（迁移引导）

**不在范围内：**
- 代理 API `/v1/messages` 的鉴权（由现有 apiKey 机制负责）
- 多用户/RBAC 权限系统
- OAuth 登录替代方案
- HTTPS 配置（建议通过反向代理 Nginx/Caddy 处理）

## 技术方案

### Session 机制
- 登录时：POST `/api/auth/login` → 验证密码（scrypt 比对）→ 生成 `crypto.randomBytes(32).toString('hex')` token → 写入内存 Map `{ token: { expiresAt } }` → Set-Cookie: `webui_session=<token>; HttpOnly; SameSite=Strict; Path=/`
- 每个受保护请求：读取 `req.cookies.webui_session`，在 Map 中查找并检查过期
- Session 有效期：24 小时（可配置）
- 登出：POST `/api/auth/logout` → 从 Map 中删除 token，清除 cookie

### 密码哈希
- 存储格式：`scrypt:<salt>:<hash>`（Base64 编码）
- 哈希参数：N=16384, r=8, p=1（适合低配服务器）
- 迁移：启动时检测 `config.webuiPassword` 是否为旧格式（不含 `scrypt:` 前缀），若是则标记为需要重新设置

### Cookie 解析
- 使用 Node.js 内置解析，避免引入 `cookie-parser` 依赖（自实现 10 行 cookie 解析）

### 中间件顺序
`createAuthMiddleware()` 必须在 `express.static()` **之前** 挂载，才能拦截静态页面请求做重定向。

### 豁免路径（无需 session）
| 路径 | 说明 |
|------|------|
| `POST /api/auth/login` | 登录入口 |
| `POST /api/auth/logout` | 不需要有效 session 也可调用（멱等）|
| `GET /api/auth/url` | OAuth 流程 |
| `POST /api/auth/complete` | OAuth 回调完成 |
| `GET /api/config` | 前端初始化读配置 |
| `GET /login.html` | 登录页面本体 |
| `GET /js/*`, `GET /css/*`, `GET /favicon*` | 登录页依赖资源 |

### 保护范围
- 所有未在豁免列表中的 `/api/*` 路由
- 所有未豁免的静态页面请求（未登录时 302 重定向到 `/login.html`）

### 改密后 Session 失效
`POST /api/config/password` 成功后，清空内存中所有 session token，强制所有在线用户重新登录。

## 预期影响

- 现有已设置密码的用户：首次访问被要求重新设置密码（明文→哈希迁移）
- 未设置密码的用户：无影响，登录页面自动跳过认证
- Claude Code CLI 的代理调用：无影响（走 `/v1/messages` + apiKey）

## 风险

- Session 存储在内存中，服务器重启后所有用户需重新登录（可接受）
- `POST /api/config/password` 改密流程需同步更新为哈希存储
- 旧明文密码迁移时，用户需要知道原始密码才能重新设置（无法反推）
- **CSRF**：cookie 设置 `SameSite=Strict`，防御浏览器发起的跨站请求；`POST /api/auth/complete` 依赖 OAuth state 参数完成 CSRF 防护（非浏览器场景）
- **暴力破解**：`POST /api/auth/login` 暂无速率限制，建议通过反向代理（Nginx limit_req）在入口处限速；后续可在应用层补充基于 IP 的限速，不纳入本次范围
- **Session 固定**：登录成功后始终生成全新 token，不复用已有 token
