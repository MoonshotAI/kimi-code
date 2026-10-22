# ISessionOutcomeMirror（sessionOutcomeMirror）

- v2: `packages/agent-core-v2/src/session/sessionActivity/sessionOutcomeMirror.ts`（约 8 行；interface 为空，能力读实现 sessionOutcomeMirrorService.ts 约 175 行得出）
- 新架构: `packages/agent-core/src/session/session.ts`（lastTurn 索引）+ `packages/harness-core/src/app/app.ts`（`onLastTurn` → `space.update`）

## 能力对照

- [x] 主 agent turn 结局持久化为会话级 lastTurnReason（TurnEnded → completed/cancelled/failed）→ `packages/agent-core/src/session/session.ts`（`lastTurnOf` 从主 agent `loopProjection` 视图派生 `LastTurn`，`onLastTurn` 上报）+ `packages/harness-core/src/app/app.ts`（`index(sessionId, { lastTurn })` 写回 catalog record）
- [x] turn 开始时清空结局（TurnStarted → 写 undefined）→ `packages/agent-core/src/session/session.ts`（投影重算：新 turn 无 outcome 时 `lastTurnOf` 回到 undefined，`settleLastTurn` 去重上报）
- [x] undo 后结局回退（ContextUndone）→ 结构承载：undo rewind 日志后视图重放，lastTurn 自然回退（`packages/agent-core/src/session/session.ts` 的 `undo` + 订阅重算）
- [x] 恢复后 reconcile（wire restore 后与已持久化值对账）→ 结构承载：重开会话以 catalog `record.lastTurn` 为种子，主 agent 挂载后由视图重算校正（`createSession` 的 `attach`）

## 结论

全部对齐；v2 的镜像写入与对账逻辑由「投影派生 + catalog 索引」结构性替代，无独立镜像服务。
