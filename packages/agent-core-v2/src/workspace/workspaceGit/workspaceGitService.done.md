# IWorkspaceGitService（workspaceGitService）

- v2: `packages/agent-core-v2/src/workspace/workspaceGit/workspaceGit.ts`（约 12 行，读 interface 及 app/git/gitService.ts 实现得出；本 service 是工作区作用域的薄封装）
- 新架构: `packages/harness-core/src/features/workspaces/git.ts`（createWorkspaceGit）

## 能力对照

- [x] status(pathFilter)（branch/ahead/behind/entries/additions/deletions/pullRequest）→ `packages/harness-core/src/features/workspaces/git.ts` 的 `WorkspaceGitPort.status`（git CLI + gh pr view，带 PR 查询缓存与超时收敛）
- [x] 状态响应的 wire 契约（FsGitStatusResponse/FsDiffResponse schema 逐字段一致）→ `packages/harness-core/src/features/workspaces/wire.ts`，与 v2 `#/app/git/git` 同形
- [x] diff(relPath, absPath)（含未跟踪文件 /dev/null diff、1MB 截断）→ `WorkspaceGitPort.diff`
- [x] 经 fs 视图与 HTTP 暴露 → `packages/harness-core/src/features/workspaces/view.ts` 的 gitStatus/diff 与 `packages/harness-core/src/feature-http/route-features/fs.ts` 的 git_status/diff action；wire schema 与 v2 完全一致

## 结论

全部对齐——status/diff 能力在 workspaces feature 的 git 端口中完整承载（早期线索称「未迁」，以当前代码为准已迁完）。
