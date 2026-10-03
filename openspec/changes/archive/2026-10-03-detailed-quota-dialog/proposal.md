# 变更提案：detailed-quota-dialog

## 背景
在 `antigravity-claude-proxy` 现有账号管理界面中，仅展示了各账号基础模型的配额百分比概览，缺乏更细粒度的时间窗口配额监控。参考外部项目 `Antigravity-Manager`（基于 Tauri/React 开发），其通过调用 Google Cloud Code 内部配额汇总接口 `v1internal:retrieveUserQuotaSummary`，实现了包含 `MODEL QUOTA` 与 `DETAILED QUOTA` 双标签页的账号详情弹窗，能够直观展示如 5 小时、1 天、1 周等多个时间窗口的剩余额度与重置时间。本项目需要复刻该弹窗，提供一致的高保真视觉与交互体验。

## 目标范围
**在范围内：**
- 后端调用 Google Cloud Code `v1internal:retrieveUserQuotaSummary` 端点，支持多级 Endpoint 降级回退机制（daily → sandbox → prod）。
- 解析配额接口返回的 `quota_groups` 数据（包含 `display_name`、`description` 及各时间窗口 `buckets`，提取 `window`、`remaining_fraction`、`reset_time`）。
- 在 `src/cloudcode/model-api.js` 中新增/扩展配额获取逻辑，并在 `AccountManager` 及 WebUI `/api/accounts` 中透传 `quota_groups`。
- 在 `public/views/accounts.html` 中实现账号详情弹窗，提供 Header（邮箱、等级标签、关闭按钮）、状态提示条、优先级调整及 `MODEL QUOTA` / `DETAILED QUOTA` Tab 切换。
- 在 `DETAILED QUOTA` 视图中按组呈现蓝底圆角卡片，内部以两列网格展示各个时间窗口的配额进度条、百分比徽章与重置时间。
- 完整适配深色模式（dark mode）与浅色模式，与 Alpine.js 现有状态管理无缝集成。

**不在范围内：**
- 修改 Claude Messages API 转换流水线或请求转发逻辑。
- 变更账号轮换选择策略（sticky/round-robin/hybrid）的核心打分算法。
- 改造其他页面（如 settings、models、usage-log 等）。

## 技术方案
1. **Cloud Code 接口调用**：在 `src/cloudcode/model-api.js` 中新增 `fetchUserQuotaSummary(account)` 函数，请求 `v1internal:retrieveUserQuotaSummary`，将获取到的 `quota_groups` 标准化存储在账号的配额对象中。
2. **WebUI 状态透传**：确保 `/api/accounts` 路由返回的数据结构中包含账号的 `quota_groups` 字段，并在刷新账号时同步更新。
3. **前端视图组件**：在 `public/views/accounts.html` 中添加 `accountDetailsModal` 对话框，由 Alpine.js 驱动，支持通过账号卡片上的“查看详情”或配额区域点击打开，实现高保真布局与交互。

## 预期影响
- 账号详情展示更加丰富，用户可精确获知特定时间窗口内的配额消耗情况与重置倒计时。
- 纯展示层与配额查询功能增强，不影响主代理流量转发性能与稳定性。

## 风险
- Google Cloud Code 内部配额汇总接口在部分网络环境下可能受阻或返回异常格式；需设计严格的降级容错，当接口失败时不阻断基础配额展示。
- 极少数未初始化或受限账号可能无 `quota_groups` 数据，前端需优雅回退并提示无详细数据。
