# IAgentRuntimeBindingService（agentRuntimeBindingService）

- v2: `packages/agent-core-v2/src/agent/runtimeBinding/runtimeBinding.ts`（约 21 行，仅 interface）
- 新架构: 无对应（决策不迁）

## 能力对照

- [ ] 当前 agent ↔ runtime 绑定的读取（current/get：workspaceId + runtimeId 二元组）— v2 远程 runtime 体系的绑定层；新架构决策不迁，agent 能力由宿主注入端口决定，无绑定对象可言
- [ ] 绑定的写入与切换（set/switch(runtimeId)，切换后驱动 IAgentRuntimeService rebind）— 同上；新栈 agent 打开时由 `packages/agent-core/src/session/session.ts` 的 ensureAgent 一次性注入 AgentCaps（requester/executor/hooks），无可切换的运行时句柄
- [ ] 绑定变更事件（onDidChange）— 随体系一并不迁
- 备注：v2 的初始绑定由 IAgentRuntimeBindingSeed 在 agent 生命周期创建时播种（`packages/agent-core-v2/src/session/agentLifecycle/agentLifecycleService.ts`），本文档与同目录 agentRuntimeBindingSeed.md / agentRuntimeService.md 同属一个体系

## 结论

未对齐 1 项——决策性不迁：runtime 绑定概念在新栈不存在，宿主注入即能力决策。
