# IDefaultWorkspace（defaultWorkspace）

- v2: `packages/agent-core-v2/src/app/defaultWorkspace/defaultWorkspace.ts`（约 11 行，读 interface 与 defaultWorkspaceService.ts、defaultWorkspacePaths.ts 得出）
- 新架构: `packages/harness-core/src/features/workspaces/feature.ts`（CreateWorkspacesProps.defaultRoot）

## 能力对照

- [x] 默认工作区根参与新会话归属（v2 ensure() 确保目录存在并被会话流程使用）→ workspaces feature：props.defaultRoot 存在时，session.created 后 createOrTouch(defaultRoot) 并把 workspaceId 写入会话 metadata（feature.ts）
- [ ] `[defaultWorkspace]` 配置节自定义根路径（path 字段，含 `~` 展开与平台路径合法性校验，见 v2 configSection.ts/defaultWorkspacePaths.ts）— 新栈 defaultRoot 只能由宿主 props 给定，两包内无配置节，缺失
- [ ] 默认根约定 `~/KimiCode/Default`（DEFAULT_WORKSPACE_RELATIVE_ROOT）— 新栈两包内无该约定，取值完全交给宿主，缺失
- [ ] isDefault(root) 判定与 ensure() 的失败分类（DefaultWorkspaceUnavailableError：blocked_by_file/permission_denied/no_space/read_only/invalid_path 等）— 新栈 workspaces feature 无 isDefault 与错误分类，createOrTouch 失败仅静默 catch（feature.ts 的 .catch(() => {})），缺失

## 结论

未对齐 3 项——「新会话自动挂到默认根」的主流程由 defaultRoot prop 承载；配置节、默认根约定与 isDefault/错误分类在新栈两包内缺失。
