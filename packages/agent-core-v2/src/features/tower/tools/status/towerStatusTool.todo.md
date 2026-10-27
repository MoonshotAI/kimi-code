# ITowerStatusTool（towerStatusTool）

- v2: `packages/agent-core-v2/src/features/tower/tools/status/status.ts`（13 行，实现见同目录 statusTool.ts，263 行 + statusReader.ts，215 行）
- 新架构: `packages/harness-core/src/features/tower/tools/status.ts`（createTowerStatusTool，190 行）

## 能力对照

- [x] 空输入与仪表盘主体：base/mode/caller 头、missions 表（含 survey 🔍 与状态 emoji）、roster 表（含死亡标记）、inbox 计数、自适应并发区（budget/inflight/暂停倒计时）、近期 activity、全关闭后的 TowerTeardown 提示 → `packages/harness-core/src/features/tower/tools/status.ts`
- [x] 未合并分支的评审门区：逐 mission 最近评审轮次/结论与 tip 是否一致（STALE 提示）→ 同文件 renderReviewGate
- [x] 死亡 worker 警告区（按 mission owner 关联 💀 条目并给出 recover 指引）→ 同文件 renderDeathWarnings
- [ ] 结构化合并门：v2 missionGate 的 ready/blocks 稳定 reason code、selected review、exact-tip/clean-rebase-waived 绑定、worker 活跃 unknown/idle 区分 — 新栈无 missionGate，简化为最新评审 + tip 对比
- [ ] state-lost 专项报告（.tower/comms/state.json 丢失但 .tower/ 尚存）与 recoveredAt 恢复警告 — 新栈无 isStateLost/loadOrRecover，未初始化统一报错
- [ ] 模式关闭时输出 "# Tower status — OFF"、未初始化与 state-lost 的三态区分 — 新栈直接 store.load()，失败即协议错误
- [ ] Awaiting spawn 区（planned 且无 owner 的 mission 点名催 spawn）、用户停止（🛑 不复活）与 reviewer 一次性死亡的区分指引 — 新栈简化

## 结论

未对齐 4 项——仪表盘主干对齐；结构化门、状态丢失报告、OFF/未初始化区分与若干分区降级。
