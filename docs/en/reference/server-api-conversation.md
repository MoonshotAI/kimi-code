# Sessions and conversations

A client receives a session's conversation and state in real time over one WebSocket connection, and uses REST endpoints to submit input, answer approvals, stop, or undo. This page describes the protocol in the order a client uses it: connect, subscribe to a session, display the conversation, submit input, handle approvals and tasks, and recover after a disconnect. For the authentication, envelope, and error codes shared by all endpoints, see [Server API](./server-api.md). For the parameters of each REST endpoint, see [Session endpoints](./server-api-sessions.md).

## Connecting

The WebSocket has a single endpoint: `ws://<host>:<port>/api/v1/ws`. Authentication happens at the upgrade request. Put the token in the `Authorization: Bearer <token>` header or in the subprotocol `kimi-code.bearer.<token>` (see [Authentication](./server-api.md#authentication)).

There is no handshake. Once the connection opens, the client starts receiving [global events](#global-events) right away and can send commands directly.

### Heartbeat

| Direction | Rule |
| --- | --- |
| Server → client | The server sends `{ "type": "ping" }` every 10 seconds, and the client answers `{ "type": "pong" }` |
| Server detects a dead connection | The server checks every 10 seconds and closes the connection with code 1001 (reason `heartbeat timeout`) once 20 seconds have passed since the last inbound frame. The disconnect therefore happens after the client has been silent for 20–30 seconds |
| Client detects a dead connection | When the client receives no frame for 25 seconds in a row, it should treat the connection as dead and reconnect. See [Reconnecting](#reconnecting) for the steps after reconnecting |

Any well-formed inbound frame counts as client activity, including frame types the server does not recognize. Frames that are not valid JSON or have no string `type` are dropped and do not count as activity.

### Commands and responses

Commands from the client are flat JSON frames: the fields sit next to `type`, and every command carries a `request_id`. The server answers each command with one response:

```json
{ "type": "response", "request_id": "1", "code": 0, "msg": "...", "task": {} }
```

`code` `0` means success. `msg` and `task` appear only when needed. When a command has no readable `request_id`, the server closes the connection with code 1008. Frame types the server does not recognize are ignored.

`subscribe` and `unsubscribe` on the same connection are handled one at a time in the order they were sent: each waits until the previous one (including opening the session) has finished, and responses come back in send order. Task commands use a separate queue and do not wait for them; see [Task output and control](#task-output-and-control). One connection can subscribe to several sessions at once, and the sessions do not affect each other.

| Command | Fields | Purpose |
| --- | --- | --- |
| `subscribe` | `request_id`, `session_id`, `agent_ids?` | Subscribe to a session; see [Subscribing to a session](#subscribing-to-a-session) |
| `unsubscribe` | `request_id`, `session_id`, `agent_ids?` | Stop receiving some or all agents |
| `task.watch` | `request_id`, `session_id`, `agent_id`, `task_id`, `since_offset?`, `tail_bytes?` | Receive one task's output; see [Tasks](#tasks) |
| `task.unwatch` | `request_id`, `session_id`, `agent_id`, `task_id` | Stop receiving a task's output |
| `task.stop` | `request_id`, `session_id`, `agent_id`, `task_id` | Stop a task |
| `task.background` | `request_id`, `session_id`, `agent_id`, `task_id` | Move a task to the background |

## Subscribing to a session

A session can contain several agents: the main agent, subagents, swarm members, and side chats. `agent_ids` in the subscription selects which agents' frames to receive and defaults to `["main"]`. Sending `subscribe` again for the same session adds agents instead of replacing the existing ones.

```json
{ "type": "subscribe", "request_id": "1", "session_id": "session_...", "agent_ids": ["main"] }
```

Once the session is open, the server responds right away, before any frame of this subscription. When the session cannot be opened, the response carries an error code and no subscription is made: `40401` when the session does not exist, and other codes such as `40930` or `40931` say why it could not be opened. A malformed frame gets `40001`.

After a successful subscription, the client receives frames in this order:

1. **Response**: the `response` to `subscribe`.
2. **Pending interactions**: every approval and question in the session that has not been answered yet, sent to this connection as `interaction` frames (see [Approvals and questions](#approvals-and-questions)).
3. **Tasks and state**: for each agent the connection starts receiving, `task.list` (see [Tasks](#tasks)), followed by `agent`, `usage` (when the agent has a model context), `goal` (main agent only), and `todo` (see [Agent state](#agent-state)).
4. **Conversation**: for each agent the connection starts receiving, one `turns` frame with the latest turns (see [Live updates](#live-updates)). When the conversation cannot be loaded, a `turns.failed` frame is sent instead.

`turns` loads asynchronously and may arrive after live `task`, `agent`, and `usage` frames. An agent's conversation frames (`turn.*`, `item.*`, `turns.removed`, `notice`), however, never arrive before its `turns`: conversation frames produced while it loads are buffered and sent in order once `turns` has gone out, so nothing is lost.

When the main agent does not exist yet at subscription time, the server creates it first, so the main agent's state frames always follow a subscription. An agent listed in `agent_ids` that has not joined the session yet announces itself with `task` and state frames once it joins.

When `subscribe` is sent again for a session that is already subscribed, only the newly added agents get `task.list`, state frames, and `turns`; agents already being received do not get `turns` again. Every successful `subscribe`, however, resends all pending interactions of the session. The client replaces its local interaction cards with the interactions received after this response.

`unsubscribe` stops receiving the listed agents. Omitting `agent_ids`, or removing the last agent, drops the whole session subscription.

### When the server closes and reopens a session

The server closes a session that has been inactive for a while: 30 minutes by default, configurable with the environment variable `KIMI_CODE_SESSION_IDLE_RECLAIM_MS`. Sessions that are busy, have pending interactions, or have scheduled tasks are not closed, and whether the session has subscribers does not affect this. `:reload` also closes the session and then reopens it.

While the session is closed, no session frames are sent, but subscriptions stay valid. When the session reopens, the server resends `task.list`, `agent`, `usage`, `goal`, `todo`, and `turns` for every subscribed agent to these connections. So `turns` does not only follow a subscription: whenever the client receives it, the client must replace that agent's conversation with it.

When a session is archived or deleted, the server removes every connection's subscription to it, stops sending its session frames, and only emits the matching [global event](#global-events). After the session is restored, the client needs to subscribe again.

### Who receives which frames

| Frame | Sent to |
| --- | --- |
| [Global events](#global-events) | Every established connection, no subscription needed |
| `turns`, `turns.removed`, `turns.failed`, `turn.*`, `item.*`, `notice` | Connections subscribed to the session that are receiving this agent |
| `task.list`, `task`, `agent`, `usage`, `goal`, `todo` | Same as above |
| `interaction` | Every connection subscribed to the session, regardless of which agents it receives |
| `task.output` | Connections watching the task's output with `task.watch`, no session subscription needed |

Global events are event frames `{ "type", "session_id"?, "timestamp", "payload" }`, where `type` is the event type. Session frames are flat frames `{ "type", "session_id", "agent_id", ... }`.

### Frame ordering

All frames of one session go through the same send queue and are sent in the order they were produced. The server sends a batch every 16 milliseconds or once 64 frames have accumulated. `response` and `interaction` are sent immediately, but never overtake frames already queued. Global events go through a separate global queue and are also sent in the order they occurred.

When a turn ends, `turn.ended` always arrives before the `agent` frame whose `status` is `idle`. The exception is while the agent's `turns` is still loading: then the `agent` frame may arrive first.

REST responses and WebSocket frames travel on different channels, so their arrival order is not fixed. For example, after submitting input, `turn.started` and the matching `user_message` may arrive before the HTTP response. Clients match the two by `prompt_id` and must not rely on arrival order.

## Conversation

An agent's conversation is a list of turns, and each turn holds an ordered list of items. Each time the user submits input, everything the agent does to handle it forms one turn. The user input, replies, reasoning, and tool calls within the turn are its items.

Turns and items are generated from the agent's persisted session records, so REST pages, `turns` frames, and a reload after a server restart show the same turns with the same ids. Only the running step and the output a tool is still producing exist solely in memory. All times are ISO 8601 strings.

### Turns

| Field | Description |
| --- | --- |
| `turn_id` | Unique within the session and never reused. A turn opened after an undo gets a new id even when it reuses the `ordinal` of an undone turn |
| `ordinal` | The turn's position in the agent's current history, which determines turn order. Pass it as `before_ordinal` to read older turns |
| `kind` | `agent`: an ordinary turn. `system`: a turn between turns that holds a single `system` item, either a completed context compaction or the fork boundary that opens an agent forked from another agent |
| `status` | `running` or `ended`. A turn the agent does not run (for example, a prompt rejected by a hook) is `ended` as soon as it appears. A `system` turn is never `running` |
| `outcome` | Ended turns only: `completed`, `interrupted`, or `failed` |
| `end_reason` | For `interrupted`: `user_cancelled` (the user stopped it) or `aborted` (stopped for another reason, such as the server stopping while it ran). For `failed`: `error`, `max_steps`, `filtered` (the provider's content filter blocked the output), or `blocked` (a hook or a policy rejected the input) |
| `error` | Failed turns only: `{ code, message, name?, status_code?, request_id?, retryable? }` |
| `retry` | Running turns only, present while a failed model request waits to be retried: `{ attempt, next_attempt, max_attempts, delay_ms, error: { name, message, status_code? } }`, where `attempt` is the attempt that just failed. It clears when the next step starts, when a step ends, or when the turn ends |
| `turn_number` | The engine's turn number, used by the [file history endpoints](./server-api-sessions.md#get-api-v1-sessions-session-id-file-history-changes) |
| `started_at`, `ended_at?`, `duration_ms?` | Start time, end time, and duration |
| `usage` | The sum of the steps' usage |
| `steps` | Ended steps (each model request is one step), ordered by `index`: `{ index, outcome, started_at, ended_at?, finish_reason?, usage? }`. A step's `outcome` is `completed`, `interrupted`, or `failed`, and its `usage` is `{ input_other, output, input_cache_read, input_cache_creation }` |
| `items` | The turn's items; see the next section |

### Items

Every item has these fields:

| Field | Description |
| --- | --- |
| `item_id` | The item id. For a tool call, `item_id` is the tool call id |
| `type` | The item type; see the sections below |
| `step_index` | The step that produced the item |
| `status` | `running` or `ended` |
| `outcome` | `completed` for ended items unless noted otherwise below |
| `created_at` | Creation time |
| `debug` | When the server runs with `KIMI_CODE_DEBUG=1`, the last item of each ended step carries it to describe that step's model request: `{ finish_reason?, usage?, timing? }`. When measured, `timing` holds `first_token_ms`, `stream_ms`, `request_build_ms`, `server_first_token_ms`, `server_decode_ms`, `client_consume_ms`, and `client_blocked_ms`. When the step ends, the item is sent again as `item.ended` |

Items are listed in the order they appeared. The remaining fields of each item type follow.

#### `user_message`

An input as it appears once it enters the conversation.

| Field | Description |
| --- | --- |
| `prompt_ids` | The prompt ids this input carries, including the `prompt_id` of a bundled skill submission or a skill activation. Several steering inputs inserted at the same point merge into one `user_message` with `placement` `steer`, and `prompt_ids` lists all of them. A client retires a pending bubble it shows locally when `prompt_ids` contains the local id, and must not assume a one-to-one match. Empty for inputs the system triggered |
| `placement` | `opener` (the input that opens the turn) or `steer` (input inserted into a running turn) |
| `origin` | Where the input came from; see the table below |
| `text` | The visible text parts joined with newlines. It excludes bundled skill instructions, prompt hook output, the notices that point the model at attached files, and image compression notes. Empty for retries and internal triggers |
| `attachments` | The files and media in the input, in order: `{ kind: "image" \| "video" \| "audio" \| "file", file_id?, url?, name?, media_type?, size?, ordinal }`. Uploaded files carry `file_id`, inline and remote media carry `url`, media stored by the server is sent as a `data:` URL in pages, and a file attached by a server-local path carries only `name`, `media_type`, and `size` |
| `skills` | The skills activated with the input: `{ name, path?, args? }` |
| `metadata` | The `metadata` sent with the input, echoed as is |

Values of `origin`:

| `origin` | Source |
| --- | --- |
| `{ kind: "user" }` | User input |
| `{ kind: "skill", name, path?, args? }` | Skill activation |
| `{ kind: "plugin_command", plugin_id, command, args? }` | Plugin command |
| `{ kind: "cron", job_id, schedule, recurring, coalesced_count, stale }` | Scheduled task. A scheduled task fires only when the main agent is idle: if it comes due while the agent is running, it waits until the agent is idle, then opens a new turn. Several due times while it waits fire only once, and the count is recorded in `coalesced_count`. One-shot tasks, and recurring tasks after their last run, are deleted automatically |
| `{ kind: "hook", hook_event }` | Hook |
| `{ kind: "goal" }` | Goal continuation |
| `{ kind: "retry" }` | Retry |
| `{ kind: "system" }` | System. A CLI shell command (`!`) and its output appear as raw text in this kind of `user_message`, each in its own ended turn |

#### `assistant_message` and `reasoning`

- **`assistant_message`**: `{ text }`, the model's reply.
- **`reasoning`**: `{ text, started_at, duration_ms? }`, the model's reasoning output. `duration_ms` is how long the reasoning streamed and is present only after the item ends. Hidden reasoning is never sent.

#### `tool_call`

One tool call. Its `item_id` is the tool call id.

| Field | Description |
| --- | --- |
| `name` | Tool name |
| `stage` | The call's stage while it runs: `input` while the model streams the arguments, `awaiting_approval` while waiting for approval, and `executing` otherwise |
| `input` | Tool arguments |
| `input_text` | The raw argument text while `stage` is `input` |
| `output` | While running, the tool's live output streams into it; once ended, it is the text of the result |
| `fields` | A JSON object of the handler's latest field snapshot |
| `media` | After the call ends, the images, videos, and audio in the result: `{ kind, file_id?, url?, media_type? }` |
| `error` | Present when the result is an error. The item's `outcome` is then `failed`, and it has no `output` |
| `note` | Extra text the tool attached to its result for the model, such as the size and dimensions of an image read by `ReadMediaFile` |
| `task_id` | Present once the call's work runs as a background task, whether it started in the background or was moved there later. After the task has left `task.list`, it still works with `task.watch` and `task.stop` |
| `interaction_id` | The approval or question raised for this call. Its content comes with the [`interaction`](#approvals-and-questions) frames |
| `agent_refs` | The subagents this call started: `{ agent_id, role: "child" \| "member", swarm_index?, task_id? }` |
| `display` | `ExitPlanMode` calls only: `{ kind: "plan_review", plan, path?, options: [{ label, description }], review: { state: "pending" \| "approved" \| "rejected" \| "cancelled", selected_option?, feedback? } }` |
| `started_at`, `ended_at?` | Start and end time |

When the turn ends before the tool produces a result, the item's `outcome` is `interrupted`. A call running in the foreground has no `task_id`; to find its task, look for the task whose `parent_tool_call_id` matches.

#### `notification`

A background task notification delivered into the conversation.

| Field | Description |
| --- | --- |
| `notification_id`, `title`, `body` | Notification id, title, and body |
| `severity` | `info` / `warning` / `error` |
| `notification_type` | Notification type |
| `source` | `{ kind, id }` |
| `task_id`, `agent_id` | The related task and agent |
| `output` | `{ file?, preview?, bytes?, truncated? }` |
| `answer` | The user's reply to a background question: `answers` maps each question to its answer, and `note` is an optional note |

#### `system`

| `kind` | Fields | Description |
| --- | --- | --- |
| `compaction` | `trigger: "manual" \| "auto"`, `instruction?`, `tokens_before?`, `tokens_after?`, `compacted_count?`, `summary?` | A completed context compaction. A compaction that completes in the middle of a running turn is placed inside that turn. A compaction that is cancelled or fails leaves nothing in the conversation |
| `fork_boundary` | `source: "btw" \| "fork"`, `forked_from: { agent_id }` | Opens the conversation of an agent forked from another agent (such as a side chat). The conversation inherited at the fork is not shown |

### Live updates

When a client starts receiving an agent, it first gets a `turns` frame:

```json
{ "type": "turns", "session_id": "...", "agent_id": "main", "event_created_at": "...", "turns": [], "has_more": true }
```

It carries the latest 10 turns, including the running turn and what it has produced so far, within 1 MiB like the REST pages. Read older turns page by page with [`GET .../agents/{agent_id}/turns`](./server-api-sessions.md#get-api-v1-sessions-session-id-agents-agent-id-turns). When a session or agent is closed and then reopened, the server sends `turns` again (see [When the server closes and reopens a session](#when-the-server-closes-and-reopens-a-session)), and any later `turns` replaces the client's latest turns.

A paginated read takes a snapshot when the request starts, so the result may include turns that were undone afterward. After receiving `turns.removed`, discard page results requested before it that have not returned yet.

When the conversation cannot be loaded, the client gets `{ type: "turns.failed", session_id, agent_id, event_created_at, code, msg }` instead, for example `40401` when the agent is not in the session, or when an agent loaded again after it was closed fails to restore. The agent stays subscribed.

Later changes arrive as the frames below. Every frame carries `session_id`, `agent_id`, and `event_created_at`:

| Frame | Content | How the client handles it |
| --- | --- | --- |
| `turn.started`, `turn.ended` | `turn` without `items` | Replace the local turn and keep its existing items. `turn.ended` is sent again when an ended turn is corrected |
| `turn.updated` | `turn_id`; `step`, once per ended step; `retry` | Write `step` into `steps` by `index`. Replace the turn's retry state with `retry`, and clear it when `retry` is absent |
| `item.started`, `item.ended` | `turn_id` and the full `item` | Replace the local item with the same `item_id`, or append it to the end of the turn if it is not there |
| `item.updated` | `turn_id`, `item_id`, `set` | `set` holds the fields of a running `tool_call` that changed; merge it shallowly into the item |
| `item.delta` | `turn_id`, `item_id`, `field`, `delta` | Append `delta` to the item's `field`, which is `text`, `input_text`, or `output` |
| `item.removed` | `turn_id`, `item_id` | Remove the item. It is a running item that will not be finished, for example when a request retry restarts the step |
| `turns.removed` | `turn_ids` | Remove the turns by `turn_id`; `turn_ids` is in ascending ordinal order. After an undo it lists the undone turns; after a context clear it lists every turn |
| `notice` | `{ level: "info" \| "warning" \| "error", title, detail?, code? }` | A live warning or error raised by the agent, for example `compaction.cancelled` when a context compaction did not finish. Notices are not part of any turn and are not resent on subscribe |

Items are pushed by these rules:

- Items that do not stream (for example, `user_message`) only get `item.ended`.
- A streamed item stays `running` until its step is persisted, then gets a single `item.ended` with the persisted values. When the next piece of content in the same step starts, earlier items do not end early, so the client treats only the last block as still streaming.
- When a `system` turn is pushed live, `turn.started`, `item.ended`, and `turn.ended` are sent back to back.

These frames may repeat content the `turns` frame already holds. Applying them as replacements, as the table describes, keeps the result correct.

## Submitting input

Submit an input with [`POST /api/v1/sessions/{session_id}/prompts`](./server-api-sessions.md#post-api-v1-sessions-session-id-prompts). It goes to the main agent by default; use `agent_id` to send it to another agent.

```sh
curl -s -X POST http://127.0.0.1:58627/api/v1/sessions/<session_id>/prompts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt_id": "p-1", "content": [{"type": "text", "text": "Continue"}]}'
```

The server handles a submission in this order:

1. Validate the media references in the content parts. An unknown or mismatched `file_id` is rejected at this step, and none of the settings below take effect.
2. Write the settings in the request to the target agent, in the order `model`, `thinking`, `permission_mode`, `swarm_mode`, `disabled_tools`. Settings take effect when the request is accepted, whether or not the input is queued. They persist, so requests after the running turn also use the new settings. `permission_mode` changes only the target agent. `plan_mode`, `goal_objective`, and `goal_control` in the request are ignored, and `metadata` is recorded on the input as is.
3. The input opens a new turn or enters the queue; see the next section.

### Starting or queueing

An input opens a new turn immediately only when the target agent is idle, the queue is empty, and no undo, manual compaction, or fork is in progress. The response then waits until the turn starts, with `status` `running`. If it ends without opening a turn, `status` is `blocked` when a hook rejected the input, or `failed` when it failed before a turn started (for example, a prompt hook failed or an attachment could not be prepared).

Otherwise, the input enters the queue and the response returns immediately with `status` `queued`. Input submitted during an undo, compaction, or fork is not rejected either: it is queued and starts automatically once the operation ends.

The server does not push queue changes. A client can read the main agent's running and queued inputs with [`GET /api/v1/sessions/{session_id}/prompts`](./server-api-sessions.md#get-api-v1-sessions-session-id-prompts). A `user_message` whose `prompt_ids` contains an id means that input has entered a turn.

### Retries and idempotency

A submission that carries `prompt_id` is idempotent. After a network error or timeout, resend the request unchanged with the same `prompt_id`:

- If the server already accepted it, it returns the result of the first submission without submitting again, and the settings in the request are not applied again;
- If the first request is still being processed, the server waits for it to finish and returns the same result;
- If the first request failed before being queued, the resend is handled as a new request; if it failed after being queued, the resend returns the same error;
- If the same `prompt_id` comes with a different request, the server returns `40927`. The comparison covers the endpoint plus the full request body, regardless of field order. Within a session, `/prompts`, `/steer`, and the skill activation endpoint share one set of `prompt_id`s, so reusing an id on another endpoint also returns `40927`.

The server keeps `prompt_id`s only in memory: at most 256 per session, evicting the oldest ended record when full. They are cleared when the server restarts or the session is deleted. Requests without `prompt_id` have no idempotency protection.

### Steering

While the agent is running, a queued input waits until the current turn ends before opening the next turn. To have the running turn read new content immediately, use one of two approaches:

- **Steer directly**: submit the content with [`POST /api/v1/sessions/{session_id}/steer`](./server-api-sessions.md#post-api-v1-sessions-session-id-steer); the request body is the same as for submitting input. When a turn is running, the response waits until the content is actually inserted into the turn at the next insertion point. If the turn ends first, the response waits until the next turn it opens has started. When no turn is running, it behaves like an ordinary submission.
- **Turn queued input into steering**: use [`POST /api/v1/sessions/{session_id}/prompts:steer`](./server-api-sessions.md#post-api-v1-sessions-session-id-prompts-steer) (several) or `prompts/{prompt_id}:steer` (one). These are available only while the main agent has a running turn and return `40402` otherwise. When several are steered together, they are validated as a whole first: if any id is not in the queue or is repeated, none are processed and the server returns `40402`.

Inserted input appears in the conversation as a `user_message` with `placement` `steer`. When a skill is activated through the skill activation endpoint while the main agent is running, it does not open a new turn. It is inserted into the current turn as steering, and the response returns after the insertion.

## Stopping, undo, and compaction

| Operation | Endpoint | Effect |
| --- | --- | --- |
| Stop the current turn | [`POST /api/v1/sessions/{session_id}:abort`](./server-api-sessions.md#post-api-v1-sessions-session-id-abort) | Stops the main agent's running turn. The turn ends with `outcome: "interrupted"` and `end_reason: "user_cancelled"` |
| Stop or withdraw one input | [`POST .../prompts/{prompt_id}:abort`](./server-api-sessions.md#post-api-v1-sessions-session-id-prompts-prompt-id-abort) | While the input is running, the same as stopping the current turn; while it is queued, removes it from the queue |
| Undo | [`POST /api/v1/sessions/{session_id}:undo`](./server-api-sessions.md#post-api-v1-sessions-session-id-undo) | Deletes the given turn and every turn after it. Files are not rolled back |
| Compact the context | [`POST /api/v1/sessions/{session_id}:compact`](./server-api-sessions.md#post-api-v1-sessions-session-id-compact) | Starts a manual compaction of the main agent's context and returns immediately |
| Fork | [`POST /api/v1/sessions/{session_id}:fork`](./server-api-sessions.md#post-api-v1-sessions-session-id-fork) | Copies the session into a new session in the same workspace |
| Side chat | [`POST /api/v1/sessions/{session_id}:btw`](./server-api-sessions.md#post-api-v1-sessions-session-id-btw) | Forks an agent from the main agent that can only use read-only tools |

### Stopping a turn

`:abort` acts only on the main agent's current turn. It returns `{ aborted: true }` whether or not a turn is running, so it is safe to resend. Whether the turn actually stopped is determined by the turn's `turn.ended`.

Stopping a turn does not clear the queue: queued user input and user steering not yet inserted are kept, and the next turn opens automatically once the stopped turn ends. Queued skill activations are cancelled along with it. The server has no endpoint to pause the queue. To stop everything, first withdraw each queued input with `prompts/{prompt_id}:abort`, then call `:abort`.

`prompts/{prompt_id}:abort` also acts only on the main agent. Withdrawing a queued input produces no turn and pushes no frames. When the input has already ended or does not exist, it returns `40402`.

Turns of agents other than the main agent, such as side chats, currently have no public stop endpoint.

### Undo

After a successful undo, the response carries `removed_turn_ids`, and subscribers receive a `turns.removed` frame with the same `turn_ids`. The two may arrive in either order. The client removes turns by `turn_id`, and removing one twice does no harm. When the agent is working (it has a running turn, queued input, or a compaction in progress), undo returns `40901`; retry after it finishes.

### Compaction

Manual compaction is not queued. When a turn is running, the queue is not empty, or another history operation is in progress, it returns `40910` right away. It also returns `40910` when the history has nothing to compact. On success the response is `{}`, and progress then shows up in three places:

- During compaction, `compacting` is `true` in the main agent's `agent` frame, and it returns to `false` when compaction ends;
- When compaction completes, a `system` turn appears in the conversation (see [`system`](#system));
- When compaction does not complete, subscribers receive a `notice` with `code` `compaction.cancelled`, and nothing is left in the conversation.

## Approvals and questions

When a tool call needs the user's permission, the server raises an approval request. When the agent needs the user to make a choice, it raises a question. Both are sent to every subscriber of the session as `interaction` frames:

| Field | Description |
| --- | --- |
| `interaction_id` | The interaction id, used when answering |
| `kind` | `approval` or `question` |
| `status` | `pending` or `ended` |
| `agent_id` | The agent that raised the interaction |
| `tool_call_id` | The waiting tool call. Its `tool_call` item carries the same `interaction_id` |
| `request` | For an approval: `{ tool_name, action, tool_input_display?, expires_at }`, where `expires_at` is 24 hours after the request was raised. For a question: `{ questions }`; see below |
| `response` | Always present once an approval ends; for a question, present only when `outcome` is `answered`, so dismissed questions and questions cancelled by the end of their turn have no `response`. Shapes below |
| `outcome` | Present once ended: `approved` / `rejected` / `cancelled` / `answered` / `dismissed` |
| `ended_at` | End time |

A question's `request.questions` holds 1–4 questions, each `{ id, question, header?, body?, options, multi_select?, allow_other?, other_label?, other_description? }`. `options` has 2–4 options, each `{ id, label, description? }`. `multi_select` allows choosing several options, and `allow_other` allows a free-text answer.

Answer with [`POST /api/v1/sessions/{session_id}/interactions/{interaction_id}`](./server-api-sessions.md#post-api-v1-sessions-session-id-interactions-interaction-id). An interaction ends in one of two ways: it is answered, or it is cancelled because its turn ended. When it ends, the server sends the interaction's last frame with `status: "ended"`, `ended_at`, `outcome`, and `response` when the table above says it is present:

- An approval's `response`: `{ decision, scope?, feedback?, selected_label? }`;
- An answered question's `response`: `{ answers, method? }`, where `answers` maps each question's text to its answer.

When several clients answer the same interaction, the first answer takes effect and later answers return `40902`. The server remembers ended interactions for only 60 seconds, up to 256 of them; answering after that returns `40404`. When a client gets either error code, it closes the card as "interaction ended".

The server does not validate the content of question answers: an unknown option id is passed through as the answer text, and an unknown question id is passed through as the key, straight to the agent.

## Tasks

All asynchronous work an agent is running is a task: shell commands (foreground and background), subagents (including swarm members), and other asynchronous work. Tasks are independent of turns, so undoing turns does not affect tasks.

### Task list

When a client starts receiving an agent, it first gets a `{ type: "task.list", session_id, agent_id, tasks }` frame, where `tasks` is every task the agent is running right now; the client replaces its local list with it. After that, each change arrives as a `{ type: "task", session_id, agent_id, event_created_at, ...task state }` frame, and every frame carries the full state. An agent that had not joined the session at subscription time starts directly with `task` frames.

When a task ends, its last `task` frame (`status: "ended"`) is sent, and it no longer appears in `task.list`. The result of an ended task lives in the session history (tool results and completion notifications). For its exact final state, send `task.watch` for it, and the response carries its state. Like `interaction`, task frames are not replayed.

| Field | Description |
| --- | --- |
| `task_id` | Task id |
| `kind` | `shell` / `subagent` / `other` |
| `status` | `running` / `ended` |
| `outcome` | Ended tasks only: `completed` / `failed` / `timed_out` / `killed` / `lost` |
| `phase` | Running subagents only: `working` / `suspended`, with the suspension reason in `state_reason` |
| `detached` | The tool call that started it no longer waits for it, which makes it a background task |
| `description` | Task description |
| `child_agent_id` | The agent id of a subagent task |
| `parent_tool_call_id` | The tool call that started the task |
| `swarm_index` | A swarm member's position in its swarm |
| `command` | A shell task's command |
| `started_at`, `ended_at` | Start and end time |
| `result_summary`, `error`, `state_reason` | Result summary, error, and state reason |
| `model`, `thinking` | The model and thinking effort a subagent uses |

### Task output and control

Task output is not pushed with `task` frames. To show a task's output, send `task.watch`; no session subscription is needed. `agent_id` is the agent the task belongs to, which is the `agent_id` on the task's `task` frames.

1. The server first responds with `code: 0`. The response's `task` is the task's current state (the same shape as a `task` frame, without `type`, `session_id`, `agent_id`, and `event_created_at`).
2. It then sends the last `tail_bytes` bytes of output as one `task.output` frame. `tail_bytes` defaults to 32 KiB and is at most 1 MiB. When `since_offset` falls inside that range, only the part after it is sent. When there is no output to send, `text` is empty.
3. Live output follows. Ended tasks can be watched too.

A `task.output` frame is `{ type: "task.output", session_id, agent_id, task_id, offset, text }`, where `offset` is the UTF-8 byte offset of `text` in the task's output. To resume after reconnecting, set `since_offset` to the end of the output you already have.

When `since_offset` falls inside the readable tail and on a character boundary, the first chunk starts there; otherwise the whole tail is sent again. Clients merge output by these rules:

- When the first chunk's `offset` equals the end of the local output, append it directly;
- Otherwise, discard the local output and rebuild it from the first chunk;
- For live output after the first chunk, drop the bytes that overlap the local output by `offset`, then append the rest.

When `task.watch` is sent again for the same task, the server first drops the old watch, then resends the first chunk from the new `since_offset`.

The other control commands:

- **`task.unwatch`**: stops pushing the task's output.
- **`task.stop`**: stops the task. When the task has already ended, it responds with the task's state directly. Stopping a foreground task ends only the tool call that started it: the tool call gets the stop result, and the turn continues.
- **`task.background`**: makes the tool call that started the task stop waiting for it, so the task keeps running in the background. When the task is already in the background or has ended, it responds with the task's state directly. A task its caller cannot stop waiting for (such as an AgentSwarm member) gets `40933`, and the response still carries the task state.

When `task.watch`, `task.stop`, and `task.background` succeed, the response's `task` is the task's current state. Commands for the same task are handled one at a time in arrival order, so a `task.unwatch` sent before the `task.watch` response takes effect after it. Different tasks, and task commands and other commands, never wait on each other.

Error codes for task commands:

- `40001`: malformed frame, including an out-of-range `tail_bytes`
- `40401`: session not found
- `40406`: the agent has no such task
- `40933`: the task cannot be moved to the background
- `50001`: internal error
- `50003`: output cannot be read

## Agent state

An agent's own state is synced by four kinds of frames. Each frame carries the full value, and the client replaces its local copy; like task frames, they are not replayed. When a client starts receiving an agent, it first gets the agent's current frames of these kinds, then the matching frame again whenever a value changes. All four carry `type`, `session_id`, `agent_id`, and `event_created_at`.

| Frame | Fields | Description |
| --- | --- | --- |
| `agent` | `status: "idle" \| "running"`, `compacting`, `model?`, `thinking?`, `permission_mode?`, `plan_mode`, `swarm_mode`, `tower_mode` | `status` is `running` while the agent handles a turn. `compacting` is `true` while the agent's context is being compacted, whether inside a turn or not. The running turn, and the retry state after a failed model request, come with the conversation frames |
| `usage` | `context_tokens`, `max_context_tokens?` | Context usage, sent only when the agent has a model context. The server coalesces it over 250 milliseconds: after a change, it sends once within at most 250 milliseconds, with only the latest value and no intermediate values |
| `goal` | `goal?` | Main agent only. `goal` is omitted when there is no goal; otherwise it is `{ objective, status: "active" \| "paused" \| "blocked" \| "complete", completion_criterion?, turns_used, tokens_used, wall_clock_ms }`. `wall_clock_ms` is the elapsed time when the frame was sent and is not resent just because time passes; the client advances the clock itself |
| `todo` | `items: [{ title, status: "pending" \| "in_progress" \| "done" }]` | The todo list, read from the agent's todo store, so it follows undo and survives a server restart |

`agent`, `goal`, and `todo` are sent only when their content actually changes.

The model and thinking effort in the `agent` frame are the agent's current effective settings. A session's model is set when the session is created (see [Create a session](./server-api-sessions.md#post-api-v1-sessions)). A session created without a usable model omits `model` and `thinking` until a model is set.

## Reconnecting

Subscriptions do not survive a disconnect. After reconnecting:

1. Send `subscribe` again for each session you need. When the response succeeds, discard all local turns of that session (including pages you loaded earlier) and any paginated requests that have not returned. `turns.removed` frames from the disconnect are not resent, and `ordinal` values may be reused after an undo, so old local turns cannot be kept.
2. After the response, the server resends pending interactions. Any local card not in this batch has already ended; close it.
3. The server resends each agent's `task.list`, `agent`, `usage`, `goal`, and `todo`, and finally `turns` with the latest page. Read older turns over REST pagination.
4. Task output watches are lost as well. Send `task.watch` again with `since_offset` set to the end of the output you already have.
5. Global events missed during the disconnect are not replayed. Refresh the lists you keep locally over REST (for example, `GET /api/v1/sessions`).

## Global events

Global events are sent to every established connection, with no subscription needed. An event frame looks like this:

```json
{ "type": "event.session.archived", "session_id": "__global__", "timestamp": "...", "payload": { "type": "event.session.archived", "workspace_id": "wd_...", "sessionId": "session_..." } }
```

`type` is the event type, and `payload` is the event content. For events tied directly to a session, `session_id` is that session's id. For other events, `session_id` is the global marker `__global__`, and the related session id is in `payload.sessionId`. Session and workspace events let a cross-workspace overview stay current without polling each workspace.

| Event | Frame `session_id` | `payload` fields | When it is sent |
| --- | --- | --- | --- |
| `session.meta.updated` | Session id | `title?`, `patch?` | The session's title or metadata changed, for example when a title is set through the profile endpoint |
| `event.session.created` | Session id | `session`: the [session object](./server-api-sessions.md#session-object) | A session was created, including by a fork |
| `event.session.work_changed` | Session id | `busy`, `main_turn_active?`, `pending_interaction?`, `last_turn_reason?` | The session's running state changed. The fields mean the same as in the [session object](./server-api-sessions.md#session-object). When a main agent turn ends, the end flag and the outcome come in the same event, so a client can use `main_turn_active` changing from `true` to `false` as a completion alert |
| `event.session.archived` | `__global__` | `workspace_id`, `sessionId` | A session was archived, on both the online and the cold archive path |
| `event.session.restored` | `__global__` | `workspace_id`, `sessionId` | An archived session was restored |
| `event.session.deleted` | `__global__` | `workspace_id`, `sessionId` | A session was deleted |
| `event.workspace.created`, `event.workspace.updated` | `__global__` | `workspace`: the full [workspace object](./server-api-service.md#workspace-object) | A workspace was created or updated. Creating a session touches the workspace, which also sends `updated` |
| `event.workspace.deleted` | `__global__` | `workspace_id`, `root` | A workspace was deleted |
| `event.config.changed` | `__global__` | `changedFields`, `config` (the same as the response of `GET /api/v1/config`) | The configuration changed |
| `event.config.warning` | `__global__` | `warnings: [{ domain?, message }]` | Reading the configuration produced warnings |
| `event.model_catalog.changed` | `__global__` | `changed: [{ provider_id, provider_name, added, removed }]`, `unchanged`, `failed: [{ provider, reason }]`, `retired_default?: { from, to, from_display_name }` | A model catalog refresh finished |
| `event.plugin.changed` | `__global__` | None | Plugins changed; the client reads the plugin list again |
| `event.capability.changed` | `__global__` | `capability_id`, `install: { running, step?, percent?, error?, note? }` | A built-in capability's install state changed |

These events only cover changes made inside this server process. Changes from other processes (for example, a CLI writing to the same home directory) become visible only after index reconciliation (about a minute), so overview clients should keep a low-frequency fallback poll.
