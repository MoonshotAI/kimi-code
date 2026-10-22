# IGitService（gitService）

- v2: `packages/agent-core-v2/src/app/git/git.ts`（约 65 行 interface）
- 新架构: `packages/harness-core/src/features/workspaces/git.ts`

## 能力对照

- [x] status（分支/ahead/behind/逐文件状态/增删行数/关联 PR 缓存）→ `packages/harness-core/src/features/workspaces/git.ts` 的 createWorkspaceGit().status（含 `gh pr view` 60s 缓存），HTTP 侧为 `packages/harness-core/src/feature-http/route-features/fs.ts` 的 fs:git_status 动作
- [x] diff（单文件 diff，未跟踪/无 HEAD 回退 no-index 对比、1MB 截断）→ 同文件 createWorkspaceGit().diff，路由侧 fs:diff 动作
- [x] findWorkTree（git 工作树探测，v2 供权限策略使用）→ `packages/harness-core/src/features/agentsMdReminder/git-work-tree.ts` 的 findGitWorkTree

## 结论

全部对齐——git status/diff 经 workspaces git 端口与 fs 路由承载，工作树探测由 findGitWorkTree 承载。
