# IAgentPermissionGate（agentPermissionGate）

- v2: `packages/agent-core-v2/src/agent/permissionGate/permissionGate.ts`（约 20 行，读 interface 与 permissionGateService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/permission/feature.ts`

## 能力对照

- [x] 工具执行前的权限裁决（policy 评估 → ask 走审批 / approve 放行 / deny 否决）→ `packages/harness-core/src/features/permission/feature.ts`（useToolPermitting 内 evaluatePermissionPolicies + requestToolApproval/formatDenyMessage）
- [x] 裁决在工具调用重写链之后、执行之前进行（v2 为 onBeforeExecuteTool，新栈为 agent-core 内置 tool.permitting 阶段，领域守卫先注册先跑、permission 殿后）→ `packages/agent-core/src/loop/`（tool.permitting 钩子阶段，见包 AGENTS.md）+ `packages/harness-core/src/features/permission/feature.ts`
- [x] data() 暴露当前 mode 与 rules → `packages/harness-core/src/features/permission/feature.ts`（PermissionRef.state ComputedRef）+ `packages/harness-core/src/features/permission/state/projection.ts`
- [x] authorize() 独立裁决入口（供执行前钩子之外的调用方复用同一评估）→ `packages/harness-core/src/features/permission/policies/chain.ts`（evaluatePermissionPolicies 为纯函数，任意调用方可直接评估）

## 结论

全部对齐（裁决编排、ask/approve/deny 三分支、独立评估入口与状态暴露均由 permission feature 承载；permission_policy_decision 遥测按既定决策不迁，不计入）。
