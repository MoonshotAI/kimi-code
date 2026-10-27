# ITowerPlanTool（towerPlanTool）

- v2: `packages/agent-core-v2/src/features/tower/tools/plan/plan.ts`（57 行，实现见同目录 planTool.ts，68 行；校验主体在 protocol/store.ts plan）
- 新架构: `packages/harness-core/src/features/tower/tools/plan.ts`（createTowerPlanTool）+ `packages/harness-core/src/features/tower/protocol/store.ts`（plan）

## 能力对照

- [x] 输入 schema（missions 数组：title/scope/tasks/context/deps/kind，strict）与主 agent 限定、模式未激活拒绝 → `packages/harness-core/src/features/tower/tools/plan.ts`
- [x] mission 建档：M 序号 id、slug 化 branch（feat/\<slug\>）与 wt-N worktree 分配、survey kind、context/tasks 落盘、MISSIONS.md 与单 mission 文件渲染、activity log → `packages/harness-core/src/features/tower/protocol/store.ts`（plan/renderMissionsIndex/renderMissionFile）
- [x] deps 必须引用已知 mission、branch 不得与既有 mission（含终态）或无主 git 分支冲突、整仓 scope 拒绝 → 同文件 plan 校验
- [ ] 非 ASCII title 拒绝（slug 会坍缩成通用词导致跨 mission 碰撞；v2 报出首个违规字符）— 新栈 plan 无该校验，描述文本也已删去
- [ ] scope 重叠时自动加依赖序列化合并（addAutoDeps 并记 mission notes；有依赖的重叠被允许）— 新栈改为一律拒绝重叠（assertScopesDisjoint 无依赖豁免），描述文本同步改写

## 结论

未对齐 2 项——建档与唯一性校验主干对齐；ASCII 强制与重叠自动依赖两项保真差异，重叠场景从"自动序列化"降级为"直接拒绝"。
