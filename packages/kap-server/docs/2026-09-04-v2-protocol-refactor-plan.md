# kap-server 统一 WS 消息协议重构计划

> 协议设计稿：code-app 仓 `docs/designs/2026-09-02-sdk-message-protocol.md`（1–15 章 + §16 修订记录）。
> 验收基准：code-app 仓 `docs/designs/2026-09-02-sdk-message-protocol-examples.html`（24 个场景实例，全部消息是 wire 形状的逐字节正本）。
> 客户端侧参照：code-app 仓 `docs/plans/2026-09-03-code-app-ws-v2-refactor-plan.md`（客户端重构计划，其 P0/P1 已完成：
> `packages/app-core/src/ws2/messages/` 的 zod schema 初版、mock server、恢复矩阵测试）。

## 1. 背景与目标

现行 wire 协议由四套并存的消息体系组成：51 型 agent 帧、19 型 `event.*` 帧、2 型 transcript 帧（`transcript.reset` / `transcript.ops`）、13+ 型控制帧（`subscribe` / `subscribe_v2` / cursors / journal 序号 / `resync_required` / volatile 标记）。同一事实最多有三个真相源（agent 帧、event 帧、transcript ops），同一改动要改多处，客户端还要为 transcript 包维护一套 op apply 层。

目标：按设计稿把 wire 收敛为一套**扁平自包含实体消息**——每个实体（turn / step / user / assistant / thinking / tool_call / system / interaction / task / todo / session.state / session / workspace / config 等）带 `state`/`status` 字段表达生命周期，内容恒为累积全量，delta 族可丢，恢复 = REST 历史 + in-flight step 回放 + 状态实体全量重发。kap-server 侧单一投影产出全部消息，zod schema 单一正本，旧四套整体退役。

非目标：操作类 REST（prompt 提交、审批应答、中断、配置写入等）的契约不变——操作的效果只经消息流下发，但操作入口本身不在本次重构范围；终端（terminal）通道维持死协议现状，不重接。

## 2. 现状盘点（勘察结论，含文件与行号）

**帧生产链**：agent-core-v2 的 App 级 `IEventService` 与 Agent 级 `IEventBus` 双总线 → `SessionEventBroadcaster`（`src/transport/ws/sessionEventBroadcaster.ts`）内联投影 → 51 型 agent 帧（`src/protocol/events-zod.ts:1049-1108` 的 45 型 + 6 型透传：`context.spliced` / `plan.revision` / `prompt.queued` / `prompt.started` / `task.notified` / `turn.steer`）；19 型 `event.*`（zod 内 13 型 + 动态构造的 5 型 interaction 帧（`sessionEventBroadcaster.ts:1217-1285`）+ `event.fs.changed`）。transcript 链：`TranscriptService` + `AgentTranscriptProjector`（`src/services/transcript/coreEventMap.ts`）→ `@moonshot-ai/transcript` 的 14 种 ops，per-agent op journal（容量 2000，纯内存）。

**两套持久化**（统一后只留一套）：

- `wire.jsonl`（`<home>/sessions/{ws}/{sid}/agents/{aid}/wire.jsonl`）：领域事件日志，冷重建的唯一事实源（`TranscriptService.readColdSnapshot`、`routes/messages.ts` 的 `/sessions/{id}/messages`）。**保留**，作为 REST 历史的来源。
- WS 事件 journal（`<home>/server/events/{sid}.jsonl` + `__global__.jsonl`）：WS 帧信封日志，仅供 `getBufferedSince` 断线回放（`src/transport/ws/sessionEventJournal.ts`）。**整体退役**。

**恢复现状**：`GET /sessions/{id}/snapshot`（`as_of_seq` + 尾 100 条 + `in_flight_turn`）+ `getBufferedSince` 游标回放 + `transcript_since` ops 重放三条并存；in-flight 只覆盖 main agent 的文本累积与 running_tools（`InFlightTurnTracker`）。统一后由 §9 语义整体替换：无游标、无序号、无 replay 标记。

**schema 分布**：kap-server `src/protocol/`（`ws-control.ts` 控制帧全 zod、`events-zod.ts` 手写 58 型、各域 `rest-*.ts`）；code-app `packages/app-core/src/api/kap-server/schema/` 手抄 18 文件 + `frameManifest.ts`（含 kap-server 缺 zod 的 11 型）。设计稿协议的 schema 初版已在 code-app `packages/app-core/src/ws2/messages/` 落地并被 mock server 与客户端消费——本计划的 P0 把它**迁回 kap-server 作为唯一正本**，消灭手抄。

**session.state 事实源全部现成**：`ISessionActivityView`（busy / main_turn_active / pending_interaction / last_turn_reason）、`IAgentProfileService` + `ISessionUsageService` + `ISessionTokenCountingService`（model / usage / context_tokens）、`IAgentActivityView`（phase 及其 turn/step/since）、`IAgentPermissionModeService`（permission）、`IAgentGoalService`（goal）、`IAgentPlanService` 与 swarm/tower features（modes）、`listSessionPendingInteractions`（pending 审批/提问）、`IAgentTaskService`（task）、`ISessionMetadata`（title）。

## 3. 目标架构

```
agent-core-v2 Event2 总线（App + Agent 两级）
        │
        ▼
┌─────────────────────┐     ┌──────────────────────┐
│  规范化投影层        │ ──► │  WS v2 在线连接扇出    │ ──► 客户端
│  （唯一投影）        │     └──────────────────────┘
│  持有：              │
│   in-flight 累积     │ ◄── 回放合成（设计稿 §9.2）
│   状态实体当前值      │ ◄── 全量重发（§9.2）
└─────────────────────┘
        │ 引擎自身持久化
        ▼
wire.jsonl ──► 冷重建（REST /sessions/{id}/history，内部实现细节）
```

- **单一投影**：引擎事件只进一个投影层（`src/services/v2Projection/`），产出的只有新协议消息。没有第二份翻译、没有 suppression 表。引擎新事件类型若未接入：default 分支打 telemetry 并显式丢弃，绝不透传。
- **投影层状态是直播的副产品**：为发出 `assistant` / `tool_call` 全量消息必须持有当前累积内容；回放只是把这些内容对新连接再发一遍（设计稿 §9.6，服务端对恢复无状态——没有 op journal、没有事件窗口、没有逐客户端游标）。
- **schema 单源**：`src/protocol/v2/`（P0 从 code-app 迁入）为唯一正本。每条出站消息经 schema 校验（失败 = 服务端 bug，打 telemetry 并丢弃，绝不放行契约外消息）；AsyncAPI 由同一份生成；code-app 经 workspace 直接 import（与现行 `@moonshot-ai/transcript` 的共享方式相同）。
- **冷重建降级为内部实现**：transcript 包的 `groupTurns` / `foldFacts` 可继续用于 REST 历史，但它不再是协议概念——wire 上没有 ops，客户端不知道它的存在。

## 4. 阶段计划

### P0：协议 schema 单源 `src/protocol/v2/`

把 code-app `packages/app-core/src/ws2/messages/`（15 个文件，zod object + type 双导出，`ServerMessage` 可辨识联合 25 型 + `ClientMessage` + `parseServerMessage` + `ContractViolation`）迁入 `packages/kap-server/src/protocol/v2/messages/`。逐字节不另起炉灶；kap-server comment-free 纪律下，迁入时剥掉全部注释。

- code-app 侧：`app-core/src/ws2/messages/` 改为 `export * from '@moonshot-ai/kap-server/protocol/v2'` 的 re-export（workspace 依赖，与 `@moonshot-ai/transcript` 同模式）， kap-server 的 `package.json` exports 增加 `./protocol/v2` 子路径。迁移完成后删除 code-app 的实体定义，**全仓只此一份**。
- `parseServerMessage` 的服务端用法：出站 `safeParse` 校验 + 失败 telemetry 丢弃（`outboundGuard`）。
- 实例对拍：code-app 的 `pnpm validate:examples`（schema × 24 tab 实例 HTML，869 条消息）迁入本仓 CI 等价物，实例 HTML 仍由 code-app 持有时，用其 fixtures JSON（`scripts/mock-ws-server/fixtures/examples.json`）做输入；防漂移检查挂两仓各自 CI。
- AsyncAPI：由 `clientControlOperations` / `serverSystemOperations` 的既有生成路径改为从 `protocol/v2` 生成（`src/protocol/asyncapi.ts`）。

**验收**：`pnpm validate:examples` 在两仓全绿；code-app 侧 `ws2/messages` 只剩 re-export；`pnpm lint`（含 no-comments 检查）通过。

### P1：规范化投影层 `src/services/v2Projection/`

Event2 → `ServerMessage` 的唯一投影。按 Agent scope 的会话逐会话持有：

- **InFlightAccumulator**：当前 in-flight turn/step 的累积态——assistant/thinking 累积文本、tool_call 的 `input_text` 累积 / `input` / `output` / 最新 `progress`、step 的 `retry` 最近值。输入为流式事件（`assistant.delta` / `thinking.delta` / `tool.call.delta` / `tool.progress`），输出为全量实体消息。
- **StateEntities**：pending interactions、running tasks、最新 todo、排队中 user（`prompt.submitted` 尚未绑定 turn 的）、最新 session.state 快照——回放时逐一全量重发（§9.2）。
- **SessionStateComposer**：session.state 唯一聚合点，从 §2 的事实源直读，任何相关域变更发全量快照；累计字段纪律（读最新，不跨消息求和）。
- **事件映射**：见 §5 映射总表。用户消息与 turn 的绑定遵守「`user_message_id` 只盖在 turn 首批消息」规则；steer/cron/task 完成在 busy 时注入当前 turn 不开新 turn（设计稿 16.4）。
- **todo 规则**：由 TodoWrite tool_call 驱动（`tools.update_store` → todo 消息全量覆盖）；todo 不落盘，REST 由最后一个 TodoWrite done 的 input 还原（设计稿 16.2）。

**验收**：单测以事件序列驱动（fake Event2 总线），断言产出的消息序列与 code-app 24 个实例 fixture 逐 tab 一致（basic / tool / multi-tool / approval / question / todo / queue-abort / injection 等可由引擎事件直接合成的场景全对拍）；schema 校验 0 违规。

### P2：REST 历史 `GET /api/v1/sessions/{id}/history`

wire.jsonl 冷重建 → 按时间排序的实体消息载荷列表（与 WS 同型同 schema），游标 `before_turn` / `after_step` / `page_size`（`before_turn` 往旧翻、`after_step` 补新），响应同时回传 `in_flight?: { turn_id, step_id }`。落盘边界 = step 边界（§9.4）：已完成 turn/step 及其内容进历史；user 创建即落盘；assistant/thinking 完成即落盘；tool_call 终态落盘；system 创建即完整落盘；interaction 终态落盘；todo 不单独落盘（由 TodoWrite done 的 input 还原）。

实现路径：复用 `TranscriptService.readColdSnapshot` 的 wire 读取与 undo/clear/steer 折叠（`src/services/transcript/wireRecords.ts` + `reduceContextTranscript`），出口改为协议实体投影（与 P1 共用实体构造代码，或经投影层对 wire 记录重放）；分页用 keyset（turn/step id 即游标，语义明确，不再有 `hasMoreOlder` / `has_more_older` / `has_more` 三名并存）。

**验收**：对 fixture 的 REST section 逐 tab deep-equal（含 recovery tab 的 A/B 两个变体）；`has_more` / `in_flight` 语义与实例一致；大会话（十万行 wire）冷重建在预算内完成（给出实测数）。

### P3：WS v2 传输 `transport/ws/v2/`

新端点 `/api/v2/ws`（v1 原样保留到 P6）。鉴权复用 `Sec-WebSocket-Protocol` bearer（`transport/ws/bearerProtocol.ts`）。

- **握手**：连接即 `hello { protocol_version: 2, server_id, capabilities: ['step_replay_v1','interaction_v1','subagent_channel_v1'] }`；`subscribe { id, session_id, agent_id?, omit? }` → `ack { id, code }`（code 复用 REST 的 ErrorCode 枚举，消灭现行 ack 魔法数字 1）；`unsubscribe` 对称；协议级 `error` 帧；心跳用 WS 协议层 ping/pong（库自带，删除应用层 nonce 帧）。
- **恢复载荷合成**（§9.2，与 P1 状态天然同源）：in-flight turn 封面 → step → 该 step 内容实体（assistant/thinking 取当前 `streaming` 全量、tool_call 取当前状态）→ 状态实体（pending interaction、running task、最新 todo、尚无 turn 的 running user、最新 session.state）。无 replay 标记，恢复与直播同一序列（§8 会话序列化：恢复排进同一会话序列，通常无缝隙无重叠；客户端幂等覆盖兜底）。
- **omit**：按消息 type 精确屏蔽下行（订阅参数而非协议分档）。
- **背压**：每连接有界出站队列，溢出即以 `error { code: 'backpressure_overflow' }` 断开该连接——慢客户端的代价是一次 §9 恢复，系统内存安全不受影响。删除现行的 bufferedAmount 延迟强发与 delta 合批逻辑（delta 可丢由类型决定，不再有合批）。
- **子代理通道**：`subscribe` 带 `agent_id` 时按同一条恢复+直播路径下发该 agent 的消息流；主通道不含子代理消息（`agent_id` 即过滤，不再有 `agent_filter` / side-channel 重发）。
- **全局消息**（workspace / config / 通知型 / session 索引变更）按现 `addGlobalTarget` 等价物扇出到全连接。

**验收**：对 code-app `scripts/mock-ws-server/verify.mjs` 的等价客户端测试全过（hello/ack/omit/backpressure/子通道/恢复载荷逐字节对拍 fixture oracle）；断线重连无重复实体（幂等）；`--debug-endpoints` 下可观测每连接队列深度。

### P4：全消息面覆盖

按域收口，逐域对照实例 fixture（24 tab 全量）：

- session.state 全字段（goal / modes / last_turn_reason / pending_interaction / usage by_model+current_turn+total / context_tokens）；`session` 索引消息（created / updated（自动标题）/ archived / deleted）。
- workspace 三 subtype；config 全量 + `changed_fields`；`config.warning`；通知型三类（model_catalog / plugin / capability，客户端 REST 重拉，除这三类外不允许通知型消息）。
- system 各 subtype：compaction（before/after tokens + summarized_through_turn）、undo（undo_turn_id）、clear、goal、plan.enter / plan.exit / plan.revision、swarm.enter / swarm.exit、skill、notice、hook、interruption（reason + turn_id）。
- cron：`user { origin: { kind: 'cron', cron_id, schedule } }`；忙时 = 系统发起的 steer（`steered_at`）。
- sideChat：`turn { origin: { kind: 'side' } }`，`main_turn_active: false` 不打断主对话。
- attachment：turn/user 的 `attachment_ids`。

**验收**：24 tab 全部端到端对拍（真实引擎驱动 kap-server，code-app 客户端对 mock 同一套 fixtures 已验证的渲染路径直接复跑）；子通道展开/收起流量断言（主通道无子代理消息泄漏）。

### P5：双跑灰度与对拍

- v2 与 v1 并存期：同一连接可同时持有 v1 订阅（旧客户端）与 v2 订阅（新客户端）；服务端两套投影并行，资源开销实测登记。
- 对拍：code-app 的 24 个实例 fixture 由真实 kap-server 回放生成一次（录制脚本），与手写 fixture deep-equal——防止实例与实现互相迁就。
- 冒烟：code-app desktop（内嵌 server）+ web（daemon）双端：会话创建 → 发送 → 工具 → 审批 → 刷新 → 中断 → 恢复。

**验收**：录制回放对拍全绿；双端冒烟无阻塞性缺陷；v1 客户端行为零回归（kap-server 自身 v1 测试套件全绿）。

### P6：旧协议死亡清单

逐项勾销（每项删除后 `pnpm lint && pnpm test` 全绿才勾）：

| 旧物 | 去向 |
| --- | --- |
| 51 型 agent 帧（events-zod 45 型 + 6 透传） | 塌缩进实体消息（生命周期进 `state` 字段） |
| 19 型 `event.*` 帧 | 会话级进 `session.state` / `session`；全局进 `workspace` / `config` / 通知型 |
| `transcript.reset` / `transcript.ops`、`subscribe_v2` 与 transcript grades | 删除；恢复走 §9 |
| `subscribe` / `unsubscribe`（v1）、`client_hello` 的 cursors / agent_filter | 统一为 v2 `subscribe(session_id, agent_id?, omit?)` |
| 会话 journal + seq/epoch、transcript op journal + per-agent seq、`getBufferedSince`、`resync_required` | 全部删除；恢复不依赖任何序号 |
| `volatile` 标志 | 删除；delta 族天然即可丢，由类型决定 |
| WS 事件 journal（`<home>/server/events/*.jsonl` + `__global__`） | 删除（文件与读写代码） |
| 应用层 ping/pong（nonce 帧） | 删除；用 WS 协议层心跳 |
| 终端帧 `terminal_*`、`abort`（WS 侧） | 现状即死协议，删除（terminal 未来若做，见开放问题） |
| `InFlightTurnTracker` / `SubagentRosterTracker` / snapshot 的 `in_flight_turn` 组装 | 由投影层 in-flight 累积取代 |
| code-app 手抄 18 个 schema 文件 + `frameManifest.ts` | 删除；import 同一份 schema（code-app 侧同步勾销） |
| `TRANSCRIPT_PROJECTED_EVENT_TYPES` / `suppressedByTranscript` | 删除；无第二通道即无抑制 |
| delta 合批（`coalesceFrames`）与 bufferedAmount 延迟强发 | 删除；delta 可丢 + 有界队列背压取代 |

## 5. 事件 → 消息映射总表

| agent-core-v2 事件（§2 来源） | 产出消息 |
| --- | --- |
| `turn.prompt`（durable） | `user { status: 'running', origin? }`（cron/hook 等由 `PromptOrigin` 映射） |
| `prompt.submitted / queued / started / completed` | `user` 状态翻转（`finished_at`；排队 = running 且尚无 turn 可推导） |
| `turn.started` | `turn { state: 'running', origin, user_message_id?（首批盖章） }` |
| `turn.steer` | `user { steered_at }`（注入当前 turn） |
| `turn.cancel / turn.ended` | `turn { state: 'completed' }`；取消由 `system(interruption)` 表达；失败在 step |
| `turn.step.started / completed / interrupted / retrying` | `step` 全量（usage / finish_reason / retry / end_reason / end_message） |
| `assistant.delta / thinking.delta` | 累积后 `assistant/thinking { status: 'streaming', text: 全量 }` + 可丢 `*.delta` |
| `tool.call.started / tool.call.delta / tool.progress / tool.result` | `tool_call` 全量（state / input / input_text / progress / output / error）+ 可丢 `tool_call.delta` / `tool.progress` |
| `interaction.request / interaction.resolved` | `interaction { state: pending → 终态, request, response }` |
| `task.started / terminated / notified` | `task` 全量（kind / state / detached / output_tail / result_summary） |
| `subagent.spawned / started / suspended / completed / failed` | `task { kind: 'subagent', child_agent_id }` + 子通道消息流 |
| `tools.update_store`（todo） | `todo` 全量覆盖 |
| `compaction.started / completed / blocked / cancelled` | `system(compaction)` + session.state 的 context_tokens 刷新 |
| `context.undo / context.undone / context.clear` | `system(undo { undo_turn_id })` / `system(clear)` |
| `goal.updated / goal.clear` | session.state.goal + `system(goal)`（状态变更） |
| `plan_mode.enter / cancel / exit / plan.revision` | `system(plan.*)` + session.state.modes.plan |
| `cron.fired` | `user { origin: { kind: 'cron', cron_id, schedule } }`（忙时 = steer，`steered_at`） |
| `agent.activity.updated / agent.status.updated` 聚合域 | `session.state` 全量快照（phase / model / usage / permission / modes / goal） |
| `session.meta.updated` / `event.session.*` | `session { subtype: created/updated/archived/deleted }` |
| `event.workspace.*` | `workspace { subtype }` |
| `event.config.changed / event.config.warning` | `config { changed_fields }` / `config.warning` |
| `event.model_catalog.changed / event.plugin.changed / event.capability.changed` | 通知型 `model_catalog` / `plugin` / `capability` |
| `hook.result / skill.activated / plugin_command.activated` | `system(hook)` / `system(skill)` / `system(notice)`（按语义归位） |
| `shell.started / output / completed` | `tool_call`（Bash 系输出并入 output_tail/progress） |
| `event.fs.changed` | 不进 v2 主协议（fs watch 是独立订阅面，P6 前维持现状或随 `watch_fs_*` 一并退役——见开放问题） |

## 6. 关键设计决策（实现时不得漂移）

- **实体 id 规则**：`turn_id = t{N}`（会话内单调）；`step_id = {turn_id}.{ordinal}`；`message_id = {step_id}.u{N} / .a{N} / .h{N}`（user 可 turn 级 `{turn_id}.u0`）；`tool_call_id` / `interaction_id` / `task_id` / `todo_id` / `system_id` 由投影层统一分配。客户端 replace-by-id 依赖这些 id 的稳定唯一性（含 agent 命名空间隔离：实体身份 = `agent_id` + type + id）。
- **累积全量生产**：投影层持有 in-flight 累积；任何实体状态变更发**全量**实体（不是 patch）；delta 族仅作逐字渲染优化并行发送（可丢：客户端没占位就丢，下一条全量自愈）。
- **user 两态与绑定**：`status: 'running' | 'completed'` 只表达「有没有被消费」；排队 = running 且尚无 turn 可推导；`created_at` / `finished_at` / `steered_at` 三时间戳；`turn.user_message_id` 只盖在 turn 产出的首批消息上。
- **turn 两态**：`state: 'running' | 'completed'`，无 error 字段；取消由 `system(interruption)` 表达，失败在 step（`step.state: 'failed'` + `end_reason` / `end_message`）或 tool_call（`state: 'error'`）。
- **落盘边界 = step 边界**：REST 含已完成 step（及其内容），回放含未完成 step；step 进行中的部分落盘（assistant 文本、完成的 tool 结果）允许 REST 与回放轻微重叠，幂等覆盖，不处理。
- **session.state 聚合**：服务端唯一聚合点，客户端不做任何跨消息推理（这是消灭「三源合并」的落点）；每次变更发全量；`usage` / `context_tokens` 为截至当前的累计值或当前值，读最新一条，不跨消息求和。
- **回放无状态**：恢复数据 = wire.jsonl（REST）+ 投影层直播副产品（in-flight 累积、状态实体当前值）；没有第三种存储。服务端重启 = 所有客户端重连 = 走一遍 §9.3，天然正确。
- **出站纪律**：每条消息过 schema；失败打 telemetry 丢弃；绝不放行契约外消息，绝不透传未接入投影的引擎事件。
- **写路径不动**：操作类 REST 契约不变；操作效果只经消息流下发（「触发事件 event.xxx」的说法整体消亡——客户端等的是对应的实体消息）。

## 7. 工程约束（本仓纪律）

- `packages/kap-server`（与 agent-core-v2、transcript）是 comment-free zone：迁入与新增代码零注释（lint 豁免指令除外），由 `scripts/check-no-comments.mjs` 强制。
- REST 走 `middleware/defineRoute` 声明式注册（zod 请求/响应 + ErrorCode 映射），不走手写 reply。
- 测试向既有测试文件聚拢（每域一个测试文件），事件驱动用 fake Event2 总线而非真实引擎拉起全 DI。
- 变更落地按 `gen-changesets` skill 生成 changeset（默认 `minor`，major 需用户确认）。
- 全程不做旧服务端兼容逻辑：v1 在 P6 前共存于独立端点，新协议不按旧客户端降级。

## 8. 风险与开放点

- **schema 包归属**：P0 放 `src/protocol/v2/`（kap-server 内）；若后续 klient / 其他消费方增多，可上移独立协议包——但无论在哪，严禁第二份手抄。
- **fs watch**：`event.fs.changed` + `watch_fs_*` 是独立订阅面，是否并入 v2（workspace 域或独立通道）未定，P6 前维持现状。
- **终端**：`terminal_*` 帧已死；未来若做终端，按开放问题单独设计（不复用旧帧）。
- **大会话冷重建成本**：wire.jsonl 全量重放的 REST 成本需要 P2 实测；超预算时引入分页投影缓存（内部实现，不进协议）。
- **多 tab 并存**：同会话多连接各自收到同一份恢复载荷（§9 无差异），P3 测试覆盖。

## 9. P1 落地备忘（实现口径，后续阶段不得漂移）

- **事件源二分**：observable 事件经 Agent 级 `IEventBus` 直达投影层；durable-only 域不走总线——审批走 observable 的 `permission.approval.requested/resolved`（与工具事件同通道、时序确定），question 走 sessionInteractions 枢纽（投影器暴露 `applyInteractionPending/Resolved` 直接方法），todo 走 `tools.update_store`（live 绑定时可用 `IAgentTodoService.onDidChange` 等价驱动），interaction.request/resolved、plan_mode.*、goal.*、context.* 等 durable 记录是 P2 冷重建的来源。
- **steer 标记**：引擎 `prompt.submitted` 新增可选 `steer: true`（submitSteer 路径，agent-core-v2 `promptService`）。投影层对 steer 提交保持悬挂（不发排队帧），`prompt.steered` 到达时直接把 user 落进当前 turn（`{turn}.u{N}` + `steered_at`）；排队提交照旧立即上时间线（预测 turn id `t{maxTurn+queueLen+1}`）。
- **id 分配**：turn `t{N}`（引擎 turnId+1）、step `{turn}.{step}`、文本 `{step}.a{N}`/`.h{N}`（每 step 各起）、user `{turn}.u{N}`（每 turn 起）、system/todo 投影器分配 `m_{NN}`/`td_{NN}`（类型前缀+两位序号，会话内单调，REST 冷重建按同规则重放保证一致）；tool_call/interaction/task 用引擎 id 透传。`approval_id` 在 interaction pending 后回链 tool_call 重发帧（同时间戳），并保留到终态帧。
- **usage 口径**：turn 完成帧 `input_tokens = Σ step.input_other`、`output_tokens = Σ step.output`，不发 `cached_tokens`；step 帧 usage 四字段（input_other/output/input_cache_read/input_cache_creation）；session.state.usage 读最新快照不求和。
- **流式文本**：占位帧（`status: streaming, text: ''`）与首个 delta 同帧时间；终态全量帧与下一事件同帧时间；空 delta 只开占位不发 delta 帧（`announced` 标记）；retry 重置在流文本但 message_id 不变（textSeq 不回退）；kind 切换/工具事件/step 收官都会关闭在流文本。
- **时间戳纪律**：同一引擎事件产出的全部消息共享事件时间；`started_at` = 实体首帧时间、`ended_at`/`finished_at` = 终态帧时间；实例 fixture 已按此归一化（code-app `scripts/mock-ws-server/normalize-examples.mjs`，含 phase.since 真实 epoch 修正），HTML 为唯一来源、examples.json 为抽取产物、kap-server test/fixtures/v2-examples.json 为 vendor 副本。
- **tool.result**：error 与 output 互斥（error 帧不带 output）；done 帧清掉残留的 progress。
- **已知引擎落差**：`turn.step.interrupted` 引擎 payload 无 usage——已按引擎真相结案（fixture 移除该字段，投影层仅在有值时映射）。

## 10. P2–P4 落地备忘

- **REST 排序**：turn 组（turn 序）→ 组内 turn 封面（仅已结束 turn）→ step 组（step 序：step 封面〔仅已完成〕→ 组内容 wire 序）；turn 级 user（含 steer）挂产生时的 step 组、紧跟封面后。在飞 turn 无封面但其已完成 step 组照常进历史、user 保持 running，`in_flight { turn_id, step_id }` 取最近 step.begin。keyset：`before_turn` 往旧、`after_step` 补尾、默认最新 `page_size` 个 turn 组。
- **冷折叠**：undo 不删实体（只出 system(undo) marker）；clear/compaction 为 floor（floor 前折叠出默认页、has_more 标记、compaction marker 置顶，`summarized_through_turn` 由当前 turn 序推导）；llm-retry 的失败尝试折叠（同 ordinal step.begin 复兴、started_at 保留首次、正文只留重试后）；REST 不含 todo 实体（恢复载荷的状态实体）。封面帧 `timestamp = 终态记录 time + 5ms`、user `finished_at = prompt.completed/aborted`、文本 ts = 最后 content.part、tool_call ts = result、interaction ts = resolved。10 万行 wire 冷重建 ~240ms。
- **恢复载荷**（`AgentV2Projector.recoveryEntities`）：在飞 turn 封面 → 当前 step → 在流实体全量（累积 streaming）→ pending interactions → running tasks → 最新 todo → **仅 queued 态 running user**（在飞 turn 的开场 user 不进恢复）→ 重 compose 的 session.state。恢复与直播同一序列、无 replay 标记；`endedAt` 与帧 ts 解耦（断线期间收官、补发时刻重发）。`SessionStateComposer.hasFacts()` 决定空恢复不发 state。
- **传输**：`/api/v2/ws` 与 v1 并存；hello 即恢复（无游标协商）；ack.code 用 ErrorCode 枚举；hello capabilities 以 fixture 为准（`step_replay_v1` + `interaction_v1`）；有界出站队列（容量 256 / in-flight 64）溢出即 `backpressure_overflow` 断开；心跳用 ws 协议层 ping/pong；每帧过 schema（outboundGuard）。binder facts 合批（同微任务多 patch 只 compose 一次）且不冲刷在流文本（`applyFacts(patch, time, flushTexts=false)`）。
- **全局扇出**：App 级 `IEventService` → session 索引帧（meta.updated 全量 SessionInfo + changed_fields、created/archived；无 deleted 事件）、workspace 三 subtype（复用 toWireWorkspace）、config 脱敏全量 + changed_fields（脱敏在发布源头 toConfigResponse）、config.warning、model_catalog/plugin/capability 薄通知（客户端 REST 重拉）。未订阅连接也收全局帧。turn_count 取 live 投影器 maxTurnId+1。
- **system subtype 全谱**：compaction / undo / clear / goal / plan.enter / plan.exit / plan.revision / swarm.enter / swarm.exit / skill / notice / hook / interruption，id 统一 `m_{NN}`。
- **引擎侧已补**：`prompt.submitted.steer`（submitSteer 标记）、`plan.revision.summary`（首个 markdown 标题）；`cron.fired` 无 promptId——投影层内部合成绑定（按 origin 关联），不改引擎。
