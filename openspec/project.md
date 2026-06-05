> **注：** 本文档由 **claude-sonnet-4-6** 模型自动生成。

# 项目上下文

## 技术栈

| 层 | 技术 | 版本 |
|---|---|---|
| 运行时 | Node.js | >=18.0.0 |
| 模块系统 | ES Modules (ESM) | `"type": "module"` |
| 后端框架 | Express.js | ^4.18.2 |
| HTTP 客户端 | undici | ^7.20.0 |
| 数据库 | better-sqlite3 | ^12.5.0 (native addon) |
| 前端 | Alpine.js + Tailwind CSS v3 + DaisyUI v4 + Chart.js | — |
| 认证 | Google OAuth 2.0 PKCE | — |
| 并发控制 | async-mutex | ^0.5.0 |
| 包管理 | npm | — |

## 架构约定

### 请求管道（核心设计）

```
Claude Code CLI
  → [Anthropic Messages API format]
  → src/server.js (路由 + 模型 auto-map)
  → src/format/request-converter.js (Anthropic → Google GenerateContent)
  → src/cloudcode/request-builder.js (封装 Cloud Code payload)
  → src/cloudcode/streaming-handler.js (SSE 流式请求 + 重试/failover)
  → Antigravity Cloud Code API (v1internal:streamGenerateContent)
  → src/cloudcode/sse-streamer.js (解析 SSE 事件)
  → src/format/response-converter.js (Google → Anthropic 格式)
  → Claude Code CLI
```

### 关键不变式（Critical Invariants）

1. **cache_control 剥离**：`cleanCacheControl()` 在 `request-converter.js` 入口强制清除所有 `cache_control` 字段，Gemini 严格 proto 验证会拒绝未知字段。
2. **sessionId 模型限制**：`sessionId` 仅对 Claude 模型族设置，Gemini 模型族不得包含此字段。
3. **模型名 post-map**：Cloud Code payload 的 `model` 字段必须使用 auto-map 后的名字（`requestedModel`），而非原始请求名（`modelId`）。
4. **Thinking 签名**：Claude↔Gemini 跨模型会话中，thinking block 的签名格式不同，由 `thinking-utils.js` + `signature-cache.js` 统一管理。

### 多账号策略

- **sticky**：同一会话粘滞到同一账号（缓存优化）
- **round-robin**：轮询分发
- **hybrid**（默认）：综合健康分数选择最优账号

各策略通过 `health-tracker`、`token-bucket-tracker`、`quota-tracker` 评分。

## 目录结构

```
src/
├── server.js                    # Express 入口，路由，模型 auto-map
├── index.js                     # 进程启动，参数解析
├── constants.js                 # 常量、模型映射、getModelFamily()
├── config.js                    # 运行时配置（端口、路径等）
├── errors.js                    # 自定义错误类型
├── fallback-config.js           # 模型 fallback 映射
├── cloudcode/
│   ├── index.js                 # 公开 API re-export
│   ├── streaming-handler.js     # 流式请求，重试，账号 failover
│   ├── message-handler.js       # 非流式请求
│   ├── request-builder.js       # Cloud Code payload 构造
│   ├── session-manager.js       # sessionId 派生
│   ├── sse-parser.js            # SSE 原始数据解析
│   ├── sse-streamer.js          # SSE 事件流处理
│   ├── model-api.js             # 模型列表/配额 API
│   ├── rate-limit-parser.js     # 限速响应解析
│   └── rate-limit-state.js      # 限速状态机
├── account-manager/
│   ├── index.js                 # AccountManager 类
│   ├── credentials.js           # Token/Project 凭证获取
│   ├── storage.js               # accounts.json 持久化
│   ├── rate-limits.js           # 账号限速状态
│   ├── onboarding.js            # 账号引导流程
│   └── strategies/
│       ├── index.js             # 策略工厂
│       ├── base-strategy.js     # 策略基类
│       ├── sticky-strategy.js
│       ├── round-robin-strategy.js
│       ├── hybrid-strategy.js
│       └── trackers/            # health / token-bucket / quota 跟踪器
├── format/
│   ├── index.js                 # 公开 API re-export
│   ├── request-converter.js     # Anthropic → Google 请求转换（含 cache_control 清除）
│   ├── response-converter.js    # Google → Anthropic 响应转换
│   ├── content-converter.js     # 内容块转换（文本、图片、工具）
│   ├── thinking-utils.js        # Thinking block 签名、过滤、恢复
│   ├── signature-cache.js       # Thinking 签名本地缓存
│   └── schema-sanitizer.js      # JSON Schema 清理（工具调用）
├── auth/
│   ├── oauth.js                 # Google OAuth 2.0 PKCE
│   ├── database.js              # Antigravity SQLite 数据库读取
│   └── token-extractor.js       # Token 提取工具
├── webui/
│   └── index.js                 # Web 控制台 API 路由
├── cli/
│   └── accounts.js              # CLI 账号管理命令
├── modules/
│   └── usage-stats.js           # 使用统计
└── utils/
    ├── logger.js                # 结构化日志
    ├── helpers.js               # sleep, throttledFetch, formatDuration 等
    ├── claude-config.js         # Claude CLI settings.json 读写
    ├── native-module-helper.js  # better-sqlite3 native 模块重建
    ├── proxy.js                 # 代理进程管理
    ├── server-presets.js        # 预设配置
    └── version-detector.js      # User-Agent 生成

public/                          # 前端（Alpine.js + Tailwind CSS）
tests/                           # CommonJS 集成测试（需 server 运行在 :8080）
bin/cli.js                       # CLI 入口（acc / antigravity-claude-proxy）
openspec/                        # OpenSpec 规范驱动开发文件
```

## 开发约定

- 后端全部使用 ESM；测试使用 CommonJS（`.cjs`）
- 无 TypeScript，无 jest/mocha——自定义 `.cjs` 测试跑者
- 集成测试需要 server 在 `:8080` 运行：`npm start` 后 `npm test`
- 前端修改需先 `npm run build:css` 或 `npm run dev:full`
- 环境变量：`WEBUI_PASSWORD`、`CLAUDE_CONFIG_PATH`、`OAUTH_CALLBACK_PORT`、`PORT`
- 新模型支持必须在 `constants.js` 的 `MODEL_MAP` / `getModelFamily()` 中注册
- `better-sqlite3` 原生模块在 Node 版本不匹配时由 `native-module-helper.js` 自动重建

## 关键文件速查

| 需求 | 文件 |
|---|---|
| 模型映射/添加新模型 | `src/constants.js` |
| 请求格式转换 | `src/format/request-converter.js` |
| Cloud Code payload 构造 | `src/cloudcode/request-builder.js` |
| 重试/failover 逻辑 | `src/cloudcode/streaming-handler.js` |
| Thinking 签名处理 | `src/format/thinking-utils.js` |
| 账号策略选择 | `src/account-manager/strategies/` |
| Web UI 路由 | `src/webui/index.js` |
| Claude CLI 设置读写 | `src/utils/claude-config.js` |
