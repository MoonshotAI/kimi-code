# spawn：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/spawn/`（918 行 ts + 2 个 md：run.ts 320 / tool.ts 205 / plan.ts 183 / format.ts 91 / feature.ts 65 / index.ts 54；spawn.md ↔ v2 agent.md、spawn-background.md ↔ v2 agent-background-enabled.md，内容逐字一致仅缺文件末换行）
- agent-core-v2：`src/agent/tools/agent/`（1015 行：agentTool.ts 766 / subagent-task.ts 156 / agent.ts 93 + 4 个 md）+ `src/session/subagent/`（1582 行：configSection.ts 433 / mirrorAgentRun.ts 271 / subagentService.ts 248 / subagentScopeCacheService.ts 199 / runAgentTurn.ts 185 / spawn.ts 75 / subagent.ts 68 / subagentScopeCache.ts 49 / subagentModelsValidationService.ts 28 / flag.ts 16 / subagentModelsValidation.ts 10）
- 蓝本关系：v2 DI 版为行为规格蓝本（feat-271 第一批首个域，第 1/8/19/50 轮迭代成型，不属 refact-237 第一批 human 蓝本）；profile catalog/委派白名单/prompt 前缀经第 19 轮迁入 profiles 域后由 spawn 消费（v2 对应物为 `app/agentProfileCatalog` + `ISessionAgentProfileCatalog`）。

## 行为差异
### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
|---|---|---|---|
| profile catalog 获取 | DI `ISessionAgentProfileCatalog`（六级 source 聚合，v2 框架内建） | 工厂 props `catalog?` 可选 override，缺省 `providerRef(ProfileCatalogRef)` 解析；两者皆无则 **Agent 工具不注册**（agent slot 挂载时门控直接 return，feature.ts:36-38） | 约束问答 spawn 条（用户 2026-09-27：props 形态为 profile catalog）+ profiles 条后续②（用户 2026-09-29：响应式门控，spec freeze 语义） |
| 子代理身份存储 | session metadata `agents[id]`（labels `parentAgentId`/`profileName`/`swarmItem`、`type:'sub'`、`forkedFrom`，durable；resume 经 metadata 校验 isSubagentMeta/parentAgentId 后 rebuild，agentTool.ts:359-391） | roster `source: 'spawn:<parentAgentId>:<profileName>'` 随 `agent.opened` 单条记录原子写入（durable）；resume 从 roster 派生身份（parseSpawnSource，run.ts:105-144），`SpawnRegistry` 内存 Map 仅存 running 守卫 | 第 7 轮（用户定稿：source 创建者标记，单次写入原子化，btw 先例）+ 第 8 轮（resume 打通非 live：roster 派生 + `session.create({agentId})` 重开，分支/历史/冻结 spec/features 全恢复，跨进程可 resume） |
| 模型绑定与持久化 | 子代理绑定持久化在 agent scope（profile 服务 `modelAlias/thinkingLevel`，重建后仍在） | config 永不持久化——创建后总是 `setConfig(调用方 config)`、explicit 模型再覆盖（run.ts:162-174）；每次 mount 由 agent 层 Feature 实时绑定；跨进程 resume 后显式 override 丢失、拿宿主默认 | 第 8 轮用户定稿①②：「tool 启动的 agent 与 main agent 运行逻辑完全一致，config 永不持久化」，override 丢失是该原则的自然结果（记录在案） |
| 镜像事件 | `subagent.spawned/started/completed/failed/cancelled` 五镜像（observable，携 parentToolCallId/model/thinkingEffort/usage/contextTokens）+ 遥测 `subagent_created` | 全部删除，零 Feature 事件；启动后 detach 前 `onUpdate({key:'subagent', text: agentId})` 做 toolCall↔子代理实时关联（tool.ts:36/89）+ agent-core `agent.opened/closed` 节点事件 | 约束问答末条（用户 2026-09-29 第 50 轮定稿：镜像是冗余投影；`tool.update` 关联是 v2 spawned 事件 parentToolCallId 职能的继任者，且覆盖一批多 spawn 的并发歧义） |
| 后台模式 | 经 v2 任务服务：`tasks.registerTask(SubagentTask, {detached, timeoutMs, signal})`，完成走任务通知 | 走 agent-core detach：`detach(formatBackgroundAck(...))` 即转后台（tool.ts:90-92），execute 继续跑完，结果经机器 `source:'async-tool'` 通知带回；task 域重定义为 detached tools 的查询/管理 | 约束问答 spawn 后台条（用户 2026-09-27：后台不需要 task——detach 机制直接承载，spawn 不分期、前台/后台/镜像一次落地） |
| 后台可用性门控 | `TaskList/TaskOutput/TaskStop` 三工具全 active 才允许 `run_in_background`，否则 `BACKGROUND_AGENT_UNAVAILABLE` 拒（agentTool.ts:132-135/441-443）；描述按门控选 enabled/disabled 两版 md | 后台恒可用；描述恒用 enabled 版文案（spawn-background.md）；无拒绝分支 | 后台走 detach 定稿的自然结果（os 工具组决策④同款：`run_in_background` 总是可用，task_id 映射为 toolCall.id） |
| fork 继承 | `agentLifecycle.fork` 继承调用方 agent type 的绑定与上下文 | `session.fork(callerAgentId, {agentId, source})`，继承调用方冻结 spec（systemPrompt/工具集）；fork 后 `target.remind(FORK_CONTEXT_NOTICE)`（文案与 v2 逐字一致，plan.ts:33-34 ↔ spawn.ts:13-14） | 第 1 轮偏差③（对齐 v2「fork 继承调用方 agent type」语义） |
| spec freeze | 参数/描述每请求动态：flag 切 fork 参、config 切 model 参、`catalogProfiles` ready 后冻结、`notify.enabled` 过滤 Tools 行（agentTool.ts:100-107/141-177） | 挂载时一次性冻结：描述全静态（models 段只列 props models，不读调用方 config；执行时模型解析仍读实时 `agent.config`） | 第 1 轮偏差②（237 spec freeze 在工具注册时冻结描述） |
| 委派白名单 | `planSpawn` 内 rootDelegationExtras/subagentAllowlistFor/withoutDelegatingTargets + allowlist 拒绝文案（subagentService.ts:90-120） | 同名函数经 profiles 域 `catalog/delegation.ts` 逐字移植，`planSpawn` 全量委派语义（discovered 来源自动可被 main 委派、caller 未声明 subagents 时过滤能再委派目标，plan.ts:121-165） | 第 19 轮（随 profiles 域落地；第 1 轮④「只允许 main 委派」的临时简化已被取代） |
| 未知 profile 文案 | `Unknown agent type: "<name>"`（subagentService.ts:117，PROFILE_UNKNOWN） | `Unknown agent profile: "<name>". Available profiles: <list>`（plan.ts:146-154） | 第 19 轮偏差⑦（取 profileService 的原文，v2 subagentService 变体未采用） |
| 校验错误通道 | zod 框架层校验 + `Error2` + `isError:true` 结果 | 校验失败返回标 `isError: true`，框架统一渲染（手写校验/容错解析差异保留）：`validateSpawnArgs`（prompt 必填 `PROMPT_REQUIRED_MESSAGE`、resume+type 拒、fork 三拒，plan.ts:79-97） | A 步已落地（第 76 轮） |
| runAndWait 等待机制 | `runAgentTurn`：loop.submit → promptHandle.launched → turn.result 两段等待 + signal 链 turn.cancel（runAgentTurn.ts:35-112） | `target.run(message, {meta, signal, onStarted})` 复合命令薄包装（run.ts:251-271）：prompt blocked → `AgentRunError('blocked')`、actor 未运行 → `'agent is not running'`、外部 signal → reject 并善后 cancel/abort | 第 36 轮（用户指示 `AgentCommands.run`，两段式等待收编进 agent-core，spawn 为薄包装）；prompt origin `{kind:'subagent'}`（v2 为 `{kind:'system_trigger', name:'subagent'}` + tracked:true） |
| 管线复用 | Agent 工具与 swarm 各自经 ISessionSubagentService | `createSubagentLauncher`/`runAndWait`/`retryAndWait`/`latestAssistantText`/`sumUsage`/`classifyOutcome` 提取在 spawn 域，swarm 经 barrel 复用 | 第 37 轮前置重构（spawn 行为零变化） |
| Service 层 | SessionSubagentService（DI Service，248 行） | 无 service——全部逻辑为 setup 作用域函数（createSubagentLauncher 闭包） | 去 Service 化三轮先例（task/plan/cron，用户裁定） |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
|---|---|---|---|
| 前台超时兜底 | `[subagent].timeoutMs`（默认 2h，`KIMI_SUBAGENT_TIMEOUT_MS`）经任务服务强制：`Agent timed out after 2 hours.` + stop_reason `timed_out`（configSection.ts:76-81、agentTool.ts:538-557） | 无任何超时——`runAndWait` 无限等待（signal 中止除外）；`subagent` 配置节未注册 | 第 1 轮遗留「超时与模型池配置待后续」至今未补；模型卡死时只能用户取消。归属：需 config 面 + 计时机制（swarm 节已有 per-attempt timeout 先例可参照） |
| stop reason 分类 | 11 类：completed/repeat_breaker/max_tokens/max_steps/filtered/provider_error/no_final_message/cancelled/stopped/timed_out/error，各有专属 next_step；`USER_INTERRUPTED_SUBAGENT_MESSAGE`（'…stopped before it finished by user.'）；reason 截断 2000 字符（agentTool.ts:561-633） | 6 类：completed/max_steps/no_final_message/cancelled/stopped/error（format.ts:1-7）——`cancelled` 分支存在但 `classifyOutcome` 实际不可达（aborted 一律归 stopped，run.ts:293-314）；无 'by user' 变体、无截断；max_tokens/filtered/provider_error/repeat_breaker 塌缩为 error | TurnOutcome 面无 max_tokens/forcedStopReason（与 swarm stopReason 同根）；toolDedupe repeat-breaker 框架未迁（第 2 轮盘点遗留）。模型拿到的失败引导粒度变粗 |
| profile 工具白名单 | toolPolicy 执行门禁（`isToolActiveForProfile` 实际过滤工具）+ 描述 Tools 行经 policy 过滤 + NOTIFY_USER 按可用性剔除（agentTool.ts:156-225/642-684） | 仅 prompt 约束：描述列 `profile.tools` 原始名单（无 policy 过滤、无 notify 剔除），执行期无 profile 级工具门禁 | 第 1 轮④ + 第 19 轮偏差③④记录在案；归属 sessionToolPolicy（permission 或 profiles，仍挂起） |
| permission mode 复制 | spawn/rebuild 时 `created.setMode(caller.mode)`（pinned profile 除外，subagentService.ts:184-186、agentTool.ts:409-411） | 未接——子代理 mode 走自身 durable 默认；main setMode 广播仅覆盖已 live agents | 第 29 轮遗留「spawn 创建时复制调用方 mode 未接」，归属 permission 域后续 |
| user tools 继承 | `inheritUserTools`（fork 按 activeToolNames 过滤、非 fork 全量，subagentService.ts:187-194） | 新架构无 user tool 概念，无对应物 | 框架差异（非本域可补） |
| runtime lease / 能力声明 | 非 fork spawn `acquire(['process'])` lease + `requiredRuntimeCapabilities:['process']` 门控 | 无 lease 概念；能力由宿主注入端口决定（`createSpawn({host?})` 缺省 `createNodeOsHost()`，process 端口供 git-context prompt 前缀用） | os 工具组决策①先例（v2 远程 runtime 场景不迁）；浏览器/远程宿主不注入 host 即无对应能力 |
| 前台转后台 | `waitForForegroundRelease`：用户中途把前台子代理转后台 → `note: The user moved this subagent to the background.` 变体 ack（agentTool.ts:526-531/686-708） | 无 pending detach 面——`run_in_background=false` 的前台 spawn 不可被用户转后台 | 未在 Handoff 单列；与 Bash 的 `BashPendingDetach`（os 域已有人为用户 detach 通道）不同，spawn 未配 |
| 后台 ack 文案 | `resume_hint` 含 `or source_id from a later <notification>` 与 task.lost/failed/killed recovery cases 整句；`next_step` 写 `do NOT wait, poll, or call TaskOutput`；`description:` 行恒出现 | resume_hint 止于 `NOT task_id ("<id>").`；next_step 改 `poll, or sleep`；description 为空时整行省略（format.ts:70-91） | v2 文案依附其任务通知体系（task.lost 通知不迁——新架构 remount 时 running 记录 reconciliation 为 lost 是 task 域行为，无通知文案对齐）；文案缩短未单列记录 |
| 子代理 scope 回收 | `SessionSubagentScopeCacheService`：完成/失败/取消即 retire，LRU（默认 32）驱逐空闲 scope，忙时 deferred 重试 ≤3 次（subagentScopeCacheService.ts 全文） | 不迁——子代理永久驻留 session live 表，直至显式 close | 未在 Handoff 记录；长会话大量 spawn 后 live agent 数无界（各 agent 持有机器/投影内存）。归属待讨论 |
| fork 子代理的 profileName | fork 计划 profileName = 调用方 profile 名（subagentService.ts:98-99），输出 `actual_subagent_type: coder`（示例） | fork 计划 profileName 恒 `'fork'`（plan.ts:20/160-162），输出 `actual_subagent_type: fork`；roster source 亦为 `spawn:<parent>:fork` | 未在 Handoff 记录；渲染/展示差异（v2 显示真实类型），resume fork 子代理后 registry 亦记 'fork' |
| 池模型的 thinking 语义 | 池条目不继承调用方 thinking：thinking = `[secondary_model].defaultEffort` ?? 模型声明默认（configSection.ts:307-318，描述附 `Pool entries don't inherit your thinking level.`） | `setConfig({...callerConfig, model})` 整盘继承调用方 thinking（run.ts:169-172）；SpawnModelEntry 无 thinking 字段 | 未在 Handoff 记录；`[secondary_model]` 节整体不迁的次生差异 |
| caller 无模型绑定的处理 | planSpawn 对任何 spawn 要求 caller `modelAlias` 在场，否则 `MODEL_NOT_CONFIGURED`（subagentService.ts:121-125） | 仅当请求显式 model 且 caller 无 config 时报 `Caller agent has no model bound.` 并 close 子代理（run.ts:162-167）；caller 无 config 且 inherit 时放行（子代理拿宿主默认绑定） | 第 8 轮「config 永不持久化」决策的松弛；v2 的早失败保护变弱（子代理跑到 LLM 才暴露无模型） |
| description 必填校验 | zod `description: z.string()` 框架层必填（空串可过） | JSON schema 声明 required 但 execute 无哨兵——模型省略 description 时仍照常启动（swarm 域有 `Provide a non-empty description for the swarm.` 哨兵，spawn 未配）；prompt 反而新增非空校验（v2 空串可过，新 `PROMPT_REQUIRED_MESSAGE` 拒绝） | 未在 Handoff 记录；prompt 校验为新增更严，description 校验为缺口，两侧互不一致 |
| 参数容错解析 | 框架 zod 校验非法 JSON/缺字段 | `JSON.parse(toolCall.arguments ?? '{}')` 裸解析——非法 JSON 走外层 catch 输出 `subagent error: <SyntaxError 原文>`（tool.ts:75/110-112），无 wait-for/edit 先例的 `invalid Agent arguments: <raw>` 文案 | 未在 Handoff 记录（swarm 域有容错解析，spawn 漏配） |
| agent-fork.md 描述附录 | flag 开时描述追加「Context forking: …」整段（agent-fork.md 1 行） | 未迁——fork 语义仅在 fork 参数 describe 里 | 未在 Handoff 记录（swarm 侧附录是空文件故无差异；Agent 工具这段是有效文案） |
| `[secondary_model]` 校验 | `SessionSubagentModelsValidationService` 会话创建即校验（force 互斥/defaultModel 必填/别名可解析/defaultEffort 支持性，configSection.ts:124-239） | 无——props models 直传 LlmModel，无校验面 | props 化的固有结果；配置错误从启动期失败变为运行期无校验 |
| mirror 载荷与输出 schema | spawned 携 model/modelSource/thinkingEffort/taskId；completed 携 usage/contextTokens；`SubagentToolOutputSchema`（result + usage 结构化输出） | 事件删除（第 50 轮）；工具输出纯文本，无输出 schema | 第 50 轮定稿；第 41 轮补的 contextTokens 镜像随之删除；usage 仍收集进 swarm completion 但不渲染 |
| 遥测 | `subagent_created` | 无 | 遥测不迁批次，待云端 appender 落地后统一补回 |
| resolveExecution 面 | display（agent_call 卡片 + background 标记）、accesses、approvalRule + matchesRule（profile 名 glob） | ToolDefinition 无此面 | permission 域（#19）与 display 体系归属；execution.display 不迁为既定批次 |
| resume 错误文案 | 三条分开：`does not exist` / `is not a subagent` / `does not belong to this parent agent`（无尾句号） | 前两条合并 `does not exist or is not a subagent.`；归属句加尾句号；新增 `could not be reopened: <cause>` | 第 8 轮（测试断言已按新文案更新，记录在案） |
| running 并发守卫 | 读子代理 loop snapshot `state==='running'`（agentTool.ts:383-385） | 读 SpawnRegistry 内存 `running` 标志（run.ts:118-127） | 外部绕过 spawn 直接 submit 的运行中子代理挡不住；registry 内存化亦使跨进程守卫依赖重开前置位/失败复位（第 8 轮已处理） |
| externalHooks 接缝 | `hooks.onWillStartAgentTask`（SubagentStart 生产）+ `notifyAgentTaskStopped`（SubagentStop 生产） | SubagentStop 已经第 50 轮由 externalHooks 自行派生（agent.opened + turn 事件 + roster source）；SubagentStart 无生产方 | 第 44 轮记录在案（SubagentStart 属第二批逐项对齐清单） |

### 新增 / 更强
| 差异点 | 说明 |
|---|---|
| 响应式工具门控 | catalog 缺席时 Agent 工具不注册（v2 恒注册）；profiles 后装/缺席的降级路径明确，spec freeze 语义一致 |
| resume 跨进程恢复完整度 | 重开走 `session.create({agentId})`——分支/历史/冻结 spec/features 名单一并恢复；v2 rebuild 走 metadata labels + forkedFrom 重建绑定，spec 为创建时绑定而非冻结快照 |
| 复合等待原语 | `AgentCommands.run`（promptId 匹配、turnId 精确归属、外部取消/超时善后）由 spawn 路径驱动落地 agent-core，sessionInit/swarm 同享 |
| 空 retry 消息实证 | 限流重试的空 content 消息驱动 turn 有测试锁定（第 37 轮）；v2 同形态无实证 |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
|---|---|---|---|
| `[secondary_model]` 节（defaultModel/models/force/model/defaultEffort 等 15 字段） | config 节 + 会话级校验服务 | 不迁；模型池为工厂 props `models: SpawnModelEntry[]`（name/description/model 直传） | 人为设计（props 化；force/defaultEffort/校验服务随节不迁） |
| `[subagent]` 节 timeoutMs + `KIMI_SUBAGENT_TIMEOUT_MS` | 默认 2h，parse int≥1 + stripEnv | 未注册、无超时 | 简化（第 1 轮遗留，见上表） |
| fork flag | `subagent_fork` flag：per-flag env > `[experimental]` config > master env > default false | 仅 env：`KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK`/`KIMI_CODE_EXPERIMENTAL_FLAG`（'true'/'1'），或 props `forkEnabled` | 简化（flag 注册表与 `[experimental]` 节不迁） |
| scope cache env（`KIMI_CODE_SUBAGENT_SCOPE_CACHE_SIZE` 默认 32 / `KIMI_CODE_SUBAGENT_SCOPE_EVICT_TIMEOUT_MS` 默认 15s） | scope 回收调参 | 不迁（无 scope cache） | 简化（未记录） |
| 工厂 props | 无 | `createSpawn({ catalog?, models?, forkEnabled?, workDir?, host? })`，不进 preset（workDir 宿主概念），example 挂载（createProfiles 之前） | 人为设计 |
| facade 方法面 | 无对外 facade（ISessionSubagentService 为内部服务：planSpawn/spawn/run/notifyAgentTaskStopped + hooks） | 无 SpawnRef；session 级 `SpawnRegistryRef` token 供 swarm 归一 running 守卫；`createSubagentLauncher` 为包内复用 API | 已对齐（均无产品 facade） |

## 工具 / 事件 / facade 面差异
- Agent 工具：参数七项（prompt/description/subagent_type/resume/run_in_background/fork/model）语义对齐——subagent_type 缺省 'coder'（v2 zod preprocess 默认，新 planSpawn 默认）、model 参 models 非空才出现、fork 参 forkEnabled() 才出现、fork 三拒文案逐字、resume+type 拒文案逐字；描述 = spawn.md + 后台段 + `Available agent types` 列表（无 toolPolicy/notify 过滤）+ models 段，缺 agent-fork.md 附录与 background-disabled 变体。
- 输出契约：前台成功（agent_id/actual_subagent_type/status/stop_reason/[summary]/resume_hint）与后台 ack（task_id/status/agent_id/automatic_notification/next_step/resume_hint）骨架逐字；差异集中在 stop_reason 分类缩减与后台 ack 文案缩短（见上表）。
- Feature 事件：v2 五镜像 + 遥测 → 新零事件（第 50 轮定稿）；关联替代物为 `tool.update{key:'subagent'}` + `agent.opened/closed` + roster source。

## 摘要
spawn 主链路（planSpawn 委派白名单 → create/fork → 模型继承 → runAndWait → 摘要提取 → 格式化交接）与 v2 逐段对齐，且经第 19 轮补齐了全量委派语义与 prompt 前缀（explore git-context），经第 8/50 轮把身份与事件体系换成了更简洁的 roster source + 统一事件流。最重要的三个差异：① 镜像事件与任务服务整体删除（后台走 detach、关联走 tool.update，第 50 轮定稿）；② 模型池/超时/校验从 config 节体系改为工厂 props（`[secondary_model]`/`[subagent]` 两节均未迁）；③ stop_reason 从 11 类塌缩为 6 类且前台无超时兜底（第 1 轮遗留至今）。最需关注的缺口：前台 2h 超时与 `[subagent]` 节未补（模型卡死只能用户取消）、子代理 scope 无回收（长会话 live agent 无界增长，未在 Handoff 记录）、permission mode 复制未接（spawn 出的子代理不继承调用方 mode）。
