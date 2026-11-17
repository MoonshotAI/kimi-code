# Kimi Agent Protocol (KAP) Specification (`0.x` Beta)

The local server started by `kimi web` (as well as the server embedded in the Kimi Code desktop app) exposes the **Kimi Agent Protocol (KAP)**: an HTTP REST control plane (`/api/v1`) paired with an optional single-connection WebSocket event and task stream (`/api/v1/ws`).

> **How to use this document (for live AI agents and client authors):**
>
> - **When NOT to use KAP**: If you only need to dispatch a one-shot task and read the final output with no mid-turn inspection, steering, or approval handling, run `kimi -p "<task>" --output-format stream-json` directly instead of using a KAP server.
> - **Choose your path**:
>   - **[Path A — Agent-to-Agent Pure HTTP Loop](#path-a-agent-to-agent-pure-http-loop-zero-websocket)** *(default for live AI agents driving Kimi Code from Bash / Python / Node)*: Connect to a running local instance or spawn `kimi web --port 0 --json`, then drive sessions end-to-end with plain HTTP (`POST /prompts` → `POST /sessions/{id}:wait` → `POST /interactions/{id}` / `GET /turns` / `POST /steer`). **Do not write WebSocket code unless you are building a live UI or streaming chat bot.**
>   - **[Path B — UI & Bot Clients (HTTP + WebSocket)](#path-b-ui-and-bot-clients-http-plus-websocket-streaming)** *(for chat bots, dashboards, and custom workbenches)*: Subscribe on `/api/v1/ws` and apply the defensive `Turn` / `Item` reduction rules below.
> - **Always-matched built-in spec & live schemas**: Once connected to a running server, you can fetch `GET /api/v1/kap.md` (exact Markdown spec bundled in that server version), `GET /openapi.json` (REST JSON Schemas), and `GET /asyncapi.json` (WebSocket frame schemas).

---

## 1. Connection and authentication

All `/api/*` routes, `/openapi.json`, and `/asyncapi.json` require a bearer token (except `OPTIONS` preflights, `GET /api/v1/healthz`, and static web assets outside `/api/`):

- **REST**: Send `Authorization: Bearer <token>`.
- **WebSocket (`/api/v1/ws`, Path B only)**: Send `Authorization: Bearer <token>` on the HTTP upgrade request, or pass subprotocol `kimi-code.bearer.<token>` in browser environments.

### Option 1: Attach to a running Desktop app or `kimi web` instance

Both `kimi web` and the Kimi Code Desktop app accept the local `0600` host token at `~/.kimi-code/server.token` (respecting `KIMI_CODE_HOME` when set) and register live server descriptors under `~/.kimi-code/server/instances/*.json`:

```json
{
  "server_id": "01JZX...",
  "pid": 48210,
  "host": "127.0.0.1",
  "port": 58627,
  "started_at": 1763000000000,
  "heartbeat_at": 1763000015000,
  "host_version": "2.6.2"
}
```

1. Read `TOKEN=$(tr -d '[:space:]' < "${KIMI_CODE_HOME:-$HOME/.kimi-code}/server.token")`.
2. Scan `${KIMI_CODE_HOME:-$HOME/.kimi-code}/server/instances/*.json` (newest `started_at` first), verify `kill -0 <pid>`, and probe `GET http://<host>:<port>/api/v1/meta` with `Authorization: Bearer $TOKEN`. Pick the first instance returning HTTP `200` (`code: 0`).
3. *(Recommended)* Fetch `GET <origin>/api/v1/kap.md` with `Authorization: Bearer $TOKEN` if you want to verify capabilities or details specific to the installed Kimi Code version.

### Option 2: Spawn a dedicated subprocess (`kimi web --port 0 --json`)

When no local instance is running — or when you want an isolated server process whose lifecycle you own — spawn:

```sh
kimi web --port 0 --json
```

- Implies `--no-open`, routes server logs to `stderr`, skips global `instances/` registration, and mints an in-memory random bearer token valid strictly for the lifetime of that child process (never reads or prints `~/.kimi-code/server.token`; cannot be combined with `--debug-endpoints`, `--allow-remote-shutdown`, `--remote-control`, `--dangerous-bypass-auth`, or `--socket`).
- Once listening, writes **one single-line JSON object** (`origin` has no trailing slash) as line 1 of `stdout`:

```json
{"origin":"http://127.0.0.1:54123","ws_url":"ws://127.0.0.1:54123/api/v1/ws","token":"...","kimi_agent_protocol_version":"0.1.0"}
```

Stop the child process with `SIGTERM` / `SIGINT` (or `POST /api/v1/shutdown`) when finished.

---

## 2. Protocol conventions and `0.x` Beta stability

- **Stability boundary (`0.x` Beta)**:
  - **Core session & conversation loop** (`/api/v1/meta`, `/api/v1/kap.md`, `/api/v1/sessions` + `:wait` / `:cancel` / `:fork` / `:undo` / `:archive` / `:restore` / `/profile`, `/agents/{agent_id}/turns`, `/prompts`, `/steer`, `/interactions`, `/files`, plus core WebSocket conversation/state frames) preserves backward-compatible defaults: existing optional parameters keep their semantics when omitted, new behaviors opt in via optional parameters or new `:action` suffixes, and incremental features advertise boolean flags on `GET /api/v1/meta` → `data.capabilities` (e.g. `session_wait`, `interactions_list`). Clients must ignore unknown JSON fields and unknown `Item` / event variants.
  - **Host management endpoints** (`/config`, `/providers`, `/models`, `/oauth/*`, `/mcp/*`, `/plugins/*`, `/capabilities/*`, `/hosts*`, `/remote-control*`, `/workspaces*`, `/fs:*`) serve first-party management UIs and may evolve across `0.x` releases — inspect live `GET /openapi.json` before calling them.
- **Standard JSON envelope**: Every `/api/v1` JSON response (except `204` empty responses, `GET /api/v1/kap.md` `text/markdown`, binary downloads, and NDJSON `stream: true` on `fs:suggest`) has the shape:
  ```json
  { "code": 0, "msg": "success", "data": {}, "request_id": "01JZX..." }
  ```
  Always check `code === 0` first. Domain errors normally return HTTP `200` with a non-zero `code` (`40001` validation failed with `details`, `40401` session/agent not found, `40404` interaction not found, `40901` session busy, `40902` interaction already ended, `40927` `prompt_id` conflict, `40931` session occupied by another OS process, `41001`/`41002` interaction expired); HTTP `401` (`40101`), `403` (`40301`), and `429` (`42901`) signal transport/auth rejections.
- **Opaque IDs & `snake_case`**: Treat `session_id`, `turn_id`, `item_id`, `interaction_id`, `task_id`, and `workspace_id` as opaque strings. In `zsh` / `bash`, **always brace variables before `:action` suffixes** (write `"${ORIGIN}/api/v1/sessions/${SID}:wait"`, never `"$SID:wait"`, because `zsh` expands `$SID:w` / `:a` / `:r` / `:c` / `:t` as history modifiers and corrupts the URL). Wire fields use `snake_case`; timestamps are ISO 8601 strings; durations end with `_ms` (`expires_in_sec` on `/files` and OAuth `expires_in`/`interval` are in seconds).

---

## 3. Path A: Agent-to-Agent pure HTTP loop (zero WebSocket)

A live AI agent supervising Kimi Code from shell commands or scripts needs only plain HTTP requests.

### Step-by-step supervision loop

1. **Create or locate a session**:
   - Create: `POST /api/v1/sessions` with `{ "cwd": "/abs/path/to/repo", "title": "Optional title" }` (or pass `"agent_config": { "permission_mode": "manual" | "auto" | "yolo", "model": "...", "thinking": "high", "plan_mode": false }` to preconfigure `main`).
   - Or locate existing sessions: `GET /api/v1/sessions?page_size=20` (or full-text search via `POST /api/v1/search` with `{ "query": "..." }`). Inspect `session.activity` (`"idle" | "turn" | "background"`) and `session.pending_interaction` (`"none" | "approval" | "question"`). Before making risky edits on an existing session, optionally branch it via `POST /api/v1/sessions/{session_id}:fork` (`{ "turn_index"?: number, "title"?: "..." }`).
2. **Submit a prompt**:
   - `POST /api/v1/sessions/{session_id}/prompts` with a fresh unique `prompt_id` (e.g. `"p-1"` or a UUID):
     ```json
     {
       "prompt_id": "p-1",
       "content": [{ "type": "text", "text": "Implement feature X and run tests." }]
     }
     ```
   - Check `code === 0` and ensure `data.status` is `"running"` or `"queued"` (not `"blocked"` or `"failed"`).
3. **Block for the next stopping point (`POST /api/v1/sessions/{session_id}:wait`)**:
   - Call `POST /api/v1/sessions/{session_id}:wait` with `{ "timeout_ms": 15000 }` (`0..60000`, default `15000`; pass a shorter window such as `1000`–`3000` when you want periodic mid-step inspection windows to peek at `/turns` or inject `/steer`).
   - `:wait` returns **immediately (0 ms)** if `session.activity !== "turn"` or a pending interaction already exists; otherwise it blocks until `main` leaves `"turn"`, a pending `approval`/`question` appears, or `timeout_ms` elapses:
     ```json
     {
       "session": { "id": "s1", "activity": "turn", "pending_interaction": "approval", "..." : "..." },
       "pending_interactions": [
         {
           "interaction_id": "i9",
           "session_id": "s1",
           "agent_id": "main",
           "kind": "approval",
           "created_at": "2026-11-17T14:00:00.000Z",
           "tool_call_id": "call_1",
           "request": {
             "tool_name": "Bash",
             "action": "Run shell command",
             "tool_input_display": { "kind": "command", "command": "pnpm test", "cwd": "/repo", "language": "bash" },
             "expires_at": "2026-11-18T14:00:00.000Z"
           }
         }
       ],
       "timed_out": false
     }
     ```
4. **Branch on the `:wait` result**:
   - **Case 1 — `pending_interactions` is non-empty** (you can also read them anytime via `GET /api/v1/sessions/{session_id}/interactions`):
     Inspect each item's `kind` and `request`, then answer via `POST /api/v1/sessions/{session_id}/interactions/{interaction_id}`:
     - For `kind === "approval"`:
       `{ "kind": "approval", "decision": "approved" | "rejected" | "cancelled", "scope"?: "session", "feedback"?: "..." }` (`"scope": "session"` auto-approves matching actions for the rest of the session; `"rejected"` with `"feedback"` tells the agent what to do instead).
     - For `kind === "question"`:
       Inspect `request.questions` (each has `id` like `"q_0"` and `options` with `id` like `"opt_0_0"` + `label`), then send `{ "kind": "question", "answers": { "q_0": { "kind": "single", "option_id": "opt_0_0" } } }` (or `{ "kind": "other", "text": "..." }`, `{ "kind": "multi", "option_ids": [...] }`, or `{ "kind": "question", "dismissed": true }`).
     - After answering all items, **loop back to `:wait`**.
   - **Case 2 — `timed_out === true` (`session.activity === "turn"` still running)**:
     Peek at live progress via `GET /api/v1/sessions/{session_id}/agents/main/turns?page_size=5` — the server flushes live streaming buffers on every `GET .../turns` read, so the last turn (`status: "running"`) includes up-to-the-millisecond `reasoning`, `tool_call` (`stage`, `display`, plus `input` / `fields` / streaming `output` once approved into `executing`), and `assistant_message` items!
     - If on track: simply **loop back to `:wait`**.
     - If off track and `pending_interactions` is empty: steer mid-turn via `POST /api/v1/sessions/{session_id}/steer`:
       ```json
       {
         "prompt_id": "steer-1",
         "content": [{ "type": "text", "text": "Stop editing foo.ts; update bar.ts instead." }]
       }
       ```
       **Important**: `POST /steer` is a **blocking** HTTP call that returns HTTP `200` only after reaching an injection point (while the model is streaming text it interrupts generation immediately; while a tool is `executing`, the tool finishes running first without being killed — use `:cancel` to kill a running tool — so do not set a tiny HTTP client timeout on `/steer`, and never call `/steer` while an unanswered `interaction` is pending). Because `/steer` may end the current turn and open a **continuation `Turn`** (where your steered message appears with `placement: "opener"`, matched by `prompt_ids`), always keep looping on `:wait` afterward until `session.activity !== "turn"`.
     - If you want to abort completely: call `POST /api/v1/sessions/{session_id}:cancel` (`{ "include_background": true }`), then optionally `POST /api/v1/sessions/{session_id}:undo` (`{ "turn_id": "..." }`).
   - **Case 3 — `pending_interactions` is empty and `session.activity !== "turn"`**:
     The main turn has finished (`session.last_turn_outcome` is `"completed" | "interrupted" | "failed"`). Fetch `GET /api/v1/sessions/{session_id}/agents/main/turns?page_size=5` to read the completed `assistant_message` and tool results (`session.activity === "background"` means `main` is idle while a detached background task continues running).

### Minimal pure-HTTP shell pattern (`curl` + `jq`)

```sh
# 1. Create session (in manual permission mode if you want to review tool approvals)
SID=$(curl -sf -X POST "${ORIGIN}/api/v1/sessions" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d "{\"cwd\":\"$PWD\",\"agent_config\":{\"permission_mode\":\"manual\"}}" | jq -r '.data.id')

# 2. Submit prompt
curl -sf -X POST "${ORIGIN}/api/v1/sessions/${SID}/prompts" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d '{"prompt_id":"p-1","content":[{"type":"text","text":"Run echo hello and report the output."}]}' >/dev/null

# 3. Supervise via :wait (always brace ${SID}:wait in zsh/bash!) until main leaves "turn"
while true; do
  WAIT_JSON=$(curl -sf -X POST "${ORIGIN}/api/v1/sessions/${SID}:wait" \
    -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
    -d '{"timeout_ms":15000}')
  COUNT=$(printf '%s' "$WAIT_JSON" | jq '.data.pending_interactions | length')
  if [ "$COUNT" -gt 0 ]; then
    IID=$(printf '%s' "$WAIT_JSON" | jq -r '.data.pending_interactions[0].interaction_id')
    curl -sf -X POST "${ORIGIN}/api/v1/sessions/${SID}/interactions/${IID}" \
      -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
      -d '{"kind":"approval","decision":"approved"}' >/dev/null
    continue
  fi
  ACTIVITY=$(printf '%s' "$WAIT_JSON" | jq -r '.data.session.activity')
  [ "$ACTIVITY" != "turn" ] && break
done

# 4. Read final assistant reply
curl -sf "${ORIGIN}/api/v1/sessions/${SID}/agents/main/turns?page_size=5" \
  -H "Authorization: Bearer ${TOKEN}" | jq -r '.data.turns[-1].items[] | select(.type=="assistant_message") | .text'
```

### Triaging and organizing session history

- **List & filter**: `GET /api/v1/sessions?page_size=50&archived=false&sort=updated_at_desc` (or `?view=by_workspace`; pass `page_token` from `next_page_token` to paginate).
- **Inspect content**: `GET /api/v1/sessions/{session_id}/agents/main/turns?page_size=10`.
- **Rename or update metadata**: `POST /api/v1/sessions/{session_id}/profile` with `{ "title": "Clear descriptive title" }` (or call `POST /api/v1/sessions/{session_id}/title/generate` to auto-generate a title). Note: `metadata` on `/profile` replaces all custom keys as a whole (`metadata: {}` is a no-op).
- **Batch archive / restore**: `POST /api/v1/sessions:archive` (or `:restore`) with `{ "ids": ["s1", "s2"] }` — inspect `data.results` and `data.failed` for per-session outcomes.

---

## 4. Core domain shapes

Fetch `GET /openapi.json` and `GET /asyncapi.json` for exhaustive field schemas; key invariants are:

- **`Session`**: `{ id, workspace_id, cwd, title, created_at, updated_at, archived, archived_at?, activity: "idle" | "turn" | "background", pending_interaction?: "none" | "approval" | "question", last_turn_outcome?: "completed" | "interrupted" | "failed", last_prompt?, metadata?, git? }`. `activity` reflects live state in *this* server process (cold on-disk sessions report `activity: "idle"` and `pending_interaction: "none"`).
- **`Turn`**: `{ turn_id, ordinal, turn_number?, kind: "agent" | "system", status: "running" | "ended", outcome?: "completed" | "interrupted" | "failed", end_reason?, error?, retry?, started_at, ended_at?, duration_ms?, usage?, steps: Step[], items: Item[] }`. Ordered by 0-based `ordinal`; pass `before_ordinal` to `GET .../turns` to paginate older history backward.
- **`Item` union** (keyed by `type`, sharing `{ item_id, type, step_index?, status: "running" | "ended", outcome?, created_at }`):
  - `user_message`: `{ prompt_ids: string[], placement: "opener" | "steer", origin, text, attachments, skills, metadata? }`.
  - `assistant_message`: `{ text }`.
  - `reasoning`: `{ text, started_at, duration_ms? }`.
  - `tool_call`: `{ name, stage?: "input" | "awaiting_approval" | "executing", input?, input_text?, output?, error?, fields?, media?, note?, task_id?, interaction_id?, agent_refs?, display?, started_at, ended_at? }` (`output` holds normal results; `error` holds failed/interrupted output; `agent_refs` lists child subagents `{ agent_id, role, swarm_index?, task_id? }[]`).
  - `notification`: background task completion injected into history.
  - `system`: `kind: "compaction"` or `kind: "fork_boundary"` (`source: "btw" | "fork"`).
- **`PendingInteraction`** (in `GET .../interactions` → `data.items`, `POST ...:wait` → `data.pending_interactions`, and WS `interaction` frames):
  - Common: `{ interaction_id, session_id, agent_id, kind: "approval" | "question", created_at?, tool_call_id? }`.
  - `approval`: `request: { tool_name, action, tool_input_display?, expires_at }`.
  - `question`: `request: { questions: [{ id, question, header?, body?, options: [{ id, label, description? }], multi_select?, allow_other?, other_label?, other_description? }] }`.

---

## 5. Path B: UI and bot clients (HTTP + WebSocket streaming)

Clients that render live token deltas, per-agent status badges, or streaming background task output open a single WebSocket at `/api/v1/ws` and implement the six invariants below:

1. **Heartbeat & command framing**: Reply `{ "type": "pong" }` whenever the server sends `{ "type": "ping" }` (every 10 s; silent connections close after 20–30 s with `1001`). Every client command (`subscribe`, `unsubscribe`, `task.watch`, `task.unwatch`, `task.stop`, `task.background`) must carry a non-empty `request_id` (missing `request_id` closes with `1008`) and receives `{ "type": "response", "request_id", "code", "msg?", "task?" }`.
2. **Subscription sequence**: Sending `{ "type": "subscribe", "request_id": "sub-1", "session_id": "s1", "agent_ids": ["main"] }` emits in order: (a) `response` (`code: 0`), (b) all pending `interaction` frames across **all agents in the session**, (c) initial `task.list`, `agent`, `context` (when a model is bound), `goal` (`main` only), and `todo` snapshots, and (d) initial `turns` snapshot (≤10 latest turns within 1 MiB). Live `turn.*` / `item.*` / `turns.removed` / `notice` frames for an agent never arrive before its initial `turns` frame.
3. **Defensive `Turn` & `Item` reduction**:
   - **`turns`**: Full replacement for `(session_id, agent_id)` — discard cached turns and any in-flight `GET .../turns` requests for that agent.
   - **`turn.started` & `turn.ended` omit `items`**: Update the turn header via `{ ...frame.turn, items: existing?.items ?? [] }` so `items` are preserved without retaining stale header fields (`retry`, `outcome`, etc.).
   - **`turn.updated`**: Upsert `frame.step` by `step.index` and set `turn.retry = frame.retry` (clearing `retry` when omitted).
   - **`item.started` carries non-empty initial text**: `assistant_message` and `reasoning` emit `item.started` on the first chunk (`item.started.item.text` is already non-empty, and short replies emit **zero** `item.delta` frames). Reduce items with:
     ```js
     switch (frame.type) {
       case 'item.started':
         itemsById.set(frame.item.item_id, { ...itemsById.get(frame.item.item_id), ...frame.item });
         break;
       case 'item.ended':
         itemsById.set(frame.item.item_id, frame.item);
         break;
       case 'item.delta': {
         const item = itemsById.get(frame.item_id);
         if (item) item[frame.field] = (item[frame.field] ?? '') + frame.delta;
         break;
       }
       case 'item.updated': {
         const target = itemsById.get(frame.item_id);
         if (target) Object.assign(target, frame.set);
         break;
       }
       case 'item.removed':
         itemsById.delete(frame.item_id);
         break;
     }
     ```
   - **Channel races**: Subscribe on WS *before* calling `POST .../prompts` (WS frames often arrive before the HTTP response resolves), and keep pending `interaction` frames in a session-level map keyed by `interaction_id` (`interaction` flushes immediately and can arrive before the 16 ms batched `tool_call` `item.started` / `item.updated`).
4. **`/steer` cross-turn completion & anti-deadlock**:
   - Mid-stream `/steer` (or `/prompts:steer` / busy `/skills/{name}:activate`) interrupts the active step and may either inject into the current turn (`placement: "steer"`) **or** end the current turn and open a **new continuation `Turn`**. Wait until all submitted `prompt_id`s appear in `user_message.prompt_ids` **and** `agent.status === "idle"` (`compacting: false`), not merely the first `turn_id`'s `turn.ended`.
   - **Never `await` `POST .../steer` on the same coroutine/loop that reads WebSocket `interaction` frames**: `/steer` blocks until an injection point, which stalls if an `approval`/`question` arrives and nothing reads the WebSocket to answer it.
5. **Task streaming (`task.watch`) & reconnection**:
   - `task.list` replaces running tasks for `(session_id, agent_id)`; `task` upserts by `task_id`. `task.output` `offset` is a **UTF-8 byte offset** (`Buffer.byteLength(text, 'utf8')`, not JS `.length`). Track `endOffset` and reconnect with `since_offset: endOffset`.
   - On WebSocket reconnect: clear local pending `interaction` cards (resubscribe only sends still-pending interactions without replaying missed `ended` events), resend `subscribe`, resend `task.watch` with `since_offset`, and refresh REST session lists. Global unsubscribed broadcasts include `session`, `workspace`, `config`, `invalidated`, `event.capability.changed`, and `event.host.changed`.
6. **Attachments & skills**: Upload attachments via `POST /api/v1/files` (`multipart/form-data` field `file`) and pass the returned `id` in `/prompts` `content`; list skills via `GET /api/v1/sessions/{session_id}/skills` and attach `skills: [{ name, args? }]` on `/prompts` or call `POST /api/v1/sessions/{session_id}/skills/{name}:activate`.

---

## 6. Endpoint and WebSocket catalog

Inspect `GET /openapi.json` and `GET /asyncapi.json` on a running server for exact request/response schemas. In **Gate**, `baseline` means present in KAP `0.1.0`; capability names map to `GET /api/v1/meta` → `data.capabilities.<flag>`.

### Core KAP endpoints (stable `0.x` supervision & client surface)

| Method & Path | Gate | Summary |
| --- | --- | --- |
| `GET /api/v1/healthz` | `baseline` | Unauthenticated liveness probe (`{ ok: true }`) |
| `GET /api/v1/meta` | `baseline` | Protocol version, `server_version`, `server_id`, `capabilities`, `experimental_flags`, `features` |
| `GET /api/v1/kap.md` | `baseline` | Built-in Markdown specification (`text/markdown; charset=utf-8`) matching this server binary |
| `GET /openapi.json` / `GET /asyncapi.json` | `baseline` | Live OpenAPI 3.0 (REST) and AsyncAPI 3.1 (WebSocket) schemas |
| `POST /api/v1/sessions` | `baseline` | Create a session (`cwd` or `workspace_id`, optional `title`, `metadata`, `agent_config`, `environment_id`) |
| `GET /api/v1/sessions` / `GET /api/v1/sessions/{session_id}` | `baseline` | List/filter/group sessions (`flat` or `by_workspace`, pagination) or read one session |
| `POST /api/v1/sessions/{session_id}:wait` | `session_wait` | Block until `activity !== "turn"`, a pending interaction appears, or `timeout_ms` (`0..60000`, default `15000`); returns `{ session, pending_interactions, timed_out }` |
| `POST /api/v1/sessions/{session_id}:cancel` | `baseline` | Cancel running turn (`agent_id?`, `include_background?`) |
| `POST /api/v1/sessions/{session_id}:fork` / `:undo` / `:compact` / `:btw` | `baseline` | Fork session (`turn_index?`), undo from `turn_id`, compact context (`instruction?`), or spawn side-chat (`{ agent_id }`) |
| `POST /api/v1/sessions/{session_id}:archive` / `:restore` / `:delete` / `:reload` / `:takeover` | `baseline` | Lifecycle actions on one session (also batch `POST /api/v1/sessions:archive` & `:restore` by `ids`) |
| `POST /api/v1/sessions/{session_id}/profile` & `/title/generate` | `baseline` | Update `title`, `metadata`, or `agent_config`, or generate a title from conversation context |
| `GET /api/v1/sessions/{session_id}/agents/{agent_id}/turns` | `baseline` | Read turns backward via `before_ordinal` (`page_size` ≤ 200; flushes live streaming items on read) |
| `GET` / `POST /api/v1/sessions/{session_id}/prompts` | `baseline` | Inspect queued/active prompts or submit a prompt (`prompt_id`, `content`, setting overrides, `skills?`) |
| `POST /api/v1/sessions/{session_id}/steer` & `/prompts:steer` & `/prompts/{prompt_id}:abort` | `baseline` | Steer directly into a running turn, promote queued prompts to steers, or abort a prompt |
| `GET /api/v1/sessions/{session_id}/interactions` | `interactions_list` | List pending `approval` and `question` interactions (`{ items }`) |
| `POST /api/v1/sessions/{session_id}/interactions/{interaction_id}` | `baseline` | Answer a pending `approval` or `question` interaction |
| `GET /api/v1/sessions/{session_id}/skills` & `POST .../skills/{name}:activate` | `baseline` | List session skills or invoke a skill |
| `GET /api/v1/sessions/{session_id}/file-history/changes` & `/content` | `baseline` | Inspect per-turn file diffs and snapshots |
| `POST /api/v1/files` & `GET` / `DELETE /api/v1/files/{file_id}` & `GET .../sessions/{id}/media/{file_id}` | `file_upload` | Upload/download attachments and download persisted session media |
| `POST /api/v1/search` | `baseline` | Full-text search across persisted session messages (`query`, `page_token?`) |
| `POST /api/v1/shutdown` | `baseline` | Gracefully stop the server (mounted on loopback or with `--allow-remote-shutdown`) |

### First-party host & workspace management endpoints (may evolve across `0.x`)

| Surface | Summary |
| --- | --- |
| `POST /api/v1/sessions/{id}/fs:{action}`, `GET .../fs/{path}:download`, `POST /api/v1/workspace/fs:*`, `GET`/`POST /api/v1/fs:*` (`fs_query`) | Session, workspace, and host filesystem browsing, search, grep, git status/diff, download, and local app launch |
| `GET`/`POST`/`PATCH`/`DELETE /api/v1/workspaces*` & `GET .../sessions/{id}/environment*` | Workspace registry, trust settings, project config dirs, and execution environments |
| `GET /api/v1/auth`, `GET`/`POST /api/v1/config`, `GET`/`POST`/`PUT`/`DELETE /api/v1/providers*`, `POST /api/v1/models/{id}:set_default`, `GET /api/v1/catalog/providers*` | Auth readiness, global config, model aliases, and provider management |
| `GET` / `POST` / `PUT` / `DELETE /api/v1/mcp/*` (`mcp`), `/api/v1/plugins*`, `/api/v1/capabilities*`, `GET /api/v1/tools` | MCP servers & OAuth, plugin marketplace/installs, built-in capabilities, and effective tool list |
| `GET`/`POST`/`DELETE /api/v1/oauth/*`, `/api/v1/remote-control*`, `/api/v1/hosts*`, `POST .../sessions/{id}/export` & `/rating`, `GET .../warnings` | Managed OAuth login/usage, Remote Control tunnel, SSH remote hosts & proxy, ZIP export, rating, and session warnings |

### WebSocket `/api/v1/ws` frames

| Direction | `type` | Gate | Summary |
| --- | --- | --- | --- |
| C → S | `subscribe` / `unsubscribe` | `websocket` | Subscribe (`agent_ids` defaults to `["main"]`) or unsubscribe session agents |
| C → S | `task.watch` / `task.unwatch` / `task.stop` / `task.background` | `tasks` | Stream UTF-8 byte-offset task output, kill a task, or detach a foreground tool call |
| C ↔ S | `ping` (S → C) / `pong` (C → S) & `response` (S → C) | `websocket` | 10 s heartbeat and `request_id`-matched command replies |
| S → C | `turns` / `turns.failed` / `turns.removed`, `turn` (`turn.started`/`turn.ended`), `turn.updated` | `websocket` | Turn snapshot, turn lifecycle headers (omit `items`), and step/retry updates |
| S → C | `item` (`item.started`/`item.ended`), `item.delta`, `item.updated`, `item.removed`, `notice` | `websocket` | Streaming item lifecycle and transient notices |
| S → C | `interaction`, `agent`, `context`, `goal`, `todo`, `task.list`, `task`, `task.output` | `websocket` / `tasks` | Session-wide pending/ended interactions, per-agent snapshots, and task streams |
| S → C | `session`, `workspace`, `config`, `invalidated`, `event.capability.changed`, `event.host.changed` | `websocket` | Unsubscribed global state broadcasts |
