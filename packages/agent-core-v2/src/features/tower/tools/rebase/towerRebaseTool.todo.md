# ITowerRebaseTool（towerRebaseTool）

- v2: `packages/agent-core-v2/src/features/tower/tools/rebase/rebase.ts`（19 行，实现见同目录 rebaseTool.ts，86 行；store 侧 rebaseMission() 在 protocol/store.ts）
- 新架构: 无对应

## 能力对照

- [ ] tower 主导的 mission 分支变基：仅 tower 可调用（worker 只能被 tower 要求时自己 rebase）、up-to-date/rebased/conflict 三态结果 — 新栈无该工具（protocol/store.ts 无 rebaseMission）
- [ ] 冲突时自动 abort 并把 mission 标 blocked、报告冲突文件、指引后台 resume worker 解决 — 无对应
- [ ] 无冲突变基保留既有评审的精确 tip 绑定（clean-rebase-waived 豁免后续合并门的 tip 校验）— 随工具一并消失
- [ ] 变基期间的分支租约（withBranchLease）与 worker 活跃观测（activeAgentIds）— 无对应

## 结论

未对齐——决策不做：合并后冲突分支改由 worker 自行变基（新栈 tools/merge.ts 输出指引 "Agent resume ... to rebase onto the updated base"）；自动 abort+blocked 联动与评审绑定保留随之缺失。
