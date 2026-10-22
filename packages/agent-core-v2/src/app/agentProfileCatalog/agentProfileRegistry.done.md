# IAgentProfileRegistry（agentProfileRegistry）

- v2: `packages/agent-core-v2/src/app/agentProfileCatalog/agentProfileRegistry.ts`（约 28 行，读 interface 与 agentProfileRegistryService.ts 得出）
- 新架构: `packages/harness-core/src/features/profiles/feature.ts`（profiles feature 的 ProfileCatalogFace 与 finder 收集机制）

## 能力对照

- [x] 多来源 profile 贡献的注册与汇总（v2 为 register()+AgentProfileContribution collection 双通道）→ `packages/harness-core/src/features/profiles/discovery/finder.ts`（`useProfileFinder` / `ProfileFinders` collection）
- [x] 按 sourceId+priority 归并同名 profile（含 builtin 保护与 override 语义）→ `packages/harness-core/src/features/profiles/catalog/catalog.ts`（buildCatalogView，priority 分级定义见 `packages/harness-core/src/features/spawn/profile.ts` 的 PRIORITY）
- [x] 变更通知（v2 onDidChange）→ profiles feature 内 `watch(finders)` 触发重建，`ProfileCatalogFace.reload()` 主动重载（`packages/harness-core/src/features/profiles/feature.ts`）
- [x] 注册条目列举（v2 entries()）→ ProfileCatalogFace 的 `list()/get()/getDefault()/inspect()`；inspect 还暴露 sourceId/priority/suppressed 归并细节
- [x] 工作区级 profile 来源（v2 注册项的 workspaceKey 维度）→ `createWorkspaceFinder` 按 workDir 发现工作区 agent 文件（`packages/harness-core/src/features/profiles/feature.ts`）

## 结论

全部对齐——DI 注册表被「finder collection + 目录归并视图 + 响应式重建」结构取代，能力面完整。
