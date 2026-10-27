# IAgentContextMemoryService（agentContextMemoryService）

- v2: `packages/agent-core-v2/src/agent/contextMemory/contextMemory.ts`（约 50 行，读 interface 与 contextMemoryService.ts 得出）
- 新架构: `packages/agent-core/src/loop/create-loop.ts`（`loop.state.messages`）+ `packages/agent-core/src/loop/record.ts`（loopProjection 事件折叠）

## 能力对照

- [x] 读取当前上下文消息列表（get）→ `packages/agent-core/src/loop/create-loop.ts` 的 `LoopState.messages`（`HistoryMessage[]`，持久且随事件折叠）
- [x] 追加消息与 loop 事件落库（append/appendLoopEvent，经事件分发持久化）→ 新栈无手工 append API，消息统一由 loop 命令与机器事实以事件落日志，`packages/agent-core/src/loop/record.ts` 的 `toLoopRecord`/`loopProjection` 折叠重建；注入式改写走 `loop.setContext`
- [x] 尾部消息移除（publishTrailingRemoval，v2 用于 swarm 场景）→ `packages/agent-core/src/loop/create-loop.ts` 的 `loop.setContext` 在编辑窗口整体重写上下文承载；整轮回撤销量路径另有 `packages/agent-core/src/session/session.ts` 的 undo
- [x] 清空上下文（clear）→ 同样由 `loop.setContext` 重写承载，无专门 API（v2 侧 clear 亦无 src 内调用方）
- [x] 应用压缩结果（applyCompaction：摘要落库、token 重基线、splice 发布）→ `packages/harness-core/src/features/compaction/feature.ts`（`loop.setContext` 落摘要，stats 经 compaction.completed 事件发布）
- [ ] prefixRevision 上下文修订计数 — v2 供 llmRequester 快照（contextRevision）与 cacheProbeService 缓存探测使用；新栈两个包内无 revision 概念与 cache probe 承载，记录在案未迁

## 结论

未对齐 1 项——上下文的读写、压缩落库已对齐到 loop/history 体系；仅 prefixRevision 修订计数（缓存探测用途）未迁。
