# IEditTool（editTool）

- v2: `packages/agent-core-v2/src/agent/tools/edit/edit.ts`（约 34 行；实现 editTool.ts 约 119 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/edit/`（tool.ts / service.ts / path-access.ts / line-endings.ts）

## 能力对照

- [x] 精确替换（old_string/new_string/replace_all、old==new 拒绝、替换计数回报）→ `packages/harness-core/src/features/edit/tool.ts`、`service.ts`（editFile）
- [x] path-access：相对路径限定工作目录、目录外必须绝对路径、敏感文件（env/密钥）拦截 → `packages/harness-core/src/features/edit/path-access.ts`
- [x] CRLF/混合行尾的读写视图对齐 → `packages/harness-core/src/features/edit/line-endings.ts`
- [x] 审批规则（按路径的规则匹配）→ `packages/harness-core/src/features/permission/language/tool-matchers.ts`（Edit 条目）
- [ ] additionalDirs 与 skill 根目录并入可写域（v2 经 workspaceCtx + skillCatalog 扩充 workspace）— 降级：`createEdit` 只收 workDir，os 域的 additionalDirs 不覆盖 edit；目录外只能用绝对路径
- [ ] runtime lease 代际检查（runtime 变更时拒绝执行并提示重试）— 决策不迁：新栈为单一 Node 宿主，无 runtime 切换

## 结论

未对齐 2 项——additionalDirs/skill 根目录未接入 edit、runtime lease 决策不迁；核心编辑能力已对齐。
