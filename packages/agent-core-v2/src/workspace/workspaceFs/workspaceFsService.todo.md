# IWorkspaceFsService（workspaceFsService）

- v2: `packages/agent-core-v2/src/workspace/workspaceFs/fs.ts`（约 267 行，读 interface 与 wire schema 得出）
- 新架构: `packages/harness-core/src/features/workspaces/view.ts`（createWorkspaceFsView）+ `packages/harness-core/src/features/os/host/types.ts`（OsFsPort）

## 能力对照

- [x] list/listMany/stat/statMany/mkdir（目录列举、批量、建目录）→ `packages/harness-core/src/features/workspaces/view.ts` 的 WorkspaceFsView 同名方法
- [x] read（offset/length 窗口、auto/utf-8/base64、二进制与大文件守卫、etag/mime/line_count）→ view.ts 的 read
- [x] search/suggest/grep（模糊搜索、路径补全、内容 grep 带上下文与限额）→ view.ts 的 search/suggest/grep（纯 Node 遍历实现，带超时与截断）
- [x] gitStatus/diff → view.ts 的 gitStatus/diff，经 `packages/harness-core/src/features/workspaces/git.ts` 的 WorkspaceGitPort
- [x] resolvePath/resolveDownload（相对路径解析、越界与符号链接守卫）→ view.ts 的 resolveWithin 体系
- [x] HTTP 暴露 → `packages/harness-core/src/feature-http/route-features/fs.ts`（sessions fs 动作族）
- [x] 宿主文件系统端口与单一 rg 载体 → `packages/harness-core/src/features/os/host/types.ts` 的 OsFsPort；rg 收敛为 `packages/harness-core/src/features/os/rg/` 一份（tools/grep.ts、glob.ts 使用）
- [ ] FsEntry 的逐条目 git_status 装饰（include_git_status）— 降级：新 wire schema（features/workspaces/wire.ts）已删除 FsEntry.git_status 字段，list/listMany 接受但忽略 include_git_status，只能整库调 gitStatus
- [ ] list 请求的 allow_ignored_globs（放行被 ignore 的特定 glob）— 缺失：新 fsListRequestSchema 无此字段，仅支持 exclude_globs

## 结论

未对齐 2 项——fs 浏览/读取/搜索/grep/git/下载解析全部对齐；逐条目 git_status 装饰与 allow_ignored_globs 两项 wire 能力被裁减。
