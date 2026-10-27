# IWorkspaceDirs（workspaceDirs）

- v2: `packages/agent-core-v2/src/workspace/workspaceDirs/workspaceDirs.ts`（约 30 行，读 interface 与 workspaceDirsService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/workspaces/feature.ts`（WorkspacesFace.addDir/additionalDirs/locate）

## 能力对照

- [x] additionalDirs 读取（.kimi-code/local.toml 的 workspace.additional_dir + 临时目录合并）→ `WorkspacesFace.additionalDirs(id)`（feature.ts 的 readAdditionalDirs + mergedAdditionalDirs）
- [x] addDir（持久写入 local.toml 或仅临时生效，返回 projectRoot/configPath/合并结果）→ `WorkspacesFace.addDir(id, path, persist)`，返回同形 AddDirResult
- [x] mergeAdditionalDirs（会话带入的临时目录并入）→ addDir 的 `persist=false` 临时分支（ephemeralDirs）
- [x] 会话侧可见的工作区目录信息（v2 sessionInfo()/ISessionWorkspaceInfo）→ 结构性替代：消费方经 `WorkspacesFace.locate/additionalDirs` 自取（如 agentsMdReminder 的 roots 计算、fs view 的 rootsForSession）
- [ ] local.toml 的 fswatch 与 onDidChange 变更事件 — 未迁：新栈不监视 local.toml，无目录变更通知（读取按 dirsCache 缓存、addDir 时失效，消费方需重新查询）

## 结论

未对齐 1 项——additional_dir 的读、写、临时合并及会话侧获取全部对齐；local.toml 文件监视与变更事件未迁，改为按需读取。
