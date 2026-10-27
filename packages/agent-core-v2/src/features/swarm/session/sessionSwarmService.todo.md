# ISessionSwarmService（sessionSwarmService）

- v2: `packages/agent-core-v2/src/features/swarm/session/sessionSwarm.ts`（约 61 行 interface；实现为同目录 sessionSwarmService.ts 约 335 行）
- 新架构: `packages/harness-core/src/features/swarm/batch.ts`

## 能力对照

- [x] 批量运行 spawn/resume/retry 任务（AgentRunBatch：并发上限、首发限速、rate-limit 挂起重试、超时、abandoned/suspended 钩子） → `packages/harness-core/src/features/swarm/batch.ts`（AgentRunBatch 全语义保留）
- [x] spawn/resume/retry 启动器（spawn 管线复用：planSpawn/launcher、用量汇总、最新助手文本摘要） → `packages/harness-core/src/features/swarm/tool.ts`（buildBatchLauncher + createSubagentLauncher，来自 `packages/harness-core/src/features/spawn/index`）
- [x] getSwarmItem（按 callerAgentId 取回子 agent 的 swarm item） → `packages/harness-core/src/features/swarm/tool.ts`（SwarmItemRegistry + getSwarmItem）
- [x] 运行结果结构（completed/failed/aborted、started/not_started、result/usage/error） → `packages/harness-core/src/features/swarm/batch.ts`（SwarmRunResult 同结构）
- [ ] cancel(callerAgentId) 与 inFlight AbortController 表 — 决策不迁：中止走工具 signal 链（工具执行 signal 直接传入 AgentRunBatch）

## 结论

未对齐 1 项——cancel/inFlight 表按决策不迁（signal 链取代）；批运行语义已对齐。
