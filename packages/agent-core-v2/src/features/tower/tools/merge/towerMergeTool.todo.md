# ITowerMergeTool（towerMergeTool）

- v2: `packages/agent-core-v2/src/features/tower/tools/merge/merge.ts`（19 行，实现见同目录 mergeTool.ts，116 行；store 侧 merge()/missionGate() 在 protocol/store.ts 与 protocol/missionGate.ts）
- 新架构: `packages/harness-core/src/features/tower/tools/merge.ts`（createTowerMergeTool）+ `packages/harness-core/src/features/tower/protocol/store.ts`（merge 内联门）

## 能力对照

- [x] 主 agent 限定与评审硬门：须 clean 评审、评审戳与当前 tip 一致、mission 戳歧义拒绝 → `packages/harness-core/src/features/tower/protocol/store.ts`（merge 内 no-review/not-clean/tip-moved/review-mission-mismatch 块）
- [x] deps 按序合并、survey 零 diff no-op 关闭（read-only 违规拒绝）、scope 越界拒绝、base 检出/脏文件保护、conflictsWith 冲突报告 → 同文件 merge 内联块
- [ ] mission 完成态门禁：not-completed/open-tasks/blockers/worker-busy/worker-unknown 五类稳定 reason block（v2 missionGate.ts + activeAgentIds 观测）— 新栈内联门无此五项
- [ ] evaluated-tip 合并与 'advanced' 竞态处理：合并精确到评估时的 commit、分支中途前进时报告部分合并/survey 未关闭、HEAD 包含性恢复校验 — 新栈直接 mergeNoFf(branch)，无竞态检测
- [ ] 分支租约（IAgentTowerService.withBranchLease）与 store 状态锁（withStateLock）— 新栈均无
- [ ] clean-rebase-waived 评审绑定（无冲突 rebase 后豁免 tip 绑定）— 随 TowerRebase 决策不做而不存在
- [ ] 全部 mission 关闭后的 TowerTeardown 就绪提示 — 新栈输出不含

## 结论

未对齐 5 项——评审/依赖/scope/base 保护主干对齐；完成态门禁、合并竞态处理、租约与状态锁、rebase 豁免绑定未迁。
