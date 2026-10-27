# IAgentToolActivationService（agentToolActivationService）

- v2: `packages/agent-core-v2/src/agent/toolActivation/toolActivation.ts`（约 10 行，读 interface 与 toolActivationService.ts/toolAvailability.ts 得出）
- 新架构: `packages/harness-core/src/runtime/hooks.ts`（useAgentTools，无门控）

## 能力对照

- [ ] 按 profile 激活工具（activate：依 activeToolNames/disallowedTools 决定哪些贡献进入注册表，SelectTools 走披露策略特例）— 新栈主 agent 工具由 feature 经 `useAgentTools` 无条件贡献（`packages/harness-core/src/runtime/hooks.ts`），工具可见性跟随 profile 的门控未做；仅子代理 spawn 时按 profile 过滤（`packages/harness-core/src/features/spawn/run.ts`）
- [ ] workspace 级禁用 veto（toolPolicyGate.disabledTools 一票否决）— 新栈无 sessionToolPolicyGate 承载（sessionToolPolicy 归属挂起，记录在案）
- [ ] 运行时能力门控（requiredRuntimeCapabilities 不满足则停用、runtime 变化时刷新）— 随 runtime 体系决策不迁
- [ ] 状态/贡献变化时增量重激活（AgentStatusUpdated、contribution onDidChange 驱动）— 新栈 feature 贡献随 Unit 挂载即生效、卸载即回收（onScopeDispose），无需重激活机制，但「运行中按状态变化切换工具集」的能力随之缺失
- [x] 延迟披露工具（deferred 工具经 SelectTools 按需加载）→ `packages/harness-core/src/features/tool-select/feature.ts`（deferTool + SelectTools 元工具）

## 结论

未对齐 4 项——主 agent 的 profile/策略/运行时门控激活整体未迁；新栈工具贡献是无条件的，仅 deferred 披露（tool-select）与 spawn 子代理过滤部分覆盖。
