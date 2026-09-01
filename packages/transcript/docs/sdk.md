# Transcript SDK

本文档描述 transcript 对外契约的**当前实现**，读者为 transcript 通道的消费方（kimi-code-app、kimi-inspect、外部 REST/WS 客户端）与 transcript 包的维护者。契约的权威定义是 `src/contract/schema.ts` 的 zod schema；本文档是其可读形式，两者冲突时以 schema 为准并修正本文档。契约变更必须附带 migration 文档（见第八节）。

## 一、定位与分层

transcript 是 session 对话时间线的读取通道，同一份数据有两种喂法：

- **live**：kap-server 订阅 core 的 observable 事件（IEventBus），由 projector 翻译成 ops 写入内存 store；
- **cold**：从 `wire.jsonl` 的 durable 记录两层 fold 重建（`history/groupTurns.ts` 负责 context 消息 → turn 树，`history/foldFacts.ts` 负责非 context 记录 → 实体与 meta）。

wire.jsonl 是历史的唯一真相源；live store 是纯内存态，随 session 消亡。cold 重建存在已声明的字段缺口（见 2.8 已知限制）。

```text
TranscriptStore（per session）
└── agents: Map<AgentId, AgentTranscript> + roster: AgentDescriptor[]
    └── AgentState
        ├── items: (Turn | Marker | TaskRef)[]     时间线；Turn 内嵌 steps[]，Step 内嵌 frames[]
        ├── tasks / interactions / attachments / todos / prompts   全局实体
        ├── meta（goal / modes / activity / agent）
        └── hasMoreOlder
```

ID 规范：turn `t{N}`（ordinal 从 0 起，与引擎一致）、step `t{N}.{M}`、文本/thinking frame `t{N}.{M}.f{K}`、tool frame `t{N}.{M}.{toolCallId}`。marker id 在 live 路径为 `live-m{N}`，cold 路径为 `m{N}`。

## 二、数据模型

### 2.1 AgentDescriptor

```ts
interface AgentDescriptor {
  agentId: AgentId;
  type?: 'main' | 'sub' | 'independent';
  parentAgentId?: AgentId;
  label?: string;
  createdAt?: string;
  disposedAt?: string;
}
```

当前写入逻辑只按 `agentId === 'main'` 区分：main 写 `'main'`，其余写 `'sub'`（`agentLifecycleService.ts:184`）；`'independent'` 无写入方。btw 侧栏 agent 与 subagent 在元数据上无法区分（都注册为 `'sub'`、`parentAgentId: 'main'`，区别仅在有无 labels）。

### 2.2 Turn / Step

```ts
interface Turn {
  kind: 'turn';
  turnId: TurnId;
  triggerPromptId?: string;
  ordinal: number;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  origin: TurnOrigin;                 // { kind: 'user'|'cron'|'task'|'hook'|'compaction'|'side'|'other', taskId?, payload? }
  prompt?: string;
  attachmentIds?: AttachmentId[];
  steps: Step[];
  startedAt?: string;
  endedAt?: string;
  usage?: Usage;                      // { inputTokens?, outputTokens?, cachedTokens?, cost? }
  durationMs?: number;
  error?: string;
}

interface Step {
  kind: 'step';
  stepId: StepId;
  turnId: TurnId;
  ordinal: number;
  state: 'running' | 'completed' | 'interrupted' | 'failed';
  frames: Frame[];
  startedAt?: string;
  endedAt?: string;
  usage?: StepUsage;                  // { inputOther, output, inputCacheRead, inputCacheCreation }
  finishReason?: string;
  timing?: StepTiming;                // llmFirstTokenLatencyMs / llmStreamDurationMs / llmRequestBuildMs / llmServerFirstTokenMs / llmServerDecodeMs / llmClientConsumeMs
  retry?: StepRetry;                  // { failedAttempt, nextAttempt, maxAttempts, delayMs, errorName, errorMessage, statusCode? }
  endReason?: string;
  endMessage?: string;
}
```

实际状态机比枚举声明小：Turn 实际只有 `running → completed | failed | cancelled`（`'queued'` 无写入方）；Step 实际只有 `running → completed | interrupted`（`'failed'` 无写入方）。core 的 `TurnEndReason` 有 4 值（含 `'blocked'`），投影到 transcript 时 `'blocked'` 折叠为 `'failed'`。

### 2.3 Frame

```ts
type Frame = TextFrame | ThinkingFrame | ToolCallFrame | NoticeFrame;
```

- `TextFrame`：`{ kind: 'text', frameId, role: 'assistant'|'user', text, attachmentIds?, taskId?, promptIds?, origin? }`（user 帧的 origin 可带 skillActivations）
- `ThinkingFrame`：`{ kind: 'thinking', frameId, text }`
- `ToolCallFrame`：`{ kind: 'tool', frameId, toolCallId, name, state: 'running'|'done'|'error', view?, input?, output?, display?, error?, inputText?, progress?, taskId?, approvalId?, todoId?, agentRefs? }`
- `NoticeFrame`：`{ kind: 'notice', frameId, level: 'error'|'warning'|'info', source?, message, detail? }`

### 2.4 Marker / TaskRef / Task / Interaction / Todo / Attachment

```ts
interface Marker {
  kind: 'marker';
  markerId: string;
  marker: string;                     // KNOWN_MARKERS 见下
  payload?: unknown;
  at?: string;
}
```

`KNOWN_MARKERS`：`'compaction' | 'undo' | 'clear' | 'goal' | 'plan.enter' | 'plan.exit' | 'plan.revision' | 'swarm.enter' | 'swarm.exit' | 'skill' | 'cron.fired' | 'notice' | 'hook'`（`marker` 字段类型为自由 string，KNOWN_MARKERS 是已知键清单）。

```ts
interface TaskRef { kind: 'taskref'; refId: string; taskId: TaskId; at?: string }

interface Task {
  taskId: TaskId;
  kind: 'shell' | 'subagent' | 'tool' | 'other';   // 'tool' 无写入方
  state: 'running' | 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost';
  detached: boolean;
  description?: string;
  agentId?: AgentId;
  outputTail: string;
  startedAt?: string;
  endedAt?: string;
  resultSummary?: string;
  error?: string;
  stateReason?: string;
  usage?: StepUsage;
  model?: string;
  thinkingEffort?: string;
}

interface Interaction {
  interactionId: InteractionId;
  interactionKind: 'approval' | 'question';
  toolCallId?: string;
  state: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'answered' | 'dismissed';
  request?: unknown;
  response?: unknown;
}
```

### 2.5 Prompt

```ts
interface Prompt {
  promptId: PromptId;
  status: 'running' | 'queued' | 'blocked' | 'completed' | 'failed' | 'aborted';
  userMessageId?: string;
  content?: unknown;
  createdAt: string;
  finishedAt?: string;
  steeredAt?: string;
}
```

prompt 实体只在 live 路径写入（cold 重建不构建 prompts 列表）。`'blocked'` 表示被外部 hook 拦截（turn 未启动）；steer 吸收的子 prompt 记为 `'completed'` 并带 `steeredAt`。

### 2.6 Meta

```ts
interface TranscriptMeta {
  goal?: { objective: string; status: 'active'|'paused'|'blocked'|'complete'; completionCriterion?; budgetUsed?; budgetLimit? };
  modes?: { plan?: { reviewPath?, version? }; swarm?: { trigger? }; tower?: {} };
  activity?: 'idle' | 'turn' | 'disposing' | 'unknown';   // 实际只写 'idle'/'turn'
  agent?: AgentStatusMeta;
}

interface AgentStatusMeta {
  model?: string;
  thinkingEffort?: string;
  usage?: { byModel?: Record<string, StepUsage>; currentTurn?: StepUsage; total?: StepUsage };
  contextTokens?: number;
  maxContextTokens?: number;
  contextUsage?: number;
  permission?: 'manual' | 'yolo' | 'auto';
  phase?: AgentPhaseMeta;
}
```

`AgentPhaseMeta` 8 种 kind：`idle | running | streaming | tool_call | retrying | awaiting_approval | interrupted | ended`，由 kap-server 的 `toLegacyPhase` 从 core 的 `AgentActivityState` 映射，经 `meta.merge` 下发；cold 路径不回填。`AgentStatusMeta` 的 `permission` 与 `contextUsage` 当前无写入方（schema 声明保留）。

### 2.7 Snapshot

```ts
interface AgentTranscriptSnapshot {
  items: TranscriptItem[];
  tasks: Task[];
  interactions: Interaction[];
  attachments: Attachment[];
  todos: Todo[];
  prompts: Prompt[];
  meta: TranscriptMeta;
  hasMoreOlder?: boolean;
}
```

### 2.8 已知限制（cold 重建缺口）

- `step.retry` 不回填（retry 事件自 #3428 起已写入 wire，但 fold 尚未消费，transient by design）。
- `step.usage / timing / finishReason`、`turn.usage`、`meta.agent.*`、`agent.phase`、prompts 列表不回填。
- step 中断信息（`state: 'interrupted'` + `endReason` / `endMessage` / `endedAt`）自 #3428 起由 durable `turn.step.interrupted` 记录回填（context 树缺少对应 step 时会合成）。
- 缺少 `turn.ended` 记录的 turn（进程崩溃中断）在 cold 路径一律标 `'completed'`。
- live/cold 对同一逻辑 marker 使用不同 id 命名空间（`live-m{N}` vs `m{N}`）。

## 三、Operations（ops）

所有 store 变更以 op batch 应用。op 联合（14 个成员）：

| op | payload | 语义 |
|---|---|---|
| `reset` | `{ agentId, snapshot }` | 整体替换 AgentState；server 不产生，仅客户端 store/测试使用（server 侧 reset 以专用帧存在） |
| `turn.upsert` | `{ turn: TurnHeader }` | upsert turn 头，保留已有 steps |
| `step.upsert` | `{ turnId, step: StepHeader }` | upsert step 头，保留已有 frames |
| `frame.upsert` | `{ turnId, stepId, frame }` | 整帧替换 |
| `append` | `{ target, offset, text }` | 向 text/thinking 帧或 task.outputTail 追加；幂等键 `(target, offset)`，重叠合并，gap 整批拒绝 |
| `marker.upsert` | `{ item, beforeTurn? }` | 时间线 marker |
| `taskref.upsert` | `{ item, beforeTurn? }` | 时间线 task 引用 |
| `task.upsert` | `{ task }` | task 实体 |
| `interaction.upsert` | `{ interaction }` | interaction 实体，同步维护 pendingInteractions |
| `attachment.upsert` | `{ attachment }` | attachment 实体 |
| `todo.upsert` | `{ todo }` | todo 实体 |
| `prompt.upsert` | `{ prompt }` | prompt 实体（live-only） |
| `meta.merge` | `{ meta }` | 深合并 meta，`null` 表示删除该键 |
| `items.remove` | `{ ids }` | 删除时间线条目，级联删除锚定的 interaction |

规则：

1. **幂等**：upsert 做字段级相等判断，无变化的 op 被丢弃、不通知订阅者；整批重放是 no-op。
2. **序号**：server 给每批分配 per-(session, agent) 连续 `seq`，watermark = 最新已分配 seq；journal 容量 2000 批（`TRANSCRIPT_OPS_JOURNAL_CAPACITY`），随 live store 消亡。

## 四、WebSocket 协议

### 4.1 订阅

```json
{ "type": "subscribe_v2", "id": "sub-1",
  "payload": { "session_id": "<sid>",
               "transcript": { "*": "delta" },
               "transcript_since": { "main": 42 } } }
```

- `transcript`：`{ <agentId|'*'>: grade }`，grade ∈ `off | turn | block | delta`。
- `transcript_since`：可选，按 agent 携带已见 seq。journal 覆盖则回放 op 批；覆盖不到（或 session 冷）回退 `transcript.reset`。
- `unsubscribe_v2`：`{ agent_ids? }`，缺省摘除整个 session 的 transcript 订阅；被摘除的 agent 恢复接收 legacy session_event。
- grade 升级触发重发 reset；降级/同级不重发。

### 4.2 下发帧

transcript 帧包裹在 session 事件 envelope 中（外层 `seq` 是 session 事件 journal 序号，与 `payload.seq` 的 transcript op-batch 序号无关）：

```json
{ "type": "transcript.ops", "seq": 137, "epoch": "...", "volatile": true,
  "session_id": "<sid>", "timestamp": "<ISO>",
  "payload": { "type": "transcript.ops", "agent_id": "main",
               "ops": [ /* TranscriptOp[] */ ], "seq": 43 } }

{ "type": "transcript.reset", "seq": 136, "volatile": true, "session_id": "<sid>",
  "payload": { "type": "transcript.reset", "agent_id": "main",
               "snapshot": { "items": [], "tasks": [], "interactions": [],
                             "attachments": [], "todos": [], "prompts": [], "meta": {} },
               "has_more_older": true, "seq": 43 } }
```

- baseline reset 恒为 `items: []`（`TRANSCRIPT_RESET_TAIL_TURNS = 0`），历史一律走 REST 分页。
- 发送时机：首次订阅（history backfill 完成后）、grade 升级、roster 出现新 agent。

### 4.3 粒度过滤

同一 store 变更，不同 grade 的下发内容：

| op 类型 | off | turn | block | delta |
|---|---|---|---|---|
| turn.upsert / meta.merge / task / interaction / marker / todo / prompt / attachment / items.remove | — | ✓ | ✓ | ✓ |
| step.upsert / frame.upsert | — | — | ✓（全量帧） | ✓ |
| append | — | — | — | ✓ |
| reset 快照 | — | turn 的 steps 掏空为 `[]` | 完整 | 完整 |

block 订阅者在流式期间只收 `frame.upsert` 空帧；step 完成时 projector 的 flushOpenFrames 会补发一次全量帧，因此 block 级也能拿到完整文本。

### 4.4 legacy 事件抑制

连接对某 agent 订阅了 transcript（grade ≠ off）后，该连接 × agent 的 transcript 投影类 legacy session_event（`TRANSCRIPT_PROJECTED_EVENT_TYPES`，49 种）不再下发；journal 仍记录，未订阅连接不受影响。`prompt.queued` 是唯一例外（不在抑制集，双通道都发）。

## 五、REST API

均包 `{ code, msg, data, request_id }` 信封。

### 5.1 `GET /sessions/{id}/transcript`

query：`agent_id`（必填）、`before_turn | after_turn`（互斥）、`page_size`（1-100，默认尾页 20 turn）。

```json
{ "agent_id": "main", "items": [ /* Turn | Marker | TaskRef */ ],
  "has_more": true,
  "tasks": [], "interactions": [], "attachments": [], "todos": [],
  "prompts": [], "meta": {},
  "agents": [ /* AgentDescriptor */ ],
  "pending_interactions": [], "seq": 43 }
```

`seq` 是该 agent 当前 watermark。live 读内存 store，cold 从 wire.jsonl 重建。

### 5.2 `GET /sessions/{id}/transcript/ops`

query：`agent_id`、`since_seq`。

```json
{ "agent_id": "main",
  "batches": [ { "seq": 43, "ops": [] } ],
  "latest_seq": 47,
  "complete": true }
```

`complete: false` = journal 覆盖不到或 session 冷 → 调用方全量刷新。

### 5.3 `GET /sessions/{id}/transcript/user-messages`

按 agent 返回用户消息列表：

```json
{ "agents": [ { "agent_id": "main",
                "messages": [ { "turn_id": "t1", "ordinal": 1, "state": "completed",
                                "origin": { "kind": "user" }, "prompt": "...",
                                "attachment_ids": [], "started_at": "..." } ],
                "attachments": [] } ] }
```

### 5.4 `GET /sessions/{id}/transcript/plan`

query：`agent_id`（必填）、`tool_call_id`（可选，窄化到单个调用）。

```json
{ "agent_id": "main",
  "plans": [ { "tool_call_id": "call_1", "turn_id": "t1",
               "source": "interaction", "plan": "...", "path": "...",
               "options": [ { "label": "...", "description": "..." } ],
               "review": { "state": "approved", "selected_option": "...", "feedback": "..." } } ] }
```

## 六、Session 级 work 状态

session 粒度的忙闲由 core 的 `ISessionActivityView` 聚合，经 `event.session.work_changed` 下发：

```json
{ "busy": false, "main_turn_active": false,
  "pending_interaction": "none", "last_turn_reason": "completed" }
```

`pending_interaction` ∈ `none | approval | question`；`last_turn_reason` ∈ `completed | cancelled | failed`。同一 view 也服务 REST 的 session facts 与 v2 `activity.status`（`approval > question > running > failed > idle`）。

## 七、事件来源

live projector 消费的 core observable 事件（主要）：`turn.started`、`turn.ended`、`turn.step.started/completed/interrupted/retrying`、`assistant.delta`、`thinking.delta`、`tool.call.started/delta`、`tool.result`、`tool.progress`、`task.started/terminated/notified`、`shell.started/output/completed`、`subagent.spawned/started/completed/failed/suspended`、`prompt.accepted/queued/submitted/started/completed/aborted/steered`、`goal.updated`、`agent.status.updated`、`agent.activity.updated`、`interaction.request/resolved`（经 session 交互状态订阅）、`error`、`warning`、`hook.result`、`cron.fired`、`skill.activated`、`plugin_command.activated`、`compaction.*`、`context.spliced/undone`。

cold fold 消费的 durable record type：`turn.prompt`、`turn.ended`、`turn.cancel`、`turn.steer`、`turn.step.interrupted`、`context.append_message`、`context.append_loop_event`（内嵌 `step.begin` / `step.end` / `content.part` / `tool.call` / `tool.result`）、`context.undo/clear/apply_compaction`、`interaction.request/resolved`、`task.started/terminated`、`goal.create/update/clear`、`plan_mode.enter/exit/cancel`、`plan.revision`、`swarm_mode.enter/exit`、`tower_mode.enter/exit`、`tools.update_store`。

## 八、版本与迁移约定

1. **契约载体**：`src/contract/schema.ts` 的 zod schema 是 wire 契约的唯一权威定义；本文档是其可读形式。两者冲突时以 schema 为准并修正本文档。
2. **wire.jsonl 只增不改**：允许新增 record type、给既有 record 新增 optional 字段；禁止删除/改名/改语义。旧文件必须永远可回放（zod optional 保证 safeParse 通过）。
3. **transcript 契约变更必须附带 migration 文档**：任何对实体字段、op 类型、帧结构、REST 响应、grade 语义的增删改，都需要在 `docs/migrations/` 下新增 `NNNN-<kebab-title>.md`，编号递增。migration 文档必含五节：
   - **变更摘要**：一句话说明改了什么、为什么。
   - **old → new 映射**：字段/枚举/op 的对照表（含删除项的去向）。
   - **对消费方的影响**：kimi-code-app / kimi-inspect / klient / 外部客户端各自需要适配什么。
   - **wire 兼容性**：新增记录类型清单；旧 wire.jsonl 的回放行为。
   - **回滚**：如何回退，回退后旧客户端看到什么。
4. **纯新增（新 op、新 optional 字段、新枚举值且有默认处理）只需 changeset**，不需要 migration 文档；migration 文档针对删除、改名、语义变更。
5. 规划中的首份 migration：`docs/migrations/0001-state-model-unification.md`（状态模型统一重构，设计稿在工作区，落地时随代码一并进入仓库）。
