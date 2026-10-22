# IAgentPermissionPolicyService（agentPermissionPolicyService）

- v2: `packages/agent-core-v2/src/agent/permissionPolicy/permissionPolicy.ts`（约 22 行，读 interface 与 permissionPolicyService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/permission/policies/chain.ts`

## 能力对照

- [x] evaluate：按固定顺序逐条评估权限策略链并返回首个定论（policyName + result）→ `packages/harness-core/src/features/permission/policies/chain.ts`（evaluatePermissionPolicies，12 条策略逐字移植：userConfiguredDeny / dangerousCommandAsk（交互时）/ autoModeApprove / sessionApprovalHistory / userConfiguredAsk / userConfiguredAllow / sensitiveFileAccessAsk / gitControlPathAccessAsk / yoloModeApprove / defaultToolApprove / gitCwdWriteApprove / fallbackAsk；原 autoModeAskUserQuestionDeny 已移出链，改由 Interaction feature 自持：`packages/harness-core/src/todo-features/interaction/permission-mode.ts`，并补充 auto 模式进出的响应式 remind）
- [x] 各策略实现（危险命令、敏感文件、git 控制路径、模式 approve 等）→ `packages/harness-core/src/features/permission/policies/`（mode.ts / user-rules.ts / defaults.ts / files.ts / dangerous.ts）+ `packages/harness-core/src/features/permission/analyzers/`（bash-danger.ts / git.ts）
- [x] 评估输入上下文（工具调用、解析后 args、interactive、mode、rules、sessionApprovalRulePatterns、config、workDir、pathClass、homeDir、fs）→ `packages/harness-core/src/features/permission/policies/chain.ts`（PermissionPolicyContext，由 `packages/harness-core/src/features/permission/feature.ts` 在 useToolPermitting 内组装）
- [x] 规则模式与主题匹配语言（策略所需的 pattern/subject 匹配）→ `packages/harness-core/src/features/permission/language/`（pattern.ts / subject-match.ts / tool-matchers.ts）

## 结论

全部对齐（策略链顺序、策略集合、上下文组装与匹配语言逐字对应）。
