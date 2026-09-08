# 变更提案：restyle-webui-admin-theme

## 背景

当前 WebUI（public/，Alpine.js 3 + Tailwind v3 + DaisyUI v4 + Chart.js，全部 CDN）为暗色 space-950 #09090b + neon-purple #a855f7 霓虹风格。用户要求将其视觉样式完全复刻为 kiro2cc-proxy/admin-ui（React + Radix/shadcn 工程）的风格，要求样式一模一样。

用户已通过 AskUserQuestion 确认两项决策：
1. **实施方式 = Alpine 换肤**：保留 Alpine.js 架构与现有 x-data/x-show/x-text/@click/x-transition 绑定、x-load-view 动态加载机制、script 加载顺序，仅移植 kiro2cc 的全部设计令牌、IBM Plex 自托管字体、侧栏布局几何、间距、圆角、配色、组件样式。不引入 React/Node 构建链迁移。
2. **改造范围 = 全部页面**：index.html 布局骨架 + login.html + dashboard / accounts / models / usage-log / logs / settings 共 6 个视图页面一次到位（8 个页面总计；仅映射 agy 现有页面，不为 kiro2cc 独有页面如 api-keys/credential-detail/changelog 新增视图）。

kiro2cc admin-ui 样式权威源已全部精读（index.css 355 行设计令牌、fonts.css 14 个 @font-face、metrics.tsx 指标条原语、account-row.tsx 行规格、progress.tsx 四档额度渐变、table-kit.tsx、button/input/card/dialog/badge、page-head/toolbar、settings-panel、model-list-page、daily-stats-page、login-page）。

## 目标范围

**在范围内：**
- `public/css/src/input.css`：全量重写 —— 移植 kiro2cc 浅色默认主题 + `.dark` 暗色双主题全部 CSS 变量（surface/hairline/ink/brand/ok/warn/danger/quota 四档渐变/ring/shadow/grid-dot）、IBM Plex @font-face、6px 滚动条、`.bg-grid-dot` 点阵纹理；**旧主题变量保名换值**（--color-neon-purple/green/cyan、--color-space-950/900/800/border、--color-text-main/bright/dim/muted、--color-chart-1..16 保留原名，值改指新令牌，供 charts.js 与 app.js 共 17 处 `getThemeColor()` 读取，防止图表静默回退硬编码霓虹色；其中 --color-space-950 在 charts.js 中作 tooltip 背景/边框色，映射时单列并注名为浅色主题下的深色 tooltip 语义值）；并重定义现有语义组件类（.view-card / .view-header / .standard-table / .custom-range / .btn-action-* / .status-pill* / .input-search / .filter-control / .nav-item 等）为新主题等价物，控制 HTML 改动面
- `tailwind.config.js`：字体栈改为 IBM Plex Sans / IBM Plex Mono；DaisyUI 主题改为 kiro2cc 浅色配色（保留 DaisyUI 插件以支撑 `.btn` 系列类，约 72 处 class 属性）
- `public/fonts/`：从 kiro2cc admin-ui/public/fonts/ 复制 8 个 woff2（约 140KB）+ 新建 `public/fonts.css`（14 个 @font-face）
- `public/index.html`：布局骨架重写 —— 去 navbar、固定左侧栏 232px + bg-grid-dot 点阵、主内容 px-9 py-7、侧栏 active 项样式（bg-brand-soft + 左侧 brand 竖条）；**移除 html 标签写死的 `class="dark"` 与 `data-theme="antigravity"`**；保留全部 Alpine 绑定、x-load-view 容器、modal、Toast、script 加载顺序
- `public/login.html`：复刻 kiro2cc login-page 样式（同步移除 `class="dark"`/`data-theme`）
- 6 个 views 逐页换肤：dashboard / accounts / models / usage-log / logs / settings —— 重点是四档渐变额度进度条（剩余语义右对齐 + QuotaPercentBadge 胶囊）、metrics 指标条（28px/700 主值 + 分隔线 + 环形图/sparkline）、SET_ROW 设置行、logstream 日志流、表格 PANEL/TH/CELL 规格
- `public/app.js`：Chart.defaults 更新（字体 JetBrains Mono → IBM Plex Mono，颜色变量 → 新令牌）+ **移除 `data-theme='black'`/`classList.add('dark')` 强制暗色设置**（app.js:94-95）；sidebarOpen / OAuth 轮询 / x-load-view 逻辑不动
- `npm run build:css` 构建验证产物

**不在范围内：**
- 不迁移到 React / Vite / Radix / shadcn 构建链
- 不修改任何后端代码（src/）、API 路由、账号管理、代理逻辑
- 不改变任何功能行为（数据获取、i18n、权限、OAuth 流程均保持原样）
- 不引入 Node 运行时字体子集化等新依赖
- 不新增 kiro2cc 独有页面视图（api-keys / credential-detail / changelog / throttle-log 等无 agy 对应物，不凭空补页）
- 不新增暗色主题切换 UI（`.dark` 变量照常移植作为预留能力，默认渲染浅色）

## 技术方案

1. **令牌层**：input.css 顶部移植 kiro2cc `:root` / `.dark` 全部变量（--surface/--surface-2/--surface-3/--sidebar/--hairline/--hairline-2/--ink/--ink-2/--ink-3/--brand 系列/--ok/--warn/--danger/--track/--code-bg/--shadow-*/--grid-dot/--ring-grad-*/--quota-*-grad 等）。默认浅色；`.dark` 类切换暗色。**旧主题变量保名换值**：charts.js 15 处 + app.js 2 处 `getThemeColor()`（public/js/utils.js:32 定义）读取 --color-neon-purple/green/cyan、--color-space-950/800/border、--color-text-muted、--color-chart-1..16 等旧变量并带硬编码霓虹 fallback（如 `|| "#a855f7"`）—— 全部旧变量名必须保留为别名、值改指新令牌对应色，否则图表静默回退霓虹配色；--color-space-950 在 charts.js 中作 tooltip 背景/边框色，映射为浅色主题下的深色 tooltip 语义值（单列注释）。
2. **字体层**：public/fonts.css（14 个 @font-face，font-display: swap，unicode-range 子集）+ 8 个自托管 woff2（约 140KB）；body 字体栈 `'IBM Plex Sans','PingFang SC','Hiragino Sans GB',system-ui,sans-serif`；mono = `'IBM Plex Mono',monospace`。index.html/login.html `<link>` 引入 fonts.css。
3. **组件类重定义层**：在 input.css 内以新令牌重定义现有语义类，使大部分 HTML 仅靠 CSS 即完成换肤；视觉结构差异处（进度条右对齐剩余语义、metrics 指标条、侧栏布局、SET_ROW 设置行、logstream）按页调整 HTML 结构。
4. **布局层**：index.html 骨架改为 kiro2cc 几何（232px 固定侧栏 + 点阵纹理 + 主内容 px-9 py-7；无顶部导航条）。
5. **逐页层**：按 kiro2cc 各页面组件规格（account-row 10 列规格、log-viewer LEVEL_PIP、model-list 分组行、settings SET_CAP/SET_CARD/SET_ROW/SEG 分段控件）改写各 views 的结构与类名，全部保留 Alpine 动态绑定与 i18n t() 调用。
6. **图表层**：app.js Chart.defaults 字体/颜色切换为新令牌，并移除 `data-theme='black'`/`classList.add('dark')` 强制暗色设置（app.js:94-95）；各 views 中 chart canvas 与 Chart.js 配置色值（dashboard.js / models.js 中引用 CSS 变量的部分）同步更新；charts.js 的 getThemeColor 旧变量名经保名换值后无需改动，实施时核对 fallback 值未被触发。

## 预期影响

- **仅前端视觉层变更**：public/ 下 11 个文件 + tailwind.config.js；后端零改动
- 构建产物 public/css/style.css 需重新生成（`npm run build:css`），当前该文件为 0 字节（预编译产物）
- 页面 HTML 结构有实质调整（非纯 CSS），但 Alpine 绑定、组件函数（js/components/*.js）、store、i18n key 全部保持兼容 —— js/components/*.js 已扫描确认几乎不含动态样式类名，无需修改
- 移动端：kiro2cc 侧栏为固定布局；现有 .sidebar-collapsed 响应式机制将按 kiro2cc 几何重做，保留移动端可用性
- 静态资源新增 8 个 woff2（约 140KB 自托管字体，无 CDN 依赖）

## 风险

1. **DaisyUI 残留样式干扰**：`.btn` / `.dialog` 等 DaisyUI 类与 kiro2cc 组件类叠加可能产生视觉冲突 → 保留 DaisyUI 插件但把其主题改为 kiro2cc 浅色配色，并在 input.css 中按需覆盖；构建后人工检查 `.btn` 使用点（约 72 处 class 属性 / 106 处 class token，依统计口径）
2. **Tailwind purge 误删动态类名**：Tailwind JIT 只扫描 content 中静态字符串；Alpine 动态 `:class` 三元中的类名若仅出现在 JS 字符串拼接中会被误删 → 现有 tailwind.config.js content 已覆盖 `./public/**/*.{html,js}`，且现有代码同样依赖此机制，风险与现状一致；新增类名保持整串静态书写
3. **CDN 类可用性**：CDN 版 Tailwind（若有页面用 play CDN）与构建版行为差异 → 现状即为构建版（build:css），无变化
4. **视觉还原偏差**：「一模一样」要求高，逐像素核对成本高 → 以 kiro2cc 组件源码中的精确数值（28px/700、13px label、h-1 进度条、rounded-[3px] 等）为唯一依据，逐页比对
5. **settings.html 1989 行体量大**：分 Tab 逐步改造，防止一次性改动引入绑定丢失 → tasks.md 拆为独立任务，每 Tab 完成后人工核验 Alpine 功能
6. **回滚**：全部改动为前端文件，git revert 单次提交即可回滚；无数据/账号/配置迁移
