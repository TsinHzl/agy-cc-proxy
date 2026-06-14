# 任务清单：webui-auth-hardening

## 状态：ARCHIVED

## 任务

- [x] T1. 在 `src/webui/index.js` 中实现 session 内存存储（`Map<token, {expiresAt}>`，有效期 24 小时，定时清理过期 entry）及内联 cookie 解析工具函数（手动解析 `req.headers.cookie`，无需引入新依赖）；session 固定防护：每次成功登录必须生成全新 `crypto.randomBytes(32).toString('hex')` token，不得复用已有 token
- [x] T2. 在 `src/config.js` 中实现 `hashPassword(plain)` / `verifyPassword(plain, hash)` (crypto.scrypt)，并实现旧明文密码迁移检测
- [x] T3. 重写 `src/webui/index.js` 中 `createAuthMiddleware()`，挂载位置在 `express.static` 之前：(a) 路径为 `/api/*`（非豁免）且无有效 session → 返回 401 JSON；(b) 其他所有非豁免路径（页面请求）且无有效 session → 302 重定向 `/login.html`；(c) `/account-limits` 和 `/health` 同样受 session 保护；豁免路径列表：`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/url`、`POST /api/auth/complete`、`GET /api/config`、`/login.html`、`/js/*`、`/css/*`、`/favicon*`
- [x] T4. 在 `src/webui/index.js` 中新增 `POST /api/auth/login` 和 `POST /api/auth/logout` 路由
- [x] T5. 在 `src/webui/index.js` 中更新 `POST /api/config/password` 路由：改密时使用哈希存储，改密成功后立即全量清空 session Map（所有在线用户均需重新登录，为预期行为）
- [x] T6. 新建 `public/login.html`：最简登录表单，成功后跳转 `/`
- [x] T7. 修改 `public/js/utils.js` 中 `request()` 函数签名：移除第三参数 `webuiPassword`，删除 `x-webui-password` header 注入和 `prompt()` 401 重试逻辑
- [x] T8. 清理前端 `public/js/store.js`：去掉 `webuiPassword` 状态和 `localStorage` 存取
- [x] T9. 清理前端 URL 密码参数及 webuiPassword 引用：`logs-viewer.js` 去掉 `/api/logs/stream?password=` 和 `webuiPassword` 读取；`usage-log-viewer.js` 去掉 `/api/usage-log?password=` 和 `webuiPassword` 读取（两者均改为依赖 cookie 鉴权）
- [x] T10a. 清理工具类调用方：`public/app.js`、`public/js/utils/account-actions.js`、`public/js/utils/model-config.js` 中移除 `request()` 第三参数
- [x] T10b. 清理页面组件调用方：`server-config.js`、`account-manager.js`、`claude-config.js`、`dashboard.js` 中移除 `request()` 第三参数及 `webuiPassword` 引用
- [x] T10c. 清理剩余组件：`data-store.js`（含密码重试回调逻辑 `if (newPassword) Alpine.store('global').webuiPassword = newPassword` 需一并删除）、`add-account-modal.js`、`public/js/components/models.js` 中移除 `request()` 第三参数

## 验收标准

- [ ] 未设置密码时，WebUI 可直接访问，无需登录
- [ ] 设置密码后，直接访问 `/` 重定向到 `/login.html`
- [ ] 正确密码登录后，`GET /api/settings` 返回 HTTP 200 及 settings 数据
- [ ] 错误密码 `POST /api/auth/login` 返回 HTTP 401，响应体不含密码明文或 hint
- [ ] 日志流 URL（`/api/logs/stream` 和 `/api/usage-log`）不含密码参数（curl 抓包验证）
- [ ] 服务重启后，原 session cookie 访问受保护路由返回 401
- [ ] 密码以 `scrypt:<salt>:<hash>` 格式存储在 config.json（cat 验证）
- [ ] 旧明文密码时，服务启动日志输出 WARN 级别提示，服务正常启动（不拒绝启动），旧密码仍可登录
- [ ] 前端代码无残留：`grep -rn "webuiPassword\|x-webui-password\|antigravity_webui_password\|password=" public/` 返回空（覆盖 public/ 根目录的 app.js 及所有子目录）
