# IUpdateGoalTool（updateGoalTool）

- v2: `packages/agent-core-v2/src/features/goal/tools/update-goal/update-goal.ts`（接口约 19 行；实现 `updateGoalTool.ts`，读 interface 与实现得出）
- 新架构: 无对应

## 能力对照

- [ ] UpdateGoal 工具：模型自评把当前 goal 置为 active/complete/blocked（含 3 轮受阻审计、完成审计提示）— 随 goal 域整体决策性删除，新栈无该工具
- [ ] 状态转移语义：终态写 GoalUpdate、终止 goal 续轮、发取消/完成提醒 — 决策性删除

备注：工具的 schema 刻意只暴露 `status` 单字段（active/complete/blocked），暂停/恢复留给用户侧命令；该约束随工具一并撤下。

## 结论

全部未对齐（决策性删除）——工具随 goal 运行时一并撤下，记录在案未迁。
