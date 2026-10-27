# IGetGoalTool（getGoalTool）

- v2: `packages/agent-core-v2/src/features/goal/tools/get-goal/get-goal.ts`（接口约 10 行；实现 `getGoalTool.ts`，读 interface 与实现得出）
- 新架构: 无对应

## 能力对照

- [ ] GetGoal 工具：空参数查询当前 goal 快照（目标、状态、完成判据、预算用量与上限）— 随 goal 域整体决策性删除，新栈无该工具
- [ ] 底层 `IAgentGoalService.getGoal()` 状态读取 — 决策性删除（详见同目录 `agentGoalService.md`）

备注：工具输出（`GoalToolResult`，含 goalId/objective/status/turnsUsed/tokensUsed/wallClockMs/budgetLimits）是模型自察进度的唯一查询口，重做简化模型时需重新决定其存废。

## 结论

全部未对齐（决策性删除）——工具随 goal 运行时一并撤下，记录在案未迁。
