# ITaskListTool（taskListTool）

- v2: `packages/agent-core-v2/src/agent/tools/task/task-list/task-list.ts`（约 25 行；实现 taskListTool.ts 约 45 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/task/tools/task-list.ts`

## 能力对照

- [x] 列出后台任务（active_only 默认 true、limit 1-100 默认 20、空列表提示）→ `packages/harness-core/src/features/task/tools/task-list.ts`
- [x] 任务记录来源（后台子代理 / 后台 Bash 等 detached 调用的登记与终态折叠，含重启后从日志重建、lost 标记）→ `packages/harness-core/src/features/task/feature.ts`、`projection.ts`
- [x] 审批规则（active/all 范围匹配）→ `packages/harness-core/src/features/permission/language/tool-matchers.ts`（TaskList 条目）
- [ ] 每条记录的 Wall time 显示（v2 formatTaskRecord 统一带 Wall time 行）— 降级：新栈记录只有 startedAt/endedAt 原始时间戳，无墙钟格式化
- [ ] 任务记录覆盖 question 类后台任务 — 随 AskUserQuestion 工具本体未迁而缺失（见 askUserQuestionTool.md）

## 结论

未对齐 2 项——Wall time 显示降级、question 类任务随提问工具缺失；列表主能力已对齐。
