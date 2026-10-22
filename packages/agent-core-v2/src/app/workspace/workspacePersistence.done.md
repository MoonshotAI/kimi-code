# IWorkspacePersistence（workspacePersistence）

- v2: `packages/agent-core-v2/src/app/workspace/workspacePersistence.ts`（约 34 行，读 interface 得出）
- 新架构: `packages/harness-core/src/features/workspaces/feature.ts`（createWorkspacesJournal + workspacesProjection）

## 能力对照

- [x] load()（载入目录，含版本字段与 deleted_workspace_ids 墓碑）→ `packages/harness-core/src/features/workspaces/feature.ts` 的 openWriter + `workspacesProjection` 回放（projection.ts 的 WorkspacesState.deletedIds 即墓碑集）
- [x] save(catalog)（整目录写回）→ 结构性替代：durable 事件逐条追加（WORKSPACE_CREATED/UPDATED/DELETED/ALIAS/TRUST_SET），由投影折叠出目录，无需整存
- [x] 持久化文件位置（homeDir 下 workspaces 存储）→ feature.ts 的 `join(homeDir, 'workspaces', 'journal.jsonl')` JSONL journal
- [x] onDidChange 变更通知 → `state` ShallowRef 订阅 + `workspace.*` 运行时事件
- [x] 无宿主文件系统时的行为 → host 缺席自动退化为 `memoryJournal()` 纯内存（v2 由 kap-server 注入文件实现，语义等价）

## 结论

全部对齐——load/save/墓碑/变更通知由 JSONL journal + 投影回放等价承载，宿主缺席时纯内存。
