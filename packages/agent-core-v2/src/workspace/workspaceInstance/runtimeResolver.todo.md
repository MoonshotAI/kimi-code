# IRuntimeResolver（runtimeResolver）

- v2: `packages/agent-core-v2/src/workspace/workspaceInstance/workspaceInstanceManager.ts`（约 40 行，与 IWorkspaceInstanceManager 同文件，读 interface 得出）
- 新架构: 无对应（决策不迁）

## 能力对照

- [ ] inspect(binding)（按 RuntimeBinding 解析 Runtime）— 未见等价：agent-core/harness-core 内无 Runtime/RuntimeBinding 抽象（该抽象仍由 kap-server 侧的 v2 运行时消费）
- [ ] acquire(binding, required)（按能力需求租用 RuntimeLease）— 未见等价：v2 远程 runtime 租约体系整体不迁，归属 kap-server/宿主层
- [ ] 消费方按 runtimeId 路由执行位置（v2 mcpCore stdio、terminal 等经 lease 选择本地/远程执行）— 未见等价：新栈一律经宿主 OsProcessPort 本地执行（`packages/harness-core/src/features/os/host/types.ts`）
- [x] 本地执行能力的最终承载 → 结构性替代：`packages/harness-core/src/features/os/host/types.ts` 的 OsHost/OsFsPort/OsProcessPort 由宿主创建并注入各 feature（决策：宿主注入端口即能力承载）

## 结论

未对齐 2 项——runtime 解析与租约属 v2 远程 runtime 体系，决策不迁；新架构以宿主注入的 OS 端口直接承载本地执行。
