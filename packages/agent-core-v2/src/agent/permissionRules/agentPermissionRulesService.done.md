# IAgentPermissionRulesService（agentPermissionRulesService）

- v2: `packages/agent-core-v2/src/agent/permissionRules/permissionRules.ts`（约 34 行，读 interface 与 permissionRulesService.ts、configSection.ts 实现得出）
- 新架构: `packages/harness-core/src/features/permission/state/projection.ts` + `packages/harness-core/src/features/permission/state/configSection.ts`

## 能力对照

- [x] rules 读取与 addRules（durable 累加）→ `packages/harness-core/src/features/permission/state/projection.ts`（PERMISSION_RULES_ADD）+ `packages/harness-core/src/features/permission/feature.ts`（PermissionRef.addRules）
- [x] sessionApprovalRulePatterns 与 recordApprovalResult（session 范围批准后沉淀为规则模式）→ `packages/harness-core/src/features/permission/state/projection.ts`（PERMISSION_RECORD_APPROVAL_RESULT）+ `packages/harness-core/src/features/permission/ask.ts`（requestToolApproval 内记录）
- [x] 规则模式解析与匹配（parsePattern/matchPermissionRule）→ `packages/harness-core/src/features/permission/language/pattern.ts` + `packages/harness-core/src/features/permission/language/tool-matchers.ts`
- [x] permission 配置节 rules 及 legacy deny/allow/ask 分组 toml 写法归一化 → `packages/harness-core/src/features/permission/state/configSection.ts`（permissionFromToml/permissionToToml 逐字移植，含 KIMI_CODE_DANGEROUS_COMMAND_GUARD env 绑定）

## 结论

全部对齐（运行时规则、durable 审批沉淀、模式语言与配置节 legacy 写法归一化均已迁移）。
