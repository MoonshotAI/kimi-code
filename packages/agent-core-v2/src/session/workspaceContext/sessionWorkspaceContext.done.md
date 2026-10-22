# ISessionWorkspaceContext（sessionWorkspaceContext）

- v2: `packages/agent-core-v2/src/session/workspaceContext/workspaceContext.ts`（约 16 行，读 interface 得出）
- 新架构: `packages/harness-core/src/features/os/path-access.ts`

## 能力对照

- [x] workDir/additionalDirs（工作区根与附加目录）→ 宿主注入：`packages/harness-core/src/features/os/feature.ts`（`CreateOsProps.workDir/additionalDirs`）；多根视图见 `packages/harness-core/src/features/workspaces/view.ts`（`WorkspaceFsRoots`）
- [x] resolve（相对路径解析）→ `packages/harness-core/src/features/os/path-access.ts`（`resolvePathAccess`）
- [x] isWithin（路径是否在工作区内）→ 同文件 `isWithinWorkspace`（含 additionalDirs）
- [x] assertAllowed（读/写/执行越界断言）→ 同文件 `resolvePathAccess`（op 维度判定）+ `packages/harness-core/src/features/workspaces/view.ts`（`resolveWithin` 含 symlink 逃逸检测）

## 结论

全部对齐；会话级工作区上下文由 os path-access 模块与宿主注入的工作区根承载。
