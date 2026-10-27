# ITowerInitTool（towerInitTool）

- v2: `packages/agent-core-v2/src/features/tower/tools/init/init.ts`（23 行，实现见同目录 initTool.ts，119 行）
- 新架构: `packages/harness-core/src/features/tower/tools/init.ts`（createTowerInitTool）

## 能力对照

- [x] 主 agent 限定与模式未激活拒绝（TOWER_MAIN_AGENT_ONLY / TOWER_MODE_USER_ENABLED_ONLY）→ `packages/harness-core/src/features/tower/tools/init.ts`
- [x] 幂等初始化 .tower 工作区（已有工作区只报告不重置、base 分支记录、检出非 base/分离 HEAD 提示、comms/worktrees 布局说明）→ 同文件 execute + `packages/harness-core/src/features/tower/protocol/store.ts`（init）
- [x] 跨会话收养：前会话 roster 退休提示、开放 mission 结转提示、live owner 拒绝 → 同文件（priorOwner/isSessionLive 检查与 retiredAgents/openMissions 输出）
- [x] base 默认值：缺省回落到 enter 时记录的 base → 同文件（args.base ?? deps.requestedBase()，feature.ts 的 /tower <base> 入口）
- [ ] 工具内重锚：显式 base 在已有工作区上重锚（v2 任意时机允许，含开放 mission），并逐 mission 输出 up-to-date/stale/no-branch 摘要与 TowerRebase 指引 — 新栈工具改为 ignoredBase 提示（"先 teardown 才能换 base"）；重锚只剩用户 /tower <base> 入口且有开放 mission 时直接报错（feature.ts prepareUserBase）

## 结论

未对齐 1 项——初始化与收养主干对齐；模型经 TowerInit 重锚 base 的能力不再由工具承担，改为用户入口且更受限制。
