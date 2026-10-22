# IBuiltinToolAssemblyService（builtinToolAssemblyService）

- v2: `packages/agent-core-v2/src/agent/toolRegistry/builtinToolAssemblyService.ts`（约 33 行，interface 与实现同文件）
- 新架构: `packages/harness-core/src/preset.ts` + `packages/harness-core/src/runtime/hooks.ts`

## 能力对照

- [x] 内置工具的静态装配（App 作用域把 AgentToolContribution 静态记录全部 provide 进集合，供下游激活）→ 新栈改为 feature 声明式贡献：每个 feature 在挂载时经 `useAgentTools` 注册自己的工具（`packages/harness-core/src/runtime/hooks.ts`，todo/plan/skill/edit/notify/ptc/swarm/tower/task 等均如此），产品级组合由 `packages/harness-core/src/preset.ts` 的 harnessPreset 一处列出
- [x] 贡献记录集合的注入（AgentToolContribution collection，供 toolActivation 遍历激活）→ kernel Unit 树 + onScopeDispose 回收承载（feature 卸载即工具注销），无需静态集合
- [x] App 作用域 OnScopeCreated 的装配时机 → preset 在 createApp 时随 feature 列表一并确定，见 `packages/harness-core/src/preset.ts`，装配不再是一个独立运行时阶段
- 备注：v2 中本服务是 toolActivation 的上游（装配 → 门控激活 → 注册）；门控激活环节的迁移情况见同目录 ../toolActivation/agentToolActivationService.md

## 结论

全部对齐——静态装配服务被「preset 组合 + feature 挂载即贡献」的声明式结构取代，装配行为本身消失而非迁移。
