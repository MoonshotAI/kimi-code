# ISessionLegacyService（sessionLegacyService）

- v2: `packages/agent-core-v2/src/app/sessionLegacy/sessionLegacy.ts`（约 28 行 interface；消费方为 kap-server 旧版会话端点 routes/sessions.ts 约 805/834 行）
- 新架构: 无对应（legacy 协议决策不迁）

## 能力对照

- [ ] status(sessionId)（旧版复合会话状态响应 SessionStatusResponse）— 决策性不迁：legacy 线协议端点，新栈由 `packages/harness-core/src/feature-http/route-features/status.ts` 的新形状 sessions.status 路由替代
- [ ] goal(sessionId)（目标模式快照 GoalSnapshot）— 决策性不迁：harness-core 无 goal 域实现（仅遗留 skill 文本提及），该 legacy 端点不迁

## 结论

未对齐——legacy 会话协议面整体决策不迁，由新形状 status 路由取代。
