# IAgentModeMutexService（agentModeMutexService）

- v2: `packages/agent-core-v2/src/agent/modeMutex/modeMutex.ts`（约 8 行，读 interface 与 modeMutexService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/tower/feature.ts`（部分承载）

## 能力对照

- [x] plan ↔ tower 双向互斥（进 tower 退 plan；plan 激活时退 tower）→ `packages/harness-core/src/features/tower/feature.ts`（enter 时 exitPeerModes 退 plan；watch plan.state.active 时退 tower）
- [x] tower 进入/退出本身的状态承载（v2 互斥监听订阅 TowerModeEnter/SwarmModeEnter/PlanModeEnter 事件）→ `packages/harness-core/src/features/tower/feature.ts`（TOWER_MODE_ENTER/EXIT durable 事件 + store 投影）+ `packages/harness-core/src/features/plan/feature.ts`（PlanRef.state）
- [ ] swarm ↔ tower 互斥（进 swarm 退 tower、进 tower 退 swarm）— v2 的 swarm mode 已删除，新栈 features/swarm 是 AgentSwarm 批量工具而非模式，无互斥对象
- [ ] goal ↔ tower 互斥（进 tower 暂停 active goal；goal 激活时退 tower）— 新栈 features 清单中无 goal feature，互斥能力缺失

## 结论

未对齐 2 项——plan 双向互斥已在 tower feature 内承载；swarm mode 删除、goal 未迁导致另外两组互斥无对应。
