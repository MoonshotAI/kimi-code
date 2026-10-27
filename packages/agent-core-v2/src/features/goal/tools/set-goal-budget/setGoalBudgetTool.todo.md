# ISetGoalBudgetTool（setGoalBudgetTool）

- v2: `packages/agent-core-v2/src/features/goal/tools/set-goal-budget/set-goal-budget.ts`（接口约 18 行；实现 `setGoalBudgetTool.ts`，读 interface 与实现得出）
- 新架构: 无对应

## 能力对照

- [ ] SetGoalBudget 工具：value + unit（turns/tokens/milliseconds/seconds/minutes/hours）设置 goal 预算上限 — 随 goal 域整体决策性删除，新栈无该工具；turn 预算是本次定稿点名过度拟合的设计点
- [ ] 预算生效链路：写 GoalUpdate 事件、刷新 deadline 调度、耗尽后拒绝工具并标记 blocked — 决策性删除

备注：时间单位（milliseconds/seconds/minutes/hours）最终都折算进 wall-clock 预算，依赖同目录 `goalDeadlineScheduler.md` 的调度器；两者同生同灭。

## 结论

全部未对齐（决策性删除）——预算维度随 goal 运行时一并撤下，将以更简单模型重做，记录在案未迁。
