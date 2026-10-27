# ITowerMissionTool（towerMissionTool）

- v2: `packages/agent-core-v2/src/features/tower/tools/mission/mission.ts`（46 行，实现见同目录 missionTool.ts，90 行；校验主体在 protocol/store.ts updateMission）
- 新架构: `packages/harness-core/src/features/tower/tools/mission.ts`（createTowerMissionTool）+ `packages/harness-core/src/features/tower/protocol/store.ts`（updateMission）

## 能力对照

- [x] 仅 id 读取 mission 视图（missions 目录 md 全文）；patch 更新 status/note/blocker/clear_blockers/task_done/scope → `packages/harness-core/src/features/tower/tools/mission.ts` + store.updateMission
- [x] 权限约束：worker 只能改自己拥有的 mission；owner/scope/spawnBase/abandoned 仅 tower 可写；scope 变更过互斥校验并记日志 → `packages/harness-core/src/features/tower/protocol/store.ts`（updateMission）
- [x] task_done 文本匹配首个开放任务、blocker 联动置 blocked、更新后回报状态/开放任务数/blocker 数 → 同文件
- [ ] task_drop/task_drop_reason：合法缩减任务的逃生口（dropped 标记、原因入 notes 与 activity log）— schema 与 store 均未迁
- [ ] status=completed 前置校验链：有 blockers/开放任务拒绝、build 无 diff 拒绝、survey 分支须零 diff、caller 有未读 inbox 拒绝 — 新栈 updateMission 无
- [ ] 非 clean 评审落地自动把 completed 翻回 active — 新栈 submitReview 无此联动
- [ ] merged 仅 TowerMerge 可记、merged/abandoned 终态不可被通用 patch 重开 — 新栈 updateMission 对 status=merged 无防护（模型可绕过合并门直接置 merged）

## 结论

未对齐 4 项——读写与权属主干对齐；task_drop、completed 前置校验、评审翻回联动与 merged 写保护未迁，其中最后一项是可绕过合并门的防护降级。
