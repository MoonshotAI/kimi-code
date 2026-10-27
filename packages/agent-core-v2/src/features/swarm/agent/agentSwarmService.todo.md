# IAgentSwarmService（agentSwarmService）

- v2: `packages/agent-core-v2/src/features/swarm/agent/swarm.ts`（约 13 行 interface；实现为同目录 swarmService.ts 约 110 行）
- 新架构: 无对应（swarm mode 已按决策整体删除）；附带的批级守卫对应 `packages/harness-core/src/features/swarm/guard.ts`

## 能力对照

- [x] AgentSwarm 批级守卫（一次仅一批、不得与其他工具调用混发的 veto；v2 挂在实现的 onBeforeExecuteTool 上） → `packages/harness-core/src/features/swarm/guard.ts`（createSwarmGuard，经 useToolBatchStarting 挂载于 `packages/harness-core/src/features/swarm/feature.ts`）
- [ ] swarm mode 状态机（enter/exit/isActive、SwarmModeEnter/Exit 持久状态、TurnEnded 自动退出） — 决策不做：swarm mode 已按 mode 定义整体删除；mode 互斥仅保留 plan↔tower 双向（`packages/harness-core/src/features/tower/feature.ts`）
- [ ] swarm mode 上下文注入（SwarmInjection 进出提醒 enter/exit-reminder） — 决策不做：随 swarm mode 一并删除
- [ ] 遥测 swarm_mode_entered/swarm_mode_exited — 决策不做：随 swarm mode 一并删除，harness-core 无这两个埋点

## 结论

未对齐 3 项——swarm mode 本体（状态机/注入/遥测）按决策删除不迁；实现内附带的批级守卫已对齐。
