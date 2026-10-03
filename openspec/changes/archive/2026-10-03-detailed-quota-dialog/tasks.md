# 任务清单：detailed-quota-dialog

## 状态：ARCHIVED

## 任务
- [x] 任务 1：在 `src/cloudcode/model-api.js` 中实现 `fetchUserQuotaSummary`，调用 `v1internal:retrieveUserQuotaSummary` 并处理多级 endpoint 降级（daily → sandbox → prod）与异常容错
- [x] 任务 2：在 `src/cloudcode/model-api.js` 中扩展 `getModelQuotas` 或新建组合提取逻辑，将解析出的 `quota_groups` 整合并缓存至账号配额对象中
- [x] 任务 3：在 WebUI 接口层（`src/webui/index.js`）及账号数据管理器中确保 `quota_groups` 被安全透传至前端，并支持手动刷新单个账号的配额数据
- [x] 任务 4：在 `public/views/accounts.html` 中构建账号详情弹窗结构，包括弹窗 Header（邮箱徽章、等级 Tag、关闭按钮）、状态提示栏、账号优先级（Priority 1-100）输入与保存控件以及 Tab 切换（Model Quota / Detailed Quota）
- [x] 任务 5：在 `public/views/accounts.html` 中实现 `DETAILED QUOTA` 视图的完整渲染，包括分组边框容器、双列网格时间窗口卡片、百分比进度条、时钟图标（Clock icon）与重置时间显示
- [x] 任务 6：在 `public/views/accounts.html` 的账号卡片上添加详情入口并完善 Alpine.js 交互状态逻辑（弹窗打开、数据加载、Tab 切换、优先级保存请求）
- [x] 任务 7：编写单元测试/集成验证脚本 `tests/test-detailed-quota.cjs` 验证配额接口解析与数据结构规范

## 验收标准
- [ ] 后端调用 `v1internal:retrieveUserQuotaSummary` 能正确解析 `quota_groups` 并提取 `display_name`、`description` 和 `buckets`（含 `window`、`remaining_fraction`、`reset_time`）
- [ ] WebUI `/api/accounts` 接口返回的数据中包含完整的 `quota_groups` 数组
- [ ] 前端弹窗界面能准确呈现两列卡片网格布局，动态进度条颜色根据剩余百分比正确区分（≥50% 绿色、≥20% 橙色、<20% 红色），并包含时钟图标与格式化重置时间
- [ ] 前端弹窗支持账号优先级（Priority 1-100）修改与保存，并提供即时反馈
- [ ] 前端支持 `MODEL QUOTA` 与 `DETAILED QUOTA` 双标签页平滑切换，支持深色与浅色模式适配
- [ ] 接口请求失败或账号无配额数据时具备优雅的兜底与提示机制
