# tower：harness-core vs agent-core-v2 差异对比

## 对应关系

- harness-core：`packages/harness-core/src/features/tower/`（ts 约 4478 行 + md 92 行：`feature.ts` 537 / `protocol/` 7 件约 1913（store 1339、git 284）/ `tools/` 11 工具 + support / `guard.ts` / `hub.ts` / `injection.ts` / `rateLimit.ts` / `workerProfile.ts` / `ops.ts`）
- agent-core-v2：`packages/agent-core-v2/src/features/tower/`（ts 4553 行 + md 92 行：`towerService.ts` 556 / `towerFeature.ts` 93 / `tower.ts` 65 / `towerOps.ts` 72 / `flag.ts` 19 / `protocol/` 约 1783 / `tools/` 11 目录各 3 件 / `injection/` / rateLimit / workerProfile）
- 蓝本关系：v2 tower 是逐字迁移蓝本（顺序表 #27，Handoff 第 42 轮迁移、第 48 轮补接线；非 refact-237 第一批 human 蓝本）。protocol 层、11 份工具描述 md、3 份 reminder md、tower-worker-overlay.md 全部逐字节一致；工具输出/错误文案经长字符串字面量比对仅剩 import 路径与审批元数据差异。

## 行为差异

### 人为设计

| 差异点 | v2 行为 | harness-core 行为 | 依据 |
| --- | --- | --- | --- |
| 宿主能力注入 | 直接用 `node:fs/promises`、`child_process.execFile`、`os.tmpdir` | 全部经 `OsHost` 端口（`OsFsPort`/`OsProcessPort`，`protocol/git.ts` 的 `Git` 类 + `TowerIo`）；`createTower({ workDir, host?, ... })` 未注入 host 时整个 feature 不组装（工具/守卫/注入不挂，facade 仍暴露），`enter` 返回 `feature-not-assembled` | Handoff 第 42 轮（OsHost 端口化 + `OsFsPort.rename` 端口扩展，store 的 state 写恢复 v2 tmp+rename 原子语义）；横切约定「host 端口注入」 |
| owned-by-live-session 判定 | owner 会话 live 且（busy 或 pendingInteraction≠none）才拒绝；owner 空闲则强制调用 owner 的 `tower.exit()` 抢下所有权；拒绝文案附 `ownerTitle`（读 owner 会话 metadata 标题）（`towerService.ts:264-279`） | owner 会话同进程 live（`app.get(owner)`）即拒绝，不区分闲忙、不强抢、不解析标题（`feature.ts:335-338`）；`TowerEnterFailure.ownerTitle` 字段保留在类型里但永不赋值（`ops.ts:59`） | Handoff 第 42 轮偏差②（无 sessionActivity 等价物，ownerTitle 不解析） |
| 工具可见性 | 模式外动态隐藏：`enter()` 把 11 个 `TOWER_MODE_TOOLS` 加进 `profile.activeToolNames`，`AgentStatusUpdated` 监听补回丢失项，restore 时 `restoreTowerTools` 恢复（`towerService.ts:114-126,281,523-530`）；flag 关闭时工具仍在但执行被 veto（"tower tools are inert…"，`:153-164`） | spec freeze：flag（`available()`）+ host 满足即在每个 agent 节点静态挂载全部 11 工具；模式关闭时执行期返回 `TOWER_MODE_USER_ENABLED_ONLY` 文本；flag 关闭时工具根本不挂载，"inert" veto 无对应物 | Handoff 第 42 轮偏差⑧（cron 先例）；横切约定「spec freeze（v2 动态重注册不迁）」 |
| modeMutex | 独立 Agent 域服务 `AgentModeMutexService`（`agent/modeMutex/modeMutexService.ts`）：订阅 `PlanModeEnter`/`SwarmModeEnter` → `tower.exit()`；订阅 `TowerModeEnter` → `plan.exit()` + `swarm.exit()` | 收进 tower 自身：`enter()` 里 `exitPeerModes()` 经 facade 可选探测退出 plan；`AgentStoreRef.onCommit` 订阅 `plan_mode.enter` 触发自身 exit。**swarm 侧互斥已随 swarm mode 删除（2026-09-30 评审）一并移除**——此前为 `providerRef(PlanRef/SwarmRef)` 双向 + 订阅 `swarm_mode.enter` | Handoff 第 42 轮偏差⑩；2026-09-30 mode 定义评审（swarm mode 不符合 mode 定义，整体删除） |
| 死亡追踪 | 标：`TaskTerminatedNotice`（会话任务服务全量终止通知，含 TaskStop 杀死、子代理超时）→ `markAgentDied`；清：`SubagentStarted`（mirrorAgentRun 在子代理开跑时发布）→ `clearAgentDied`（`towerService.ts:129-139,439-456`） | 标：TowerSpawn 自己的 `runAndWait` 结算处分流（done/aborted/failed → 非 completed 即 `markAgentDied`，`tools/spawn.ts:355-409,485-495`）；清：session slot `useOnSession('turn.started')` 按 event.agentId `clearAgentDied`（`feature.ts:181-190`）——worker 开 turn 才清，覆盖进程内 live 复用与跨进程 reopen+resume，被动 remount 不误清 | Handoff 第 42 轮偏差③ + 第 48 轮（kernel probe 实证 sibling 事件经共享祖先节点可订阅后接线） |
| inbox wake | TowerSend 经 sessionBus 发布 `TowerInboxSent`（observable）；`AgentTowerService.onTowerInboxSent` 合并信号，`loop.notify({turnScoped:false, onConsume, onDrop})` 投递（`towerService.ts:465-521`） | TowerSend 发布到进程内 `TowerHub`（session slot 共享）；main agent 订阅后 queueMicrotask 合并，机器 running 时挂一次性 `turn.done` 监听、空闲后 `agent.submit(..., { origin: { kind:'injection', variant:'tower_inbox' } })`（`feature.ts:362-401,503-520`）。合并口径、120 字 subject 截断、唤醒文案、origin variant 逐字一致 | Handoff 第 42 轮偏差⑦（cron 先例；v2 loop.notify 的机器语义差异在案） |
| 模式注入 | reminder 总线：`TowerModeInjection` 注册 variant `tower_mode`，由 reminder service 追踪 `injectedPositions`/`lastDisclosure`，历史来自 contextMemory（`injection/towerModeInjection.ts`） | `useBeforeStep` + `agent.remind(key:'tower-mode')`：自管理 landed/in-flight/queued 状态机扫描 store history（`injection.ts`）。full/sparse/exit 三变体、节奏常量（DEDUP_MIN=2 / FULL_REFRESH=5）、userSeen→full 规则、3 份 reminder md 逐字节一致；reminder 落账 key 为 `tower-mode`（v2 variant 为 `tower_mode`，持久化 meta 的标识串不同） | 横切约定「remind 取代 v2 reminder 总线」 |
| durable 事件载荷 | `TowerModeEnter { agentId, sessionId?, base? }` / `TowerModeExit { agentId }` + `towerKey/towerOwnerKey/towerBaseKey` 三个 replayable state（`towerOps.ts`） | 同名 `tower_mode.enter/exit` journal 事件，载荷去 `agentId`（`{ sessionId?, base? }`）+ 单个 `towerModeProjection` fold 出 `{active, owner, base}`（`ops.ts:3-48`）；agent-core `decodeAgent` 对含 agentId 键的 plain 事件抛错 | Handoff 第 42 轮偏差① |
| TowerSpawn 启动路径 | 直接 `agentLifecycle.create({ binding: { profile, model, thinking } })` + `subagents.run` + `mirrorAgentRun` + 注册 `SubagentTask`（detached，带 `resolveSubagentTimeoutMs` 超时）（`tools/spawn/spawnTool.ts:308-370`） | 复用 spawn 域 `createSubagentLauncher`：`launchPlanned(SpawnPlan)` → `runAndWait` → 工具 `detach(ack)` 转为后台任务；不走 `planSpawn` 的委派白名单（会拒 tower-worker），直接构造 plan | Handoff 第 42 轮偏差⑨ |
| worker roster 身份 | mirror/labels 体系 | roster source 沿用 `spawn:<parent>:tower-worker`（不自造 `tower:` 前缀，保住 spawn 的 `Agent(resume=...)` 协议） | Handoff 第 42 轮偏差④ |
| 模型解析 | caller profile 的 `modelAlias` 经 `[subagent]`/`[secondary_model]` config 解析（`resolveSubagentBinding`；reviewer 在非 force 时回退 `'primary'`；`resolveSubagentThinking`；`wrapSubagentModelError` 错误包装）（`spawnTool.ts:186-197,331-335`） | worker 显式绑 `props.models[0]`（池非空），reviewer `{ kind:'inherit' }` 继承 caller config（`tools/spawn.ts:315-318`）；thinking/force/错误包装不迁 | Handoff 第 42 轮偏差⑤ |
| 组装与门控 | `registerFeature(TowerFeature)` 默认启用集，构造时 flag off 则不组装（`isTowerFeatureAssembled` + `_setTowerFeatureAssembledForTests` 测试后门）；flag 定义含 title/description/`surface:'both'`/`isExposed` | 不进 preset、不挂 example；`createTower(props)` 由宿主显式装配；`available?: boolean \| (() => boolean)` 工厂 prop 可注入任意判定，缺省读 env | Handoff 第 42 轮（flag 门控域对齐 notify；`/tower` 开关为宿主职责，驱动 `TowerRef`） |
| rate limiter 归属 | App 域 DI 服务 `ITowerRateLimitService`（OnDemand） | app slot `useExpose(TowerRateLimitRef, createTowerRateLimiter())` | 结构对齐；常量与状态机逐字（`rateLimit.ts` ↔ `towerRateLimitService.ts`） |

### 简化 / 保真度损失

| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
| --- | --- | --- | --- |
| 状态镜像 | `AgentStatusUpdated({ towerMode })` 在 enter/exit/restore/config·featureManager 变化时发布（`reconcileTowerProjection`），kap-server 状态 API 与 `sessionLegacy` 的 `tower_mode` 字段由此供给 | 不迁（无 AgentStatusUpdated 等价面、`restoreTowerTools`/`reconcileTowerProjection` 不迁） | 外部状态面缺口；Handoff 第 42 轮不迁项（kap-server 状态面，facade `TowerRef.state` 代替） |
| inbox 流量可观测性 | `TowerInboxSent` 为 sessionBus observable 事件，进程外可观测 | 内存 `TowerHub` 仅供进程内 wake，无对外事件 | 外部可观测性缺口；如需可由 Feature 事件补 |
| `[experimental]` config 面 | flag 经 `registerFlagDefinition`：env > `[experimental] tower = true`（config.toml）> master env > default | 仅 env（`KIMI_CODE_EXPERIMENTAL_TOWER` / `KIMI_CODE_EXPERIMENTAL_FLAG`）+ `available` prop。**注意**：`experiment-off` 失败文案仍逐字写着「or `[experimental] tower = true` in config.toml」（`ops.ts:69`），文案与能力不一致 | Handoff 第 42 轮不迁项；文案误导属记录在案的残留 |
| worker 权限模式 pin | `hasPinnedPermissionMode(tower-worker)` 三处豁免：会话级 `broadcastPermissionMode` 跳过、Agent 工具 resume 不把 caller 模式复制给 worker、swarm rebuild 同（`agentLifecycleService.ts:489`、`agentTool.ts:409`、`sessionSwarmService.ts:294`） | 无 `hasPinnedPermissionMode` 等价物：spawn 时 `setMode('auto')` 逐字保留（`tools/spawn.ts:339`），但之后 `/permission` 广播会覆盖 tower worker 的 auto 模式 | 用户切权限模式会波及 worker；归属 permission 域后续 |
| worker Write/Edit 限制判定 | 依据 durable profile 绑定（`profile.data().profileName`）+ executor 的 `execution.accesses`（声明式文件访问，write/readwrite）判定逃逸（`towerService.ts:213-248`） | 依据内存 `SpawnRegistry`（`registry.get(agentId)?.profileName`，`feature.ts:493-494`）+ 直接解析 toolCall JSON 的 `file_path`/`path`（`guard.ts:55-71,91-98`） | registry 重启后为空、经 launcher resume 才重建（实际窗口极小：worker 开 turn 必经 resume 路径）；accesses 通道对 Write/Edit 等价但通用性更低 |
| send 的「无运行中任务」提示 | 查会话任务服务（含经 Agent 工具 resume 的运行中 worker，`tasks.list(true)`） | 查 TowerSpawn 自己的 `running` 集合（`tools/send.ts:65-68`）；经 `Agent(resume=)` 恢复运行的 worker 不在集合内 | 可能误报 `note: X has no running task…` 提示（文案层，不影响投递） |
| 子代理超时 | TowerSpawn 注册任务带 `resolveSubagentTimeoutMs(config)`（`[subagent]` 超时） | 无超时机制（`runAndWait` 随工具 signal） | 长跑 worker 不会被超时杀死；归属 spawn/config 域 |
| ToolResult isError 通道 | 拒绝/协议错误返回 `{ output, isError: true }`；参数由框架 zod 校验并报字段级错误 | 已切回：`runTowerTool` catch 与各校验失败标 `isError: true`，框架统一渲染；参数解析失败统一 `invalid TowerX arguments: <raw>`（`tools/support.ts:83-101`） | A 步已落地（第 76 轮） |
| 审批元数据 | 每个工具 `ToolExecution` 带 `description`（如 `Reading tower status`）+ `approvalRule: <工具名>` | `ToolDefinition` 无此面（未用 `useToolPermission`） | 审批 UI 语义与按工具名审批规则缺失；归属 permission 域 |
| worker 工具面 | worker 经 profile tools 列表只见 6 个 Tower 工具（Finding/Inbox/Mission/Review/Send/Status）+ 标准集 | 新架构无 per-profile 工具过滤：worker 节点的 spec 含全部 11 个 Tower 工具（越权者执行期返回 `TOWER_MAIN_AGENT_ONLY`） | spec 膨胀、与 briefing「只能经 tower 工具协调」的约束靠执行期拒绝兜底；横切归属 sessionToolPolicy（Handoff 完整性核查②，归属待用户定） |
| WIP 快照临时 index 位置 | `mkdtemp(os.tmpdir())` 建临时 GIT_INDEX_FILE，用完 `rm` | 放 `<repo>/.tower/wip-index-<uuid>`，用完 `fs.remove`（`protocol/baseWip.ts:44-46,71`） | crash 时残留位置从系统 tmp 变为 `.tower/` 内；功能等价 |
| env 运行期翻转语义 | flag 在 Feature 构造时固化，翻转需重启（`feature-not-assembled` 文案即「a restart is required」） | `available()` 每次调用实时读 env：挂载后翻转 env 可使 `enter()` 通过但工具未挂载（spec freeze 下模式活而无工具） | 理论边缘情形（env 通常进程启动即定）；记录在案 |

### 新增 / 更强

| 差异点 | 说明 |
| --- | --- |
| `TowerEvent` Feature 事件面 | `tower.spawned`（agentId/parentAgentId/name/kind/profile/description/model?/background）、`tower.completed`（含 summary + TokenUsage）、`tower.failed`、`tower.cancelled`（`feature.ts:93-130`，fire 点在 `tools/spawn.ts`）。v2 无 tower 专属事件（走 `emitAgentRunSpawned`/`mirrorAgentRun` 通用 subagent 镜像）。**注意**：Handoff 第 50 轮已把 spawn/swarm/sessionInit 的镜像事件全部收敛删除，tower.\* 属「未动，待用户与并行会话协调收敛」——该事件面可能随收敛决策删除 |
| `TowerFace.state` 响应式 | facade 暴露 `state: ShallowRef<TowerModeState>`（v2 `IAgentTowerService` 只有命令式 getter），宿主可订阅模式状态 |
| 工厂 props 可测试性 | `available`（布尔或函数）、`catalog`（缺省探测 `ProfileCatalogRef`，皆无回落静态目录）、`models`、`host` 全部可注入；v2 靠全局 DI + `_setTowerFeatureAssembledForTests` 后门 |
| git 运行器稳健性 | `createGitRunner` 自管 60s 超时（SIGTERM→5s 宽限→SIGKILL）、16MB 输出截断即杀、stdin 关闭、进程 dispose（`protocol/git.ts:60-136`）；v2 依赖 `execFile` 内建 timeout/maxBuffer。端口化同时带来跨宿主能力 |

## 可配置项差异

| 配置项 | v2 | harness-core | 分类 |
| --- | --- | --- | --- |
| 实验 flag | `KIMI_CODE_EXPERIMENTAL_TOWER` env + `[experimental] tower` config + master env，经 flagRegistry（含 surface/isExposed 元数据） | 仅 `KIMI_CODE_EXPERIMENTAL_TOWER` / `KIMI_CODE_EXPERIMENTAL_FLAG` 两 env（`feature.ts:528-537`） | 简化（config 面不迁，Handoff 第 42 轮在案） |
| `available` prop | 无 | `boolean \| (() => boolean)`，缺省 env 判定 | 新增 |
| `host` prop | 无（直接 node API） | `OsHost`，未注入即 `feature-not-assembled` | 人为设计 |
| `workDir` | `sessionContext.cwd` | `props.workDir`（`resolveTowerRepoRoot` 同一函数，repoRoot.ts 逐字） | 已对齐（等价来源） |
| worker/reviewer 模型 | caller `modelAlias` + `[subagent]`/`[secondary_model]` config 节（model/thinking/force/timeoutMs） | `props.models?: readonly SpawnModelEntry[]`（worker 取 `[0]`，reviewer inherit）；thinking/timeout 不迁 | 人为设计（第 42 轮偏差⑤） |
| profile 目录 | 全局 `IAgentProfileService` | `props.catalog?` → `ProfileCatalogRef` 可选探测 → 静态目录回落（`feature.ts:439-442`） | 人为设计（config 缺席回落默认值，横切约定） |
| 速率限制常量 | `RATE_LIMIT_CAPACITY_SHRINK_INTERVAL_MS=2000` / `RECOVERY=180_000` / `TOWER_SPAWN_PAUSE_MS=60_000` / `TOWER_MAX_BUDGET=16` | 逐字一致（`rateLimit.ts:17-20`） | 已对齐 |
| 注入/唤醒常量 | `TOWER_MODE_DEDUP_MIN_TURNS=2` / `FULL_REFRESH=5` / `WAKE_SUBJECT_PREVIEW_MAX=120` / `REVIEW_REQUEST_SCAN_LIMIT=50` / inbox `DEFAULT_LIMIT=20` / `INBOX_COUNT_LIMIT=1000` / `RECENT_LOG_LINES=10` | 逐字一致 | 已对齐 |
| git 常量 | `GIT_TIMEOUT_MS=60_000`、16MB maxBuffer、identity-unknown 时 `Kimi Tower <kimi-tower@localhost>` 兜底提交 | 逐字一致（`protocol/git.ts`） | 已对齐 |
| durable 事件/schema | `tower_mode.enter/exit` zod schema（含 agentId）+ 三个 replayable state key | 同名事件无 zod schema（plain journal 事件，载荷无 agentId）+ 单个 fold 投影 | 人为设计（第 42 轮偏差①） |

## 工具 / 事件 / facade 面差异

- **工具清单**：11 个工具同名（TowerInit/Plan/Spawn/Merge/Teardown/Send/Inbox/Finding/Review/Mission/Status）、zod 参数 schema 逐字（含 strict/superRefine/各 describe）、描述 md 11 份逐字节一致、输出与错误文案逐字一致（长字符串字面量 diff 仅剩 import 路径与 v2 审批 description）。差异集中在：审批元数据、参数解析失败文案（以上见「简化」表）、TowerSend 的 running 判定、TowerSpawn 的启动/模型/事件路径（以上见「人为设计」表）。
- **TowerSpawn ack**：`task_id` 在 v2 为注册的 `SubagentTask` id；harness-core 为 `detach` 的 toolCall id（`tools/spawn.ts:453`）——新架构 task 投影即以 toolCallId 为 taskId（`task.detached` journal 事件），Task\* 工具可用，语义等价。detach 后 settled 结局（completed/killed/failed + summary/subagent error）作为后台任务完成通知落地。
- **Feature 事件**：harness-core 新增 `tower.*` 四件（待第 50 轮收敛协调）；v2 的 `TowerInboxSent` observable 不迁；`tower_mode.enter/exit` durable 事件同名（载荷去 agentId）。
- **facade**：`TowerFace`（`{ state: ShallowRef, isActive(), requestedBase(), enter(base?), exit() }`，`TowerRef` token）⊃ v2 `IAgentTowerService`（无 state ref）；`towerEnterFailureMessage` 四态文案逐字一致（但 `experiment-off` 文案提及的 config 面未迁、owned-by-live-session 永不带 ownerTitle）。
- **worker profile**：`TOWER_WORKER_PROFILE_DEF` 定义逐字（tools 列表/描述/role 拼接/overlay md 逐字节）；贡献通道 v2 为 `contributeProfiles`，harness-core 为 `useProfileFinder({ sourceId: 'feature:tower', priority: 0 })`（app slot，`feature.ts:170-174`）——Handoff 第 19 轮「tower worker profile 贡献通道待 #27」遗留已闭合。

## 摘要

整体对齐度很高：protocol 层（store/git/paths/types/repoRoot）、11 工具的 schema/md/文案、速率限制器、注入节奏与三份 reminder、worker profile、modeMutex 双向语义全部对齐，且多为逐字级别。最重要的三个差异：① ownership 简化——v2 的「owner 空闲可强抢 + ownerTitle」被削为「live 即拒」（第 42 轮在案）；② 工具面从 v2 的动态激活（模式外隐藏、restore 恢复、inert veto）变为 spec freeze 下的静态挂载 + 执行期门控，worker 侧还少了 per-profile 工具过滤（11 个 Tower 工具全量进 worker spec，横切归属 sessionToolPolicy）；③ 外部状态/观测面（AgentStatusUpdated 镜像、TowerInboxSent observable、sessionLegacy `tower_mode`）未迁。最需关注的缺口：`tower.*` Feature 事件与第 50 轮镜像收敛决策相左、悬而未决（可能删除）；`experiment-off` 文案承诺的 `[experimental]` config 面不存在（文案与能力不一致）；`/permission` 广播缺少 tower-worker pin 豁免会改动 worker 的 auto 模式。
