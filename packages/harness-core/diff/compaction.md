# compaction：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/compaction/`（ts 约 1091 行：machine 404 / controller 251 / shape 202 / summarize 132 / feature 47 / errors 31 / index 24，外加 2 个 md）
- agent-core-v2：`packages/agent-core-v2/src/agent/fullCompaction/`（约 1485 行：fullCompactionService 955 / strategy 266 / compactionOps 158 / 其余 6 件）+ 强关联的 `src/agent/contextMemory/compactionHandoff.ts`（371 行，种子选择/shape 算法）与 `src/agent/fullCompaction/contextRecovery.ts`
- 蓝本关系：**直接蓝本是 refact-237 的 `src/human/compaction/`（第一批迁移）**——shape.ts / summarize.ts / errors.ts 与 human 版几乎逐字（仅 import 与事件工厂机械适配）；controller.ts / machine.ts 为 human 版的框架适配（turn.done 事件合一、删除 `resuming` 阶段）。DI 版 fullCompaction 是行为规格蓝本，但大量细节差异实际源自 human 蓝本而非本轮取舍，下表逐条标注「蓝本因素」。两份 md（compaction-instruction / compaction-summary-prefix）与 v2 逐字节一致（cmp 验证）。

## 行为差异

### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
|---|---|---|---|
| 触发分类 | `CompactionSource = 'manual' \| 'auto'` 两态 | `CompactionReason = 'budget' \| 'manual' \| 'overflow'` 三态（蓝本因素：human 蓝本同源） | refact-237 工作模型 |
| 超预算（beforeStep）处理 | `beforeStep` 里 `block()` 挂起当前 step 等 compaction 完成，随后**原地续跑**（fullCompactionService.ts:497-503,538-552） | `useBeforeStep` 抛 `CompactError('budget-blocked')` **当前 turn 立即失败**，compaction 经 `queueMicrotask` 后台跑（controller.ts:216-228） | 237 工作模型「`useBeforeStep` 超预算抛 CompactError」；docs `how-to-guides/03-listen-and-trigger.md:124`「当前 turn 必须立刻失败，在这里 await run 等于让超预算的 history 再进一次请求」 |
| 换分支后的恢复 | 就地 splice：`context.apply_compaction` 投影替换内存历史，turn/会话无缝继续 | `switchBranch` 后 **live actor 保持 pause，由宿主重挂**（agent slot 不能卸自己）；compact 返回 `{ branchId }` | 237 第 73 轮「压缩完成后不在 Feature 内重挂 agent，返回 branchId 给宿主」；docs `03-listen-and-trigger.md:178`「live actor 不会跟着 switchBranch 走，由宿主重挂」 |
| manual compact 并发姿态 | turn 活跃时直接抛 `COMPACTION_UNABLE`（"Cannot compact while a turn is active or another context change is running."，fullCompactionService.ts:342-347,388-393） | `pause()` 后轮询等 idle（25ms 间隔，300s 超时 `CompactError('reset-timeout')`，machine.ts:112,125-134）（蓝本因素：human 蓝本同） | human 蓝本继承 |
| Feature 事件面 | durable `full_compaction.begin/cancel/complete` + observable `compaction.started/blocked/cancelled/completed`（Event2 总线；completed 带完整 `CompactionResult`） | 机器事件经 `deps.onEvent` 回调（**不**挂 `createFeature<E>`）；durable 记录为 **session journal** 的 `compaction.started{agentId,reason,instruction}` / `compaction.completed{agentId,branch}` / `compaction.cancelled{agentId,cause,errorMessage}`；stats 另存 `agent.switched` 的 stats 载荷 | 237 第 109 轮「不给 compaction 挂机器 CompactionEvent（节点上的 journal 形状不同）」；237 工作模型「压缩事件写 session journal，不改 sessionTypes」 |
| durable phase 状态 | `fullCompactionKey` phase（idle/running）replayable + `onDidRestore` 时 running→cancel 归一（fullCompactionService.ts:457-460） | 无 durable phase——compaction 是进程内 per-run actor，journal 事件即 durable 记录；崩溃时 switch 未发生则分支原样 | 架构性设计（branch 切换是最后一步，天然安全点） |
| tokenCounting 衔接 | `applyCompaction` 后 `tokenCounting.rebase(measured:false)` 显式重定锚 | 零接线——锚点随 message meta，seed 只留 user entries（assistant 锚被丢弃）即自动 rebase | 271 约束问答 tokenCounting 条（第 83-84 行）与第 41 轮执行事实「compaction 零改动，已实证」 |
| 摘要 turn 形态 | `llmRequester.start` 独立请求（source `requestKind:'full_compaction'`） | `createTurnMachine` + `runTurn`（空 tools、`maxSteps:1`、自带 requester/config，不读 agent 的 setConfig/setRequester） | 237 第 113/125 轮「另开 turn 不进 agent.submit 队列、不读 setRequester」 |
| TODO 附加 | 内部直读 `IAgentTodoService` 自动 `renderTodoList(todos,'## TODO List')`（fullCompactionService.ts:810-816） | `deps.todos` 回调端口注入（controller deps；example 未接） | 宿主端口注入横切约定 |
| onWillCompact 扩展点 | `hooks.onWillCompact`（OrderedHookSlot） | `deps.onWillCompact` props 回调（签名含 reason/instruction/signal/tokenCount，等价） | 形态映射 |
| 错误体系 | `Error2` 码 `compaction.failed` / `compaction.unable`（带 cause 包装） | `CompactError` 九码：busy / unknown-agent / insufficient / drift / summary-failed / aborted / cancelled / reset-timeout / budget-blocked | 蓝本因素 + coded error 范式（HostFsError 先例） |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
|---|---|---|---|
| **Context Recovery footer 未迁** | `captureWireLines` + `fullCompactionWireRangesKey` durable 记录历次 wire 行区间，`renderContextRecoveryPointer` 把「window N: lines x–y」指针段附加到 contextSummary（fullCompactionService.ts:749-767,818-838；contextRecovery.ts） | 无 wire 概念，footer 完全不产出；但 `compaction-instruction.md` 与 v2 逐字节一致，第 51 行仍承诺 "a recovery pointer is appended below this summary automatically"——**文案与实现不一致** | 271 第 2 轮（2026-09-28）完整性核查在案，至今未修；模型被误导认为可回查原始日志 |
| **overflow 后不重试失败 turn** | loop 错误处理器：overflow → 自动 compaction → `context.retry()` 透明重跑失败请求（fullCompactionService.ts:199-204,468-495），turn 不死 | `turn.done` failed 且 `error.kind==='context_overflow'` → 后台 `run('overflow')`（controller.ts:197-210）；**turn 已以 failed 终结**，用户意图不会自动续跑（蓝本因素：human 蓝本同构） | 超窗时用户需重新发起；恢复语义降级。agent-core 的 `useLlmRecovery` 是潜在正式接缝，未立项 |
| **成功后无 continuation 消息** | 压缩后历史末尾附 `compaction_continuation` reminder（"Context compaction is complete — continue the work…"，compactionHandoff.ts:157-164,120-122）；human 蓝本经 `resuming` 阶段对非 manual 原因 `input.submit` 发送 | `resuming` 阶段整体删除，continuation 完全不注入；`compactionContinuationMessage`（shape.ts:74）导出但**全仓零消费**（死导出） | 压缩后模型没有「继续工作」提示；死导出待清理或接线 |
| **宿主消费方未落实重挂** | （v2 无需重挂，就地 splice） | 范式要求宿主在 `compaction.completed` 后 remount，但 example、feature-http `POST {id}:compact`（route-features/compaction.ts）、ACP `/compact`（feature-acp/builtin-commands.ts:82-95）**均未重挂**：成功后 agent 滞留 paused、机器内存 `context.messages` 仍是旧分支历史（agent.ts:406,644 实证机器历史不随 switchBranch 更新） | 仓内无可用的端到端 compact 消费路径；undo（agent-core builtin 第 34 轮）是唯一落实「close+create 重挂」的参照 |
| lastCompactedTokens 生命周期 | `TurnStarted` 重置 `lastCompactedTokenCount` / `compactionCountInTurn` / `consecutiveOverflowCompactions`（fullCompactionService.ts:462-466） | 仅 `turn.done(done)` 重置 `overflowAttempts`；`lastCompactedTokens` **终身不重置**（controller.ts:104-108,198-201）（蓝本因素：human 同） | 压缩后 context 再涨到 trigger 但未超上次压缩前 token 时，后续 turn 不再触发预算压缩 |
| 预算规则收窄 | `DefaultCompactionStrategy`：`used >= max*triggerRatio` **或** `used+reservedContextSize(50K) >= max`；blockRatio 与 triggerRatio 可分（不同则 afterStep 再查一次）；per-model `compactionTriggerRatio`/`reservedContextSize` override（strategy.ts:18-28,91-135） | 仅 `used >= max*triggerRatio` 单阈值（props 注入），无保留区规则、无 afterStep 复查（controller.ts:104-108） | 触发更迟：窗口尾部 50K 缓冲区内不压缩，更容易先撞远端 413 |
| 摘要请求保真度 | `maxOutputSize = maxOutputSize ?? min(maxContext,128K)`；总尝试 `compactionMaxAttempts ?? 5`；overflow 收缩按比率 [0.7,0.5,0.35] 预算式取最近消息；`providerFinishReason==='truncated'` 拒收（CompactionTruncatedError）；empty 区分 filtered；`runWithCredentialRecovery` 显式包裹；`isRetryableGenerateError` 退避重试；`stripDynamicToolContext` 剥动态工具上下文（fullCompactionService.ts:644-733） | `maxShrinkAttempts` 默认 **3**；收缩=每次丢最旧 1 条（summarize.ts:123-131）；**不查 truncated**（截断摘要会被接受）；empty 不区分 filtered；**无 credential recovery**（裸 turn 机不过 bindAgentLogics，credentialsRecovery 仅 agent ports 路径接线，contribution-hooks.ts:337）；429/5xx 依赖 requester 默认重试策略；无动态工具上下文剥离（蓝本因素居多：human 蓝本同） | 压缩成功率与摘要完整性低于 v2；401 直接失败；tool-select 动态 schema 消息进摘要请求 |
| observedMaxContextTokensByModel | 从 413/overflow 学习有效窗口（0.85 安全系数，per-model 记忆，fullCompactionService.ts:320-331） | 未迁 | 虚标窗口的模型每次都先失败一次再压缩 |
| 遥测 | `compaction_finished` / `compaction_failed` 全字段（tokens/duration/retry_count/thinking_effort/trace_id/usage 四件）+ cancel `track2` | 未接（telemetry 域批次待补）；机器事件 `compaction.completed` 的 `summary` 载荷（usage/traceId/attempts/droppedCount）仅经 `onEvent` 回调 | 271 第 24 轮「各域遥测不迁」批次待补 |
| keep 过滤语义 | 按 `origin.kind` 细粒度丢弃：injection/shell_command/compaction_summary/system_trigger/task/cron_job/cron_missed/hook_result/retry 全丢，skill_activation/plugin_command 仅 user-slash 保留（compactionHandoff.ts:184-214） | 按 `meta.source ∈ {undefined,'input'}` 过滤（shape.ts:89-93）——cron 信封、skill-loaded、swarm retry 空消息经 `agent.submit` 进入均为 `source:'input'`，**会被当作真实用户输入保留**（蓝本因素：human 同过滤器） | 压缩后保留的「用户消息」混入系统发起内容；origin 字段存在但未用于过滤 |
| 错误文案/码 | `COMPACTION_UNABLE`："No messages to compact in current history." | `insufficient`："nothing to compact"（machine.ts:169）等九码文案全新 | 对外文案不逐字（feature-http 统一映射 40910） |
| 策略窗口函数 | `computeCompactCount` / `reduceCompactOnOverflow` / `canSplitAfter` 部分压缩窗口选择（strategy.ts:137-266） | 未迁 | v2 全量压缩路径亦未调用（grep 无消费方），属 v2 侧死面，无实际行为损失 |

### 新增 / 更强
| 差异点 | 说明 |
|---|---|
| drift 检测机制化 | quiesce 记录 branch head，摘要后逐条核验增量（`HISTORY_DELTA_TYPES` = message.appended/turn.started/turn.ended 命中即 `CompactError('drift')`，machine.ts:113,136-147）+ 分支一致性双检；v2 为 `historySafeToCompact` 引用比较（仅允许尾部追加真实用户输入） |
| pendingAuto 串行化 | active 运行期间 auto 触发排队一次，完成后 `firePending` 复查预算再补跑（controller.ts:110-121,158-163）；v2 是 begin 返回 false / block 等待 |
| 未跑 queue 保留进 seed | quiesce 快照含 pending queue，seed 以 `input.submitted` 事件重放进新分支（shape.ts:60-65）；v2 manual 仅 idle 可跑（队列恒空），无等价物 |
| feature-http / ACP 对外面 | `POST /sessions/{id}:compact`（缺席 40910、coded error 409；route-features/compaction.ts）、ACP `/compact` builtin 命令——v2 对应面在 kap-server，本仓内属新增 |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
|---|---|---|---|
| `budget.maxContextTokens()` | 读 profile `modelCapabilities`（max_input ?? max_context）+ observed 学习收窄 | 工厂 props 回调（example：`model.maxContextSize ?? 262_144`） | 人为设计（宿主端口） |
| `budget.triggerRatio` | 模型 `compactionTriggerRatio` override，默认 0.85 | 工厂 props（example 0.85） | 人为设计 |
| overflow 尝试上限 | `maxOverflowCompactionAttempts = 3`（超限抛 CONTEXT_OVERFLOW） | `maxAutoAttempts` props 默认 3（到顶不再触发，turn 继续失败） | 已对齐（兜底动作略异） |
| 摘要尝试上限 | `MAX_COMPACTION_RETRY_ATTEMPTS = 5`（`compactionMaxAttempts` override） | `maxShrinkAttempts` props 默认 3 | 简化（蓝本因素） |
| 摘要超时 | 无显式超时（AbortSignal 控制） | `timeoutMs` props，缺省走 `runTurn` 默认 120s | 蓝本因素 |
| `reservedContextSize` 50K / blockRatio / checkAfterStep | strategy 常量 + per-model override | 无 | 简化 |
| 摘要 maxOutputSize 128K 封顶 | 有 | 无 | 简化 |
| continuation / todos / onEvent / onWillCompact | 内部服务直读（todo/telemetry/hooks） | 工厂 props 端口 | 人为设计 |
| config 节 / env 绑定 | 无 | 无 | 已对齐 |
| 默认启用 | DI `registerScopedService(OnScopeCreated)` 恒在 | 工厂不进 preset，宿主显式挂载 | 人为设计（工厂形态横切约定） |

## 工具 / 事件 / facade 面差异
- 无 agent 工具（两侧一致）。
- facade：v2 `IAgentFullCompactionService` —— `compacting: FullCompactionTask | null`（含 tokenCount/traceId/promise）、`begin({source,instruction?}): boolean`、`cancel()`、`hooks.onWillCompact`、`onDidFinishCompaction` 事件。harness-core `CompactionRef` —— `compact(instruction?): Promise<{ branchId }>`（manual；busy/unknown-agent 抛 CompactError）、`cancel()`、`status(): { phase, reason?, startedAt? }`。phase 词表：v2 `idle|running|cancelled|completed`（durable 态）；harness-core `idle|quiescing|summarizing|switching|completed|cancelled`（机器态，比 human 蓝本少 `resuming`）。
- 事件对照：v2 `compaction.started{trigger,instruction}` → harness-core 机器 `compaction.started{reason,instruction}`（同形，术语不同）；v2 `compaction.blocked{turnId}`（step 等压缩时发）→ harness-core 同名事件（启动时 agent 非 idle 即发，时机不同）；v2 `compaction.completed{result 全量}` → harness-core 机器 `compaction.completed{branchId,stats,durationMs,originTurnId,summary 遥测}` + journal `compaction.completed{agentId,branch}`；v2 `compaction.cancelled` 无载荷 → harness-core 带 `cause/error/durationMs/originTurnId/tokensBefore`（信息更多）。
- feature-http：`POST /sessions/{id}:compact`（body `{instruction?}`；facade 缺席 40910、coded error 409 → ErrorCode.COMPACTION_UNABLE）；`status` 路由的 `compacting` 位由 `CompactionRef.status()` 供给（route-features/status.ts:97）。ACP `/compact`（busy 文案 "A context compaction is already running."）。

## 摘要
总体对齐程度中等：核心骨架（quiesce→summarize→switch 三段、keep 选择算法 20K/2K 与 elision 文案、两份 md 逐字节、预算触发阈值 0.85、overflow 3 次上限）与 v2 同构，但运行时语义差异显著。最重要的三个差异：① 超预算/overflow 后当前 turn 必死且不自动续跑（v2 是 block 等待后原地续跑 + retry），叠加「宿主重挂」范式在仓内无一消费方落实，成功后 agent 滞留 paused、内存历史仍是旧分支——compact 在 example/HTTP/ACP 三条现成路径上都不可端到端使用；② Context Recovery footer 未迁而 instruction.md 仍承诺 recovery pointer，文案与实现不一致（271 第 2 轮已在案）；③ 摘要请求保真度降级（无 truncated 拒收、无 credential recovery、尝试上限 5→3、无动态工具上下文剥离）。最需关注的缺口是续跑/重挂链路的消费方落实，其次是 telemetry 批次补回与 keep 过滤对 origin.kind 的细粒度对齐。
