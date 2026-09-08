# 技术方案：restyle-webui-admin-theme

## 上下文

- 目标：agy-cc-proxy WebUI（Alpine.js + Tailwind v3 + DaisyUI v4）视觉完全复刻 kiro2cc-proxy/admin-ui（React + Radix/shadcn + Tailwind 3.4）
- 用户决策：Alpine 换肤（不迁移构建链）+ 全部页面一次到位
- 样式权威源：kiro2cc index.css（355 行令牌）+ fonts.css（14 @font-face）+ 各 tsx 组件精确数值
- 现状：public/css/style.css 为 0 字节预编译产物，真实样式源为 public/css/src/input.css（529 行暗色霓虹主题）
- 关键事实：charts.js 17 处 `getThemeColor()`（utils.js:32 定义，仅 charts.js 消费）读取旧变量 --color-neon-*/--color-space-*/--color-text-*/--color-chart-N 且带硬编码霓虹 fallback；app.js:94-95 强制 `data-theme='black'` + `classList.add('dark')`；index.html:2 / login.html:2 写死 `data-theme="antigravity" class="dark"` —— 三处均阻止浅色主题生效，必须移除/保名换值

## 目标 / 非目标

**目标**
- kiro2cc 全部设计令牌、IBM Plex 自托管字体、布局几何、组件规格 1:1 落地
- Alpine 绑定 / i18n / OAuth / 图表 / 日志流功能零回归
- 后端零改动，改动面收敛在 public/** + tailwind.config.js

**非目标**
- 不引入 React/Vite/Radix；不改后端；不改功能行为

## 决策

### 决策 1：令牌移植进 input.css，旧变量保名换值，tailwind.config 同名语义色映射
kiro2cc 的组件类大量使用 `bg-surface`/`text-ink-3`/`border-hairline` 等语义色，且 quota 渐变、ring 光晕、grid-dot 是纯 CSS 变量消费。直接在 input.css `:root`/`.dark` 移植全部变量，并在 tailwind.config.js `theme.extend.colors` 中映射同名语义色（surface/surface-2/surface-3/hairline/hairline-2/ink/ink-2/ink-3/brand/ok/warn/danger/track 等，值取 `var(--surface)` 等），使 HTML 可用与 kiro2cc 相同的 Tailwind 类名。shadow（shadow-hair/shadow-panel/shadow-pop）同理映射。
**旧变量保名换值**：--color-neon-purple/green/cyan、--color-space-950/900/800/border、--color-text-main/bright/dim/muted、--color-chart-1..16（input.css:43-58 实为 16 个）等旧主题变量名全部保留，值改指新令牌对应色（如 --color-neon-purple → var(--brand)）—— charts.js 15 处 + app.js 2 处 getThemeColor 消费与 utils.js:32 定义保持零改动，同时消除硬编码霓虹 fallback 被触发的可能；--color-space-950 在 charts.js 中作 tooltip 背景/边框色，需单列映射为浅色主题下的深色 tooltip 语义值。

### 决策 2：重定义现有语义类 + 按页改 HTML，双轨推进
- 现有 HTML 大量引用 .view-card/.standard-table/.custom-range/.btn-action-*/.status-pill*/.input-search/.filter-control/.nav-item —— 在 input.css 中把这些类**重定义**为 kiro2cc 等价样式（如 .view-card → rounded-[11px] border-hairline bg-surface shadow-panel），未及逐页改写的区域也能整体换肤
- 视觉结构差异处（metrics 指标条、四档进度条右对齐剩余语义、SET_ROW 设置行、logstream、侧栏骨架）必须改 HTML 结构 —— CSS 无法把「左对齐已用进度条」变成「右对齐剩余渐变条」
- 结果：每个任务 = 重定义类（CSS）+ 该页结构调整（HTML）一次完成

### 决策 3：保留 DaisyUI 插件，主题改 kiro2cc 配色
`.btn` 类使用集中在 modal 与操作按钮（约 72 处 class 属性 / 106 处 class token，依统计口径）。移除 DaisyUI 改动面大且收益低；保留插件、将 daisyui 主题配色改为 kiro2cc（primary #0D7A6F、base-100 #F6F7F8 等），使 `.btn` 系列自然贴近新风格，再在 input.css 按需覆盖细节。

### 决策 4：字体自托管复制，不改打包方式
直接复制 admin-ui/public/fonts/ 8 个 woff2 → public/fonts/，新建 public/fonts.css（14 个 @font-face 原文，font-display: swap），index.html/login.html `<link rel="stylesheet" href="/fonts.css">` 引入。服务器对 public/ 为静态目录（webui/index.js mounts public/），woff2 可直接服务，无需构建链参与。

### 决策 5：Tailwind 语义色映射 + 静态类名书写防 purge
- tailwind.config.js content 保持 `./public/**/*.{html,js}`
- 新增的 kiro2cc 风格类名在 HTML 中整串静态书写（`hover:bg-surface-3` 不拆拼接），与现状机制一致，防 JIT 误删
- `data-[state=checked]:bg-brand` 等 variant 改写为 Alpine 等价（`:class="enabled ? 'bg-brand' : 'bg-track'"`），避免依赖 Radix data 属性

### 决策 6：暗色主题跟随（.dark 类预留，默认浅色，三处 dark 强制设置移除）
kiro2cc 默认浅色。本项目当前无主题切换功能，本次默认渲染浅色主题；`:root`/`.dark` 双套变量照常移植，为后续暗色切换预留能力，但不在本次范围内新增切换 UI。
**必须同步移除三处强制 dark 设置**（否则浅色主题永远不会生效）：index.html:2 与 login.html:2 html 标签上的 `class="dark"` + `data-theme="antigravity"`，以及 app.js:94-95 的 `data-theme='black'` + `classList.add('dark')`。Alpine 绑定与 Chart.defaults 初始化逻辑本身保留。

## 风险 / 权衡

- **视觉还原成本**：逐页比对的代价最高，但用户要求「一模一样」—— 以 kiro2cc 源码数值为唯一依据，不接受近似色/近似圆角
- **settings.html 1989 行**：改造期间 Alpine 绑定丢失风险最高 → 按 Tab 拆步，只动 class/结构，不动 x-data/x-model/x-show 表达式
- **Chart.js 图表**：charts.js 依赖旧变量名 —— 保名换值策略保证其零改动可用；实施后人工核对图表无霓虹色残留（即 fallback 值 `#a855f7` 等未被触发）
- **JS 内硬编码霓虹色**（保名换值覆盖不到的部分）：models.js:11-20 `thresholdColors` 8 组硬编码 hex、model-dropdown.js:72-73 `focus:!border-neon-*` 类名 —— 任务 10 中显式改为 CSS 变量或新令牌色；app.js:101 `Chart.defaults.font.family` 同步切换 IBM Plex Mono
- **DaisyUI 覆盖残留**：daisyui 生成的组件 CSS 可能与新类冲突 → input.css 中覆盖规则置于文件后部，构建后人工核验 modal/按钮

## 迁移方案

- 单分支 feature/restyle-webui-admin-theme，全量前端文件变更，一次提交或按任务分批提交
- 回滚：git revert；无数据迁移、无配置变更、无重启要求（前端静态文件即时生效，浏览器强刷即可）

## 待决问题

无 —— 实施方式与范围均已经用户 AskUserQuestion 确认。
