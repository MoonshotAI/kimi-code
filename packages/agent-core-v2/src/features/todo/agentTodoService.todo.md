# IAgentTodoService（agentTodoService）

- v2: `packages/agent-core-v2/src/features/todo/todoService.ts`（约 182 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/todo/feature.ts`

## 能力对照

- [x] get/replace/clear 与变更通知（onDidChange） → `packages/harness-core/src/features/todo/feature.ts`（TodoRef：items/state computed）与 `packages/harness-core/src/runtime/stores.ts`（FeatureStore.dispatch 提交后视图更新）
- [x] 持久化与崩溃恢复（v2 为 ToolsUpdateStore 事件溯源 actor） → `packages/harness-core/src/runtime/stores.ts`（useFeatureStore 打开 agents/<id>/todo 日志并重放 projection）与 `packages/harness-core/src/features/todo/projection.ts`
- [x] 可撤销（v2 durable undoable） → `packages/harness-core/src/runtime/stores.ts`（undoAgentTurns 按 turnId rewind feature 日志）
- [x] 写入可等待且原子（dispatch 返回即 commit 完成） → `packages/harness-core/src/runtime/stores.ts`（FeatureStore.dispatch 内部 await opened.commit）
- [x] 陈旧提醒（模型久未更新 todo 时注入提醒） → `packages/harness-core/src/features/todo/feature.ts`（turn.started 监听 + STALE_TURNS=2 + loop.remind）；口径从 v2 按 step 统计改为按 turn 差值，提醒能力保留
- [ ] 遥测 todo_reminder_shown / todo_turn_ended — 未迁：harness-core 无这两个埋点（记录在案未迁）

## 结论

未对齐 1 项——两个遥测埋点未迁；存储、撤销、提醒与工具链路已对齐，写入语义升级为可等待原子提交。
