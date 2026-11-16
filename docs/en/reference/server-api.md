<script setup>
import { onMounted } from 'vue'
import { withBase } from 'vitepress'
import { redirectLegacyServerApiAnchor } from '../../.vitepress/theme/serverApiLegacyAnchors'

onMounted(() => redirectLegacyServerApiAnchor('en'))
</script>

# Server API (Beta)

The local server started by `kimi web` (as well as the server embedded in the desktop app) exposes the **Kimi Agent Protocol (KAP)**: a pair of HTTP REST endpoints (`/api/v1`) and a WebSocket event stream (`/api/v1/ws`). Clients and scripts can use them to create sessions, submit prompts, stream live conversation turns and agent state, respond to approvals, and manage workspaces, models, plugins, and MCP servers. For startup flags and CLI options, see [kimi Command](./kimi-command.md#kimi-web).

::: warning Note
This protocol is in Beta and may evolve across releases. A running server also serves machine-readable schemas generated directly from its live validation definitions at [`GET /openapi.json`](#online-schemas) and [`GET /asyncapi.json`](#online-schemas).
:::

## Document map

1. **This page (Overview and Quick Start)**: [Material for agents](#material-for-agents), conventions, [authentication](#authentication), [response envelope](#response-envelope), [error codes](#error-codes), and a 5-step [quick start](#quick-start).
2. **[Sessions and Conversations](./server-api-conversation.md)**: Client protocol guide — connecting and subscribing, rendering a conversation turn (`Turn` / `Item`), submitting input and steering, stopping / undoing / compacting, approvals and questions, task output streaming, agent state, and global events. Every section pairs a complete interactive wire trace with concise client rules. **Start here when building a client.**
3. **[Session Endpoints](./server-api-sessions.md)**: Reference for all `/api/v1/sessions` REST endpoints (creating, listing and grouping sessions, batch archive/restore, profile settings, session actions, turn pagination, prompt queue, and interaction replies).
4. **[Service and Configuration Endpoints](./server-api-service.md)**: Server metadata, OAuth login and usage, remote control, config, models and providers, workspaces, built-in capabilities and plugins, MCP management, file uploads, and global search.
5. **[File Endpoints](./server-api-files.md)**: Session filesystem, workspace filesystem, host filesystem endpoints, and HTTP streaming/download semantics.

## Material for agents

When asking an AI agent to build a Kimi Code client, dashboard, or automation script:

- **Send a single file**: Give the agent <a :href="withBase('/en/kap.md')" target="_blank" download="kap.md"><code>/en/kap.md</code></a>.
- **Send a focused subset**: When context is tight, pick the pages that match the task and include this page's conventions and error codes:

| Goal | Guide sections | Reference pages |
| --- | --- | --- |
| Read-only dashboard or progress monitor | [Subscribing to a session](./server-api-conversation.md#subscribing-to-a-session), [Global events](./server-api-conversation.md#global-events) | [Sessions](./server-api-sessions.md#sessions) |
| Minimal chat client | [Quick start](#quick-start), [Conversation](./server-api-conversation.md#conversation), [Submitting input](./server-api-conversation.md#submitting-input) | [Session Endpoints](./server-api-sessions.md) |
| Remote approval and question handler | [Approvals and questions](./server-api-conversation.md#approvals-and-questions) | [Approvals and questions](./server-api-sessions.md#approvals-and-questions) |
| Background task monitor or batch automation | [Quick start](#quick-start), [Tasks](./server-api-conversation.md#tasks) | [Session actions](./server-api-sessions.md#session-actions), [Prompts](./server-api-sessions.md#prompts) |

Include this brief with the files:

```text
Implement a Kimi Code client following the attached Kimi Agent Protocol documentation.
- Server URL: http://127.0.0.1:58627/api/v1; WebSocket: ws://127.0.0.1:58627/api/v1/ws; credential: YOUR_TOKEN.
- Use only the messages, endpoints, and fields defined in the spec; skip unknown event types, item types, or fields without failing.
- Check the envelope `code` field on every HTTP response; see "Error codes" for meanings.
- Generate a session-unique `prompt_id` on the client when submitting input, and resend with the same `prompt_id` on network errors or timeouts.
```

## Conventions

- **Naming and time**: REST and WebSocket fields use `snake_case`; timestamps are ISO 8601 strings; durations end with `_ms` (milliseconds).
- **Opaque IDs**: `session_id`, `turn_id`, `item_id`, `interaction_id`, and `task_id` are opaque strings — do not parse their format. `turn_id` and `item_id` are derived deterministically from persisted engine records, so live events and paginated history return identical IDs.
- **Action paths**: Non-CRUD operations on a resource or collection use a `:{action}` suffix with `POST`, such as `POST /api/v1/sessions/{session_id}:fork` or `POST /api/v1/sessions:archive`.
- **Reading wire examples**: Interactive protocol blocks label each frame by direction — `Client` (WebSocket client → server), `Server` (WebSocket server → client), `HTTP` (HTTP request), and `Reply` (`data` inside the HTTP response envelope). Highlighted fields mark the focus of that step; click `{…}` or **Expand all** in the top-right corner to inspect the full JSON:

```wire focus=request_id,code,cancelled
C { "type": "task.watch", "request_id": "r2", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab" }
S { "type": "response", "request_id": "r2", "code": 0 }
H POST /api/v1/sessions/s1:cancel
R { "cancelled": true }
```

## Address and online schemas

The server listens on `http://127.0.0.1:58627` by default (probing up to 100 consecutive ports if busy; override with `--host` and `--port`, or pass `--port 0` to let the OS pick an ephemeral port).

A running server exposes two machine-readable specifications generated from its validation schemas (both require authentication):

- `GET /openapi.json`: REST specification (OpenAPI 3.0)
- `GET /asyncapi.json`: WebSocket specification (AsyncAPI)

## Authentication

All `/api/*` paths, `/openapi.json`, and `/asyncapi.json` require a bearer token, except:

- `OPTIONS` preflight requests
- `GET /api/v1/healthz` (liveness probe)
- Static web assets outside `/api/`

Clients obtain `(origin, token)` either by launching `kimi web --no-open --port 0` and reading the bound URL and `Token` from its startup output, or by receiving `(origin, token)` directly from the embedding host (such as the desktop app or remote relay). Pass the token in the `Authorization: Bearer <token>` header for REST requests; WebSocket upgrade requests accept either that header or the subprotocol `kimi-code.bearer.<token>`.

Missing or invalid credentials return HTTP 401 (`code: 40101`); missing, malformed, or disallowed `Host` headers return HTTP 403 (`code: 40301`). When bound to a non-loopback address, 10 failed auth attempts from the same source within 60 seconds ban that source for 60 seconds, returning HTTP 429 (`code: 42901`).

## Response envelope

Every JSON response (except raw binary streams) uses the same envelope:

```json
{
  "code": 0,
  "msg": "success",
  "data": {},
  "request_id": "01JZX4A6E7M8V0R3Q0N2K2M5Q9"
}
```

| Field | Description |
| --- | --- |
| `code` | Business status code: `0` on success, non-zero on error (see [Error codes](#error-codes)). Always check `code` first |
| `msg` | Status summary or error message |
| `data` | Response payload on success (the response fields documented for each endpoint describe `data`); `null` on error except `40911` (`:undo` boundary / count failure returns `{ reason, requestedCount, undoableCount }`) |
| `details` | Optional structured error context (e.g., field validation issues on `40001`, lock holder on `40931`, `model_id` on `40113`) |
| `request_id` | ULID for this request (clients may supply `X-Request-Id`) |

HTTP status is `200` for almost all responses; check `code` for the outcome. Exceptions:

| Scenario | HTTP status |
| --- | --- |
| Auth failure / disallowed Host or Origin / rate limit | `401` / `403` / `429` |
| Creating a provider, `:import_catalog`, `:import_registry` | `201` (body is still the standard envelope) |
| Deleting a provider | `204` (empty body) |
| Binary and streaming download endpoints | `206` (Range) and `304` (ETag), with real `4xx` / `500` status codes on error; see [Binary and streaming endpoints](./server-api-files.md#binary-and-streaming-endpoints) |

## Error codes

HTTP responses and WebSocket `response` frames share the same error codes:

| Range / Code | Meaning |
| --- | --- |
| `0` | Success |
| `40001` | Request validation failed (`details` lists each offending field) |
| `40003`–`40006` | Provider is OAuth-managed (`40003`), catalog entry cannot be imported (`40004`), custom registry unavailable (`40005`), duplicate workspace source folder (`40006`) |
| `40101` | Missing or invalid credential (HTTP 401) |
| `40301` | Missing, invalid, or disallowed `Host` header (HTTP 403) |
| `40110`–`40113` | No provider configured (`40110`), missing provider credential (`40111`), credential rejected (`40112`), model cannot be resolved (`40113`) |
| `40401`–`40421` | Session or agent not found (`40401`), prompt not found (`40402`), interaction not found or expired (`40404`), task not found (`40406`), file not found (`40407`), MCP server not found (`40408`), path not found (`40409`), workspace not found (`40410`), skill not found (`40415`), catalog entry not found (`40417`), capability not found (`40418`), plugin not found (`40419`), environment not found (`40420`), turn not found (`40421`) |
| `40901` / `40902` | Session or agent busy (`40901`), interaction already ended (`40902`) |
| `40910`–`40920` | Compaction unavailable (`40910`), turn cannot be undone (`40911`), skill not user-invocable (`40912`), goal state conflict (`40913`–`40918`, `40920`) |
| `40922`–`40935` | Query does not match `page_token` (`40922`), title generation unavailable (`40923`), capability install conflict (`40924`/`40925`), environment unavailable (`40926`), `prompt_id` reused with different payload (`40927`), remote control conflict (`40928`), MCP OAuth failed (`40929`), session written by newer server (`40930`), session occupied by another process (`40931`), session updated by another process (`40932`), task cannot be backgrounded (`40933`), plugin catalog changed (`40934`), cannot enter Tower mode (`40935`) |
| `41302`–`41305` | File exceeds 10 MiB (`41302`), remote directory too large (`41303`), path outside workspace (`41304`), search timed out (`41305`) |
| `42901` / `42902` | Auth failure ban (`42901`), file watch limit exceeded (`42902`) |
| `50001`–`50004` | Internal error (`50001`), persistence failure (`50003`), model catalog unavailable (`50004`) |
| `6xxxx` / `7xxxx` / `8xxxx` | Tool runtime, LLM provider, or MCP passthrough errors (`msg` preserves upstream message) |

### Cross-process concurrency (`40931` and `40932`)

Multiple clients connected to the same `kap-server` instance share live sessions in memory and never hit these codes. They appear only when separate processes (for example, a standalone CLI and the desktop embedded server) touch the same session on disk:

- **`40931` (session occupied)**: Another process is actively writing to the session (`details` identifies the holder). Retry once it finishes, or call [`POST /api/v1/sessions/{session_id}:takeover`](./server-api-sessions.md#post-api-v1-sessions-session-id-takeover) if the holding process crashed and left a stale lock.
- **`40932` (session stale)**: Another process modified the session. On prompt submission, skill activation, and compaction, the server automatically reloads the session, pushes fresh `turns` frames to subscribers, and runs the request; only `:undo` returns `40932` directly after reloading so the user can inspect the updated history before undoing.

## Pagination

List endpoints use three pagination styles:

- **`page_token` / `page` pagination**: [`GET /api/v1/sessions`](./server-api-sessions.md#get-api-v1-sessions) (both flat and `view=by_workspace`) and [`POST /api/v1/search`](./server-api-service.md#post-api-v1-search) issue an opaque `next_page_token` bound to the query parameters (changing filters mid-pagination returns `40922` / `40001`). `GET /api/v1/sessions` also accepts a stateless 1-based `page` number.
- **Turn `before_ordinal` pagination**: [`GET /api/v1/sessions/{session_id}/agents/{agent_id}/turns`](./server-api-sessions.md#get-api-v1-sessions-session-id-agents-agent-id-turns) pages backward by turn `ordinal`.
- **ID cursor pagination (`before_id` / `after_id`)**: Flat session lists accept `before_id` or `after_id` (mutually exclusive) plus `page_size`.

## Quick start

This 5-step walkthrough uses `curl` and a dependency-free Node.js script (Node.js 22+ includes a built-in `WebSocket` client) to create a session, subscribe to events, submit a prompt, stream the reply, and page backward through history.

### 1. Set environment variables

Start the server (`kimi web --no-open --port 0`) and set `KAP` and `TOKEN` from the bound `Local` origin (without `#token=...`) and `Token` printed in its startup output (or `http://127.0.0.1:58627` when running without `--port 0`):

```sh
export KAP="http://127.0.0.1:<port from startup output>"
export TOKEN="<Token from startup output>"
```

### 2. Create a session

```sh
curl -s -X POST "$KAP/api/v1/sessions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"cwd\": \"$PWD\"}"
```

Store the returned `data.id` (`session_...`) in `SESSION`:

```sh
export SESSION="<data.id from the response>"
```

### 3. Connect WebSocket and subscribe

Subscribe before submitting input so you receive every event from the start of the turn. Save this as `subscribe.mjs` and run `node subscribe.mjs`:

```js
const { KAP, TOKEN, SESSION } = process.env;
const ws = new WebSocket(`${KAP.replace(/^http/, 'ws')}/api/v1/ws`, [
  `kimi-code.bearer.${TOKEN}`,
]);

ws.onopen = () => {
  ws.send(
    JSON.stringify({
      type: 'subscribe',
      request_id: 'sub-1',
      session_id: SESSION,
      agent_ids: ['main'],
    }),
  );
};

ws.onmessage = (frame) => {
  const event = JSON.parse(frame.data);
  if (event.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
  console.log(event.type, event);
};
```

### 4. Submit input and watch the event stream

In another terminal, submit a prompt with a client-generated `prompt_id` for idempotent retries:

```sh
curl -s -X POST "$KAP/api/v1/sessions/$SESSION/prompts" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt_id": "p-1", "content": [{"type": "text", "text": "Summarize this repository in one sentence"}]}'
```

Here is the complete sequence of frames from subscription through turn completion (click `…` or **Expand all** to inspect full payloads):

```wire focus=code,status,turn.kind,item.type,item.prompt_ids,delta,turn.outcome
C { "type": "subscribe", "request_id": "sub-1", "session_id": "s1", "agent_ids": ["main"] }
S { "type": "response", "request_id": "sub-1", "code": 0 }
S { "type": "task.list", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "tasks": [] }
S { "type": "agent", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "status": "idle", "compacting": false, "model": "kimi-for-coding", "thinking": "high", "permission_mode": "manual", "plan_mode": false, "swarm_mode": false, "tower_mode": false }
S { "type": "turns", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turns": [], "has_more": false }
H POST /api/v1/sessions/s1/prompts
  { "prompt_id": "p-1", "content": [ { "type": "text", "text": "Summarize this repository in one sentence" } ] }
R { "prompt_id": "p-1", "user_message_id": "u_1", "status": "running", "content": [ { "type": "text", "text": "Summarize this repository in one sentence" } ], "created_at": "2026-10-29T10:30:00.000Z" }
S { "type": "turn.started", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn": { "turn_id": "t_1", "ordinal": 0, "turn_number": 0, "kind": "agent", "status": "running", "started_at": "2026-10-29T10:30:00.000Z", "steps": [] } }
S { "type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": { "item_id": "u_1", "type": "user_message", "step_index": 0, "status": "ended", "outcome": "completed", "created_at": "2026-10-29T10:30:00.000Z", "prompt_ids": ["p-1"], "placement": "opener", "origin": { "kind": "user" }, "text": "Summarize this repository in one sentence", "attachments": [], "skills": [] } }
S { "type": "item.started", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": { "item_id": "a_1", "type": "assistant_message", "step_index": 1, "status": "running", "created_at": "2026-10-29T10:30:00.500Z", "text": "" } }
S { "type": "item.delta", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item_id": "a_1", "field": "text", "delta": "This is the core Kimi Code monorepo." }
S { "type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": { "item_id": "a_1", "type": "assistant_message", "step_index": 1, "status": "ended", "outcome": "completed", "created_at": "2026-10-29T10:30:00.500Z", "text": "This is the core Kimi Code monorepo." } }
S { "type": "turn.updated", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "step": { "index": 1, "outcome": "completed", "finish_reason": "stop", "started_at": "2026-10-29T10:30:00.400Z", "ended_at": "2026-10-29T10:30:01.800Z" } }
S { "type": "turn.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn": { "turn_id": "t_1", "ordinal": 0, "turn_number": 0, "kind": "agent", "status": "ended", "outcome": "completed", "started_at": "2026-10-29T10:30:00.000Z", "ended_at": "2026-10-29T10:30:01.800Z", "duration_ms": 1800, "steps": [ { "index": 1, "outcome": "completed", "finish_reason": "stop" } ] } }
S { "type": "agent", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "status": "idle", "compacting": false, "model": "kimi-for-coding", "thinking": "high", "permission_mode": "manual", "plan_mode": false, "swarm_mode": false, "tower_mode": false }
```

### 5. Page backward through earlier turns

The initial `turns` frame carries at most the latest 10 turns. When `has_more` is `true` and the user scrolls up, pass the `ordinal` of the earliest locally loaded turn (`FIRST_ORDINAL`) as `before_ordinal` to fetch older turns (the returned `Turn` objects have the exact same shape as the WebSocket stream):

```sh
curl -s -H "Authorization: Bearer $TOKEN" \
  "$KAP/api/v1/sessions/$SESSION/agents/main/turns?before_ordinal=$FIRST_ORDINAL&page_size=20"
```

## Next steps

- [Sessions and Conversations](./server-api-conversation.md): Interactive WebSocket walkthroughs and client state reduction rules
- [Session Endpoints](./server-api-sessions.md): REST reference for sessions, turns, prompts, and interactions
- [Service and Configuration Endpoints](./server-api-service.md): Workspaces, models, plugins, MCP, and global search
- [File Endpoints](./server-api-files.md): Session and workspace file operations and streaming downloads
