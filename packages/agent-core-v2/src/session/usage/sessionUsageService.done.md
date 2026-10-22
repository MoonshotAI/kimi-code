# ISessionUsageService（sessionUsageService）

- v2: `packages/agent-core-v2/src/session/usage/sessionUsage.ts`（约 22 行，读 interface 得出）
- 新架构: `packages/harness-core/src/features/usage/feature.ts`

## 能力对照

- [x] record（按模型记录一次 LLM 用量）→ 结构承载：usage 由 loop 自动写入 assistant 消息 meta 并持久化（`packages/agent-core/src/loop/machine/request-actor.ts`），无需显式 record API
- [x] status(agent) 总量（total）→ `packages/harness-core/src/features/usage/feature.ts`（`UsageRef`：`usage` 折叠全部 assistant meta usage，`total` 为 grandTotal）
- [x] status 分解（byModel/currentTurn）→ `packages/harness-core/src/feature-http/ws-v1/transcriptModel.ts`（`AgentUsageMeta`：`byModel/currentTurn/total` 聚合）
- [x] onDidRecord 记录事件 → 结构承载：消费方订阅 `agent.view`（usage feature 同款）或 ws-v1 状态推送，无独立事件流

## 结论

全部对齐；显式 record/事件流由「loop 自动记账 + 视图订阅」结构性替代。
