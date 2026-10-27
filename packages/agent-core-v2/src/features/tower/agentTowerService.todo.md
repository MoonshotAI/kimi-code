# IAgentTowerService（agentTowerService）

- v2: `packages/agent-core-v2/src/features/tower/tower.ts`（69 行接口与契约，实现见同目录 towerService.ts，937 行）
- 新架构: `packages/harness-core/src/features/tower/feature.ts`（createTower 工厂 + TowerRef/TowerFace）

## 能力对照

- [x] 模式进出 enter/exit 与 isActive 判定（主 agent 限定、实验 flag、未组装拒绝）→ `packages/harness-core/src/features/tower/feature.ts`（TowerFace + ops.ts towerModeProjection）
- [x] enter 的 base 准备（ensureRepository/init/为脏检出建基分支并快照 WIP/已初始化时重锚 rebase）→ `packages/harness-core/src/features/tower/feature.ts`（prepareUserBase/createBaseBranch + protocol/store.ts rebase）
- [x] 工作区 ownership：adopt/release、owned-by-live-session 拒绝、恢复时对外来 owner 的 reconcile（离线收养/在线退出）→ `packages/harness-core/src/features/tower/feature.ts`（resolveTowerOwner/adoptTowerRoster/releaseTowerOwnership + agent 层恢复块）
- [x] 与 plan 的双向模式互斥（进 tower 退 plan；plan 激活则 tower 退出）→ `packages/harness-core/src/features/tower/feature.ts`（exitPeerModes + watch planRef）
- [x] 执行期守卫：TodoList 否决、Agent resume 前台否决、worker Write/Edit 限本方 worktree → `packages/harness-core/src/features/tower/guard.ts`
- [x] inbox 来信唤醒主 agent（运行中推迟到 turn 结束再注入）→ `packages/harness-core/src/features/tower/feature.ts`（flushInboxWake）+ `packages/harness-core/src/features/tower/feature.ts`
- [x] roster agent 死亡标记与清除 → `packages/harness-core/src/features/tower/tools/spawn.ts`（markAgentDied）+ feature.ts（turn.started → clearAgentDied）
- [x] full/sparse/exit 三级模式提醒注入 → `packages/harness-core/src/features/tower/injection.ts`
- [x] /tower 用户入口（enter/exit 与 towerEnterFailureMessage）→ `packages/harness-core/src/feature-http/route-builtin/sessions.ts`（config.towerMode → TowerRef）
- [ ] isBranchLeased/withBranchLease 分支租约（merge/rebase/spawn 互斥与 Agent resume 租约否决）— 新栈无对应机制
- [ ] ownerTitle 解析与对空闲 owner 的强抢退出（exit('takeover')）— 既定简化为 owned-by-live-session 一律拒绝，ownerTitle 不解析
- [ ] 模式外工具动态隐藏/恢复与 towerMode 投影（addActiveTool、restoreTowerTools、AgentStatusUpdated 镜像、reconcileTowerProjection）— 既定取舍：新栈工具恒可见，执行期门控等价，投影面不迁
- [ ] Bash 命令 git 突变守卫（bashGuard.ts 523 行 analyzeTowerBashCommand）— 未迁
- [ ] AgentSwarm / CreateGoal / UpdateGoal(active) 互斥否决 — 新栈无（goal 域不存在；swarm 域无互斥）
- [ ] flag 关闭后 Tower 工具 inert 否决（TOWER_FLAG_VETO_TOOLS）— 新栈未组装即不挂工具，运行期 flag 翻转无否决
- [ ] inbox wake 增强面（去重 key、批量上限与省略计数、gate digest、recoveredAt 警告、用户插话取消 wake 并重排）— 新栈简化为计数 + 最新主题
- [ ] hasPinnedPermissionMode：会话级权限广播与 resume 重建跳过 tower-worker — 未迁（新栈仅 spawn 时 setMode('auto')，之后会被会话广播波及）
- [ ] `[experimental]` config 面（config.toml 作为 flag 来源）— 既定不迁：新栈只读 env，available 由宿主注入
- [ ] telemetry track2 tower_mode_enter/exit、exit(reason) 原因 — 未迁（新栈 exit() 无参）

## 结论

未对齐 10 项——模式进出、ownership、互斥、守卫、唤醒、提醒等主干已对齐；分支租约、bash 守卫、swarm/goal 否决、投影与 config 面、telemetry 未迁或记录在案的简化。
