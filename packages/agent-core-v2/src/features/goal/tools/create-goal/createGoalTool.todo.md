# ICreateGoalTool（createGoalTool）

- v2: `packages/agent-core-v2/src/features/goal/tools/create-goal/create-goal.ts`（接口约 23 行；实现 `createGoalTool.ts`，读 interface 与实现得出）
- 新架构: 无对应

## 能力对照

- [ ] CreateGoal 工具：objective（必填、有长度上限）+ completionCriterion（可选）+ replace（替换现有 active/paused/blocked goal）参数面与校验 — 随 goal 域整体决策性删除，新栈无该工具
- [ ] 创建语义：写入 durable GoalCreate、触发 goal 驱动续轮与注入 — 决策性删除

备注：`packages/harness-core/src/features/skill/builtin/write-goal.md` 仅保留 goal 写作指引 skill，不提供 CreateGoal 工具能力。

## 结论

全部未对齐（决策性删除）——工具随 goal 运行时一并撤下，将以更简单模型重做，记录在案未迁。
