## 上下文
现有 `antigravity-claude-proxy` 具有多账号轮换能力，但在前端管理面板上仅展示各个账号的基础模型配额百分比。用户无法得知特定时间周期（如 5 小时、1 天、1 周）内的配额使用与恢复进度。参考 Tauri 客户端 `Antigravity-Manager` 的实现，Google Cloud Code 内部提供了专用的配额汇总 RPC `v1internal:retrieveUserQuotaSummary`，能够返回丰富的分组配额信息。本项目需要在 Node.js 后端与 WebUI 前端复现该能力。

## 目标 / 非目标
**目标：**
- 在 `src/cloudcode/model-api.js` 中新增对 `v1internal:retrieveUserQuotaSummary` 的请求支持与多级端点降级。
- 提取并规范化 `quota_groups` 数据结构，透传给前端。
- 在 `public/views/accounts.html` 中复刻参考界面的详细配额弹窗，支持两列网格布局、深浅色模式、进度条色彩阶梯与时间格式化。

**非目标：**
- 不修改代理的主请求流水线（如 `streamGenerateContent`）。
- 不破坏现有轻量级轮换策略（依然优先依赖轻量配额字段，详细配额主要供人类可视化审查）。

## 决策
1. **端点多级降级**：
   - 优先请求 `https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`
   - 备选请求 `https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary`
   - 兜底请求 `https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`
   - 请求载荷保持与参考实现一致：`{ "project": projectId }`，头信息携带标准 Antigravity headers 与 Bearer token。

2. **数据模型对齐**：
   - 后端将响应中的 `quotaGroups` 提取并标准化为：
     ```json
     [
       {
         "display_name": "Claude 3.5 Sonnet",
         "description": "Daily quota for Claude 3.5 Sonnet",
         "buckets": [
           {
             "window": "WINDOW_1_DAY",
             "remaining_fraction": 0.85,
             "reset_time": "2026-10-04T12:00:00Z"
           }
         ]
       }
     ]
     ```

3. **前端渲染决策**：
   - 使用 Alpine.js 原生状态管理，在账号对象中绑定 `quota_groups`。
   - 弹窗采用 DaisyUI 4 + Tailwind CSS 3 响应式网格布局，深浅主题自适应。
   - 百分比样式映射：`percentage >= 50` 采用翠绿色（emerald），`percentage >= 20` 采用琥珀色（amber），小于 20 采用危险红色（red）。

## 风险 / 权衡
- **网络开销与限流风险**：频繁调用配额汇总接口可能带来微量延迟或触碰 Google 限流；在账号管理器中引入缓存机制，仅在用户点击刷新或定时批量探测时发起请求。
- **UI 布局溢出**：时间窗口名称长度可能不一；使用弹性布局和截断/环绕处理，保证在移动端与小屏幕窗口上良好展示。

## 迁移方案（如适用）
- 无破坏性变更，老旧无 `quota_groups` 字段的缓存账号数据优雅显示为基础配额，在下次刷新后自动升级包含新数据。

## 待决问题（Open Questions，如适用）
- 无。
