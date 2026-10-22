# IWorkspaceService（workspaceService）

- v2: `packages/agent-core-v2/src/app/workspace/workspace.ts`（约 26 行，读 interface 得出）
- 新架构: `packages/harness-core/src/features/workspaces/feature.ts`（WorkspacesFace）

## 能力对照

- [x] list()（按 root 去重的 workspace 列表）→ `WorkspacesFace.list`（dedupeWorkspacesByRoot）
- [x] get(id)（含别名解析）→ `WorkspacesFace.get`（getWorkspaceEntry 走 aliases 映射）
- [x] createOrTouch(root, name?)（存在即 touch lastOpenedAt，否则新建并记录别名）→ `WorkspacesFace.createOrTouch`（feature.ts，含 root 存在性/目录校验与 WORKSPACE_ALIAS 补记）
- [x] update(id, {name}) → `WorkspacesFace.update`
- [x] delete(id)（连带同 root 条目与别名清理）→ `WorkspacesFace.delete`（按 rootKey 扫描别名并提交 WORKSPACE_DELETED）
- [x] 变更通知（v2 经 persistence onDidChange/事件类）→ `workspace.created/updated/deleted` 运行时事件 + `state` ShallowRef

## 结论

全部对齐——workspace 目录的增删改查、touch 语义与变更通知均在 workspaces feature 的 durable 事件 + fold 投影体系中等价承载。
