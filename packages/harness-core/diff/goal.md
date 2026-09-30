# goal：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/goal/`（约 2004 行 ts + 7 份 md；`feature.ts` 1020 行为单文件摊平形态）
- agent-core-v2：`packages/agent-core-v2/src/features/goal/`（约 2421 行 ts + 7 份 md；`goalService.ts` 1443 行 + DI 工具类）
- 蓝本关系：迁移顺序表 #21，以 v2 DI 版实现为行为规格蓝本（非 refact-237 第一批 human 蓝本）；第 28 轮实现、第 33 轮去 Service 化摊平（行为零变化）、第 31 轮落地 afterStep/stopTurn 框架能力但 goal 侧接线留作后续。

## 行为差异

### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
|---|---|---|---|
| reminder 通道与时序 | `GoalInjection` 挂 reminder 总线（`register('goal', …)`），isNewTurn 时在**新 turn 首个 LLM 请求**即携带 goal reminder；budget-stop/cancelled 经 `notify` 即发 | `agent.remind` 被动注入：每 turn 首个 `beforeStep` 注入一次（`lastRemindedTurnId` 去重，key `'goal'`），经 mid-turn drain 落账——**首 step 请求不含本 turn reminder**（continuation prompt 本身携带目标指引弥补）；纯文本单步 turn 不带入（第 16 轮记录的机器语义） | 约束问答「reminder 域怎么迁」（2026-09-27 用户：不实现 reminder 域，各 Feature 直调 `agent.remind`，v2 reminder 总线不迁） |
| CreateGoal 启动审批通道 | 工具 resolve 期挂 `display:{kind:'goal_start', objective, completionCriterion, mode}`；`onBeforeExecuteTool` 钩子在 `mode!=='auto'` 时经 `IAgentToolApprovalService` 问审（`'goal-start-review-ask'`），批准且 `selectedLabel` 为 auto/yolo/manual 时同步切换 permission mode | `useBeforeTool` 守卫一律经 interaction `kind:'approval'` 问审（payload `{kind:'goal_start', objective?, completionCriterion?}`，无 mode 字段、无 selectedLabel→setMode 后续）；取消/拒绝文案与 v2 `toolApprovalService.ts:231-244` 逐字一致（含 ` Reason: <feedback>` 后缀） | 第 28 轮契约「interaction 启动审批」；plan 先例（审批走 interaction 是各域自有特性，非 Permission） |
| 终稿写入时机（UpdateGoal complete/blocked） | 工具结果带 `stopTurn: true`：turn 在工具结果处停止，`goalOutcomeContinuation` 经 `loop.notify()` 立即开新 turn 让模型写终稿 | 无 stopTurn 通道：终稿提示（`buildGoalCompletionSummaryPrompt`/`buildGoalBlockedReasonPrompt`，与 v2 逐字一致）作为普通工具结果返回，模型在**同一 turn 内**续写终稿 | 第 31 轮定稿：「新架构『同 turn 续一步』已等价，非必需；ToolResult 级 stopTurn 通道未做」；第 28 轮偏差③在案 |
| 错误体系 | `Error2` + 错误域注册（`errors.ts` 8 码，含 title/action 展示文案，含 v2 独有的 `goal.metadata_reserved`） | `GoalError extends Error { code }` 7 码（无 `goal.metadata_reserved`——无 session metadata 镜像面），工具层映射为文本结果 | coded error 范式（sessionExport 第 20 轮偏差⑤先例：Error2 域注册机制不迁） |
| waitFor 可用性探测 | 动态三查：`IFlagService.enabled(WAIT_FOR_FLAG_ID)` + 工具注册表 `resolve('WaitFor')` + `toolPolicy.isToolActive` | 读冻结 spec：`ports.toolDescriptions.some(t => t.name==='WaitFor' && t.deferred!==true)` | spec freeze 横切约定（工具集挂载时冻结，动态重注册不迁） |
| 时钟与调度器接缝 | `IGoalDeadlineScheduler` App 级 DI 服务（`now()` hrtime 毫秒 + `schedule` setTimeout unref），actor 机经 `goal.deadline.refresh/clear` 事件驱动 | 工厂 props `createGoal({ now?, wallNow? })`（默认 hrtime 单调钟 / `Date.now`），feature 闭包内 `setTimeout` + `pushCleanup` | 第 28 轮「注入时钟端口（默认 hrtime 单调钟）」；无定时器原语约定（Feature 内 setTimeout + pushCleanup 即可） |
| 进 preset / flag | v2 `registerFeature` 默认启用集，无 flag | 进 preset（`createGoal()`），无 flag | 第 28 轮偏差⑤（以 v2 `src/index.ts:383` 副作用注册为证） |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
|---|---|---|---|
| 预算硬停的收场方式 | afterStep 检测预算越限：首次 arm grace + 注 `GOAL_BUDGET_STOP_REMINDER`（给模型一步写终稿），下一 afterStep `ctx.stopTurn = true`——**turn 以 done 正常收场**；grace 前查 `loop_control.maxStepsPerTurn` 剩余步数 | 检测点（usage 越限/turnStarted/setBudget/deadline/turnDone）arm grace + 同款 reminder → `useBeforeTool` 全工具拒绝（同款文案）→ 下一 `beforeStep` `agent.abort`——**turn 以 aborted 收场**；不读 maxStepsPerTurn（无条件 arm） | 第 28 轮偏差④在案；第 31 轮 `useAfterStep`+stopTurn 已落地，「goal 接 afterStep（预算检测点前移 + 硬停改 stopTurn 正常收场）为后续小改，待用户指示」——当前代码尚未接线（`feature.ts` 无 `useAfterStep`） |
| fork 目标清除与 forkNotice | session fork 写 `'forked'` marker（`GoalForked`）：durable 状态清 goal、置 `forkNotice.reminderPending`，normalize 时注 `GOAL_FORK_CLEARED_REMINDER`（"This fork does not have a current goal…"），`ContextAppendMessage` 落账后熄标记；session custom metadata 的 `goal` 键 fork 时剔除（`forkCustomMetadata` 的 `withoutGoal`） | 无任何 fork 处理：投影只认 `goal.create/update/clear`，feature 无 fork 监听——fork 后 goal 状态沿 branch parent 链回放**继承**（工具/钩子仅 main 生效，子代理侧惰性）；无 fork-cleared reminder，fork 分支历史里残留旧 goal reminder 无更正 | 未在 Handoff 在案（goal 域无 fork 决策记录；cron 有同类遗留可参照）；影响 btw/spawn fork 出的子代理上下文整洁度，归属待定 |
| 失败 pause 原因细分 | `goalFailurePauseReason` 按 ErrorCodes 细分：PROVIDER_AUTH → `'Paused after provider authentication error'`、PROVIDER_FILTERED → `'Paused after provider safety policy block'`、MODEL_NOT_CONFIGURED/MODEL_CONFIG_INVALID → `'Paused after model configuration error'`（前者配 `'LLM not set, send "/login" to login'`） | 按 `LlmErrorKind` 映射（`feature.ts:973-1005`）：`rate_limit`→同款；`connection/timeout`→connection 前缀；`status/auth/provider/overloaded/quota_exhausted/context_overflow/...`→provider API 前缀；其余 runtime 前缀——**auth 专属前缀、safety-filtered、model-config 三类未复现** | 第 28 轮偏差②在案；第 37 轮 `'auth'` kind 落地后归入 provider-api 桶，「PROVIDER_AUTH 专属 pause 前缀恢复可选」在案 |
| CreateGoal 的 auto 免审旁路 | `mode==='auto'` 时不挂 display、不问审 | 一律问审（permission 域第 29 轮已落地，但 goal 侧未像 plan 那样接 `PermissionRef` 旁路） | plan 旁路已在 permission 轮接通（第 29 轮）；goal 侧同类接线待做，未见单独在案 |
| stopBatchAfterThis | UpdateGoal（非 active 且 goal active 时）与 SetGoalBudget（设定后即超限时）在 resolve 期声明 `stopBatchAfterThis`，同批后续工具不执行 | 无批控制通道：preflight 后整批并发执行，UpdateGoal 与同批其他工具并发跑 | 与 stopTurn 同源的通道缺口（A 步/机器层议题）；第 40 轮 preflight 屏障定稿后批语义更突出 |
| 工具内 staleness 复查 | 三工具 execute 内复查 goalId 自 resolve 期是否变化，变则回 `'Goal not created/resumed/completed/blocked: the current goal changed.'`（`isGoalToolTarget` 豁免） | 仅 `useBeforeTool` 守卫一处（`GOAL_STALE_TOOL_RESULT`，文案与 v2 一致），execute 内无复查 | 守卫级拦截已对齐；execute 期复查未迁，未见在案 |
| isError 结果通道 | 参数/状态校验失败回 `{isError:true, output}`——模型经 `<system>ERROR: Tool execution failed.</system>` 状态块感知业务失败 | 已切回——非法 status 等校验失败标 `isError: true`（missing-goal/no-active-goal 等 v2 本就不标的回复保持不标）；框架统一渲染 | A 步已落地（第 76 轮） |
| 遥测 | `goal_created`/`goal_budget_set`/`goal_cleared`/`goal_status_changed`/`goal_continued` 五事件 | 无 | 第 28 轮偏差①在案；telemetry builtin 第 24 轮已落地，goal 接线列入「遥测待补回」批次 |
| token 记账依赖 | `ISessionUsageService` 恒在，`onDidRecord` 逐条记账 | `node.providerRef(UsageRef)` 可选探测 + watch——**usage feature 未挂载时 token 记账整体失效**（token 预算永不触发） | providerRef 可选探测横切约定；preset 默认挂 usage 时行为对齐 |
| session metadata goal 镜像 | 会话 custom metadata 有 `goal` 保留键镜像（`goal.metadata_reserved` 错误码佐证；写入方在 kap-server 侧投影；fork 时剔除） | 无镜像面（`GoalRef.state` 响应式 ref + `goal.updated` 事件替代） | 消费方在 kap-server/TUI，不属 harness-core 范围；如需对齐属宿主投影议题 |
| canLaunchContinuation 条件 | `state==='idle' && !hasPendingRequests` | 仅 `!snapshot.matches('running')`（snapshot undefined 时放行），不查待处理队列 | 边界差异：队列有用户消息时 v2 跳过自动续跑，harness 照常 submit 排队；未见在案 |

### 新增 / 更强
| 差异点 | 说明 |
|---|---|
| `GoalFace.state: ShallowRef<GoalModelState>` | facade 直接暴露响应式状态（v2 只能 `getGoal()` 快照读或订阅 `GoalUpdated` 事件） |
| 串行操作链 `run/enqueue` | 所有 facade 操作与效果回调经单 promise 链串行化，替代 v2 actor 邮箱 + 事件机的效果编排，resume/setBudget/deadline 等并发竞态在闭包内收敛 |
| 守卫阶段序 | goal 守卫经 `useBeforeTool` 跑在内置 permission 裁决之前（第 29/40 轮定稿的两阶段管线），修掉 v2 扁平注册（顺序=DI 激活顺序）的同类缺陷 |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
|---|---|---|---|
| goal 专属 config 节 | 无（仅读 loop 域 `loop_control.maxStepsPerTurn` 用于 grace/continuation 门控） | 无（且不读 maxStepsPerTurn） | 已对齐（读取差异见行为表「预算硬停」行） |
| env 绑定 | 无 | 无 | 已对齐 |
| experimental flag | 无（默认启用） | 无（进 preset） | 已对齐（第 28 轮偏差⑤） |
| 工厂 props | 无工厂；`IGoalDeadlineScheduler` DI 服务替换 | `createGoal({ now?, wallNow? })` | 已对齐（时钟注入接缝形态不同） |
| 审批交互契约 | `ToolInputDisplay{kind:'goal_start', objective, completionCriterion, mode}` + approval `selectedLabel` 可切 mode | interaction `kind:'approval'`，payload `{kind:'goal_start', objective?, completionCriterion?}`，响应 `{decision, feedback?}`（`GoalStartApprovalResponse`） | 简化（mode 展示与切 mode 未迁，见行为表审批行） |
| facade 方法面 | `IAgentGoalService` 12 方法 | `GoalFace` 9 方法 + `state` ref | 见下节 |

## 工具 / 事件 / facade 面差异
- **工具清单**：`CreateGoal`/`GetGoal`/`UpdateGoal`/`SetGoalBudget` 四件同名；4 份工具 md 与 3 份 injection md **逐字节一致**（cmp 验证）；参数 zod schema 同款（strict、describe 逐字），harness 手写 JSON Schema 与 v2 `toInputJsonSchema` 输出等价。
- **工具契约差异**：主路径输出/错误文案逐字一致（`'Goal resumed.'`、missingGoal 三态、`'Goal budget set: …'`、超预算提示等）；未迁项——execute 期 staleness 三文案、`isError` 标记、`stopTurn`/`stopBatchAfterThis`（均见行为表）。非 main agent 拒绝文案 `GOAL_MAIN_AGENT_ONLY` 两侧逐字一致（harness 全部 agent 可见四工具、execute 期拒绝；v2 另受 subagent profile 工具白名单过滤，可见性差异与 cron 第 17 轮编排者决定④同类）。
- **Feature 事件**：`goal.updated` 类型串一致、payload `{snapshot, change}` 同形；v2 为 observable Event2 总线事件（kap-server 投影消费），harness 为 Feature 节点事件（`useFire`，tier hook/handle 消费，agentId 经 EventContext 富化——decodeAgent 拒 agentId 字段载荷先例）。
- **durable 事件**：`goal.create`/`goal.update`/`goal.clear` 类型串两侧一致；v2 为 zod schema + agentId 字段的 Event2 类，harness 为无 schema 的 journal 记录 + 投影防御性字段读取（`readBudgetLimits`/`readCounter`/`readStatus`）；v2 另有 `'forked'`（GoalForked）与 `ContextAppendMessage` 参与 forkNotice，harness 均无。undo/分支语义两侧一致（v2 `undoable:false`；harness 随 branch 切换投影重放自然成立，第 28 轮在案）。
- **facade**：九方法对齐（`getGoal`/`createGoal`/`pauseGoal`/`resumeGoal`/`setBudgetLimits`/`cancelGoal`/`markBlocked`/`markComplete`/`pauseOnInterrupt`）；harness 新增 `state` ref；未迁 `isGoalToolTarget`（守卫内部化）、`recordTokenUsage`/`incrementTurn`（usage/计次已内部接线，v2 侧主要供测试与内部调用）。

## 摘要
核心生命周期（create/pause/resume/cancel/complete/blocked）、三类预算记账与 deadline 调度、continuation 循环、reminder/工具文案与 durable 事件形态高度对齐（7 份 md 逐字节一致，主路径文案逐字）。最重要的两个差异：① 预算硬停 turn 以 **aborted 收场**（v2 为 stopTurn 正常收场——afterStep 能力已备、goal 接线是记录在案的待做小改）；② **fork 语义未迁**——v2 session fork 清 goal + forkNotice 提醒 + metadata 剔除，harness 沿分支继承且无提醒（Handoff 未在案）。最需关注的缺口：优雅收场（stopTurn 接线）与 fork 目标清除；其次为遥测/isError 批次与 auth/filtered/model-config 三类 pause 前缀的恢复。
