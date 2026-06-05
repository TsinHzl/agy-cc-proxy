> **注：** 本文档由 **claude-sonnet-4-6** 模型自动生成。

# Antigravity Claude Proxy

[![npm version](https://img.shields.io/npm/v/antigravity-claude-proxy.svg)](https://www.npmjs.com/package/antigravity-claude-proxy)
[![npm downloads](https://img.shields.io/npm/dm/antigravity-claude-proxy.svg)](https://www.npmjs.com/package/antigravity-claude-proxy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

一个暴露 **Anthropic 兼容 API** 的代理服务器，由 **Antigravity Cloud Code** 提供支持，让你可以通过 **Claude Code CLI** 和 **OpenClaw / ClawdBot** 使用 Claude 和 Gemini 模型。

![Antigravity Claude Proxy Banner](images/banner.png)

> **⚠️ 警告：** Google 已对连接此代理的账号发出 ToS 违规封禁。使用风险自负。

<details>
<summary><strong>⚠️ 服务条款警告 — 安装前请阅读</strong></summary>

> [!CAUTION]
> 使用此代理可能违反 Google 的服务条款。少数用户反映其 Google 账号遭到**封禁**或**影子封禁**（未明确通知的访问限制）。
>
> **使用此代理即表示你确认：**
> - 这是一个非官方工具，未经 Google 认可
> - 你的账号可能被暂停或永久封禁
> - 你承担使用此代理的所有风险
>
> **建议：** 不要使用主账号，请使用小号，如有需要可将其加入主账号的家庭共享计划。

</details>

---

## 工作原理

```
┌──────────────────┐     ┌─────────────────────┐     ┌────────────────────────────┐
│   Claude Code    │────▶│  本代理服务器        │────▶│  Antigravity Cloud Code    │
│  （Anthropic     │     │ （Anthropic → Google │     │  (daily-cloudcode-pa.      │
│   API 格式）     │     │  Generative AI）     │     │   sandbox.googleapis.com)  │
└──────────────────┘     └─────────────────────┘     └────────────────────────────┘
```

1. 接收 **Anthropic Messages API 格式**的请求
2. 使用已添加的 Google 账号（或 Antigravity 本地数据库）的 OAuth Token
3. 转换为带有 Cloud Code 包装的 **Google Generative AI 格式**
4. 发送到 Antigravity 的 Cloud Code API
5. 将响应转换回 **Anthropic 格式**，完整支持 Thinking / Streaming

## 前置条件

- **Node.js** 18 或更高版本
- 单账号模式需安装 **Antigravity**，多账号模式需准备 Google 账号

---

## 安装

### 方式一：npm（推荐）

```bash
# 通过 npx 直接运行（无需安装）
npx antigravity-claude-proxy@latest start

# 或全局安装
npm install -g antigravity-claude-proxy@latest
antigravity-claude-proxy start
```

### 方式二：克隆仓库

```bash
git clone https://github.com/badri-s2001/antigravity-claude-proxy.git
cd antigravity-claude-proxy
npm install
npm start
```

---

## 快速开始

### 1. 启动代理服务器

```bash
# 全局安装后
acc start
# 或: antigravity-claude-proxy start

# 使用 npx
npx antigravity-claude-proxy@latest start

# 克隆本地后
npm start
```

服务器默认以**后台进程**方式运行在 `http://localhost:8080`，关闭终端后仍继续运行。

| 命令 | 说明 |
| :--- | :--- |
| `acc start` | 后台启动代理 |
| `acc stop` | 关闭代理 |
| `acc restart` | 重启代理 |
| `acc status` | 查看代理状态和 PID |
| `acc ui` | 打开 Web 控制台 |
| `acc start --log` | 前台运行并显示日志 |

### 2. 关联账号

选择以下任一方式授权代理：

#### **方式 A：Web 控制台（推荐）**

1. 代理运行后，在浏览器打开 `http://localhost:8080`。
2. 进入 **Accounts** 标签页，点击 **Add Account**。
3. 在弹出窗口中完成 Google OAuth 授权。

> **无头/远程服务器**：如果服务器没有浏览器，WebUI 支持"手动授权"模式。点击 "Add Account" 后，复制 OAuth URL 在本机完成授权，再将授权码粘贴回来即可。

#### **方式 B：CLI（桌面或无头环境）**

```bash
# 桌面端（会打开浏览器）
antigravity-claude-proxy accounts add

# 无头环境（Docker/SSH）
antigravity-claude-proxy accounts add --no-browser
```

> 完整 CLI 账号管理选项，运行 `antigravity-claude-proxy accounts --help`。

#### **方式 C：自动检测（Antigravity 用户）**

如果已安装并登录 **Antigravity** 应用，代理会自动检测本地会话，无需额外配置。

自定义端口：

```bash
PORT=3001 antigravity-claude-proxy start
```

### 3. 验证运行状态

```bash
# 健康检查
curl http://localhost:8080/health

# 查看账号状态和配额限制
curl "http://localhost:8080/account-limits?format=table"
```

---

## 与 Claude Code CLI 配合使用

### 配置 Claude Code

#### **通过 Web 控制台（推荐）**

1. 打开 `http://localhost:8080` 的 WebUI。
2. 进入 **Settings** → **Claude CLI**。
3. 使用 **Connection Mode** 开关切换：
   - **Proxy Mode**：使用本地代理服务器（Antigravity Cloud Code）。可在此配置模型、Base URL 和预设。
   - **Paid Mode**：直接使用官方 Anthropic Credits（需要自己的订阅）。此模式隐藏代理设置以防误配置。
4. 点击 **Apply to Claude CLI** 保存。

> [!TIP] > **配置优先级**：Shell 环境变量（如 `.zshrc` 中设置的）优先级高于 `settings.json`。若使用 Web 控制台管理配置，请确保终端中没有手动导出冲突的变量。

#### **手动配置**

创建或编辑 Claude Code 配置文件：

**macOS / Linux：** `~/.claude/settings.json`  
**Windows：** `%USERPROFILE%\.claude\settings.json`

使用 Claude 模型：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://localhost:8080",
    "ANTHROPIC_MODEL": "claude-opus-4-6-thinking",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-6-thinking",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-sonnet-4-6",
    "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-4-6",
    "ENABLE_EXPERIMENTAL_MCP_CLI": "true"
  }
}
```

使用 Gemini 模型：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://localhost:8080",
    "ANTHROPIC_MODEL": "gemini-3.1-pro-low",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "gemini-3.1-pro-low",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gemini-3.5-flash-low",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gemini-3.5-flash-low",
    "CLAUDE_CODE_SUBAGENT_MODEL": "gemini-3.5-flash-low",
    "ENABLE_EXPERIMENTAL_MCP_CLI": "true"
  }
}
```

### 加载环境变量

**macOS / Linux：**

```bash
echo 'export ANTHROPIC_BASE_URL="http://localhost:8080"' >> ~/.zshrc
echo 'export ANTHROPIC_AUTH_TOKEN="test"' >> ~/.zshrc
source ~/.zshrc
```

> Bash 用户将 `~/.zshrc` 替换为 `~/.bashrc`

**Windows（PowerShell）：**

```powershell
Add-Content $PROFILE "`n`$env:ANTHROPIC_BASE_URL = 'http://localhost:8080'"
Add-Content $PROFILE "`$env:ANTHROPIC_AUTH_TOKEN = 'test'"
. $PROFILE
```

**Windows（命令提示符）：**

```cmd
setx ANTHROPIC_BASE_URL "http://localhost:8080"
setx ANTHROPIC_AUTH_TOKEN "test"
```

重启终端后生效。

### 运行 Claude Code

```bash
# 确保代理已运行
antigravity-claude-proxy start

# 在另一个终端运行 Claude Code
claude
```

> **注意：** 如果 Claude Code 要求选择登录方式，在 `~/.claude.json`（macOS/Linux）或 `%USERPROFILE%\.claude.json`（Windows）中添加 `"hasCompletedOnboarding": true`，重启终端后重试。

### 代理模式 vs 付费模式

在 **Settings** → **Claude CLI** 中切换：

| 功能 | 🔌 代理模式 | 💳 付费模式 |
| :--- | :--- | :--- |
| **后端** | 本地服务器（Antigravity） | 官方 Anthropic Credits |
| **费用** | 免费（Google Cloud） | 付费（Anthropic Credits） |
| **模型** | Claude + Gemini | 仅 Claude |

**付费模式**会自动清除代理设置，让你直接使用官方 Anthropic 账号。

### 多 Claude Code 实例（可选）

同时运行官方版和 Antigravity 版，添加以下别名：

**macOS / Linux：**

```bash
# 添加到 ~/.zshrc 或 ~/.bashrc
alias claude-antigravity='CLAUDE_CONFIG_DIR=~/.claude-account-antigravity ANTHROPIC_BASE_URL="http://localhost:8080" ANTHROPIC_AUTH_TOKEN="test" command claude'
```

**Windows（PowerShell）：**

```powershell
# 添加到 $PROFILE
function claude-antigravity {
    $env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.claude-account-antigravity"
    $env:ANTHROPIC_BASE_URL = "http://localhost:8080"
    $env:ANTHROPIC_AUTH_TOKEN = "test"
    claude
}
```

然后用 `claude` 使用官方 API，用 `claude-antigravity` 使用此代理。

### 以系统服务运行（systemd）

以 systemd 服务运行时，代理在不同用户（如 `root`）下运行，无法找到 `~/.claude/settings.json`。设置 `CLAUDE_CONFIG_PATH` 指向真实用户的 `.claude` 目录：

```ini
# /etc/systemd/system/antigravity-proxy.service
[Service]
Environment=CLAUDE_CONFIG_PATH=/home/youruser/.claude
ExecStart=/usr/bin/node /path/to/antigravity-claude-proxy/src/index.js
```

不设置此项，WebUI 的 Claude CLI 标签页将无法读写你的 Claude Code 配置。

### 使用 PM2 部署（推荐用于远程服务器）

在通过克隆仓库方式部署的远程服务器上，使用 PM2 可在断开终端连接后保持代理持续运行，并在服务器重启后自动拉起。

**安装 PM2：**
```bash
npm install -g pm2
```

**启动并注册开机自启：**
```bash
pm2 start ecosystem.config.cjs
pm2 save        # 保存进程列表
pm2 startup     # 注册 systemd 自启（按输出提示执行对应命令）
```

**更新到最新代码：**
```bash
git pull
pm2 restart agy-cc-proxy
```

| 命令 | 说明 |
| :--- | :--- |
| `pm2 status` | 查看运行状态 |
| `pm2 logs agy-cc-proxy` | 实时查看日志 |
| `pm2 restart agy-cc-proxy` | 重启代理 |
| `pm2 stop agy-cc-proxy` | 停止代理 |

### 卸载

**停止并移除 PM2 进程：**
```bash
pm2 stop agy-cc-proxy
pm2 delete agy-cc-proxy
pm2 save --force
```

**移除开机自启 systemd 服务：**
```bash
pm2 unstartup systemd
```

**全局卸载 PM2：**
```bash
npm uninstall -g pm2
```

**删除仓库及所有项目文件：**
```bash
cd ..
rm -rf antigravity-claude-proxy
```

---

## 文档

- [可用模型](docs/models.md)
- [多账号负载均衡](docs/load-balancing.md)
- [Web 管理控制台](docs/web-console.md)
- [高级配置](docs/configuration.md)
- [macOS 菜单栏应用](docs/menubar-app.md)
- [OpenClaw / ClawdBot 集成](docs/openclaw.md)
- [API 端点](docs/api-endpoints.md)
- [测试](docs/testing.md)
- [故障排查](docs/troubleshooting.md)
- [安全、使用与风险说明](docs/safety-notices.md)
- [法律声明](docs/legal.md)
- [开发文档](docs/development.md)

---

## 致谢

本项目基于以下项目的思路和代码：

- [antigravity-claude-proxy](https://github.com/badrisnarayanan/antigravity-claude-proxy) — 本项目复制并基于的原始仓库
- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) — 适用于 OpenCode 的 Antigravity OAuth 插件
- [claude-code-proxy](https://github.com/1rgs/claude-code-proxy) — 使用 LiteLLM 的 Anthropic API 代理

---

## 许可证

MIT

---

<a href="https://buymeacoffee.com/badrinarayanans" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="50"></a>

## Star 历史

[![Star History Chart](https://api.star-history.com/svg?repos=badrisnarayanan/antigravity-claude-proxy&type=date&legend=top-left&cache-control=no-cache)](https://www.star-history.com/#badrisnarayanan/antigravity-claude-proxy&type=date&legend=top-left)
