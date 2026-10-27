# ITodoListTool（todoListTool）

- v2: `packages/agent-core-v2/src/features/todo/tools/todo-list/todo-list.ts`（约 28 行 interface；实现为同目录 todoListTool.ts 约 95 行）
- 新架构: `packages/harness-core/src/features/todo/tool.ts`

## 能力对照

- [x] TodoList 工具（省略 todos 读取、传数组整体替换、传空数组清空；title/status 入参 schema） → `packages/harness-core/src/features/todo/tool.ts`（createTodoListTool）与 `packages/harness-core/src/features/todo/todo-list.md`
- [x] 更新/清空结果文案与列表渲染 → 同文件 + `packages/harness-core/src/features/todo/todoItem.ts`（renderTodoList）
- [x] 写入落库后再返回（读取写后状态渲染） → 同文件（await store.dispatch 后按新状态渲染）
- [x] 写后引导提示 → `packages/harness-core/src/features/todo/todo-list-write-reminder.md`（固定提醒模板）；v2 为按进度动态生成的 nextStepHint（todoListTool.ts），现为静态文案，引导能力保留
- [x] 审批规则（TodoList 名称匹配） → `packages/harness-core/src/features/permission/language/tool-matchers.ts`（TodoList 条目）
- [ ] 遥测 todo_list_written（含 steps_since_write/after_reminder 统计） — 未迁：harness-core 无此埋点（记录在案未迁）

## 结论

未对齐 1 项——todo_list_written 埋点未迁；工具读写链路已对齐。
