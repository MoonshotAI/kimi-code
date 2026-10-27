# IAgentRuntimeService（agentRuntimeService）

- v2: `packages/agent-core-v2/src/agent/runtimeBinding/agentRuntime.ts`（约 126 行，interface 与实现同文件）
- 新架构: 无对应（决策不迁）

## 能力对照

- [ ] 运行时检视（inspect：runtime 身份/代数/状态/能力集）— v2 远程 runtime 体系的一部分；新架构决策不迁，「宿主注入什么端口即能力决策」
- [ ] 能力可用性判定（isAvailable(requiredCapabilities)）— 同上；新栈无 RuntimeCapability 概念（全仓 grep 无命中）
- [ ] 运行时租约获取（acquire → RuntimeLease，按能力借用 fs 等）— 同上；新栈能力由宿主经 feature props/facade 直接注入（如 agentsMdReminder 经 props 接 host、os feature 的 OsFsPort）
- [ ] 运行时变更通知（onDidChange，binding/registry 变化触发 rebind）— 随体系一并不迁

## 结论

未对齐 1 项——决策性不迁：v2 远程 runtime 的 lease/generation/能力校验体系整体被「宿主注入端口即能力」取代。
