# ISessionStateService（sessionStateService）

- v2: `packages/agent-core-v2/src/session/state/sessionState.ts`（约 9 行，读 interface 得出；能力即 IStateRegistry 会话级持久键值注册表）
- 新架构: `packages/agent-core/src/store/`（事件源 journal + 投影）+ `packages/harness-core/src/app/app.ts`（`featureWriter`）

## 能力对照

- [x] 会话级持久键值状态（contributeState/get/set，重启恢复）→ `packages/agent-core/src/store/`（每会话 event-sourced journal，`replica.view(projection)` 重放即恢复）+ `packages/harness-core/src/app/app.ts`（`featureWriter(sessionId)` 给每个 feature 自有持久日志）
- [x] 状态键贡献点（defineState + contributeState 注册模式）→ 结构替代：各 feature 在自己的声明文件旁定义事件与投影（如 `packages/agent-core/src/session/model.ts` 的 `sessionProjection`），无需集中注册表
- [x] 历史回溯与 undo 语义（v2 依赖 state-registry 配合 undo 恢复）→ `packages/agent-core/src/session/session.ts`（`undo` rewind 日志，投影重放即回到任意 turn 起点）
- [x] 运行时状态切片读取 → `packages/agent-core/src/session/`（roster/loopProjection 等投影视图；运行时态只活在活对象上，复合态按需计算）

## 结论

全部对齐；通用键值注册表由「每 feature 事件源 journal + 投影」的自有状态模型结构性替代。
