> **注：** 本文档由 **gemini-3.5-flash-low** 模型自动生成。

# 项目上下文

## 技术栈
- 语言：JavaScript (Node.js, ES Modules)
- 后端：Express.js, SQLite (better-sqlite3)
- 前端：Alpine.js, Tailwind CSS, Chart.js, DaisyUI
- 运行环境：Node.js
- 依赖：Google OAuth 2.0 认证，Anthropic/Google Generative AI 协议转换，better-sqlite3

## 架构约定
- 模块化设计：请求处理（server.js）、API 客户端（cloudcode/）、账户池管理（account-manager/）、格式转换（format/）
- 采用 Repository 模式以及多账号负载均衡（Sticky/Round-Robin/Hybrid 策略）

## 目录结构
- `src/`：后端核心代码
- `public/`：前端 Web 管理页面
- `tests/`：测试脚本（CommonJS）

## 开发约定
- 使用 ESM 编写源码
- 环境变量支持：`WEBUI_PASSWORD`, `CLAUDE_CONFIG_PATH`, `OAUTH_CALLBACK_PORT`
- 测试使用 `npm test` 或运行具体 `.cjs` 测试脚本
