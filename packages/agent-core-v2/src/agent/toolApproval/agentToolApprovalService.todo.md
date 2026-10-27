# IAgentToolApprovalService（agentToolApprovalService）

- v2: `packages/agent-core-v2/src/agent/toolApproval/toolApproval.ts`（约 37 行，读 interface 与 toolApprovalService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/permission/ask.ts`

## 能力对照

- [x] requestToolApproval：发起 approval 交互、等待用户决定、session 范围批准沉淀规则 → `packages/harness-core/src/features/permission/ask.ts`（requestToolApproval，经 `packages/harness-core/src/features/interaction/` 的 interactions.request 承载）
- [x] 审批请求/结果事件外发（permission.approval.requested/resolved）→ `packages/harness-core/src/features/permission/ask.ts`（fire 同名事件）
- [x] formatDenyMessage / formatApprovalRejectionMessage（含 worker agent 的换路指引后缀）→ `packages/harness-core/src/features/permission/ask.ts`（逐字对应，isMain 判定）
- [x] resolvePermissionResolution：approve 放行 / deny 否决文案 / ask 转审批 → `packages/harness-core/src/features/permission/feature.ts`（useToolPermitting 内三分支）
- [ ] 审批展示的富 execution.display（v2 取工具执行上下文自带的 display，kind 多样）— 不迁：新栈首版恒为通用派生（kind: 'generic'，summary=action，detail=args），见 ask.ts

## 结论

未对齐 1 项——审批交互、事件、文案与规则沉淀均已迁移；富展示面按首版决策降级为通用派生。
