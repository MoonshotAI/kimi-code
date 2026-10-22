# IWorkspaceAliases（workspaceAliases）

- v2: `packages/agent-core-v2/src/app/workspaceAliases/workspaceAliases.ts`（约 10 行，读 interface 与 workspaceAliasesService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/workspaces/projection.ts`（aliases 映射 + resolveWorkspaceId）

## 能力对照

- [x] resolveAliasIds(id)（按 root 归并同义 workspace id：目录条目 + session_index 历史 id）→ `packages/harness-core/src/features/workspaces/projection.ts` 的 WORKSPACE_ALIAS 记录与 aliases 映射；归一查询用 `resolveWorkspaceId/getWorkspaceEntry`
- [x] 别名随 createOrTouch 自动补记（id 漂移时）→ feature.ts 的 createOrTouch 在 rootKey 命中旧条目时提交 WORKSPACE_ALIAS
- [x] 别名参与会话归属（v2 消费方按别名集匹配会话）→ `WorkspacesFace.sessionCount` 的候选集（aliases 反查）与 `packages/harness-core/src/feature-http/route-builtin/sessions.ts` 的 resolveWorkspaceId 归一过滤
- [x] 别名随 delete 清理 → projection.ts 的 WORKSPACE_DELETED 分支（按 root/aliasIds 移除映射并记墓碑）

## 结论

全部对齐——别名登记、归一解析、会话归属与删除清理均已迁入 workspaces 投影（trust/aliases 同源 journal）。
