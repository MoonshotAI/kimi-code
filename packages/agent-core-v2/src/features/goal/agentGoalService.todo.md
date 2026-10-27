# IAgentGoalService（agentGoalService）

- v2: `packages/agent-core-v2/src/features/goal/goalService.ts`（约 1454 行，读 interface 与实现得出）
- 新架构: 无对应（曾完整迁移到 harness-core 后按用户定稿整体删除，将以更简单模型重做）

## 能力对照

- [ ] Goal 生命周期状态机：`createGoal/pauseGoal/resumeGoal/cancelGoal/markBlocked/markComplete/pauseOnInterrupt`（durable 投影 GoalCreate/GoalUpdate/GoalClear，fork 清空并发 `goal_fork_cleared` 提醒）— 决策性删除：turn 预算与多 Goal 归属设计过度拟合，整域撤下待重做
- [ ] 三维预算：`setBudgetLimits`（turns/tokens/时间）、`recordTokenUsage`/`incrementTurn` 计数、预算耗尽后拒绝工具调用并发 `goal_budget_stop` 提醒、goal 标记 blocked — 同上，决策性删除
- [ ] Goal 驱动续轮：未完成 goal 的 `goal_continuation` 自动续轮（含 step 上限续跑提示词）与完成/受阻审计提示 → v2 内嵌 continuation prompt；新栈无对应
- [ ] 错误自愈暂停：rate limit/连接/鉴权/API/模型配置/运行时/安全过滤等错误按类别暂停 goal 并记 reason — 决策性删除
- [ ] Goal 上下文注入与工具守卫：`GoalInjection` 提醒、`isGoalToolTarget` 过期 goal 工具结果拒绝（`GOAL_STALE_TOOL_RESULT`）、wait-for 指引 — 决策性删除
- [ ] `getGoal()` 状态查询（含预算报告）— 决策性删除

备注：独立的 write-goal skill 保留在 `packages/harness-core/src/features/skill/builtin/write-goal.md`（仅写作指引，不含运行时），不构成 goal 运行时能力的承载。

## 结论

全部未对齐（决策性删除）——goal 运行时（生命周期、预算、续轮、暂停、注入）整体撤下，将以更简单模型重做；迁移盘点按「记录在案未迁」处理。
