# ITowerCompleteTool（towerCompleteTool）

- v2: `packages/agent-core-v2/src/features/tower/tools/complete/complete.ts`（20 行，实现见同目录 completeTool.ts，100 行；store 侧 complete() 约 150 行）
- 新架构: 无对应

## 能力对照

- [ ] worker 一站式完成协议：report 非空校验、caller 须为拥有 mission 的 worker、mission 置 completed 与 review-request/survey-summary 通知同一状态锁内完成 — 新栈无该工具（protocol/store.ts 无 complete()）
- [ ] 完成前硬约束：assertCompletable（blockers/开放任务/无 diff 拒绝）与 assertInboxRead（有未读消息拒绝完成）— 随工具一并消失；新栈 TowerMission(status=completed) 无这些前置校验
- [ ] 通知幂等：重复完成复用已存消息（notificationCreated=false），存储失败时保留已持久化的 completed 并报告 notificationError — 无对应
- [ ] state-lost 降级路径：状态恢复后 mission 记录丢失时以 completion-report-state-lost 消息交付报告且不虚报完成 — 新栈无 loadOrRecover 体系

## 结论

未对齐——决策不做：worker 完成流拆回 TowerMission(status=completed) + TowerSend 两步（新栈 tools/spawn.ts 简报如此指示，workerProfile.ts 工具表已不含 TowerComplete）；一站式原子性、读净 inbox 硬约束与幂等通知随之降级。
