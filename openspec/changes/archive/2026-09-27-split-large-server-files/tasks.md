# 任务清单：split-large-server-files

## 状态：ARCHIVED

## 任务

### 0. 测试基线（拆分前）
- [x] C0. 在当前 HEAD（拆分前）启动服务器（端口 8080）运行 `npm test` 记录基线结果；同时运行 `npm run test:strategies` + `npm run test:sanitizer`。基线中有失败项时逐条记录（文件+失败原因），作为拆分后归因依据（逐条追加记录于本文件 C0 条目下方的"基线记录"小节）；基线失败项拆分后不要求变绿，但不得新增失败。

  #### 基线记录（2026-09-26，commit 6afcb7a，branch feature/split-large-server-files）
  - `npm run test:strategies`：89 passed, 0 failed ✅
  - `npm run test:sanitizer`：18 passed, 0 failed ✅
  - `npm test`（需 live server :8080）：8 FAIL / 8 PASS。失败项：
    1. Cache Control Stripping — "User text block with cache_control" FAIL（Response received: NO）
    2. Thinking Signatures — "Turn 1: Thinking + Signature + Tool Use" FAIL（Response received: NO）
    3. Multi-turn Tools (Non-Streaming) — FAIL
    4. Multi-turn Tools (Streaming) — FAIL
    5. Interleaved Thinking — FAIL
    6. Image Support — FAIL
    7. Prompt Caching — FAIL
    8. Empty Response Retry — FAIL
  - 根因：本机无可用账号（`~/.config/antigravity-proxy/accounts.json` 不存在，account pool "0 total, 0 available"），所有需真实上游调用的测试无法获得响应（Response received: NO），与代码逻辑无关。通过项：strategies、sanitizer、cross-model、oauth、403 rotation×2、streaming whitespace、version detection。
  - 拆分后归因标准：上述 8 个失败项保持失败即可（不得新增失败）；全部通过项必须仍通过。

### A. webui 拆分（src/webui/index.js → src/webui/*）
- [x] A1. 新建 `src/webui/session.js`：原样搬移 `sessions`、`SESSION_TTL_MS`、session 定时清理 `setInterval`、`parseCookies`、`isSessionValid`、`createSession`（纯搬移，加 import/export 胶水）。验证：`node --check src/webui/session.js`
- [x] A2. 新建 `src/webui/auth.js`：原样搬移 `EXEMPT_PATHS`、`EXEMPT_PREFIXES`、`cookieSecureAttr`、`isExempt`、`createAuthMiddleware`。验证：`node --check`
- [x] A3. 新建 `src/webui/account-ops.js`：原样搬移 `setAccountEnabled`、`removeAccount`、`addAccount`（含 MAX_ACCOUNTS 检查）。验证：`node --check`
- [x] A4. 新建 `src/webui/validate-config.js`：原样搬移 `validateConfigFields`。验证：`node --check`
- [x] A5. 新建 10 个路由模块（每个模块一个 `registerXxx(app, ctx)`，handler 正文按白名单搬移）：`routes/auth.js`、`routes/accounts.js`、`routes/config.js`（含 GET /api/settings）、`routes/claude.js`、`routes/server-presets.js`、`routes/models.js`、`routes/logs.js`、`routes/strategy.js`（GET /api/strategy/health）、`routes/oauth.js`、`routes/api-keys.js`（`maskKeySecret`/`serializeKey` 随 api-keys 搬移）。验证：`node --check` 全部
- [x] A6. 重写 `src/webui/index.js` 为组装入口：保留 `mountWebUI(app, dirname, accountManager)` 签名与调用时序，`pendingOAuthFlows` 留在组装文件并通过 ctx 传入。验证：`node --check` + 启动冒烟 `/health` 200
- [x] A7. 全量 grep 核对无未定义引用；按 proposal「允许的改写类别白名单」逐文件核对 handler 正文文本等价（忽略缩进与 import/export 包裹差异）

### B. server 拆分（src/server.js → src/server/*）
- [x] B1. 新建 `src/server/parse-error.js`：原样搬移 `parseError`、`parseResetDuration`。验证：`node --check`
- [x] B2a. 新建 `src/server/middleware.js`：按原注册顺序搬移中间件注册逻辑为 `registerCoreMiddleware(app, ctx)`：cors()、express.json(REQUEST_BODY_LIMIT)、DUMP_REQUEST_BODY 诊断中间件、trust proxy、/v1 access logging、/v1 API key 认证、usageStats.setupMiddleware(app)、调用 `usageLog.init()`、silent handler（POST /api/event_logging/batch 返回 200）。注意：`usageLog.init()` 原为模块加载期副作用，此处改为在 registerCoreMiddleware 内调用，由组装文件（server.js）按原顺序显式调用 registerCoreMiddleware，语义等价（原 server.js 的中间件注册段本身也位于模块顶层执行）。验证：`node --check`
- [x] B2b. 新建 `src/server/routes-misc.js`：`registerMiscRoutes(app, ctx)` 原样搬移 POST /（silent）、/test/clear-signature-cache、/refresh-token、/v1/models、count_tokens（501）。验证：`node --check`
- [x] B2c. 新建 `src/server/routes-health.js`（/health、/account-limits）与 `src/server/routes-messages.js`（POST /v1/messages 主端点：MODEL_MAP alias → config.modelMapping → resolveModel → isAllRateLimited 乐观重置 → 流式分支（先拉首事件再 flushHeaders、captureUsage、usageLog.record/recordUsage）→ 非流式分支 → 外层 catch（auth 错误清缓存+forceRefresh 改写、headersSent 降级 SSE error））。验证：`node --check`
- [x] B3. 重写 `src/server.js` 为 bootstrap+组装：argv 解析、`ensureInitialized`、`accountManager` 导出、中间件链注册顺序、`usageStats.setupRoutes`/`usageLog.setupRoutes`/404/`export default app` 时序不变。验证：`node --check` + 启动冒烟
- [x] B4. 全量 grep 核对无未定义引用；确认模块加载副作用（`usageLog.init`、定时器）时机不变

### C. 验证与收尾
- [x] C1. `npm run test:strategies` + `npm run test:sanitizer`（独立于 server）通过
- [x] C2. 启动服务器（端口 8080）后 `npm test` 集成套件通过（或记录无法运行原因）
- [x] C3. 行数复核：`wc -l` 确认 src/server.js 与 src/webui/index.js 均 < 200 行，无其他文件超 1000 行

## 验收标准
- [x] 拆分仅含代码搬移 + 白名单允许的胶水（import/export、ctx 引用改写、registerXxx 外壳）；逐函数文本等价比对通过，无逻辑变更
- [x] `node --check` 全部新文件通过；服务器可启动，`/health` 返回 200
- [x] 对外 API、SSE 行为、认证路径、日志输出不变（集成测试相对 C0 基线无新增失败）
- [x] src/server.js 与 src/webui/index.js 均降至约 200 行以内
