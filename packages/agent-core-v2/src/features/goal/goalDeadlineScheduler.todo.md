# IGoalDeadlineScheduler（goalDeadlineScheduler）

- v2: `packages/agent-core-v2/src/features/goal/goalDeadlineScheduler.ts`（约 12 行，读 interface 得出；为 goal 截止时间调度提供可替换时钟的 `now()/schedule(delayMs, callback)`）
- 新架构: 无对应

## 能力对照

- [ ] goal 截止（wall-clock 预算）到期调度：按 delayMs 排程回调、可注入时钟便于测试 — 随 goal 域整体决策性删除（turn 预算与多 Goal 归属设计过度拟合，待以更简单模型重做），新栈两个包内无等价物
- [ ] `now()` 时钟抽象 — 同上；wall-clock 预算维度本身已随 `setBudgetLimits` 一起撤下

备注：本服务是 `goalService.ts` 的内部协作件（接口仅 `now/schedule` 两个方法），对外能力经 `IAgentGoalService` 的预算链路暴露；其未对齐结论与 `agentGoalService.md` 同源，不单独构成用户可见缺口。

## 结论

全部未对齐（决策性删除）——本服务是 goal wall-clock 预算的调度原语，随 goal 域一并撤下，记录在案未迁。
