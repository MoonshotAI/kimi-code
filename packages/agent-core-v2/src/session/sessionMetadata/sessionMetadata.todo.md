# ISessionMetadata（sessionMetadata）

- v2: `packages/agent-core-v2/src/session/sessionMetadata/sessionMetadata.ts`（约 58 行，读 interface 得出）
- 新架构: `packages/agent-core/src/session/space.ts`（SessionRecord/catalog）+ `packages/harness-core/src/app/app.ts`（`app.update`）

## 能力对照

- [x] 读/写会话元数据（read/update 浅合并 patch + 变更事件）→ `packages/agent-core/src/session/space.ts`（`SessionSpace.get/update`，`mergeSessionRecord` 对 metadata 浅合并）+ `packages/harness-core/src/app/app.ts`（`app.update` 并发 `session.meta_updated` 事件）
- [x] setTitle / 生成标题不覆盖自定义（titleKind 守护）→ `packages/harness-core/src/features/kimi/sessionTitle/feature.ts`（`titleKindOf`：custom 不覆盖，写回 `metadata.titleKind`）
- [x] setArchived（归档/取消归档）→ `packages/harness-core/src/feature-http/route-v2/sessions.ts`（archive/unarchive 批量动作写 `metadata.archived/archived_at` 并关闭会话）
- [x] applyPromptMetadata（记录 lastPrompt）→ `packages/harness-core/src/features/sessionIndex/feature.ts`（`applyPrompt` 写 `last_prompt`；扫描回 fill 见 scan.ts）
- [x] lastTurnReason 持久化 → `packages/agent-core/src/session/session.ts`（lastTurn 索引经 `onLastTurn` 写回 catalog）
- [x] custom 自由字段 → `packages/agent-core/src/session/space.ts`（`SessionRecord.metadata` 自由键）
- [ ] registerAgent 富 AgentMeta（labels/type/parentAgentId/swarmItem 持久化）— 降级：roster 仅持久化 `source/forkedFrom`（`packages/agent-core/src/session/model.ts`）；labels 的 btw 标记、parentAgentId/profileName 已由 source 编码承载，swarmItem 由 `packages/harness-core/src/features/swarm/batch.ts` 注册表承载，但通用 labels/type 字段未迁

## 结论

未对齐 1 项——registerAgent 的富 AgentMeta 降级（通用 labels/type 字段未迁，主要消费方已由 source 编码与 swarm 注册表承载）。
