# M：主对话消息流迁移到 transcript 协议（设计文档）

日期：2026-08-19 ｜ 状态：待评审 ｜ 关联：#256、#257、#260、#3005、`HANDOFF-subagent-badge.md`

## 1. 背景与动机

主对话消息流目前走 **客户端自投影** 产线：daemon 广播原始 agent-core 事件（`session_event` 帧）→ `frameClassifier` 分流 → `agentEventProjector`（每会话投影成 AppEvent）→ `eventReducer` 落进 `KimiClientState` → `messagesToTurns` 出 ChatTurn。

这套产线是 #256 那 26+ 轮 review 反复修补的地方，也是遗留 7 条边界评论（事件重放/乱序/重绑）的宿主。问题的结构性根源是：**同一份事实在服务端和客户端各投影了一次**，客户端版本必须在重连重放、乱序、新旧 daemon 混部下保持与服务等价——这个不变量本质上无法经济地维持。

与此同时，**transcript 协议已经存在且经过生产验证**（子代理详情面板在用）：服务端把同一批事件投影为权威的 per-agent transcript（`coreEventMap.ts`），客户端通过 `transcript.reset`/`transcript.ops` 消费，乱序、重放、缺口由 seq 水位与 REST 补页机制处理。并且服务端已铺好迁移缝：**连接一旦带 transcript grade 订阅，即按连接×agent 抑制被 transcript 覆盖的 `session_event` 类型**（`sessionEventBroadcaster.ts` 的 `TRANSCRIPT_PROJECTED_EVENT_TYPES`）。

**目标**：主对话的消息渲染改由 transcript 协议驱动，客户端自投影产线整体退役（或退化为非消息切片的最小集），消除双投影。

## 2. 现状盘点（事实，均有代码证据）

### 2.1 服务端 transcript 投影覆盖（kimi-code/packages/kap-server/src/services/transcript/）

`AgentTranscriptProjector.map()`（`coreEventMap.ts:206-295`）产出：turn/step 头（`turn.upsert`/`step.upsert`）、text/thinking/tool 三种帧（`frame.upsert` + `append`）、marker、`task.upsert` 与 taskref、`interaction.upsert`、`prompt.upsert`、`todo.upsert`、`meta.merge`。

| 内容 | 进 transcript？ | 证据与备注 |
|---|---|---|
| 用户消息（turn.prompt） | ✅ 进 TurnHeader.prompt | `coreEventMap.ts:299-318`；~~live 路径不写 attachmentIds~~ **已修复（#3088）**：`turn.started` 携带 `promptAttachments`，live 投影产出附件实体 |
| thinking / assistant delta | ✅ `append` op（带 offset），边界处 `frame.upsert` 收敛 | `:564-569, :617-634` |
| 工具调用（含参数流） | ✅ 帧累积 inputText 整帧 upsert | `:671-704` |
| 审批/问答 | ✅ 但**不经 bus 事件**，走 `ISessionInteractionService` 桥，产出全局 `interaction.upsert` 实体 | `coreBinding.ts:284-315, coreEventMap.ts:1346-1393` |
| 后台任务完成通知（task.notified） | ✅ turn 进行中作为 role:'user' text 帧；无 open step 时丢弃 | `:816-840` |
| goal | ✅ `meta.merge{goal}` + marker；~~清除 goal 是已知限制~~ **已修复（#3088，`goal:null` 全链路清除）** | `:1092-1123` |
| plan 模式 | ✅ 徽章（agent.status 切片）+ `plan.revision` marker | `:1125-1153, :1223-1232` |
| compaction / cron | ✅ marker | `:273-287` |
| usage | ✅ step 头 → 汇总进 turn 头 | `:441-461, :376-395` |
| session.meta / 会话级聚合事件 | ❌ 不进（非 per-agent） | 无对应 case |

### 2.2 transcript 协议机制

- 订阅：`subscribe_v2` 控制帧带 per-agent grade（off/turn/block/delta）+ 可选 `transcript_since` 游标（`ws-control.ts:170-200`）。**详情面板现行以 delta grade 订阅**（`packages/app-core/src/api/daemon/ws.ts:696-710` 固定）。
- **~~现行 WS 限制（迁移前置项）~~ ✅ 已完成（随本 PR 合入）**：`DaemonEventSocket` 现按 session 保存 agent map（`ws.ts`），多 agent 并发订阅共存——主流（main agent）与详情面板（子代理）同会话同时在线；每次 `subscribe_v2` 携带全量 agent 集合（服务端整组替换语义），重连时各 agent 水位随 `transcript_since` 重放；详情面板切换时显式摘除旧 agent。
- 基线：reset 为 items-empty（只带全局态 + 水位 seq + `has_more_older`）；历史经 REST `GET /sessions/{id}/transcript?before_turn/page_size` 翻页（客户端封装 `packages/app-core/src/api/daemon/transcript.ts:14-37`）。
- 缺口恢复：`GET .../transcript/ops?since_seq=N` 点对点补（`complete:false` → 全量 refresh）；或带游标重订阅由服务端 replay。
- 客户端 `TranscriptChannel`（app-core/transcript/channel.ts）：`refresh`（REST 首页 + 途中 ops 缓冲）、`applyOps`（旧 seq 丢弃、跳号/append 缺口 → onGap）、`loadOlder`（翻页去重合并）。**注意：channel 只有 onChange/onGap 两个回调，没有 `onEmptyReset`**（#257 的 R5 讨论的是池层的等价物）。
- 抑制缝：连接带 grade 后，`TRANSCRIPT_PROJECTED_EVENT_TYPES` 内的 session_event 在该连接×agent 上被抑制（服务端既存机制）。

### 2.3 客户端两条 turn 产线差距

`auxiliaryTranscriptToTurns`（254 行）把 transcript turn item 合成 AppMessage 后**委托 `messagesToTurns`**，但恒传空 approvals/plans（`:42`）。

| 特性 | 主流（messagesToTurns） | transcript 产线现状 | 缺口对策（见 §4） |
|---|---|---|---|
| thinking / 工具卡 / 媒体（ReadMediaFile） | ✅ | ✅ 基本具备 | — |
| 用户消息媒体附件 | ✅ | ✅（S1 已修复，live 附件随 #3088 进 transcript） | — |
| 通知卡（后台任务完成） | ✅ | ✅（taskId text 帧 → TaskNotification） | — |
| 审批卡 / 问答卡 | ✅（approvals/questions 切片） | ❌（interaction 实体未消费） | S2 |
| compaction 分隔线 / cron 卡 | ✅ | ❌（marker 未消费） | S3 |
| goal 卡 / goal continuation | ✅ | ❌（meta.goal 未消费 + 清除限制） | S4 |
| plan 卡（ExitPlanMode 内容） | ✅（plansByToolCallId） | ❌（可用 `GET transcript/plan` 补） | S5 |
| 错误卡（turnError） / 重试态 | ✅（切片） | ⚠️ turn 头有 error 未消费 | S6 |
| skill/plugin 命令卡、隐藏注入 | ✅（origin metadata） | ❌ | S7 |
| 乐观用户消息（本地回显） | ✅（reducer 合成） | ❌（协议外） | S8 |
| steering 痕迹 / undo 标记 | 两边均无渲染 | ⚠️ prompt.upsert / 'undo' marker 在服务端已有，客户端未消费 | S9 |

### 2.4 主流的非消息切片（session_event 保留范围）

**关键事实（R4 评审厘清）**：grade 生效后，抑制集 `TRANSCRIPT_PROJECTED_EVENT_TYPES` 覆盖**几乎全部 per-agent 事件**——turn.*/delta/tool.*/shell.*/task.*/subagent.*/compaction.*/goal.updated/plan.revision/agent.status.updated/prompt.*/event.approval.*/event.question.*/error/warning 等全在其中。能继续从 session_event 拿到的只有：**全局事件**（`isGlobalEvent`：session.created/updated/deleted、session.meta.updated、work_changed、usage_updated、config 等）+ **agent 生命周期**（agent.created/disposed）+ tool.list.updated / mcp.server.status。

因此：**主 agent 的一切 per-agent 消费方都必须改由 transcript 实体驱动**，没有"保留原路径"的例外——消息流（§2.3 全表）、审批/问答（含侧栏置顶与 thinking settle，S2）、goal（S4b）、plan（S5）、错误/重试（S6）、warnings（S13）、dock 行（task.upsert）、待办（todo.upsert）、以及 agent.status 的非 usage 字段（live model/swarmMode/thinkingEffort，S12——`event.session.usage_updated` 只带 usage，补不回它们，`mappers.ts:642-648`）。

**例外（R6 评审厘清）：BTW 侧聊等 side-channel agent 的原始事件路径保留**——抑制按连接×agent 生效，侧聊 agent 没有 transcript 订阅，其 agentDelta/agentTurnEnded/taskProgress/taskCompleted 事件照常下发（`useKimiWebClient.ts:1116-1129` 消费进 `sideChatMessagesByAgent`，`useSideChat.ts:78-94` 渲染）。Phase 3 的退役范围**只限 main 消息路径**，侧聊投影不得误删。

- `lastSeqBySession`（durable 光标）与连接态与 transcript seq 正交，保留。
- ~~dock 任务行保留原路径~~（已更正）：dock 任务行 `tasksBySession` **改由 transcript `task.upsert` 实体驱动**——grade 生效后 `subagent.*`/`task.*` 原始事件被抑制，而这些事件正是 dock 行的实时来源（`agentEventProjector.ts:1213-1457,1537-1749`），REST `/tasks` 又不含前台/swarm 行（`useTaskPoller.ts:74-77,255-258`）。**Phase 2 切换前必须完成接入**（含前台/swarm 行的实时性），否则新启动的子代理缺实时行、进度与取消入口。**行内元数据索引同样要迁**（R13 评审）：现行从 `messagesBySession` 恢复 Bash 行的命令（`useKimiWebClient.ts:2254-2296`）和子代理卡的 prompt（`:2302-2335`）——删除消息切片前，这两个索引改从主 transcript 帧构建，或让 task 实体携带等价字段，否则后台 Bash 行丢命令、子代理卡退化成类型名。

## 3. 目标架构

```
daemon ── transcript.reset/ops ──► TranscriptChannel(main) ──► mainTranscriptToTurns ──► ChatTurn ──► ChatPane
     │                        ├─► task.upsert / todo.upsert 实体 ──► tasksBySession（dock 行）/ 待办列表
     │                        ├─► interaction.upsert 实体 ──► 审批/问答卡 + 置顶/thinking settle + 系统通知
     │                        └─► meta/marker ──► goal/plan/错误/warnings/agent.status 字段
     └──── session_event（保留） ──► 全局事件（sessions/work/config/usage…）+ agent 生命周期 + BTW 侧聊通道
```

- 主 agent 以 **delta grade** 订阅 transcript（与详情面板同档——生产实证路径；grade 终选见 §8 开放问题 ①）。
- 消息渲染不再经过 `agentEventProjector`/`eventReducer` 的消息路径；新增 `mainTranscriptToTurns`（在 `auxiliaryTranscriptToTurns` 基础上补全 §2.3 缺口，或直接扩展它并改名）。
- `session_event` 连接保留，但仅消费 transcript 管不到的事件（§2.4）；服务端按 grade 自动抑制重复消息事件。
- `agentEventProjector`/`eventReducer` 退役范围：消息流切片（messagesBySession、turnActive 等）退役；**per-agent 消费方全部改由 transcript 实体驱动**（消息、审批/问答、goal、plan、错误/重试、warnings、dock 行、待办、agent.status 字段——见 §2.4/§4）；保留的只剩全局事件与 agent 生命周期（§2.4）。

## 4. 缺口清单与对策

服务端缺口（kimi-code 仓，先行）：

- **S1 附件 live 缺口**：✅ 已完成（kimi-code#3088，随本 PR 的 submodule 指针合入）——`turn.started` 携带 `promptAttachments`，live 投影产出附件实体与 `attachmentIds`。
- **S4a goal 清除限制**：✅ 已完成（kimi-code#3088）——`meta.merge{goal:null}` 全链路清除。
- （可选）S9 steering/undo marker 的客户端消费：服务端已有 `prompt.upsert` 实体与 'undo' marker，仅需客户端映射——无服务端改动。

客户端缺口（app 仓）：

- **S2 审批/问答卡（含侧栏语义与系统通知）**：`mainTranscriptToTurns` 消费 `interaction.upsert` 实体（pending→终态）。主流还用 approvals/questions 切片做**侧栏置顶与 thinking settle**（`eventReducer.ts:701-770`）——`event.approval.*`/`event.question.*` 同样在抑制集内（见 §2.4），**这些切片也必须在 Phase 2 切换前改由 interaction 实体驱动**，否则待处理交互不再置顶、thinking 无法按交互收敛。**终态副作用（R10 评审）**：ExitPlanMode 审批被他端处理/过期时，现行在 approval 终态写入 review 并刷新 plan（`useKimiWebClient.ts:1084-1091,1218-1236`）——抑制后必须在 interaction 的 resolved/expired 边沿按 toolCallId 写入 review 并刷新对应 plan（与 S5 联动），否则 fallback plan 永远停在 pending。**系统通知同理**：现行在实时 AppEvent 边沿触发（`useKimiWebClient.ts:1206-1216` → `:3830-3862`），抑制后须在 interaction 实体的 **pending 新建边沿按 interaction ID 去重触发等价通知**，且冷加载的既存 pending 项不得补发。
- **S3 compaction/cron**：消费 marker → 分隔线/cron 卡（`compactionBySession` 切片可退役为 transcript 驱动）。
- **S4b goal 卡（含 continuation origin 语义）**：消费 `meta.merge{goal}` + marker → goalBySession 等价物。**且必须完整映射 `TurnHeader.origin`**（R10 评审）：`messagesToTurns.ts:952-975` 依赖 `system_trigger/goal_continuation` origin 来隐藏机器 prompt、加续跑标记并禁用 undo，而 `auxiliaryTranscriptToTurns.ts:63-80` 目前只为 task 通知复制 origin——只迁 goal 卡会把隐藏 prompt 显示成用户消息。origin 映射列为 Phase 2 前置项（与 S7 同源）。
- **S5 plan 卡**：`GET transcript/plan`（服务端既有路由）+ `plan.revision` marker 驱动刷新。
- **S6 错误/重试**：消费 turn 头 error / step 头 retry → turnError/turnRetry 等价物。**且保留后台错误的即时提示**（R12 评审）：现行在 fresh error 事件上除写切片外还把结构化错误加入 `warnings`（`eventReducer.ts:1118-1146`）——抑制后须在实时 error 新建边沿按 seq/turn 去重生成同等提示，冷加载历史错误不补发。
- **S7 skill/plugin 命令卡与隐藏注入**：transcript prompt 需携带 origin（审视服务端 prompt.upsert 字段是否够；不够则服务端补 origin 字段，小 PR）——与 S4b 的 `TurnHeader.origin` 完整映射同一条路径。
- **S8 乐观用户消息**：协议外概念。方案：保留 composer 侧的本地乐观气泡（纯 UI 态，不进 transcript），transcript 的 TurnHeader.prompt 落地后按 promptId/内容对账去重（现行 optimistic 去重逻辑可平移）。
- **S10 队列中消息与无 turn prompt 终态**：队列展示现行由 session_event 投影；更关键的是**无 TurnHeader 的 prompt 终态**——被 pre-submit hook 拒绝（blocked）或排队中被取消（aborted）的 prompt 不产生 turn，现行靠 `promptCompleted`/`promptAborted` 清理本地 in-flight、工作指示器与乐观气泡（`agentEventProjector.ts:1128-1149`、`useKimiWebClient.ts:1188-1204`），而这两个事件在 grade 下会被抑制。迁移方案：消费 transcript 的 `prompt.upsert` 终态做同样的清理（列为 Phase 0 调研 + Phase 1 对账项），否则这类输入会永久停在「发送中」并阻塞本地队列。**同时（R7 评审）**：`prompt.submitted` 也在抑制集内——它现承担 HTTP 响应丢失时的 promptId 回填（`useKimiWebClient.ts:1132-1144`，Stop 取消不确定提交/排队 prompt 的恢复路径）。Phase 2 前置：消费 `prompt.upsert` 的 pending/running 新建边沿保存 prompt ID，否则 Stop 只能会话级兜底，不可见的排队 prompt 可能随后继续执行。

- **S11 dock 待办列表**：dock 的待办 pill/面板现由 `latestTodos(messagesBySession[sid])` 派生（`useKimiWebClient.ts:2634-2639`）。transcript 有权威 `todo.upsert` 实体但客户端未消费——在 Phase 3 删除 `messagesBySession` 之前必须让 todo 实体驱动该状态，否则所有 TodoList 会话待办变空。

- **S12 agent.status 的非 usage 字段**：live model / swarmMode / thinkingEffort / **planMode** 现由 `agent.status.updated` 同步（`agentEventProjector.ts:1004-1057`，planMode 再驱动 `planModeBySession` 的 composer 状态，`useKimiWebClient.ts:1024-1025`），该事件在 grade 下被抑制。全部改由 transcript 的 meta/status 切片驱动（coreEventMap 已把 plan/swarm 模式写进 meta，`:1125-1153`），否则状态栏与 composer 的 swarm/thinking/plan 模式停在旧值、后续 prompt 可能携带过期配置。

- **S13 warnings 切片**：`warning` 事件在抑制集内（§2.4），warnings 切片改由 transcript 的 notice marker 驱动（Phase 2 切换前完成），否则后台告警不再进入提示。

- **S14 per-session 主 channel 池与后台保留**：现行对最近 4 个会话保留 WS 订阅（LRU，`useKimiWebClient.ts:2085-2128`），后台会话的交互通知/状态更新因此实时。主 transcript channel 必须有等价物：若 channel 随 ChatPane 激活/停用（auxiliary pool 正是这种生命周期），切走的会话只能靠重开时 REST 补边沿，S2 承诺的后台审批/问答系统通知会漏发。Phase 0 建立与 LRU 等价的 per-session 主 channel 池与后台订阅策略。
- **S15 会话活跃时间（recency）**：现行在 turn 开始/结束与新审批/问答到达时 `bumpSessionRecency`（`eventReducer.ts:701-755,1027-1084`），侧栏按 updatedAt 纯时间排序；这些事件均被抑制。Phase 2 前置：从 transcript 的新 turn 与 interaction 实时新建边沿按 seq/实体 ID 去重执行等价 bump，冷加载不补触发；**无 turn 的 prompt 终态（blocked/aborted）边沿同样纳入**（现行 `eventReducer.ts:1008-1024` 在这两类上 bump），去重复用 S10 的终态口径——否则最近活动会话不再浮顶、这类会话留在侧栏旧位置。

回退与兼容（已拍板：不做旧 daemon 兼容）：

- **不为旧版 daemon 保留回退路径**。daemon 版本由 kimi-code submodule 指针钉住（desktop 打包同期 daemon；web 开发经 `KIMI_SERVER_URL` 也要求指向同期 daemon），客户端连接到一个无 transcript grade 的旧 daemon 属于**不支持的配置**，不做探测与回退代码。
- 迁移本身的保险丝是两个 dev 开关（`localStorage`，均仅 `import.meta.env.DEV` 生效）：`kimi-main-transcript-shadow=1` 起第二条 transcript 连接跑 shadow 对账（Phase 1）；`kimi-main-transcript-render=1` 让 ChatPane 改从 transcript channel 渲染（Phase 2，旧产线继续喂其他切片）。新产线出问题时摘开关切回现行产线调试，但**旧产线不长期保留**——Phase 3 完成即删除，连同 projector/reducer 里历年来为旧 daemon 写的兼容分支一并清理。

## 5. 分阶段实施

**Phase 0（前置补齐）** — ~~kimi-code 仓 S1、S4a~~（✅ #3088 已合）+ ~~WS 同会话多 agent 并发 transcript 订阅~~（✅ 随本 PR 合入）+ 调研确认（S7 的 prompt origin 字段、S10 队列）。
**Phase 1（shadow 双跑对账）** — ✅ 完成。shadow 用第二条独立 WS 连接订阅 transcript（抑制缝按连接×agent 生效，共用主连接会饿死旧产线）；CDP 装置对账 8 组场景（简单文本、2+2 前后台子代理、goal、plan、审批、compaction、cron、后台任务完成、steering、断线重连）全部 settled in sync。对账驱动的服务端修复合入 #3102（通知折叠 buffer 方案、task 起源边界改读 durable `turn.prompt`、task 实体补 model/thinkingEffort）。唯一保留差异：legacy 刷新后丢 compaction `trigger`（旧产线缺陷，transcript 侧信息更全，随旧产线退役消失）。
**Phase 2（切换渲染）** — ✅ 完成。ChatPane 数据源切到 transcript 产线（`mainTurnsProjector` 位置复用）；随后按盘点清单逐项改接：todos / turnActive / turnError / turnRetry / compaction banner / plan/swarm mode / approvals+questions+planReview（interactions 实体）/ dock 任务行（task.upsert + 后台任务对折叠 + REST model 富化）/ turn 结束边沿（unread、完成与审批问答通知、队列 drain、promptId 回填、recency bump）/ 乐观气泡（独立 UI 切片，S8）。主 channel 池已合并到主连接（grade 生效，服务端抑制主 agent 的 session_event 投影帧）。
**Phase 3（退役）** — ✅ 完成（`9a142214`，−3137 行）：`agentEventProjector`/`eventReducer` 的消息路径、`messagesBySession` 切片及全部旧 daemon 兼容分支删除；transcript 池成为唯一产线（无 dev 开关、无 shadow 连接、无对账装置）。**遗留**：#256 的 7 条边界评论逐条回复「已被 transcript 迁移取代」并 resolve（随 PR 合并时处理）；`HANDOFF-subagent-badge.md` Bug 3 复核；goal turn-end suppression 的 seam 测试随旧路径删除，覆盖缺口记录在案（live 已验证）。

依赖与顺序：~~#3005~~（✅ 已合）、#257 先行合并（它修的是 transcript 消费者，M 直接受益）；#256 遗留 7 条**明确挂起到 Phase 3**；Bug 3 挂起到 Phase 3 复核。

**已知取舍（随退役定型）**：goal 卡的实时流式更新改为回合边界 REST 刷新（`goal.updated` 在抑制集内，且 transcript `meta.goal` 不含 turns/wallClock 明细，需 daemon 侧富化后才能恢复实时）；warnings 的实时增量降级为会话选择时 REST 拉取（notice marker 已在 transcript，边沿接线留作后续）；goal turn-end 的 seam 测试缺口待按 transcript 边沿重写。

## 6. 风险

- **双跑期的事件双写**：抑制缝按连接×agent 工作，shadow 期两条产线会各拿一份消息——对账层消费，用户无感；注意内存/CPU 开销，shadow 默认仅 dev。
- **transcript 投影与现行投影的语义差**（例：task.notified 无 open step 时丢弃 vs 现行合成隐藏用户消息；approvals 的侧栏语义）——逐项列入 Phase 1 对账清单，不允许"差不多"放行。
- **无旧 daemon 安全网**：不做回退兼容意味着 daemon 与客户端必须同期（submodule 指针钉住）。web 开发若 `KIMI_SERVER_URL` 指到旧 daemon，transcript 订阅会失败——表现为消息流空白，需要在文档/报错里给出醒目提示而不是静默兜底。
- **性能**：delta/append 帧量与现行相当（同一份投影，只是搬到服务端）；block grade 下每步有 `frame.upsert` 收敛帧，关注长 turn 的帧大小，必要时升 delta grade。

## 7. 验证策略

- Phase 1 对账自动化：CDP 探针（已建套路）驱动 2+2 子代理、goal/plan、审批、compaction、cron、后台任务完成、 steering、断线重连 8 组场景，双产线逐块 diff。
- 单测：`mainTranscriptToTurns` 全特性用例（对齐现行 messagesToTurns 的测试集，能复用则复用）；TranscriptChannel 的缺口/翻页已有测试基线。
- 仓库规矩：UI 行为变化（若有）亮暗双主题视觉验证；`check:style` 无新增 findings。

## 8. 开放问题（评审时拍板）

1. grade 选择：详情面板的实证基线是 **delta**（`ws.ts:696-710` 固定），不是文档早前写的 block。先 delta（复用实证路径）还是先 block（帧更粗、量更省）？（倾向先 delta——与唯一生产验证路径同档，风险最小；block 留作性能对比项在 Phase 1 对账时实测）
2. 乐观消息去重的对账键：promptId 还是内容指纹？（倾向 promptId，现行逻辑平移）
3. ~~`agentEventProjector` 的 dock 行职责归谁~~ **已定案（R2 评审）**：由 transcript `task.upsert` 实体驱动 `tasksBySession`，且必须在 Phase 2 切换前完成（见 §2.4）；取消链路的时序在 Phase 1 对账中专项验证。
