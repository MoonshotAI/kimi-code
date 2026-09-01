# Transcript SDK

状态：**目标契约**。本文档描述状态模型统一重构（migration 0001，规划于 `docs/migrations/`）落地后的 transcript 对外契约。落地前以代码为准，落地后以本文档为准；此后任何契约变更必须附带一份 migration 文档（见第八节）。

读者：transcript 通道的消费方（kimi-code-app、kimi-inspect、外部 REST/WS 客户端）与 transcript 包的维护者。

## 一、定位与分层

transcript 是 session 对话时间线的**唯一读取通道**。所有持久事实以 wire.jsonl 的 durable 记录为唯一真相源；live 与 cold 是同一 fold 逻辑对同一记录流的两种喂法，同一 session 任一时刻两种读法结果一致。

```text
wire.jsonl（durable 记录，真相源）
   └─ fold（transcript 包，live 增量 / cold 批量共用）
       └─ TranscriptStore（per session）
           └─ AgentTranscript（per agent，不可变 AgentState）
               ├─ WS 订阅通道（transcript.ops / transcript.reset，按 grade 过滤）
               └─ REST 只读接口（分页、ops 补差）
```

非 durable 事件（`assistant.delta` / `thinking.delta` / `tool.call.delta` / `tool.progress`）只用于流式渲染，其写入 store 的内容会被 durable 记录 fold 出的全量帧幂等覆盖校准。消费方永远可以只依据 durable 来源的内容重建一致视图。

## 二、数据模型

### 2.1 容器

```ts
interface TranscriptStore {
  agents: Map<AgentId, AgentTranscript>;
  roster: AgentDescriptor[];
}

type AgentCreatedBy = 'session' | 'btw' | 'agent' | 'agent_swarm' | 'tower_spawn';

interface AgentDescriptor {
  agentId: AgentId;
  createdBy: AgentCreatedBy;
  parentAgentId?: AgentId;
  forkedFrom?: AgentId;
  label?: string;
  disposedAt?: string;
}
```

agent 分类由 `createdBy` 派生：`'session'` → main；`'btw'` → btw 侧栏；其余 → subagent。`createdBy` 是封闭枚举，新增能创建 agent 的工具时扩充。

### 2.2 AgentState

```ts
interface AgentState {
  items: TranscriptItem[];                       // Turn | Marker | TaskRef 时间线
  tasks: Map<TaskId, Task>;
  interactions: Map<InteractionId, Interaction>;
  attachments: Map<AttachmentId, Attachment>;
  todos: Map<TodoId, Todo>;
  prompts: PromptQueueState;
  meta: TranscriptMeta;
  hasMoreOlder: boolean;                         // 仅 reset/快照截断置真
}
```

### 2.3 Turn / Step

```ts
interface Turn {
  kind: 'turn';
  turnId: TurnId;                                // 't{N}'，ordinal 从 0 起
  ordinal: number;
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  origin: TurnOrigin;
  promptId?: PromptId;
  prompt?: string;
  attachmentIds?: AttachmentId[];
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  endReason?: 'blocked' | 'max_steps' | 'lost' | 'error';
  error?: string;
  steps: Step[];
  usage?: Usage;
}

type TurnOrigin =
  | { kind: 'user'; payload?: unknown }
  | { kind: 'cron'; taskId?: TaskId; payload?: unknown }
  | { kind: 'task'; taskId: TaskId; payload?: unknown }
  | { kind: 'hook'; payload?: unknown }
  | { kind: 'compaction'; payload?: unknown }
  | { kind: 'other'; payload?: unknown };

interface Step {
  stepId: StepId;                                // 't{N}.{M}'
  turnId: TurnId;
  ordinal: number;
  state: 'running' | 'completed' | 'interrupted';
  frames: Frame[];
  startedAt?: string;
  endedAt?: string;
  usage?: StepUsage;
  timing?: StepTiming;
  retry?: StepRetry;
  finishReason?: string;
}
```

状态机（终态不可变；每个 prompt 启动执行即创建新 turn）：

```text
Turn:  running ──→ completed | failed | cancelled
Step:  running ──→ completed | interrupted
```

- `endReason` 是终态细节：`'blocked'`（hook 拦截）、`'max_steps'`、`'lost'`（进程崩溃导致无 `turn.ended` 记录）、`'error'`。
- turn 历史是只读事实：后续 prompt 不会改写已有 turn 的 state；undo 是整个删除 turn（`items.remove`），不是状态变更。

### 2.4 Frame

```ts
type Frame = TextFrame | ThinkingFrame | ToolFrame | NoticeFrame;
```

- `TextFrame`：`{ kind: 'text', frameId, role: 'assistant'|'user', text, attachmentIds?, taskId?, promptIds?, origin? }`
- `ThinkingFrame`：`{ kind: 'thinking', frameId, text }`
- `ToolFrame`：`{ kind: 'tool', frameId, toolCallId, name, state: 'running'|'done'|'error', view?, input?, output?, display?, error?, inputText?, progress?, taskId?, approvalId?, todoId?, agentRefs? }`
- `NoticeFrame`：`{ kind: 'notice', frameId, level: 'info'|'warning'|'error', source?, message, detail? }`

### 2.5 Marker / TaskRef / Task / Interaction / Todo / Attachment

```ts
interface Marker {
  kind: 'marker';
  markerId: string;                              // 'm{N}'，live/cold 同一命名
  marker: 'compaction' | 'undo' | 'clear' | 'goal'
    | 'plan.enter' | 'plan.exit' | 'plan.revision'
    | 'swarm.enter' | 'swarm.exit'
    | 'skill' | 'cron.fired' | 'notice';
  payload?: unknown;
  at?: string;
}

interface TaskRef { kind: 'taskref'; refId: string; taskId: TaskId; at?: string }

interface Task {
  taskId: TaskId;
  kind: 'shell' | 'subagent' | 'other';
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

### 2.6 Prompt（队列实体，无状态机）

```ts
interface Prompt {
  promptId: PromptId;
  userMessageId: string;
  content: MessageContent[];
  createdAt: string;
  blocked?: true;                                // hook 拦截，终态，不产生 turn
  steeredInto?: TurnId;                          // 被 steer 吸收的 turn
}

interface PromptQueueState {
  records: Map<PromptId, Prompt>;
  active: PromptId | null;
  queued: PromptId[];
}
```

读取方式：排队中 = 在 `queued`；执行中 = 是 `active`；执行结果 = 沿 `promptId` 读 `turn.state`；被拦截 = `blocked`；被吸收 = `steeredInto`。prompt 实体描述"当前队列"，session 冷启动后队列为空。

### 2.7 Meta

```ts
interface TranscriptMeta {
  goal?: { objective: string; status: 'active'|'paused'|'blocked'|'complete';
           completionCriterion?: string; budgetUsed?: number; budgetLimit?: number };
  modes?: { plan?: { reviewPath?: string; version?: number };
            swarm?: { trigger?: string };
            tower?: Record<string, never> };
  agent?: { model?: string; thinkingEffort?: string; usage?: AgentUsageMeta;
            contextTokens?: number; maxContextTokens?: number; contextUsage?: number;
            permission?: 'manual' | 'yolo' | 'auto' };
}
```

`meta` 不含 activity 与 agent.phase——两者是派生量，见第六节。

## 三、Operations（ops）

所有 store 变更以 op batch 应用。op 联合：

| op | payload | 语义 |
|---|---|---|
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
| `prompt.upsert` | `{ prompt }` | prompt 记录 |
| `prompt.queue` | `{ active, queued }` | prompt 队列拓扑 |
| `meta.merge` | `{ meta }` | 深合并 meta，`null` 表示删除该键 |
| `items.remove` | `{ ids }` | 删除时间线条目，级联删除锚定的 interaction |

规则：

1. **幂等**：upsert 做字段级相等判断，无变化的 op 被丢弃、不通知订阅者；整批重放是 no-op。
2. **序号**：server 给每批分配 per-(session, agent) 连续 `seq`，watermark = 最新已分配 seq；journal 容量 2000 批，随 live store 消亡。
3. **原子结算**：一次 turn 结束结算（step 终态 + turn 终态 + prompt 队列变更）在同一个 op batch 提交；batch 边界 = dispatcher 同步执行序列边界。消费方永远看不到"turn 已结束、prompt 未结算"的中间态。

## 四、WebSocket 协议

### 4.1 订阅

```json
{ "type": "subscribe_v2", "id": "sub-1",
  "payload": { "session_id": "<sid>",
               "transcript": { "*": "delta" },
               "transcript_since": { "main": 42 } } }
```

- `transcript`：`{ <agentId|'*'>: grade }`，grade ∈ `off | turn | block | delta`。
- `transcript_since`：可选，按 agent 携带已见 seq。journal 覆盖则回放 op 批；覆盖不到（或 session 冷）回退 `transcript.reset`，`complete: false` 时调用方应全量刷新。
- `unsubscribe_v2`：`{ agent_ids? }`，缺省摘除整个 session 的 transcript 订阅；被摘除的 agent 恢复接收 legacy session_event。
- grade 升级触发重发 reset；降级/同级不重发。

### 4.2 下发帧

```json
{ "type": "transcript.ops",
  "session_id": "<sid>",
  "payload": { "agent_id": "main", "seq": 43, "ops": [ /* TranscriptOp[] */ ] } }

{ "type": "transcript.reset",
  "session_id": "<sid>",
  "payload": { "agent_id": "main",
               "snapshot": { "items": [], "tasks": [], "interactions": [],
                             "attachments": [], "todos": [],
                             "prompts": { "records": [], "active": null, "queued": [] },
                             "meta": {} },
               "has_more_older": true,
               "seq": 43 } }
```

- baseline reset 恒为 `items: []`（`TRANSCRIPT_RESET_TAIL_TURNS = 0`），历史一律走 REST 分页。
- 外层不携带 session-event journal seq；`payload.seq` 是 transcript op-batch 序号。

### 4.3 粒度过滤

同一 store 变更，不同 grade 的下发内容：

| op 类型 | off | turn | block | delta |
|---|---|---|---|---|
| turn.upsert / meta.merge / task / interaction / marker / todo / prompt.* / attachment / items.remove | — | ✓ | ✓ | ✓ |
| step.upsert / frame.upsert | — | — | ✓（全量帧） | ✓ |
| append | — | — | — | ✓ |
| reset 快照 | — | turn 的 steps 掏空 | 完整 | 完整 |

block 订阅者在流式期间只收 `frame.upsert` 空帧；step 完成时 fold 会补发一次全量帧（flush），因此 block 级也能拿到完整文本。

### 4.4 legacy 事件抑制

连接对某 agent 订阅了 transcript（grade ≠ off）后，该连接 × agent 的 transcript 投影类 legacy session_event 不再下发；journal 仍记录，未订阅连接不受影响。`prompt.queued` 是唯一例外（双通道都发）。

## 五、REST API

均包 `{ code, msg, data, request_id }` 信封。

### 5.1 `GET /sessions/{id}/transcript`

query：`agent_id`、`before_turn | after_turn`、`page_size`（默认尾页 20 turn，上限 100）。

```json
{ "agent_id": "main", "items": [ /* Turn | Marker | TaskRef */ ],
  "has_more": true,
  "tasks": [], "interactions": [], "attachments": [], "todos": [],
  "prompts": { "records": [], "active": null, "queued": [] },
  "meta": {}, "agents": [ /* AgentDescriptor */ ],
  "pending_interactions": [], "seq": 43 }
```

`seq` 是该 agent 当前 watermark。live 读内存 store，cold 从 wire.jsonl fold 重建，结果一致。

### 5.2 `GET /sessions/{id}/transcript/ops`

query：`agent_id`、`since_seq`。

```json
{ "agent_id": "main",
  "batches": [ { "seq": 43, "ops": [] } ],
  "latest_seq": 47,
  "complete": true }
```

`complete: false` = journal 覆盖不到或 session 冷 → 调用方全量刷新（重新拿 reset/分页）。

### 5.3 其他

- `GET /sessions/{id}/transcript/user-messages`：用户消息列表。
- `GET /sessions/{id}/transcript/plan?agent_id=[&tool_call_id=]`：ExitPlanMode 计划信息。

## 六、派生 selector

以下量不存储，由消费方（或 L4 view 层）从 AgentState 派生：

```ts
function deriveActivity(state: AgentState): 'idle' | 'turn';
function deriveAgentPhase(state: AgentState): AgentPhase;
```

- `deriveActivity`：存在 running 的 turn **或** running 的 task → `'turn'`，否则 `'idle'`。
- `deriveAgentPhase`：`pendingInteractions` 非空 → `awaiting_approval`；最新 turn 非 running → `idle`；当前 step 有 `retry` → `retrying`；有 running 的 tool frame → `tool_call`；有未关闭的 text/thinking frame → `streaming`；否则 `running`。kind ∈ `idle | running | streaming | tool_call | retrying | awaiting_approval`。

## 七、事件来源（fold 输入）

transcript 只 fold durable 记录。消费方无需直接读 wire.jsonl，但理解字段来源有助于排查：

- **骨架**：`turn.prompt`（turn 开始，fire 于 `startTurn`）、`turn.ended`、`turn.cancel`、`turn.steer`、`context.append_message`、`context.append_loop_event`（step.begin / content.part / tool.call / tool.result / step.end）、`context.undo/clear/apply_compaction`。
- **实体**：`task.started/terminated`、`interaction.request/resolved`、`goal.*`、`plan_mode.*/swarm_mode.*/tower_mode.*/plan.revision`、`tools.update_store`。
- **数值与诊断**：`step.end` 内嵌（usage/timing/finishReason）、`profile.bind`、`config.update`、`token_counting.*`、`permission.set_mode`、`usage.record`、`turn.step.retrying`、`prompt.*`、`subagent.*`、`error`、`warning`、`cron.fired`。
- **派生规则**：有 `turn.prompt` 无 `turn.ended` → `failed + endReason:'lost'`；`turn.ended.reason='blocked'` → `failed + endReason:'blocked'`。

session 级忙闲（会话列表）走另一通道：`event.session.work_changed`（`busy / main_turn_active / pending_interaction / last_turn_id / last_turn_reason`），只用于整体忙闲显示与恢复旁证，不参与 prompt 精确结算。

## 八、版本与迁移约定

1. **契约载体**：`packages/transcript/src/contract/schema.ts` 的 zod schema 是 wire 契约的唯一权威定义；本文档是其可读形式。两者冲突时以 schema 为准并修正本文档。
2. **wire.jsonl 只增不改**：允许新增 record type、给既有 record 新增 optional 字段；禁止删除/改名/改语义。旧文件必须永远可回放（zod optional 保证 safeParse 通过）。
3. **transcript 契约变更必须附带 migration 文档**：任何对实体字段、op 类型、帧结构、REST 响应、grade 语义的增删改，都需要在 `docs/migrations/` 下新增 `NNNN-<kebab-title>.md`，编号递增。migration 文档必含五节：
   - **变更摘要**：一句话说明改了什么、为什么。
   - **old → new 映射**：字段/枚举/op 的对照表（含删除项的去向）。
   - **对消费方的影响**：kimi-code-app / kimi-inspect / klient / 外部客户端各自需要适配什么。
   - **wire 兼容性**：新增记录类型清单；旧 wire.jsonl 的回放行为。
   - **回滚**：如何回退，回退后旧客户端看到什么。
4. **纯新增（新 op、新 optional 字段、新枚举值且有默认处理）只需 changeset**，不需要 migration 文档；migration 文档针对删除、改名、语义变更。
5. 首份 migration：`docs/migrations/0001-state-model-unification.md`（本次状态模型统一，随重构落地）。
