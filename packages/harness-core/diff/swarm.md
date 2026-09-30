# swarm：harness-core vs agent-core-v2 差异对比

> **2026-09-30 评审后更新**：swarm mode 已整体删除（ops.ts / injection.ts / enter-reminder.md / exit-reminder.md 四文件移除，`SwarmRef` facade、`enterSwarmMode` 工具调用、auto-exit 一并去除；tower 的 modeMutex 只保留 plan 双向；feature-http status 路由删 `swarm_mode` 字段）。依据：mode 定义评审——swarm mode 不符合 mode 定义（无模型面/工具面效果；唯一真实 trigger 为 'tool' 时 reminder 按规则永不注入，模型不可感知），其残余语义只是「有 swarm 在跑」的运行状态标记。本文 mode 相关各行（modeMutex、durable 事件载荷、facade、状态面、注入）保留为删除前状态的历史记录。

## 对应关系
- harness-core：`packages/harness-core/src/features/swarm/`（1532 行 ts + 3 个 md：batch.ts 683 / tool.ts 534 / feature.ts 182 / injection.ts 54 / guard.ts 48 / ops.ts 25 / index.ts 6；agent-swarm.md / enter-reminder.md / exit-reminder.md 与 v2 cmp 逐字节一致）
- agent-core-v2：`src/features/swarm/`（1616 行 ts + md：session/agentRunBatch.ts 677 / tools/agent-swarm/agentSwarmTool.ts 351 / session/sessionSwarmService.ts 335 / agent/swarmService.ts 105 / agent/injection/swarmInjection.ts 75 / tools/agent-swarm/agent-swarm.ts 63 / session/sessionSwarm.ts 61 / swarmOps.ts 49 / configSection.ts 44 / swarmFeature.ts 28 / agent/swarm.ts 13）+ 互斥依赖 `src/agent/modeMutex/modeMutexService.ts`（51 行）
- 蓝本关系：v2 DI 版 `features/swarm` 为行为规格蓝本（feat-271 第 37/40/50 轮迁移，不属 refact-237 第一批 human 蓝本）；子代理 spawn/resume 运行管线复用 spawn 域提取的 `createSubagentLauncher`（第 37 轮前置重构，v2 两侧共用 `ISessionSubagentService` 的同构物）。

## 行为差异
### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
|---|---|---|---|
| 独占响应守卫的落地通道 | `AgentSwarmService` 订阅 `toolExecutor.onBeforeExecuteTool`，读 `event.toolCalls` 整批后 `event.veto`（swarmService.ts:47-64） | 批级贡献点 `useBeforeToolBatch`（guard.ts:5-19）：批内 AgentSwarm===1 且批长===1 放行；>1 deny `multipleAgentSwarmDeniedMessage(hasOtherToolCalls)`；===1 混批 deny `mixedAgentSwarmDeniedMessage()`——判定体与文案逐字，非 main worker guidance 后缀逐字（guard.ts:43-47 ↔ v2 `formatDenyMessage`，toolApprovalService.ts:250-255）；整批 denied 经 preflight 屏障短路、框架逐 call 落地为同文本 denied 结局 | feat-271 约束问答 AgentSwarm 守卫条（用户 2026-09-29 两番定稿：先批可见性、同日否决后改批级贡献点 + preflight 屏障，第 40 轮落地；依据为 codex/opencode/pi/claude-code 四家 per-call 决策面均不含 sibling 批的对比结论） |
| 镜像/状态事件 | 镜像全家：`subagent.spawned/started/completed/failed/cancelled`（observable，mirrorAgentRun.ts）+ `SubagentSuspended`（sessionSwarmService.ts:52-56）+ `AgentStatusUpdated{swarmMode}`（swarmOps.ts:41/45）+ 遥测 `subagent_created` | 全部删除，零 Feature 事件；子代理关联改由启动时 `onUpdate({key:'subagent', text: agentId})`（tool.ts:172/186，retry 不重发）+ agent-core `agent.opened/agent.closed` 节点事件 + roster source + 双方 journal | 约束问答末条（用户 2026-09-29 第 50 轮定稿）：「Spawn 本质上就是 tool call 调用了一个 agent……镜像通道是冗余投影」，roster source（durable 身份）+ 双方 journal（durable 内容）+ 统一 tool/agent 事件流（实时） |
| 子代理身份与 swarmItem 存储 | session metadata labels（`parentAgentId`/`swarmItem`，durable；subagentMetadata.ts、sessionSwarmService.getSwarmItem 读 metadata） | 身份 = roster `source: 'spawn:<parent>:<profile>'`（spawn 域写入，durable）；swarmItem = session slot 内存 Map（`SwarmSessionRef.items`，feature.ts:109、tool.ts:47/113-116） | 第 7/8 轮 roster source 创建者标记设计（单次写入原子化）；swarmItem 内存化为设计要点⑨记录在案的取舍（见「简化」表） |
| 模型池来源 | config `[secondary_model]` 节（defaultModel/models/force/defaultEffort），描述段单行 `buildSubagentModelSummary`（configSection.ts:343-351） | 工厂 props `models: SpawnModelEntry[]`（LlmModel 对象直传）；描述段改用 spawn 多行格式（`- name: description` + `- primary: your current model and thinking level`，tool.ts:470-482） | spawn 设计要点（props 形态）；第 37 轮偏差②（v2 单行格式依赖 defaultModel 概念，新架构无） |
| spec freeze | 参数/描述每请求动态读：`parameters` getter 读 flag + config（agentSwarmTool.ts:76-83），`description` getter 读 flag + config（:99-106） | 挂载时一次性冻结：models 非空才带 model 参、forkEnabled() 才带 fork 参（tool.ts:484-533）、描述静态拼接（spawn 先例） | 横切约定 spec freeze + 第 1 轮偏差② |
| AgentSwarm 工具注册门控 | 随 SwarmFeature 无条件注册（swarmFeature.ts:24） | catalog 在场才注册（props.catalog 缺省经 `providerRef(ProfileCatalogRef)` 解析，皆无则不挂工具；守卫/注入/mode 三件套不受影响仍挂，feature.ts:141-165） | 约束问答 profiles 条后续②（用户 2026-09-29）：响应式门控，spec freeze 语义下已挂载 agent 不受后到 catalog 影响 |
| 批中止语义 | `isUserCancellation(reason)` 区分：用户取消 → `finishWithUserCancellation`，否则 `fail(reason)` 整批 reject（agentRunBatch.ts:147-154、577-583） | 工具 signal 中止即一律走 v2 用户取消分支（逐任务 aborted + 两态文案逐字，batch.ts:171-174/551-580）；`fail()` 路径删除 | 第 37 轮偏差④：新架构无 `isUserCancellation` 对应类，取消语义统一 |
| 限流判定 | `isProviderRateLimitError`（llm-adapter 错误类判定，agentRunBatch.ts:326） | 结构判定 `failure.error.kind === 'rate_limit'`（batch.ts:666-669）；原始 kind 经 `attemptError` 挂到 Error 上传递（tool.ts:424-437） | 设计要点⑦（goal `llmErrorPayloadOf` 先例）；第 37 轮偏差⑦：requester 抛错机器归一化为 `kind:'unknown'` 规避默认重试 |
| 限流重试驱动 | `resumeAttempt(retryTurn=true)` → `runAgentTurn({kind:'retry'})` 提交空 content user 消息（origin `{kind:'retry'}`，sessionSwarmService.ts:214-216、runAgentTurn.ts:47-50） | `retryAndWait` 提交空 content user 消息（origin `{kind:'retry'}`，spawn/run.ts:236-249） | 设计要点⑦；第 37 轮偏差⑦：空消息驱动 turn 已实证通过（未实证则停报不得降级的契约条件满足） |
| enter/exit facade 落账 | fire-and-forget（`void dispatcher.dispatch`，swarmService.ts:69/75） | `await store.dispatch`（feature.ts:120-127） | plan 第 15 轮偏差⑥先例（facade 确定性，行为不变） |
| 工具校验错误 | `Error2(VALIDATION_FAILED, …)` + `isError:true` 结果 | 校验错误返回标 `isError: true`（catch-all 单点），框架统一渲染（Error2 → 普通 Error 差异保留）；description 缺失/空白给哨兵文案 `Provide a non-empty description for the swarm.`（tool.ts:303-305）；参数 JSON 容错解析 `invalid AgentSwarm arguments: <raw>`（tool.ts:415-422） | 第 37 轮偏差③（v2 靠 zod 框架层校验，对齐 spawn `PROMPT_REQUIRED_MESSAGE` 补齐）+ wait-for 先例（容错解析）；A 步已落地（第 76 轮） |
| modeMutex（plan/swarm/tower 互斥） | 独立 Agent 级 `AgentModeMutexService`：PlanModeEnter→tower.exit、SwarmModeEnter→tower.exit、TowerModeEnter→plan.exit+swarm.exit（modeMutexService.ts:26-42） | 双向均在 tower feature 内实现：tower enter 时 `exitPeerModes()` 经 facade 可选探测退出 plan/swarm（tower/feature.ts:305-312），`AgentStoreRef.onCommit` 订阅 `plan_mode.enter`/`swarm_mode.enter` 触发 tower exit（tower/feature.ts:403-411）；swarm 域自身零代码 | 第 42 轮偏差⑩（「swarm 轮 modeMutex 待 #27」遗留闭合，swarm 侧无需改动）；语义与 v2 逐向对应 |
| durable 事件载荷 | `SwarmModeEnter{agentId, trigger}` / `SwarmModeExit{agentId}`（swarmOps.ts:11-35） | `swarm_mode.enter{trigger}` / `swarm_mode.exit{}`——去 agentId（ops.ts:3-4） | 第 37 轮偏差①：agent-core `decodeAgent` 对含 agentId 字段的 plain 事件 throw（plan/cron 同先例） |
| 运行管线复用 | AgentSwarmTool → ISessionSwarmService → ISessionSubagentService.spawn/run + mirrorAgentRun | 提取 spawn 域 `createSubagentLauncher`（launchPlanned/resume）+ `runAndWait/retryAndWait/latestAssistantText/sumUsage/classifyOutcome`，swarm 直跑 `AgentRunBatch`（tool.ts:103-220） | 第 37 轮前置重构（spawn 行为零变化、spawn.test 保绿，经 spawn barrel 导出） |
| registry 归一 | 无共享 registry（running 判定读子代理 loop snapshot） | 优先 `providerRef(SpawnRegistryRef)`（spawn 挂载时跨 Feature running 守卫归一），缺席回落 swarm 私有 session Map（feature.ts:148-149） | 第 37 轮偏差⑥ |
| 批调度本体 | `AgentRunBatch` 677 行：首发 5、700ms 间隔、限流容量收缩(2s)/恢复(3min)、`retry` 包退避、`setClampedTimeout` | 683 行全语义移植：`retry` 包不引（内联 `3000*2^(retryCount-1)`，batch.ts:440-442）、`setClampedTimeout` 内联 `Math.min(timeout, 0x7fffffff)`（batch.ts:629-635）、per-attempt timeout、`resolveSwarmMaxConcurrency` 逐字 | 设计要点⑤ |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
|---|---|---|---|
| swarmItem 重启丢失 | 持久化在 session metadata labels，重启后 resume 仍渲染 `item="…"` | session slot 内存 Map，重启丢失；仅影响 resume 结果的 `item=` 渲染属性 | 设计要点⑨记录在案的保真度损失（roster 无此字段）；如需恢复需在 roster/agent metadata 加字段 |
| stopReason 恒 undefined | mirrorAgentRun 透传 `TurnResult.stopReason`（repeat_breaker 等），渲染进 `stop_reason="…"` 属性 | completion 只产 `{result, usage}`（tool.ts:134-151）；渲染代码保留 stop_reason 支持但永不可达 | 第 37 轮遗留（TurnOutcome 无 max_tokens/forcedStopReason 面）；`shouldRenderResumeHint` 的 stopReason 分支同成死路径（status 分支仍生效） |
| `SessionSwarmService.cancel` / inFlight 表 | 按 callerAgentId 登记 AbortController，facade 级整体取消（sessionSwarm.ts:57、sessionSwarmService.ts:138-140） | 不迁；中止只走工具 signal 链 | 设计要点「不迁」项；SwarmRef 无 cancel 方法 |
| 'task' trigger 生产方 | 类型存在（'manual'|'task'|'tool'）但全仓无生产方 | 同——类型保留 + auto-exit 语义保留（feature.ts:129-134），无生产方 | 设计要点「不迁」项（v2 亦无，非缺口，记录在案防误读） |
| reminder 尾部清理 | exit 时 `publishTrailingRemoval(history)` + `popSwarmModeReminder`（swarmService.ts:74-76、swarmOps.ts:49）：退出时若 enter reminder 是上下文尾条则移除 | 无对应物不迁：exit 后下一 beforeStep 注入一次 exit reminder 即翻转（injection.ts:34-39） | 设计要点③「不迁」；代价是历史里多一对 enter/exit reminder，无功能影响 |
| kap-server 状态面 | `AgentStatusUpdated{swarmMode}` → kap-server `status` API 的 `swarm_mode` 字段（sessionLegacyService.ts:79/97）；`swarm_mode` REST 路由 | facade `SwarmRef.isActive()` 代替；不改 kap-server、无 feature-http 路由 | 设计要点「不迁」项（goal/plan 先例） |
| 遥测 | `subagent_created`（emitAgentRunSpawned，mirrorAgentRun.ts:152-162） | 无 | 遥测不迁批次，待云端 appender 落地后统一补回 |
| 镜像载荷字段 | `parentToolCallUuid`、`runInBackground`（task 恒 false）、`thinkingEffort`、`model/modelSource`（spawned 事件） | 随事件删除一并消失 | 第 50 轮定稿的固有结果；第 37 轮遗留「resume 的 spawned 事件 model 恒 undefined」随事件删除而作废 |
| usage/contextTokens 出口 | `SubagentCompleted{resultSummary, usage, contextTokens}`（mirrorAgentRun.ts:199-207、262-271） | usage 仍收集进 `AgentRunAttemptCompletion` 但不渲染、无事件出口；contextTokens 第 41 轮曾补进 `swarm.completed`，第 50 轮随事件删除 | 第 50 轮定稿；TUI 子代理卡片 chip 数据源改由 tokenCounting facade/子代理 history 推导（归属 tokenCounting 域收尾） |
| v2 fork 附录描述 | flag 开时描述追加 `AGENT_SWARM_FORK_DESCRIPTION` | 不迁 | 无实际差异——v2 `agent-swarm-fork.md` 是 0 行空文件（设计要点⑥） |
| retry 的 profileName 回落 | 读子代理 `IAgentProfileService`（rebuild 后仍有真实 profile 名） | registry 空（如进程重启后）时回落字面量 `'subagent'`（tool.ts:45/210） | 仅影响渲染与 description 文本中的 profile 名；未在 Handoff 单列，属 registry 内存化的次生损失 |

### 新增 / 更强
| 差异点 | 说明 |
|---|---|
| preflight 屏障（框架级） | 批级与 per-call 决策分离：`useBeforeToolBatch`（批）→ 每 call `useBeforeTool` → `useToolPermission`，全批决策在 turn 机 `preparingTools` 状态跑完后才 `turn.spawn_tools` 统一进入执行；abort 于 preflight 期间合成全批 aborted 结局（第 40 轮，agent-core 框架能力，v2 扁平订阅模型无此保证） |
| facade 响应式状态 | `SwarmRef.state: ShallowRef<SwarmModeState>`（含 trigger 三态）响应式可读；v2 仅 `isActive` getter |
| 限流重试实证 | retry 空消息驱动 turn 经测试锁定（rate_limit → requeue → 同 agent 空消息 retry turn 跑完，history 恰 1 条 `content:[]` + origin.kind='retry' 条目）；v2 同形态无实证记录 |
| host 端口注入 | `createSwarm({ host? })` 未传时缺省 `createNodeOsHost()`（供 profiles 的 git-context prompt prefix 用 process 端口）；v2 走 runtime lease `acquire(['process'])`——传输无关性更强（宿主可不注入进程能力，第 18 轮 OsHost 先例） |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
|---|---|---|---|
| `swarm` 节 | `z.object({timeoutMs: z.number().int().min(0).optional()})`，默认 2h；import 时全局注册 | 同 schema 同默认值，app slot `useConfigSection` 注册；config 缺席经 `providerRef(ConfigRef)` 可选探测走默认值（feature.ts:144-147） | 已对齐（逐字语义，设计要点①） |
| `KIMI_CODE_SWARM_TIMEOUT_MS` | env 绑定 parse int≥1 + stripEnv | 同（feature.ts:56-72） | 已对齐（逐字） |
| `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` | `resolveSwarmMaxConcurrency`：正整数否则 `Error2(VALIDATION_FAILED)` 同文案 | 同函数逐字移植（Error2→Error，batch.ts:671-683） | 已对齐（逐字） |
| fork flag | `subagent_fork` flag：per-flag env > `[experimental]` config > master env > default false（flag.ts:6-14） | 仅 env：`KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK` 或 `KIMI_CODE_EXPERIMENTAL_FLAG`（'true'/'1'），或 props `forkEnabled` 覆盖（feature.ts:172-182） | 简化（`[experimental]` config 面与 flag 注册表不迁） |
| `[secondary_model]` 节 | defaultModel/models/force/defaultEffort 四字段 + 校验 | 不迁；模型池为工厂 props `models` | 人为设计（props 化；spawn 域同） |
| 工厂 props | 无（registerFeature 默认启用集） | `createSwarm({ catalog?, models?, forkEnabled?, workDir?, host? })`，进 preset | 人为设计（设计要点：v2 默认启用集，cron 先例） |
| facade 方法面 | IAgentSwarmService：enter/exit/isActive；ISessionSwarmService：run/cancel/getSwarmItem | SwarmRef：state/isActive/enter/exit（run 由工具内部直跑 batch，cancel 不迁，getSwarmItem 内化） | 简化（cancel 不迁，见上表） |

## 工具 / 事件 / facade 面差异
- AgentSwarm 工具：参数 schema 逐字对齐（strict、128 上限、各字段 describe 逐字；model 参 models 非空才出现、fork 参 forkEnabled() 才出现——对应 v2 的 `stripSubagentModelParameter`/`stripSubagentForkParameter` 动态裁剪）；description = agent-swarm.md（cmp 逐字节一致）+ models 段（格式差异见上表）；specs 展开全文案（至少 2 items/128 上限/prompt_template 必填/占位符/去重）逐字；`renderSwarmResults`（summary/resume_hint/属性转义）逐字。
- Feature 事件：v2 为 swarm 复用 `subagent.*` 名 + `SubagentSuspended`；新架构第 37 轮曾按 `swarm.*` 命名空间实现五事件（spawned/completed/failed/cancelled/suspended，记为偏差），第 50 轮按用户定稿全部删除——现状两侧均无可观察的 swarm/subagent 镜像事件，消费方统一走 tool/agent 事件流。
- facade：v2 双服务（agent 级 mode + session 级 run/cancel/getSwarmItem）→ 新单 `SwarmRef`（state/isActive/enter/exit）。

## 摘要
swarm 是对齐度很高的一域：AgentRunBatch 调度（首发 5/700ms/限流收缩恢复/退避/per-attempt timeout）、独占守卫文案、specs 校验全文案、renderSwarmResults、enter/exit reminder（cmp 逐字节）、swarm 配置节与两个 env 全部逐字对齐，modeMutex 也经 tower 域双向闭合。最重要的三个差异：① 守卫从 v2 扁平 veto 迁入框架级 `useBeforeToolBatch` + preflight 屏障（用户两番定稿的结构升级）；② 全部镜像/状态事件按第 50 轮定稿删除，关联改走 `tool.update` + roster + `agent.opened/closed`；③ 模型池从 `[secondary_model]` config 节改为工厂 props（描述段格式随之变化）。最需关注的缺口：swarmItem 重启丢失（仅影响 resume 渲染，记录在案）、stopReason 恒 undefined（TurnOutcome 面无此字段，渲染支持保留成死路径）、`SessionSwarmService.cancel` 与 kap-server `swarm_mode` 状态面未迁。
