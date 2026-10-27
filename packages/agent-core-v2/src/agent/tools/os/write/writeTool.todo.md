# IWriteTool（writeTool）

- v2: `packages/agent-core-v2/src/agent/tools/os/write/write.ts`（约 33 行；实现 writeTool.ts 约 140 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/os/tools/write.ts`

## 能力对照

- [x] overwrite/append 两种模式、父目录自动创建、写入字节数回报 → `packages/harness-core/src/features/os/tools/write.ts`
- [x] path-access：相对路径限定工作目录、目录外必须绝对路径、敏感文件拦截、additionalDirs → `packages/harness-core/src/features/os/path-access.ts`（createOs 可传 additionalDirs，见 `../feature.ts`）
- [x] 审批规则（按路径的规则匹配）→ `packages/harness-core/src/features/permission/language/tool-matchers.ts`（Write 条目）
- [ ] skill 根目录并入可写域（v2 经 skillCatalog.getSkillRoots 扩充 additionalDirs）— 记录在案未迁：新栈 additionalDirs 仅来自 createOs props，不与 skill 域联动；可用绝对路径绕过
- [ ] runtime lease 代际检查 — 决策不迁：新栈为单一 Node 宿主

## 结论

未对齐 2 项——skill 根目录联动未迁、runtime lease 决策不迁；写入主链路已对齐。
