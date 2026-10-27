# IStandaloneRuntimeFactory（standaloneRuntimeFactory）

- v2: `packages/agent-core-v2/src/runtime/standaloneRuntime.ts`（约 41 行，读 interface 与实现得出）
- 新架构: 无对应

## 能力对照

- [ ] 本地运行时工厂（createLocalRuntime(workspaceId) → Runtime）— agent-core 与 harness-core 内无 Runtime/LocalRuntime 体系（已 Grep 核实无 StandaloneRuntime/LocalRuntime 对应），能力缺失；v2 远程 runtime 体系整体不迁
- [ ] 运行时四能力聚合（environment/fs/process/terminal 注入 LocalRuntime）— 无对应；新栈 os 三端口经 `packages/harness-core/src/features/os/host/` 直接注入 feature，不经运行时工厂（terminal 域亦决策不迁，见 os/interface/hostTerminalService.md）
- [ ] App 级按需激活（v2 经 registerScopedService OnDemand 注册）— 随 DI 体系一并废弃，无对应；新栈宿主在 `packages/harness-core/src/host/` 直接组装所需端口
- [ ] 按 workspaceId 维度派生运行实例（v2 每个 workspace 一个 LocalRuntime）— 无对应；新栈 workspace 维度由 `packages/harness-core/src/features/workspaces/` 的目录与 journal 承载，与进程/文件系统端口解耦

## 结论

未对齐 1 类：v2 远程 runtime 体系决策不迁，工厂与 Runtime 抽象在新栈两个包内无承载；其本地能力面（环境/文件系统/进程）已由 os host 端口分别承接，workspace 维度另有 workspaces feature 承担。
