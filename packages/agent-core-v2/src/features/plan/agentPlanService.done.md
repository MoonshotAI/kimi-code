# IAgentPlanService（agentPlanService）

- v2: `packages/agent-core-v2/src/features/plan/plan.ts`（接口约 23 行；实现 `planService.ts` 约 279 行 + `exitPlanModeReview.ts` 约 175 行 + `injection/`，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/plan/feature.ts`（`PlanRef` facade + guard/review/injection/projection）

## 能力对照

- [x] `enter/cancel/clear/exit/recordRevision/status` 六方法（含 already-active 报错、createFile 失败回滚、修订版本写 blob 并记 PlanRevision 事件）→ `packages/harness-core/src/features/plan/feature.ts` 与 `projection.ts`、`storage.ts`（存储改为宿主注入 `PlanStorage` 端口）
- [x] 计划模式守卫：Write/Edit 仅允许写当前 plan 文件、拒绝 TaskStop、拒绝 CronCreate/CronDelete（拒绝文案逐字一致）→ `packages/harness-core/src/features/plan/guard.ts`
- [x] ExitPlanMode 五分支审批：approved（含选项前缀「Selected approach…Execute ONLY…」）/ dismissed / Reject and Exit（退出 + isError + stopTurn）/ Revise 或带 feedback / 裸 rejected（isError + stopTurn），输出文案逐字一致 → `packages/harness-core/src/features/plan/review.ts`
- [x] auto 权限模式免审旁路（退出并标注 auto-approved 未获用户明确认可，文案逐字一致）→ `packages/harness-core/src/features/plan/guard.ts`（`permissionMode?.() === 'auto'` 分支）
- [x] 提醒变体：full/sparse/reentry/exit 四变体 + 无 plan 路径时的 inline 版，7 个 md 与 v2 逐字相同，去重 2 轮、全量刷新 5 轮阈值一致 → `packages/harness-core/src/features/plan/injection.ts` 与 `injection/` 目录
- [x] 进入产品默认装配 → `packages/harness-core/src/preset.ts`（`createPlan()`）

备注：v2 的 plan 埋点（`plan_submitted`/`plan_resolved`/`plan_enter_resolved`、telemetry mode 上下文）未随迁，归属 telemetry 域记录在案未迁；plan id 由 hero-slug 改为 UUID（仅影响文件路径可读性）；`AgentStatusUpdated` 的 planMode 标志由 `PlanRef.state` 响应式状态取代。

## 结论

全部对齐：六个服务方法、守卫、五分支审批、auto 旁路与提醒变体逐函数核查均有等价承载，仅存埋点等内部面差异。
