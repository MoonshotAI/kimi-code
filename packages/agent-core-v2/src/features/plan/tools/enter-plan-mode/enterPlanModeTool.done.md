# IEnterPlanModeTool（enterPlanModeTool）

- v2: `packages/agent-core-v2/src/features/plan/tools/enter-plan-mode/enter-plan-mode.ts`（接口约 12 行；实现 `enterPlanModeTool.ts` 约 60 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/plan/tools/enter-plan-mode.ts`

## 能力对照

- [x] 空参数 schema 与描述文档 → `packages/harness-core/src/features/plan/tools/enter-plan-mode.ts` 与 `enter-plan-mode.md`（md 与 v2 逐字相同）
- [x] 已激活时报错 `Plan mode is already active. Use ExitPlanMode when the plan is ready.`（逐字一致）→ 同文件 `execute`
- [x] 进入失败包装 `Failed to enter plan mode: …`（逐字一致）→ 同文件
- [x] 成功工作流提示双形态（有/无 plan 文件路径两版文案，含「Do NOT edit files other than the plan file…」等全部句子，逐字一致）→ 同文件 `enteredPlanModeMessage`

备注：v2 的 `plan_enter_resolved`（auto_approved）埋点未随迁，归属 telemetry 域记录在案未迁。

## 结论

全部对齐：门控、报错与双形态成功文案逐字迁移。
