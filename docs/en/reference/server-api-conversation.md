# Sessions and Conversations

Clients receive live conversation turns, agent state frames, interaction requests, and task output over a single WebSocket connection (`/api/v1/ws`), and use REST endpoints (`/api/v1`) to submit input, answer approvals, stop, or undo. This page follows the lifecycle a client implements: every section pairs a **complete interactive wire trace** (click `{…}` or **Expand all** in the top-right corner to inspect full payloads) with concise client reduction rules. For REST parameter tables, see [Session Endpoints](./server-api-sessions.md); for authentication, envelopes, and error codes, see [Server API](./server-api.md).

## Connecting

The WebSocket endpoint is `ws://<host>:<port>/api/v1/ws`. Authentication happens during the HTTP upgrade handshake via `Authorization: Bearer <token>` or the subprotocol `kimi-code.bearer.<token>` (see [Authentication](./server-api.md#authentication)).

There is no handshake frame. Once connected, the client immediately receives [global events](#global-events) and can send commands right away.

### Heartbeat

| Direction | Rule |
| --- | --- |
| Server → Client | Sends `{ "type": "ping" }` every 10 seconds; the client replies with `{ "type": "pong" }` |
| Server timeout | Checks every 10 seconds on a monotonic clock and closes connections silent for 20 seconds with code `1001` (`heartbeat timeout`, occurring after 20–30 seconds of silence) |
| Client timeout | If no frame arrives for 25 seconds (also checked immediately when a background tab becomes visible or network connectivity returns), disconnect and reconnect as described in [Reconnecting](#reconnecting) |

```wire
S {"type": "ping"}
C { "type": "pong" }
```

Any valid inbound JSON frame with a string `type` counts as client activity; invalid JSON or frames without `type` are ignored. The server times heartbeats on a monotonic clock (unaffected by wall-clock adjustments or system sleep); if the server's own event loop stalls for more than 12.5 seconds, it sends a fresh `ping` and grants a new 20-second window, draining already-buffered socket messages before closing.

### Commands and responses

Client WebSocket commands are flat JSON frames and must include a non-empty `request_id` (missing `request_id` on a known command closes the socket with code `1008`). The server replies to every command with a `response` frame:

```wire focus=request_id,code,msg
C { "type": "subscribe", "request_id": "sub-1", "session_id": "s1", "agent_ids": ["main"] }
S {"type": "response", "request_id": "sub-1", "code": 0}
C { "type": "subscribe", "request_id": "sub-2", "session_id": "s404" }
S {"type": "response", "request_id": "sub-2", "code": 40401, "msg": "session not found"}
```

`subscribe` and `unsubscribe` commands on the same connection run sequentially in send order; task commands (`task.*`) serialize per task without blocking subscriptions. Conversation, interaction, task-state (`task`), agent-state (`agent`, `context`, `goal`, `todo`), and global event frames carry an ISO 8601 `event_created_at` timestamp (`response`, `ping` / `pong`, `task.list`, and `task.output` do not).

| Command | Fields | Purpose |
| --- | --- | --- |
| `subscribe` | `request_id`, `session_id`, `agent_ids?` | Subscribe to a session (defaults to `["main"]`); sending `subscribe` again adds agents incrementally |
| `unsubscribe` | `request_id`, `session_id`, `agent_ids?` | Stop receiving the listed agents, or the entire session when `agent_ids` is omitted or the last agent is removed |
| `task.watch` | `request_id`, `session_id`, `agent_id`, `task_id`, `since_offset?`, `tail_bytes?` | Stream a task's output; the `response` includes the current `task` state |
| `task.unwatch` | `request_id`, `session_id`, `agent_id`, `task_id` | Stop streaming task output |
| `task.stop` | `request_id`, `session_id`, `agent_id`, `task_id` | Stop a running task; the `response` includes the updated `task` state |
| `task.background` | `request_id`, `session_id`, `agent_id`, `task_id` | Detach a foreground task into the background; the `response` includes the updated `task` state |

## Subscribing to a session

Besides the main agent (`main`), a session can contain subagents, swarm members, and side chats (`btw`), each with its own conversation and state. The walkthrough below shows opening a session, receiving its initial state, and expanding/collapsing a subagent panel:

<ol class="kap-walk">
<li>
<strong>Subscribe to a session and receive initial content</strong>
The user opens session <code>s1</code>. Upon receiving a successful <code>response</code>, the client clears its local state for <code>s1</code> and applies the pending interactions, running task list, agent state frames, and the latest page of <code>turns</code>:

```wire focus=agent_ids,code,interaction_id,tasks,status,context_tokens,has_more
C { "type": "subscribe", "request_id": "sub-1", "session_id": "s1", "agent_ids": ["main"] }
S {"type": "response", "request_id": "sub-1", "code": 0}
S {"type": "interaction", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "sub_7", "interaction_id": "i12", "kind": "approval", "status": "pending", "tool_call_id": "c7", "request": {"tool_name": "Bash", "action": "Run command", "expires_at": "2026-10-30T10:30:00.000Z"}}
S {"type": "task.list", "session_id": "s1", "agent_id": "main", "tasks": [{"task_id": "task-7q2m", "kind": "subagent", "status": "running", "phase": "working", "detached": false, "description": "Find call sites", "child_agent_id": "sub_7", "parent_tool_call_id": "call_agent_1", "started_at": "2026-10-29T10:29:50.000Z"}]}
S {"type": "agent", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "status": "running", "compacting": false, "model": "kimi-for-coding", "thinking": "high", "permission_mode": "manual", "plan_mode": false, "swarm_mode": false, "tower_mode": false}
S {"type": "context", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "context_tokens": 18210, "max_context_tokens": 262144}
S {"type": "goal", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main"}
S {"type": "todo", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "items": []}
S {"type": "turns", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turns": [{"turn_id": "t_9", "ordinal": 9, "turn_number": 9, "kind": "agent", "status": "running", "started_at": "2026-10-29T10:29:45.000Z", "steps": [], "items": []}], "has_more": true}
```

Even though only `main` is in `agent_ids`, the approval `i12` requested by subagent `sub_7` still arrives (`interaction` frames are session-wide and bypass `agent_ids`), while `sub_7`'s running status and description appear on `main`'s subagent entry in `task.list`.
</li>
<li>
<strong>Expand and collapse a subagent panel</strong>
When the user expands <code>sub_7</code>, send an incremental <code>subscribe</code> with <code>agent_ids: ["sub_7"]</code> (already-subscribed <code>main</code> does not resend <code>turns</code>); when collapsing the panel, unsubscribe <code>sub_7</code>:

```wire focus=agent_ids,agent_id,code
C { "type": "subscribe", "request_id": "sub-2", "session_id": "s1", "agent_ids": ["sub_7"] }
S {"type": "response", "request_id": "sub-2", "code": 0}
S {"type": "task.list", "session_id": "s1", "agent_id": "sub_7", "tasks": []}
S {"type": "agent", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "sub_7", "status": "running", "compacting": false, "model": "kimi-for-coding", "plan_mode": false, "swarm_mode": false, "tower_mode": false}
S {"type": "todo", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "sub_7", "items": []}
S {"type": "turns", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "sub_7", "turns": [], "has_more": false}
... User collapses the subagent panel
C { "type": "unsubscribe", "request_id": "unsub-1", "session_id": "s1", "agent_ids": ["sub_7"] }
S {"type": "response", "request_id": "unsub-1", "code": 0}
```
</li>
</ol>

Frame ordering on subscription:

1. **Reply (`response`)**: Always arrives first. If the session cannot be opened, `code` is non-zero (`40401`, `40930`, `40931`) and no subscription is created.
2. **Pending interactions (`interaction`)**: Sent immediately after `response` for all unresolved approvals and questions in the session. Every successful `subscribe` resends all pending interactions so the client can replace its local interaction list.
3. **Tasks and state (`task.list`, `agent`, `context`, `goal`, `todo`)**: Sent for each newly subscribed agent. Subscribing to a brand-new session materializes `main` automatically.
4. **Conversation page (`turns` or `turns.failed`)**: Loaded asynchronously from disk (up to the latest 10 turns within 1 MiB) and may arrive after live state frames, but **live conversation frames (`turn.*`, `item.*`, `turns.removed`, `notice`) for an agent never arrive before its `turns` frame** — frames produced during loading are buffered and flushed in order right after `turns`.

### When the server closes and reopens a session

The server reclaims sessions idle for 30 minutes (`KIMI_CODE_SESSION_IDLE_RECLAIM_MS`) when they have no running turn, pending interaction, or cron job; `:reload` also closes and reopens a session.

- **Idle reclaim and reload**: Subscriptions remain active across close/reopen. When the session reopens, the server resends `task.list`, state frames, and `turns` for every subscribed agent. Whenever a client receives `turns`, it replaces the latest turns for that agent.
- **Archive or delete**: Archiving or deleting a session removes all subscriptions and broadcasts the corresponding global event. After restoring an archived session, send `subscribe` again.

### Who receives which frames

| Frame category | Recipients |
| --- | --- |
| [Global events](#global-events) | Every open WebSocket connection (no subscription needed) |
| `interaction` | Every connection subscribed to the session, **regardless of `agent_ids`** |
| `turns`, `turns.removed`, `turns.failed`, `turn.*`, `item.*`, `notice` | Connections subscribed to the session whose `agent_ids` include `agent_id` |
| `task.list`, `task`, `agent`, `context`, `goal`, `todo` | Same as above |
| `task.output` | Connections watching that task via `task.watch` (no session subscription needed) |

### Frame ordering

- Frames for the same session share one outbound queue (flushed every 16 ms or 64 frames; `response` and `interaction` flush immediately without overtaking queued frames).
- When a turn finishes, `turn.ended` always precedes the `agent` frame with `status: "idle"` (unless the initial `turns` page is still loading).
- HTTP responses and WebSocket frames travel over separate channels and may arrive in either order. Match them by `prompt_id`, `turn_id`, or `interaction_id`.

## Conversation

An agent's conversation is an ordered list of **turns (`Turn`)**, each containing an ordered list of **items (`Item`)**. The walkthrough below shows a complete turn (user message, reasoning, tool call, assistant reply) followed by a turn that retries an upstream error and fails:

<ol class="kap-walk">
<li>
<strong>Turn start and user message</strong>

```wire focus=turn.turn_id,turn.kind,item.type,item.prompt_ids,item.placement
S {"type": "turn.started", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn": {"turn_id": "t_1", "ordinal": 0, "turn_number": 0, "kind": "agent", "status": "running", "started_at": "2026-10-29T10:30:00.000Z", "steps": []}}
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "u_1", "type": "user_message", "status": "ended", "outcome": "completed", "created_at": "2026-10-29T10:30:00.000Z", "prompt_ids": ["p-1"], "placement": "opener", "origin": {"kind": "user"}, "text": "Does the start command in README still work?", "attachments": [], "skills": []}}
```
</li>
<li>
<strong>Reasoning and tool call (Step 1)</strong>

```wire focus=item.type,item.name,item.stage,field,delta,set,item.output,step.finish_reason
S {"type": "item.started", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "r_1", "type": "reasoning", "step_index": 1, "status": "running", "created_at": "2026-10-29T10:30:00.400Z", "text": "", "started_at": "2026-10-29T10:30:00.400Z"}}
S {"type": "item.delta", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item_id": "r_1", "field": "text", "delta": "Let's read README.md first"}
S {"type": "item.started", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "call_read_1", "type": "tool_call", "step_index": 1, "status": "running", "created_at": "2026-10-29T10:30:01.700Z", "name": "Read", "stage": "input", "started_at": "2026-10-29T10:30:01.700Z"}}
S {"type": "item.delta", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item_id": "call_read_1", "field": "input_text", "delta": "{\"path\":\"README.md\"}"}
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "r_1", "type": "reasoning", "step_index": 1, "status": "ended", "outcome": "completed", "created_at": "2026-10-29T10:30:00.400Z", "text": "Let's read README.md first to check the script.", "started_at": "2026-10-29T10:30:00.400Z", "duration_ms": 1200}}
S {"type": "item.updated", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item_id": "call_read_1", "set": {"stage": "executing", "input": {"path": "README.md"}}}
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "call_read_1", "type": "tool_call", "step_index": 1, "status": "ended", "outcome": "completed", "created_at": "2026-10-29T10:30:01.700Z", "name": "Read", "stage": "executing", "input": {"path": "README.md"}, "output": "1\t# App\n2\tRun `pnpm dev`", "started_at": "2026-10-29T10:30:01.700Z", "ended_at": "2026-10-29T10:30:02.100Z"}}
S {"type": "turn.updated", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "step": {"index": 1, "outcome": "completed", "finish_reason": "tool_calls", "started_at": "2026-10-29T10:30:00.300Z", "ended_at": "2026-10-29T10:30:02.100Z", "usage": {"input_other": 5210, "output": 96, "input_cache_read": 0, "input_cache_creation": 0}}}
```
</li>
<li>
<strong>Assistant reply and turn completion (Step 2)</strong>

```wire focus=item.type,delta,item.text,turn.outcome,turn.duration_ms
S {"type": "item.started", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "a_1", "type": "assistant_message", "step_index": 2, "status": "running", "created_at": "2026-10-29T10:30:02.400Z", "text": ""}}
S {"type": "item.delta", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item_id": "a_1", "field": "text", "delta": "Yes, `pnpm dev` in README matches package.json."}
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "a_1", "type": "assistant_message", "step_index": 2, "status": "ended", "outcome": "completed", "created_at": "2026-10-29T10:30:02.400Z", "text": "Yes, `pnpm dev` in README matches package.json."}}
S {"type": "turn.updated", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "step": {"index": 2, "outcome": "completed", "finish_reason": "stop", "started_at": "2026-10-29T10:30:02.200Z", "ended_at": "2026-10-29T10:30:04.200Z"}}
S {"type": "turn.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn": {"turn_id": "t_1", "ordinal": 0, "turn_number": 0, "kind": "agent", "status": "ended", "outcome": "completed", "started_at": "2026-10-29T10:30:00.000Z", "ended_at": "2026-10-29T10:30:04.200Z", "duration_ms": 4200, "steps": [{"index": 1, "outcome": "completed", "finish_reason": "tool_calls", "started_at": "2026-10-29T10:30:00.000Z", "ended_at": "2026-10-29T10:30:04.200Z"}, {"index": 2, "outcome": "completed", "finish_reason": "stop", "started_at": "2026-10-29T10:30:02.200Z", "ended_at": "2026-10-29T10:30:04.200Z"}]}}
```
</li>
<li>
<strong>Provider error, retry countdown, and failed turn</strong>
When an LLM request hits a retryable error, <code>turn.updated</code> carries <code>retry</code> (and <code>item.removed</code> drops any partial reply from the failed attempt before the retry starts). If retries are exhausted, the turn ends with <code>outcome: "failed"</code>:

```wire focus=retry.attempt,retry.delay_ms,turn.outcome,turn.end_reason,turn.error
S {"type": "turn.updated", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_2", "retry": {"attempt": 1, "next_attempt": 2, "max_attempts": 3, "delay_ms": 2000, "error": {"name": "ProviderError", "message": "upstream overloaded", "status_code": 529}}}
S {"type": "turn.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn": {"turn_id": "t_2", "ordinal": 1, "turn_number": 1, "kind": "agent", "status": "ended", "outcome": "failed", "end_reason": "error", "error": {"code": "provider.overloaded", "message": "Provider overloaded, please try again later", "status_code": 529, "retryable": true}, "started_at": "2026-10-29T10:31:00.000Z", "ended_at": "2026-10-29T10:31:08.000Z", "steps": []}}
```
</li>
</ol>

### Turns

| Field | Description |
| --- | --- |
| `turn_id` | Session-unique ID; never reused after an undo |
| `ordinal` | Zero-based position in the agent's current history; sort turns by `ordinal` and pass it as `before_ordinal` when paging backward |
| `turn_number` | Engine turn number used by the [file history endpoints](./server-api-sessions.md#get-api-v1-sessions-session-id-file-history-changes) |
| `kind` | `agent` (normal turn) or `system` (a turn containing a single `system` item between turns, such as manual compaction or a fork boundary) |
| `status` | `running` or `ended` |
| `outcome` | Present when `status` is `ended`: `completed`, `interrupted`, or `failed` |
| `end_reason` | When `interrupted`: `user_cancelled` or `aborted`; when `failed`: `error`, `max_steps`, `filtered`, or `blocked` |
| `error` | On failed turns: `{ code, message, name?, status_code?, request_id?, retryable? }` |
| `retry` | On running turns waiting to retry: `{ attempt, next_attempt, max_attempts, delay_ms, error: { name, message, status_code? } }` |
| `started_at`, `ended_at?`, `duration_ms?` | Timestamps and duration in milliseconds |
| `usage` | Sum of step token usage: `{ input_other, output, input_cache_read, input_cache_creation }` |
| `steps` | Finished steps: `{ index, outcome, started_at, ended_at?, finish_reason?, usage? }` |
| `items` | Ordered items in the turn (`turn.started` and `turn.ended` omit `items`; keep existing items for that turn) |

### Items

Every item shares these base fields:

| Field | Description |
| --- | --- |
| `item_id` | Item ID (for `tool_call`, this is the tool call ID) |
| `type` | `user_message` / `reasoning` / `assistant_message` / `tool_call` / `notification` / `system` |
| `step_index` | Step number that produced the item |
| `status` | `running` or `ended` |
| `outcome` | Present when `status` is `ended`: `completed`, `interrupted`, or `failed` |
| `created_at` | Creation timestamp (ISO 8601) |
| `debug` | Attached to the last item of each finished step when `KIMI_CODE_DEBUG=1`: `{ finish_reason?, usage?, timing? }` |

#### `user_message`

| Field | Description |
| --- | --- |
| `prompt_ids` | Client `prompt_id` values carried by this message (multiple steers merged at the same point list all of their IDs). Retire local optimistic bubbles whose `prompt_id` appears in `prompt_ids` |
| `placement` | `opener` (started the turn) or `steer` (inserted into a running turn) |
| `origin` | `{ kind: "user" }`, `{ kind: "skill", name, path?, args? }`, `{ kind: "plugin_command", plugin_id, command, args? }`, `{ kind: "cron", job_id, schedule, recurring, coalesced_count, stale }`, `{ kind: "hook", hook_event }`, `{ kind: "goal" }`, `{ kind: "retry" }`, or `{ kind: "system" }` |
| `text` | User-visible text (strips system-injected attachment notices, image compression notes, and bundled skill bodies) |
| `attachments` | `{ kind: "image" \| "video" \| "audio" \| "file", file_id?, url?, name?, media_type?, size?, ordinal }[]` |
| `skills` | Bundled skills: `{ name, path?, args? }[]` |
| `metadata` | Echoes the custom `metadata` submitted with the prompt |

#### `assistant_message` and `reasoning`

- **`assistant_message`**: `{ text }`, the model's reply.
- **`reasoning`**: `{ text, started_at, duration_ms? }`, the model's reasoning output (`duration_ms` is populated once `ended`).

#### `tool_call`

| Field | Description |
| --- | --- |
| `name` | Tool name (e.g., `Bash`, `Read`, `Edit`, `Agent`, `ExitPlanMode`) |
| `stage` | `input` (streaming arguments) → `awaiting_approval` (waiting for user decision) → `executing` |
| `input`, `input_text` | Parsed input object and raw argument text streamed during `stage: "input"` |
| `output`, `error` | Streaming output and normal result text in `output`; failure (`failed`) or stop (`interrupted`) output (including partial output before the stop) in `error` |
| `fields`, `media`, `note` | Handler field snapshot, media attachments (`{ kind, file_id?, url?, media_type? }`), and model note |
| `task_id` | Task ID when the tool runs as (or is detached to) a background task; use with `task.watch` / `task.stop` |
| `interaction_id` | Associated approval or question ID (matches [`interaction`](#approvals-and-questions)) |
| `agent_refs` | Spawned subagents or swarm members: `{ agent_id, role: "child" \| "member", swarm_index?, task_id? }[]` |
| `display` | For `ExitPlanMode`: `{ kind: "plan_review", plan, path?, options, review }` |
| `started_at`, `ended_at?` | Start and end timestamps |

#### `notification`

Background task notification delivered into the conversation: `{ notification_id, title, body, severity: "info" \| "warning" \| "error", notification_type, source: { kind, id }, task_id?, agent_id?, output?: { file?, preview?, bytes?, truncated? }, answer?: { answers: Record<string, string \| true>, note?: string } }`.

#### `system`

| `kind` | Extra fields | Description |
| --- | --- | --- |
| `compaction` | `trigger: "manual" \| "auto"`, `instruction?`, `tokens_before?`, `tokens_after?`, `compacted_count?`, `summary?` | Completed context compaction divider |
| `fork_boundary` | `source: "btw" \| "fork"`, `forked_from: { agent_id }` | Opening boundary of a forked or side-chat (`btw`) agent |

### Live updates

Clients reduce conversation frames with these rules:

| Frame | Payload | Client action |
| --- | --- | --- |
| `turns` | `turns: Turn[]`, `has_more: boolean` | Sent on subscribe or session reopen; replaces the latest turns for that agent |
| `turns.failed` | `code: number`, `msg: string` | Initial conversation load failed (the subscription remains active; show an error state and replace it if a later `turns` frame arrives) |
| `turn.started`, `turn.ended` | `turn` (without `items`) | Insert or update the turn header by `turn_id`, preserving its existing `items`; sort turns by `ordinal` |
| `turn.updated` | `turn_id`, `step?`, `retry?` | Write `step` into `turn.steps` by `index`; replace `turn.retry` (or clear it when omitted) |
| `item.started`, `item.ended` | `turn_id`, `item` | Replace the item with matching `(turn_id, item_id)` in place, or append to `turn.items` if new |
| `item.delta` | `turn_id`, `item_id`, `field`, `delta` | Append `delta` to `item[field]` (`text`, `input_text`, or `output`) |
| `item.updated` | `turn_id`, `item_id`, `set` | Shallow-merge `set` onto the item |
| `item.removed` | `turn_id`, `item_id` | Remove the item from the turn (used when a retried step discards its partial reply) |
| `turns.removed` | `turn_ids: string[]` | Delete the listed turns by `turn_id` and discard any in-flight pagination requests sent before this frame |
| `notice` | `{ level, title, detail?, code? }` | Show a transient toast/banner (e.g., `compaction.cancelled`); do not insert into turns |

## Submitting input

Submit user input with [`POST /api/v1/sessions/{session_id}/prompts`](./server-api-sessions.md#post-api-v1-sessions-session-id-prompts). The walkthrough below shows submitting while idle, queueing while busy and converting to a steer, and retrying idempotently after a timeout:

<ol class="kap-walk">
<li>
<strong>Submit while idle: starts a new turn immediately</strong>

```wire focus=prompt_id,status,item.prompt_ids,item.placement
H POST /api/v1/sessions/s1/prompts
  { "prompt_id": "p-1", "content": [ { "type": "text", "text": "Investigate this error" } ] }
R { "prompt_id": "p-1", "user_message_id": "u_1", "status": "running", "content": [ { "type": "text", "text": "Investigate this error" } ], "created_at": "2026-10-29T10:35:00.000Z" }
S {"type": "turn.started", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn": {"turn_id": "t_1", "ordinal": 0, "turn_number": 0, "kind": "agent", "status": "running", "started_at": "2026-10-29T10:35:00.000Z", "steps": []}}
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "u_1", "type": "user_message", "status": "ended", "outcome": "completed", "created_at": "2026-10-29T10:35:00.000Z", "prompt_ids": ["p-1"], "placement": "opener", "origin": {"kind": "user"}, "text": "Investigate this error", "attachments": [], "skills": []}}
```
</li>
<li>
<strong>Submit while busy: queued, then steered into the active turn</strong>

```wire focus=status,steered,prompt_ids,item.placement,item.prompt_ids
H POST /api/v1/sessions/s1/prompts
  { "prompt_id": "p-2", "content": [ { "type": "text", "text": "Also check lint" } ] }
R { "prompt_id": "p-2", "user_message_id": "u_2", "status": "queued", "content": [ { "type": "text", "text": "Also check lint" } ], "created_at": "2026-10-29T10:35:10.000Z" }
H POST /api/v1/sessions/s1/prompts:steer
  { "prompt_ids": ["p-2"] }
R { "steered": true, "prompt_ids": ["p-2"] }
... Current step finishes; steer is injected at the next boundary
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "u_2", "type": "user_message", "status": "ended", "outcome": "completed", "created_at": "2026-10-29T10:35:12.000Z", "prompt_ids": ["p-2"], "placement": "steer", "origin": {"kind": "user"}, "text": "Also check lint", "attachments": [], "skills": []}}
```
</li>
<li>
<strong>Network timeout: resend with the same <code>prompt_id</code></strong>

```wire focus=prompt_id,status
H POST /api/v1/sessions/s1/prompts
  { "prompt_id": "p-3", "content": [ { "type": "text", "text": "Run unit tests too" } ] }
... Request times out; client resends the exact same payload and prompt_id
H POST /api/v1/sessions/s1/prompts
  { "prompt_id": "p-3", "content": [ { "type": "text", "text": "Run unit tests too" } ] }
R { "prompt_id": "p-3", "user_message_id": "u_3", "status": "queued", "content": [ { "type": "text", "text": "Run unit tests too" } ], "created_at": "2026-10-29T10:35:20.000Z" }
```
</li>
</ol>

### Starting or queueing

- **Immediate turn**: When the target agent is idle, its queue is empty, and no undo, compaction, or fork is running, the submission starts a turn immediately and returns `status: "running"` (or `blocked` / `failed` if rejected by a hook before starting).
- **Queued**: Otherwise (including during undo, compaction, or fork), the submission enters the queue and returns `status: "queued"` immediately. Read `main`'s active and queued prompts with [`GET /api/v1/sessions/{session_id}/prompts`](./server-api-sessions.md#get-api-v1-sessions-session-id-prompts).

### Retries and idempotency

Generate a session-unique `prompt_id` on the client for every submission:

- Resending the same `prompt_id` with an identical body returns the original response (or waits for an in-flight first request) without duplicating the prompt or re-applying overrides.
- Reusing a `prompt_id` with a different body or across `/prompts`, `/steer`, and `skills/{name}:activate` returns `40927`.

### Steering

To inject input into a running turn before it finishes:

- **Direct steer**: Call [`POST /api/v1/sessions/{session_id}/steer`](./server-api-sessions.md#post-api-v1-sessions-session-id-steer) with the same body as `/prompts`.
- **Steer queued prompts**: Call [`POST /api/v1/sessions/{session_id}/prompts:steer`](./server-api-sessions.md#post-api-v1-sessions-session-id-prompts-steer) with `prompt_ids`. Once inserted, the prompt appears in the turn as a `user_message` with `placement: "steer"`.

## Stopping, undoing, and compacting

The walkthrough below shows stopping a running turn, undoing turns, running manual compaction, and starting a read-only side chat (`btw`):

<ol class="kap-walk">
<li>
<strong>Withdraw a queued prompt and cancel the active turn (<code>:cancel</code>)</strong>

```wire focus=aborted,cancelled,item.outcome,turn.outcome,turn.end_reason
H POST /api/v1/sessions/s1/prompts/p-9:abort
R { "aborted": true }
H POST /api/v1/sessions/s1:cancel
R { "cancelled": true }
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_3", "item": {"item_id": "call_bash_1", "type": "tool_call", "step_index": 1, "status": "ended", "outcome": "interrupted", "created_at": "2026-10-29T10:36:00.000Z", "name": "Bash", "stage": "executing", "error": "partial output...\n[Command interrupted by user]", "started_at": "2026-10-29T10:36:00.000Z", "ended_at": "2026-10-29T10:36:02.000Z"}}
S {"type": "turn.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn": {"turn_id": "t_3", "ordinal": 2, "turn_number": 2, "kind": "agent", "status": "ended", "outcome": "interrupted", "end_reason": "user_cancelled", "started_at": "2026-10-29T10:35:50.000Z", "ended_at": "2026-10-29T10:36:02.000Z", "steps": []}}
```
</li>
<li>
<strong>Undo turn <code>t_5</code> and all subsequent turns (<code>:undo</code>)</strong>

```wire focus=turn_id,removed_turn_ids,turn_ids
H POST /api/v1/sessions/s1:undo
  { "turn_id": "t_5" }
R { "removed_turn_ids": ["t_5", "t_6", "t_7"] }
S {"type": "turns.removed", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_ids": ["t_5", "t_6", "t_7"]}
```
</li>
<li>
<strong>Compact context manually (<code>:compact</code>)</strong>

```wire focus=compacting,turn.kind,item.kind,item.tokens_before,item.tokens_after
H POST /api/v1/sessions/s1:compact
  { "instruction": "Keep database migration conclusions" }
R {}
S {"type": "agent", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "status": "idle", "compacting": true, "plan_mode": false, "swarm_mode": false, "tower_mode": false}
S {"type": "turn.started", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn": {"turn_id": "t_8", "ordinal": 5, "turn_number": 5, "kind": "system", "status": "ended", "outcome": "completed", "started_at": "2026-10-29T10:38:00.000Z", "ended_at": "2026-10-29T10:38:00.000Z", "steps": []}}
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_8", "item": {"item_id": "sys_1", "type": "system", "status": "ended", "outcome": "completed", "created_at": "2026-10-29T10:38:00.000Z", "kind": "compaction", "trigger": "manual", "instruction": "Keep database migration conclusions", "tokens_before": 182340, "tokens_after": 8120, "summary": "…"}}
S {"type": "turn.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn": {"turn_id": "t_8", "ordinal": 5, "turn_number": 5, "kind": "system", "status": "ended", "outcome": "completed", "started_at": "2026-10-29T10:38:00.000Z", "ended_at": "2026-10-29T10:38:00.000Z", "steps": []}}
S {"type": "agent", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "status": "idle", "compacting": false, "plan_mode": false, "swarm_mode": false, "tower_mode": false}
```
</li>
<li>
<strong>Start a read-only side chat (<code>:btw</code>)</strong>

```wire focus=agent_id,agent_ids,code
H POST /api/v1/sessions/s1:btw
R { "agent_id": "btw_1" }
C { "type": "subscribe", "request_id": "sub-btw", "session_id": "s1", "agent_ids": ["btw_1"] }
S {"type": "response", "request_id": "sub-btw", "code": 0}
```
</li>
</ol>

### Stopping a turn

- [`POST /api/v1/sessions/{session_id}:cancel`](./server-api-sessions.md#post-api-v1-sessions-session-id-cancel) cancels the target agent's running turn (defaults to `main`, or pass `agent_id` for a subagent or side conversation); passing `include_background: true` also stops detached background tasks. Returns `{ cancelled: true }` when a turn or background task was cancelled, or `{ cancelled: false }` idempotently when idle. In-flight `tool_call` items end with `outcome: "interrupted"` and keep partial output; pending interactions end with `cancelled`.
- Cancelling a turn does not clear queued user prompts. To stop everything, first withdraw queued prompts with [`POST .../prompts/{prompt_id}:abort`](./server-api-sessions.md#post-api-v1-sessions-session-id-prompts-prompt-id-abort), then call `:cancel`.

### Undo

- [`POST /api/v1/sessions/{session_id}:undo`](./server-api-sessions.md#post-api-v1-sessions-session-id-undo) takes `{ turn_id, agent_id? }` and removes that turn and all later turns without rolling back disk files.
- The target turn must have `kind: "agent"` and open with a `user_message` whose `origin.kind` is `user`, `skill`, or `plugin_command`; it cannot cross a prior compaction (`40911`), and returns `40901` while the agent is busy.

### Compaction

- [`POST /api/v1/sessions/{session_id}:compact`](./server-api-sessions.md#post-api-v1-sessions-session-id-compact) starts manual compaction when `main` is idle (returns `40910` when busy or already compacting).
- During compaction `agent.compacting` is `true`; completion emits a `system` turn carrying a `compaction` item; cancellation emits a `notice` frame with `code: "compaction.cancelled"`.

## Approvals and questions

When a tool call requires permission (`approval`) or asks the user a structured question (`question`), the server pushes an `interaction` frame to every subscriber of the session. Clients reply via [`POST /api/v1/sessions/{session_id}/interactions/{interaction_id}`](./server-api-sessions.md#post-api-v1-sessions-session-id-interactions-interaction-id):

<ol class="kap-walk">
<li>
<strong>Receive an approval request and approve for the session</strong>

```wire focus=set,interaction_id,kind,status,decision,scope,outcome
S {"type": "item.updated", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_3", "item_id": "c7", "set": {"stage": "awaiting_approval", "interaction_id": "i9"}}
S {"type": "interaction", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "interaction_id": "i9", "kind": "approval", "status": "pending", "tool_call_id": "c7", "request": {"tool_name": "Bash", "action": "Run command", "tool_input_display": {"command": "rm -rf dist"}, "expires_at": "2026-10-30T10:31:00.000Z"}}
H POST /api/v1/sessions/s1/interactions/i9
  { "kind": "approval", "decision": "approved", "scope": "session" }
R { "outcome": "approved", "ended_at": "2026-10-29T10:31:00.000Z" }
S {"type": "interaction", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "interaction_id": "i9", "kind": "approval", "status": "ended", "outcome": "approved", "ended_at": "2026-10-29T10:31:00.000Z", "response": {"decision": "approved", "scope": "session"}, "request": {"tool_name": "Bash", "action": "Run command", "tool_input_display": {"command": "rm -rf dist"}, "expires_at": "2026-10-30T10:31:00.000Z"}}
S {"type": "item.updated", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_3", "item_id": "c7", "set": {"stage": "executing"}}
```
</li>
<li>
<strong>Receive a question and submit an answer</strong>

```wire focus=interaction_id,kind,request.questions,answers,outcome
S {"type": "interaction", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "interaction_id": "i10", "kind": "question", "status": "pending", "tool_call_id": "c8", "request": {"questions": [{"id": "q1", "question": "Which package manager?", "multi_select": false, "allow_other": true, "options": [{"id": "a", "label": "pnpm (Recommended)"}, {"id": "b", "label": "npm"}]}]}}
H POST /api/v1/sessions/s1/interactions/i10
  { "kind": "question", "answers": { "q1": { "kind": "single", "option_id": "a" } }, "method": "click" }
R { "outcome": "answered", "ended_at": "2026-10-29T10:31:20.000Z" }
S {"type": "interaction", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "interaction_id": "i10", "kind": "question", "status": "ended", "outcome": "answered", "ended_at": "2026-10-29T10:31:20.000Z", "request": {"questions": [{"id": "q1", "question": "Which package manager?", "multi_select": false, "allow_other": true, "options": [{"id": "a", "label": "pnpm (Recommended)"}, {"id": "b", "label": "npm"}]}]}, "response": {"answers": {"q1": "pnpm (Recommended)"}, "method": "click"}}
```
</li>
</ol>

| Field | Description |
| --- | --- |
| `interaction_id` | Unique interaction ID used in the reply endpoint URL |
| `kind` | `approval` or `question` |
| `status` | `pending` or `ended` |
| `agent_id`, `tool_call_id` | Originating agent and waiting `tool_call` item ID |
| `request` | Approval: `{ tool_name, action, tool_input_display?, expires_at }`; Question: `{ questions: [{ id, question, header?, body?, options: [{ id, label, description? }], multi_select?, allow_other? }] }` |
| `outcome`, `ended_at`, `response?` | Present when `status: "ended"`: `outcome` is `approved` / `rejected` / `cancelled` / `answered` / `dismissed` |

Client rules:

- **Close the card on the `status: "ended"` `interaction` frame**, not on the HTTP reply, so all open windows stay in sync.
- **Concurrent replies**: The first reply wins; later replies receive `40902` (already ended) or `40404` (evicted after 60 seconds / 256 entries). Treat both codes as resolved and close the card silently.

## Tasks

Shell commands (foreground and background) and subagents (including AgentSwarm members) are synchronized and controlled exclusively over WebSocket:

<ol class="kap-walk">
<li>
<strong>Start a background command and watch its output (<code>task.watch</code>)</strong>

```wire focus=task_id,detached,parent_tool_call_id,offset,text
S {"type": "task", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab", "kind": "shell", "status": "running", "detached": true, "description": "Start dev server", "command": "pnpm dev", "parent_tool_call_id": "call_bash_1", "started_at": "2026-10-29T10:33:20.100Z"}
C { "type": "task.watch", "request_id": "r2", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab" }
S {"type": "response", "request_id": "r2", "code": 0, "task": {"task_id": "bash-k3f9x2ab", "kind": "shell", "status": "running", "detached": true}}
S {"type": "task.output", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab", "offset": 0, "text": "> dev\n> vite\n\n"}
S {"type": "task.output", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab", "offset": 14, "text": "  VITE ready in 312 ms\n"}
```
</li>
<li>
<strong>Unwatch, resume from <code>since_offset</code>, and stop the task (<code>task.stop</code>)</strong>

```wire focus=since_offset,offset,text,status,outcome
C { "type": "task.unwatch", "request_id": "r3", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab" }
S {"type": "response", "request_id": "r3", "code": 0}
... Reopen the output panel and pass the UTF-8 byte end offset 37
C { "type": "task.watch", "request_id": "r4", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab", "since_offset": 37 }
S {"type": "response", "request_id": "r4", "code": 0, "task": {"task_id": "bash-k3f9x2ab", "kind": "shell", "status": "running", "detached": true}}
S {"type": "task.output", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab", "offset": 37, "text": "10:41:07 [vite] hmr update\n"}
C { "type": "task.stop", "request_id": "r5", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab" }
S {"type": "task", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab", "kind": "shell", "status": "ended", "outcome": "killed", "detached": true, "started_at": "2026-10-29T10:33:20.100Z", "ended_at": "2026-10-29T10:52:03.410Z"}
S {"type": "response", "request_id": "r5", "code": 0, "task": {"task_id": "bash-k3f9x2ab", "kind": "shell", "status": "ended", "outcome": "killed", "detached": true}}
```
</li>
</ol>

### Task list

| Field | Description |
| --- | --- |
| `task_id` | Task ID |
| `kind` | `shell` / `subagent` / `other` |
| `status` | `running` or `ended` (an ended task emits one final `task` frame and is absent from future `task.list` frames) |
| `outcome` | On ended tasks: `completed` / `failed` / `timed_out` / `killed` / `lost` |
| `phase` | On running subagents: `working` or `suspended` |
| `state_reason` | On suspended subagents: human-readable suspension reason |
| `detached` | `false` while the spawning tool call is still awaiting it (foreground); `true` when running in the background |
| `description`, `command` | Description and shell command string |
| `child_agent_id`, `parent_tool_call_id`, `swarm_index` | Subagent ID, spawning tool call ID, and swarm member index |
| `model`, `thinking` | Subagent model and thinking level |
| `started_at`, `ended_at`, `result_summary`, `error` | Timestamps, summary, and error |

### Task output and control

- **`task.watch` and byte-offset merging**: The server replies with `response` (carrying the current `task` state) followed by an initial `task.output` chunk (up to the last 32 KiB by default, max 1 MiB, or bytes after `since_offset` when within the tail window). If the initial chunk's `offset` matches your local UTF-8 byte length, append `text`; otherwise replace your local buffer with the chunk.
- **Stopping or backgrounding a foreground tool**: Foreground tasks appear in `task.list` with `detached: false` and `parent_tool_call_id`. Sending `task.stop` stops only that tool call while the turn continues; sending `task.background` detaches it (`detached: true`, the tool call completes immediately, and a `notification` item arrives when the background task finishes; AgentSwarm members cannot be detached and return `40933`).

## Agent state

Each agent's state is split into four independent full-replacement frames by update cadence:

| Frame | Core fields | Description |
| --- | --- | --- |
| `agent` | `status: "idle" \| "running" \| "ended"`, `compacting`, `model?`, `thinking?`, `permission_mode?`, `plan_mode`, `swarm_mode`, `tower_mode` | Running status and active settings. Update settings via [`POST /api/v1/sessions/{session_id}/profile`](./server-api-sessions.md#post-api-v1-sessions-session-id-profile) |
| `context` | `context_tokens`, `max_context_tokens?` | Context window water-level for this agent alone, **coalesced over a 250 ms window** |
| `goal` | `goal?: { objective, status, completion_criterion?, turns_used, tokens_used, wall_clock_ms }` | Main agent only (`goal` is omitted when no goal is active; increment `wall_clock_ms` locally for live timers) |
| `todo` | `items: [{ title, status: "pending" \| "in_progress" \| "done" }]` | Agent todo list, replaced as a whole on writes and `:undo` |

## Reconnecting

Subscriptions and `task.watch` streams do not persist across disconnects. After reconnecting:

1. **Resend `subscribe`**: When the `response` succeeds, clear local turns and in-flight pagination requests for that session, and rebuild state from the incoming `interaction`, `task.list`, state frames, and `turns`.
2. **Re-watch task output**: Resend `task.watch` for any open output panel with `since_offset` set to the UTF-8 byte length of your local buffer.
3. **Refresh global lists**: Global events missed while offline are not replayed; re-fetch [`GET /api/v1/sessions`](./server-api-sessions.md#get-api-v1-sessions) and other global lists via REST.

## Global events

Global events are sent to every connected WebSocket client without subscription. Every frame is flat and starts with `type` and `event_created_at`; there is no `session_id`, `timestamp`, or `payload` envelope:

```wire focus=type,change,session,kind
S {"type": "session", "event_created_at": "2026-10-29T10:41:30.000Z", "change": "updated", "session": {"id": "s2", "workspace_id": "wd_aaa_000000000000", "cwd": "/work/app", "title": "Fix login", "created_at": "2026-10-29T10:30:00.000Z", "updated_at": "2026-10-29T10:41:30.000Z", "activity": "idle", "pending_interaction": "none", "last_turn_outcome": "completed", "archived": false}}
S {"type": "invalidated", "event_created_at": "2026-10-29T10:42:00.000Z", "kind": "models"}
```

| `type` | Additional fields | Client rule |
| --- | --- | --- |
| `session` | `change`: `created` / `updated` / `archived` / `restored` / `deleted`; `session` is the full [session object](./server-api-sessions.md#session-object) | Replace by `session.id`; delete when `change` is `deleted`. Creation, renames, archive/restore, activity, and latest-turn outcomes all use this frame |
| `workspace` | `change`: `created` / `updated` / `deleted`; `workspace` is the full [workspace object](./server-api-service.md#workspace-object) | Replace by `workspace.id`; delete when `change` is `deleted` |
| `config` | `config` is the full configuration with secrets redacted; optional `warnings` is `{ domain?, message }[]` | Replace local config and surface any warnings |
| `invalidated` | `kind`: `models` / `plugins` | The list changed but its contents are not included: refetch `GET /api/v1/models` for `models`, or `GET /api/v1/plugins` for `plugins` |

Built-in capability installation progress uses a separate flat `event.capability.changed` frame with `event_created_at`, `capability_id`, and `install`. It is not an invalidation notice; clients should keep showing installation progress.
