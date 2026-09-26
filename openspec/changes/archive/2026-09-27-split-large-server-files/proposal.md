# 变更提案：split-large-server-files

## 背景

仓库中仅剩两个超过 1000 行的 JS 源文件：

- `src/webui/index.js` — 1543 行，混合了会话/认证中间件、账号文件操作辅助函数、配置校验器，以及 10 个领域的共 39 个 Express 路由（auth、accounts、config、claude、server presets、models、logs、strategy health、oauth、api keys），全部塞在一个 `mountWebUI()` 闭包内。
- `src/server.js` — 1152 行，混合了 CLI 参数解析、初始化逻辑、7 个中间件（CORS/body/dump/access log/api-key auth/usage/silent handler）、错误分类（parseError/parseResetDuration），以及核心 API 路由（/health、/account-limits、/v1/messages 等）。

单文件过大导致导航困难、多任务并行修改冲突率高。本次变更将其按职责域拆分为多个聚焦模块，**约束：拆分代码仅仅是代码移动** —— 所有函数体、路由 handler、注释逐字原样搬移，不重命名、不改逻辑、不重排执行顺序、不改变任何对外行为。

## 目标范围

**在范围内：**
- 将 `src/webui/index.js`（1543 行）拆分为：会话/认证模块、账号操作辅助模块、配置校验模块、按领域分组的路由注册模块（共 10 个路由文件：auth、accounts、config[含 settings]、claude、server-presets、models、logs、strategy[health]、oauth、api-keys）；`index.js` 保留 `mountWebUI()` 组装入口。
- 将 `src/server.js`（1152 行）拆分为：错误分类模块（parseError/parseResetDuration）、中间件模块、按领域分组的 API 路由模块；`server.js` 保留 bootstrap 与组装。
- 拆分后两个入口文件均降至约 200 行以内。
- 拆分后 `node --check` 全部通过，`npm test` 相关集成测试行为不变。

**不在范围内：**
- 任何逻辑修改、重命名、错误处理增强、样式调整。
- `public/` 前端、`tests/`、`bin/cli.js`、其余 `src/` 模块的任何改动。
- 新增依赖或构建配置变更。

## 技术方案

- **纯搬移模式**：每个被移动的函数/路由 handler 的代码正文与原文件逐字一致；仅允许的"新增胶水"是每个新模块的 import/export 语句与一个 `registerXxx(app, ctx)` 注册函数外壳。
- **允许的改写类别白名单（仅限以下四类，超出即违规）**：
  1. 新增 import / export 语句；
  2. 原闭包内自由变量引用改为 `ctx.x` 或解构导入（标识符改名，表达式本体不变）；
  3. `registerXxx(app, ctx)` 函数外壳本身；
  4. handler 正文换行/缩进随包裹调整。
  验收核对方式：逐函数文本等价比对（忽略缩进与上述白名单差异），不做不可量化的"逐字"承诺。
- **webui 依赖注入**：路由模块通过 `ctx` 对象接收共享符号，避免行为改变；共享辅助函数从原文件原样导出。
- **server 模块拆分**：`parseError`/`parseResetDuration` 原样移入 `src/server/parse-error.js`；中间件按原注册顺序保留在组装文件或中间件模块中；路由（/health、/account-limits、/v1/messages、杂项端点）分别注册。`FALLBACK_ENABLED`、`STRATEGY_OVERRIDE`、`ensureInitialized`、`accountManager` 等共享状态通过模块导入或参数传递，保持原有初始化时序。
- **导入顺序与副作用保持**：模块加载顺序（如 `usageLog.init()`、`setInterval` 清理器）与原文件一致，不改变执行语义。

### webui/index.js 顶层共享状态与闭包符号清单（搬移核对清单，无"等"字敞口）

| 符号 | 去向 |
|---|---|
| `packageVersion`（模块级 const，L30） | 留在 index.js，经 ctx 传入路由模块 |
| `pendingOAuthFlows`（Map，L34） | 留在 index.js（组装层），经 ctx 传入 routes/oauth.js |
| `sessions`（Map，L38）、`SESSION_TTL_MS`（L39） | session.js，导出；auth.js 与 routes/auth、routes/config(password) 经 import/ctx 使用 |
| `parseCookies`（L50） | session.js 导出（routes/auth/logout 使用） |
| `isSessionValid`（L64）、`createSession`（L77） | session.js 导出（auth.js / routes/auth 使用） |
| `setAccountEnabled`（L92）、`removeAccount`（L106）、`addAccount`（L123） | account-ops.js 导出（routes/accounts、routes/oauth 使用） |
| `EXEMPT_PATHS`/`EXEMPT_PREFIXES`（L161-162）、`cookieSecureAttr`（L164）、`isExempt`（L168）、`createAuthMiddleware`（L181） | auth.js 导出（index.js 组装时注册中间件） |
| `validateConfigFields`（L202） | validate-config.js 导出（routes/config、routes/server-presets 使用） |
| `accountManager`（mountWebUI 参数） | index.js 持有，经 ctx 传入全部路由模块 |
| `logger`、`config`、各 import（oauth/storage/claude-config/server-presets/api-keys manager 等） | 由各新模块按需直接 import（与原文件相同的来源模块） |
| `dirname`（静态资源路径） | index.js 持有（mountWebUI 参数），仅组装层使用 |
| `maskKeySecret`/`serializeKey`（api-keys 路由内部辅助） | 随 routes/api-keys.js 搬移 |

### 模块依赖层级规则（单向，禁止环）

```
index.js（组装：中间件注册 + 调用各 registerXxx）
  → routes/*（仅依赖 helpers 层 + ctx 注入 + 直接 import 无状态工具模块）
  → helpers 层：session.js / auth.js / account-ops.js / validate-config.js
  → （helpers 层直接 import src/ 既有模块：storage.js、logger、oauth.js 等，禁止反向依赖 routes/* 或 index.js）
```
- `routes/accounts.js` 与 `routes/api-keys.js` 互不依赖；两者都只依赖 ctx + helpers 层。
- `routes/logs.js`（GET /api/logs、/api/logs/stream）与 `routes/strategy.js`（GET /api/strategy/health）各自独立成模块；`GET /api/settings` 归入 `routes/config.js`（同为运行时配置读取域）。

## 预期影响

- 零行为变化：对外 API、SSE 流、认证路径、日志输出完全不变。
- 现有集成测试（需 :8080 live server）与独立单测（strategies、sanitizer）均应照常通过。
- 后续修改 WebUI 路由或核心 API 时冲突面缩小至对应领域文件。

## 风险

- **闭包变量遗漏**：原路由 handler 依赖 `mountWebUI()` 闭包内的局部变量（如 `pendingOAuthFlows`、`accountManager`）——通过 ctx 注入逐项核对，遗漏会导致 ReferenceError；用 `node --check` + 冒烟启动验证。
- **循环依赖**：webui 路由模块与辅助模块互相引用可能形成环——保持单向依赖（routes → helpers/session/validate），必要时经 ctx 注入。
- **模块加载时序**：`setInterval` 会话清理器、`usageLog.init()` 等副作用必须保持原执行时机——由组装文件按原顺序显式调用（`usageLog.init()` 原为模块加载期执行，搬入 `registerCoreMiddleware` 后由 server.js 按原顺序显式调用，语义等价）。

应对策略：拆分后立即 `node --check` 全部新文件；启动服务器冒烟验证 /health、WebUI 登录页可访问；逐文件 grep 确认无残留未定义引用。
