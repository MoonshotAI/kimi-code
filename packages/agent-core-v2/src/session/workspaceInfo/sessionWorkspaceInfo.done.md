# ISessionWorkspaceInfo（sessionWorkspaceInfo）

- v2: `packages/agent-core-v2/src/session/workspaceInfo/workspaceInfo.ts`（约 18 行，读 interface 得出）
- 新架构: `packages/harness-core/src/features/workspaces/feature.ts`

## 能力对照

- [x] additionalDirs 读取（会话关联工作区的附加目录）→ `packages/harness-core/src/features/workspaces/feature.ts`（`WorkspacesFace.additionalDirs(id)`；会话-工作区关联见 `packages/harness-core/src/features/workspaces/session.ts`）
- [x] 附加目录变更（addDir 持久化）→ 同文件 `addDir(id, path, persist)`（写入工作区配置）
- [x] 变更通知（onDidChange）→ 同文件 `workspace.updated` feature 事件（addDir/update 时 fire）
- [x] ready（初始加载）→ 结构承载：workspaces feature 挂载即完成 journal 加载，消费方经 `useReady`/`ready` 语义对齐

## 结论

全部对齐；会话种子视图由 app 级 workspaces facade 与 feature 事件承载。
