# IExitPlanModeTool（exitPlanModeTool）

- v2: `packages/agent-core-v2/src/features/plan/tools/exit-plan-mode/exit-plan-mode.ts`（接口约 76 行；实现 `exitPlanModeTool.ts` 约 180 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/plan/tools/exit-plan-mode.ts`

## 能力对照

- [x] options 参数面：1–3 个选项、label 1–80 字符、唯一性校验、保留标签（Approve/Reject/Reject and Exit/Revise）禁用，描述文案逐字一致 → `packages/harness-core/src/features/plan/tools/exit-plan-mode.ts`（`parseExitPlanModeArgs`）
- [x] 描述文档 → `packages/harness-core/src/features/plan/tools/exit-plan-mode.md`（与 v2 逐字相同）
- [x] 未激活报错 `…Use EnterPlanMode (or /plan) first.`、空 plan 报错 `No plan file found. Write your plan to …`（逐字一致）→ 同文件 `execute`
- [x] 审批前记录修订（recordRevision）→ 审批在 `packages/harness-core/src/features/plan/guard.ts` 拦截时先于交互调用 `recordRevision`（时序与 v2 的 resolvePlanReviewDisplay 等价）
- [x] 通过/免审输出：`formatPlanForOutput`/`formatAutoApprovedPlanForOutput` 两版文案逐字一致 → `packages/harness-core/src/features/plan/review.ts`

备注：v2 的 `plan_submitted`/`plan_resolved` 埋点未随迁，归属 telemetry 域记录在案未迁；v2 经 `ToolInputDisplay.kind='plan_review'` 走审批 UI 契约，新栈改由 interaction feature 的 approval 请求承载（宿主交互契约换代，用户可见流程一致）。

## 结论

全部对齐：参数校验、报错、修订记录与审批输出逐字迁移，审批通道由 plan_review display 改为 interaction approval。
