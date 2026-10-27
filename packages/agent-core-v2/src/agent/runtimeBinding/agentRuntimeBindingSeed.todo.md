# IAgentRuntimeBindingSeed（agentRuntimeBindingSeed）

- v2: `packages/agent-core-v2/src/agent/runtimeBinding/runtimeBinding.ts`（约 21 行，仅 interface；与 IAgentRuntimeBindingService 同文件）
- 新架构: 无对应（决策不迁）

## 能力对照

- [ ] Agent 作用域创建时的初始 runtime 绑定种子（readonly binding，开 agent 时播种，再由 IAgentRuntimeBindingService 承载后续切换）— v2 远程 runtime 体系的一环；新架构决策不迁整个 runtime 体系（无 lease、无 generation 校验、无 requiredRuntimeCapabilities，全仓 grep 无命中），种子概念随之消失
- [ ] 种子的只读暴露供 scope 内其他服务消费 — 同上；新栈能力在 agent 打开时由宿主经 AgentCaps 一次性给定（`packages/agent-core/src/session/session.ts` 的 ensureAgent），无需种子对象
- 备注：v2 中种子由 agent 生命周期服务在创建 Agent 作用域时提供（`packages/agent-core-v2/src/session/agentLifecycle/agentLifecycleService.ts`），与同目录 agentRuntimeBindingService.md / agentRuntimeService.md 同属一个体系
- 备注：种子本身不含行为，仅是绑定值的注入位；其消费方 IAgentRuntimeBindingService 的对照结论同为决策不迁

## 结论

未对齐 1 项——决策性不迁：随 v2 runtime 绑定体系整体取消。
