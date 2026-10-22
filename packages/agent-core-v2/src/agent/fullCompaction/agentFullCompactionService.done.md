# IAgentFullCompactionService（agentFullCompactionService）

- v2: `packages/agent-core-v2/src/agent/fullCompaction/fullCompaction.ts`（约 36 行，读 interface 与 fullCompactionService.ts 得出）
- 新架构: `packages/harness-core/src/features/compaction/feature.ts`

## 能力对照

- [x] 发起压缩（begin，携带 source 与可选 instruction）→ `packages/harness-core/src/features/compaction/feature.ts` 的 `compact(instruction)`；触发源 manual/auto 对应 CompactionReason 的 manual/budget/overflow（自动由 _stepStarting 预算检查与 _noteLlmOutcome 溢出恢复驱动）
- [x] 进行态查询（compacting 任务：触发源/中止控制器/promise）→ 同文件 `status()` 返回 CompactionStatus（phase: idle/quiescing/summarizing/resetting/completed/cancelled 加 reason、startedAt）
- [x] 取消（cancel）→ `cancel()`，取消原因细分 cancelled/user-abort/drift/failed
- [x] 压缩前钩子（hooks.onWillCompact）→ 同文件 `deps.onWillCompact`（携带 reason/instruction/signal/tokenCount）
- [x] 完成事件（onDidFinishCompaction）→ `compaction.completed` 事件（含 CompactionStats 与 summary telemetry），另有 `compaction.started`/`blocked`/`cancelled`

## 结论

全部对齐——压缩的发起、进行态、取消与前后钩子/事件均由 harness-core compaction feature 经 CompactionRef 暴露的 CompactionFace 承载。
