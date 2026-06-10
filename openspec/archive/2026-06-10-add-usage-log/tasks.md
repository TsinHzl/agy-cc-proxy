# 任务清单：add-usage-log

## 状态：ARCHIVED

## 任务
- [x] T1: 创建 `src/modules/usage-log.js` — 用量日志模块核心（数据结构、环形缓冲区、`record()`、`getRecords()`、定价表、Credits 计算）
- [x] T2: 在 `src/modules/usage-log.js` 中实现持久化（`load()`/`save()`/`prune()`、定时刷盘、SIGTERM 处理器）
- [x] T3: 在 `src/modules/usage-log.js` 中实现 `setupRoutes(app)` — 注册 `GET /api/usage-log` 路由
- [x] T4: 修改 `src/server.js` — 导入 usage-log 模块，调用 `setupRoutes(app)`，在 `POST /v1/messages` 流式处理循环中集成用量追踪（记录 startTime、从 SSE 事件提取 usage、计算 timeToFirstToken、调用 `record()`）
- [x] T5: 创建 `public/views/usage-log.html` — 使用日志视图模板（表格布局，含所有展示字段）
- [x] T6: 创建 `public/js/components/usage-log-viewer.js` — Alpine.js 组件（`GET /api/usage-log` 数据获取、渲染、跟随全局轮询刷新）
- [x] T7: 修改 `public/index.html` — 添加侧边栏"使用日志"导航项（System 分组，"运行日志"上方）+ 视图容器 + 组件脚本引用
- [x] T8: 修改 `public/app.js` — 注册 `usageLogViewer` 到 `window.Components` 和 Alpine.data
- [x] T9: 修改 `public/js/translations/zh.js` — 添加中文翻译键值
- [x] T10: 修改 `public/js/translations/en.js` — 添加英文翻译键值

## 验证方式
- T1-T3: 启动服务器后 `curl http://localhost:8080/api/usage-log` 返回 `{status:"ok", records:[]}`
- T4: 发送 `/v1/messages` 请求后再次 curl 验证记录出现
- T5-T8: 浏览器访问 WebUI，点击"使用日志"导航项，页面正常渲染
- T9-T10: 切换中/英文，页面文案正确

## 验收标准
- [ ] 侧边栏"使用日志"位于"运行日志"上方
- [ ] 页面展示用量明细表格，包含：时间、模型、API 密钥、模型用量（输入/输出/缓存读取/总计 Tokens）、请求耗时（总耗时/首 Token 耗时）、消费金额
- [ ] 每次 `/v1/messages` 流式请求成功完成后自动记录用量
- [ ] 非流式 `/v1/messages` 请求成功后也自动记录用量（首 Token 耗时为 `-`）
- [ ] 请求失败（流开始前失败）不记录用量
- [ ] 数据持久化到磁盘，正常重启后数据保留
- [ ] 记录数超过 5000 时自动丢弃最旧记录
- [ ] 页面跟随全局轮询间隔自动刷新
