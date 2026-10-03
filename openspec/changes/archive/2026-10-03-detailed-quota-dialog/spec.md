## Purpose
本功能提供账号细粒度配额数据查询与可视化展示能力，向用户呈现 Google Cloud Code 各模型及时间窗口（如 5h、1d、weekly）的剩余额度与重置时间。

## ADDED Requirements

### Requirement: Retrieve Detailed Quota Summary
The system SHALL request Google Cloud Code `v1internal:retrieveUserQuotaSummary` endpoint using the account's credentials, supporting endpoint fallback, and parse `quota_groups` with bucket statistics.

#### Scenario: Successfully Fetch Quota Groups
- **GIVEN** 有效的账号 Access Token 与关联的 Project ID
- **WHEN** 调用 `fetchUserQuotaSummary` 方法请求配额汇总
- **THEN** 系统按优先级尝试 `daily`、`sandbox`、`prod` 端点直至成功
- **AND** 返回规范化的 `quota_groups` 数组，每个 group 包含 `display_name`、`description` 和 `buckets`

#### Scenario: Endpoint Request Failure Fallback
- **GIVEN** 账号凭证失效或当前 Google Cloud Code 节点不可达
- **WHEN** 所有备用端点均返回非 200 响应或抛出网络异常
- **THEN** 系统记录错误日志并安全返回空数组或兜底结构
- **AND** 不阻断现有的基础模型配额查询流程

### Requirement: Render Detailed Quota Modal
The system SHALL render a detailed quota dialog on the accounts page displaying account metadata, tier badge, model quota tab, and detailed quota group cards.

#### Scenario: Display Detailed Quota Group Cards
- **GIVEN** 选中的账号包含 `quota_groups` 数据
- **WHEN** 用户在弹窗中切换到 `DETAILED QUOTA` 标签页
- **THEN** 系统渲染双列网格布局的时间窗口卡片（包含窗口标识、剩余百分比、进度条、时钟图标 Clock icon 和格式化重置时间）
- **AND** 进度条颜色根据剩余百分比动态渲染（≥50% 绿色、≥20% 橙色、<20% 红色）

#### Scenario: Handle Empty Quota Groups
- **GIVEN** 选中的账号不包含 `quota_groups` 数据或数组为空
- **WHEN** 用户查看账号配额弹窗
- **THEN** 系统仅展示基础模型配额或在详细配额区域展示优雅的无数据空状态提示

### Requirement: Configure Account Priority in Modal
The system SHALL provide priority input and update controls within the account details modal, persisting user changes to the account pool.

#### Scenario: Update Account Priority
- **GIVEN** 用户在账号详情弹窗中
- **WHEN** 用户修改 Priority 数值并点击 Save 按钮
- **THEN** 系统向后端发起更新请求，持久化保存优先级，并展示操作成功反馈
