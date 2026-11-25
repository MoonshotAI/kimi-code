# Kimi Agent Protocol (KAP) Runtime Guide

Served by the running Kimi Code local server at `GET /api/v1/kap.md` (KAP `1.0.0`; Kimi Code CLI >= `v2.7.0` / Kimi Code Desktop >= `v1.4.0`). For exact request bodies, query parameters, and response schemas of this server version, inspect `GET /openapi.json` (REST) and `GET /asyncapi.json` (WebSocket).

## 1. Local connection & schema discovery

All `/api/v1/*`, `/openapi.json`, and `/asyncapi.json` endpoints require `Authorization: Bearer <token>` (`GET /api/v1/healthz` is unauthenticated).

1. **Attach to a running Desktop app or `kimi web` server first** (so new or updated sessions appear live in the user's open Kimi Code window without manual refresh):
   - Read `KIMI_HOME="${KIMI_CODE_HOME:-$HOME/.kimi-code}"` and `TOKEN="$(tr -d '[:space:]' < "$KIMI_HOME/server.token")"`.
   - Sort `"$KIMI_HOME"/server/instances/*.json` with `product == "kimi-code-desktop"` first, then newest `started_at` (never iterate `*.json` in raw ULID filename order, which hits the oldest process first):
     ```sh
     jq -rs 'map(select((.port // 0) > 0)) | sort_by((if .product == "kimi-code-desktop" then 0 else 1 end), -(.started_at // 0)) | .[] | "\(.pid)\t\(.host)\t\(.port)"' "$KIMI_HOME"/server/instances/*.json
     ```
   - Verify `kill -0 "$pid"`, map `host` `"0.0.0.0"` to `"127.0.0.1"` (or `"::"` / `"::1"` to `"[::1]"`), and pick the first `http://<host>:<port>` where `GET /api/v1/kap.md` (`Authorization: Bearer ${TOKEN}`) returns HTTP `200`.
2. **Fallback -- start an on-demand subprocess**:
   - Spawn `kimi web --port 0 --json` in the background (`--json` implies `--no-open`, writes logs to `stderr`, and mints an in-memory bearer token for that process).
   - Parse line 1 of `stdout`:
     ```json
     {"origin":"http://127.0.0.1:54123","ws_url":"ws://127.0.0.1:54123/api/v1/ws","token":"...","kimi_agent_protocol_version":"1.0.0"}
     ```
   - Stop the background process (`SIGTERM`) once active turns have settled.
3. **Inspect detailed route parameters on demand**:
   - REST OpenAPI 3.0: `curl -sf -H "Authorization: Bearer ${TOKEN}" "${ORIGIN}/openapi.json" | jq '.paths["/api/v1/sessions/{session_id}:wait"]'`
   - WebSocket AsyncAPI 3.1: `curl -sf -H "Authorization: Bearer ${TOKEN}" "${ORIGIN}/asyncapi.json"`

---

## 2. Request conventions

- **JSON envelope**: JSON endpoints return `{ "code": 0, "msg": "success", "data": ..., "request_id": "..." }`. Check `code === 0` first (`40001` validation error with `details`, `40401` session/agent not found, `40404` interaction not found, `40901` session busy, `40902` interaction already ended, `40927` `prompt_id` conflict, `40931` session locked by another process, `40939` agent not closable, `40940` turn not continuable, `40941` primary directory of an implicit workspace cannot be changed, `41001`/`41002` interaction expired; HTTP `401`/`403`/`429` indicate auth or rate-limit rejection).
- **Workspace placement when creating sessions (`workspace_id` vs `workspace_root`)**:
  - Keep new or follow-up sessions in the **current project/workspace** unless the user explicitly asks for a different directory -- do **not** switch `workspace_root` to `$HOME` just because a task inspects machine-wide paths.
  - On `POST /api/v1/sessions`, passing only `workspace_root` always routes to an `implicit` (`wd_*`) workspace and will **not** attach to a Desktop `managed` (`wm_*`) workspace. A `workspace_root` inside a git repository (a subdirectory or a linked worktree) joins the implicit workspace of the repository's main checkout, unless that directory already has its own implicit workspace with at least one session (archived ones count): such a workspace stays in use until it is deleted (for example in the desktop app), after which new sessions there join the repository's workspace. Take `workspace_id` from the response instead of deriving it from `workspace_root`. Resolve `workspace_id` first:
    1. **Inside a Kimi Code session** (`$KIMI_CODE_WORKSPACE_ID` and `$KIMI_CODE_SESSION_ID` are injected in `Bash` tool child processes): pass `{ "workspace_id": "$KIMI_CODE_WORKSPACE_ID" }` together with the `environment_id` and `environment_cwd` that `GET /api/v1/sessions/${KIMI_CODE_SESSION_ID}` reports for your session (omit `environment_cwd` when it is absent). Sessions of one workspace can run in different checkouts of its repository, and `workspace_id` alone starts the new session at the workspace root (usually the main checkout) even when yours runs in a linked worktree.
    2. **From an external agent** (`$KIMI_CODE_WORKSPACE_ID` unset): query `GET /api/v1/workspaces` and match `data.items[]` where `root` equals your target directory (preferring `kind == "managed"` if multiple match); pass `{ "workspace_id": "<id>" }` when found, or `{ "workspace_root": "<target_dir>" }` only when no workspace exists for that directory yet.
  - A new session runs in the directory it starts in: `environment_cwd` when given, otherwise `workspace_root`, or the workspace root when only `workspace_id` is given. A session started at the root follows it when the root changes; one started anywhere else stays in its own directory. With `workspace_id`, `workspace_root` must equal the workspace root or lie in the same git repository -- its main checkout, a linked worktree, or a subdirectory of either (`40001` otherwise; the rule is the same for `managed` and `implicit` workspaces):
    - When the workspace root is itself a subdirectory of a repository, `workspace_root` must be that subdirectory, or a directory inside it, in any checkout.
    - Additional directories, nested repositories and submodules do not count, nor does a repository whose main checkout is the home directory or above it. Outside a repository only the root itself is accepted.
    - Paths are compared after resolving symlinks, so a symlink inside the repository that points outside it is rejected, and a symlinked spelling of the workspace root is accepted.
  - To make the agent work somewhere else, also pass `environment_id` (`"local"` or a configured remote environment) and `environment_cwd` (a directory on that environment, such as one package of a monorepo).
  - A session reports the workspace root in `workspace_root`, and the directory it runs in, when that is not the workspace root, in `environment_cwd`.
- **Shell variable bracing (`zsh` / `bash`)**: Always brace variables before `:action` suffixes -- write `"${ORIGIN}/api/v1/sessions/${SID}:wait"`, not `"$SID:wait"` (`zsh` treats `:w`, `:a`, `:r`, `:c`, `:t` as modifiers).

---

## 3. Core HTTP workflows

### A. Bidirectional session handoff (`HandOff`) & spawning parallel sessions

- **Hand off TO Kimi Code (or fan out follow-up sessions)**: Attach to the live Desktop / `kimi web` server (§1.1) so sessions appear in real time, resolve `workspace_id` (§2) so they land in the active workspace, call `POST /api/v1/sessions` (`{ "workspace_id"?, "workspace_root"?, "title", "agent_config"?: ... }`), then submit a concise structured brief (Goal, Modified files, Constraints, Next steps) via `POST /api/v1/sessions/{session_id}/prompts` and return each `session_id` (plus `kimi -S <session_id>`) to the user. If running against an on-demand `kimi web --port 0 --json` subprocess, wait via `:wait` until `activity !== "turn"` before stopping the subprocess so history persists cleanly.
- **Pick up FROM Kimi Code**: Locate the session via `GET /api/v1/sessions?page_size=50&archived=false&sort=updated_at_desc` (add `query=<text>` to match title or last prompt, or an exact session id) or `POST /api/v1/search` (`{ "query": "..." }`), read `GET /api/v1/sessions/{session_id}/agents/main/turns?page_size=10` (plus `GET .../interactions` if `pending_interaction !== "none"`), summarize progress and blockers, and either wait for the user's next instruction or continue (optionally branching first via `POST /api/v1/sessions/{session_id}:fork` `{ "turn_index"?: number, "title"?: "..." }`).

### B. Cross-workspace session organization

Omitting `workspace_id` on `GET /api/v1/sessions` queries across all workspaces on the machine:

- **List & paginate**: `GET /api/v1/sessions?page_size=100&archived=false&sort=updated_at_desc` (`page_size` <= `100`, or `fields=id,archived&page_size=10000`; pass `page_token` from `next_page_token`; use `?view=by_workspace` to group).
- **Rename vague titles**: Inspect `GET .../agents/main/turns?page_size=5`, then update via `POST /api/v1/sessions/{session_id}/profile` (`{ "title": "..." }`, omitting `metadata` unless replacing custom keys) or `POST /api/v1/sessions/{session_id}/title/generate`.
- **Batch archive / restore**: `POST /api/v1/sessions:archive` (or `:restore`) with `{ "ids": ["s1", "s2"] }` -- inspect `data.results` and `data.failed`.

### C. Multi-turn Agent-to-Agent discussion & interactive turn loop

1. **Resolve model (when the user names a specific model)** & **create a session**:
   - Query `GET /api/v1/models` (`data.items[]` has `{ provider, model, display_name, support_efforts }`) to map a human model name to `"${provider}/${model}"` instead of guessing model IDs.
   - Create a session in the target workspace (§2) via `POST /api/v1/sessions` with `{ "workspace_id": "...", "workspace_root"?: "...", "title"?: "...", "agent_config"?: { "permission_mode": "manual" | "auto" | "yolo", "model"?: "${provider}/${model}", "thinking"?: "high", "plan_mode"?: false } }` (or only `"workspace_root"` when no workspace exists yet).
2. **Submit a round prompt**: `POST /api/v1/sessions/{session_id}/prompts` with a unique `prompt_id` (`"round-1"`, `"round-2"`, ...) and `{ "content": [{ "type": "text", "text": "..." }] }`. Verify `code === 0` and `data.status` is `"running"` or `"queued"`.
3. **Wait for the next stopping point**: `POST /api/v1/sessions/{session_id}:wait` with `{ "timeout_ms": 15000 }` (`0..60000`, default `15000`; use `1000`-`3000` for periodic progress checks). Returns in `0 ms` if `session.activity !== "turn"` or a pending interaction already exists; otherwise blocks until `main` leaves `"turn"`, a pending `approval`/`question` appears, or `timeout_ms` elapses (`{ session, pending_interactions, timed_out }`). When it returns with `timed_out: false`, everything the session recorded so far is on disk: a server restarted after a crash at that point shows the same turns.
4. **Branch on the `:wait` result**:
   - **`pending_interactions` non-empty** (also readable via `GET /api/v1/sessions/{session_id}/interactions`): reply via `POST /api/v1/sessions/{session_id}/interactions/{interaction_id}`:
     - `kind === "approval"`: `{ "kind": "approval", "decision": "approved" | "rejected" | "cancelled", "scope"?: "session", "feedback"?: "..." }`.
     - `kind === "question"`: inspect `request.questions` (`id` like `"q_0"`, `options[].id` like `"opt_0_0"` + `label`), then send `{ "kind": "question", "answers": { "q_0": { "kind": "single", "option_id": "opt_0_0" } } }` (or `"multi"`, `"other"`, `"multi_with_other"`, `"skipped"`, or `{ "kind": "question", "dismissed": true }`).
     - Loop back to `:wait`.
   - **`timed_out === true` (`session.activity === "turn"`)**: read live progress via `GET /api/v1/sessions/{session_id}/agents/main/turns?page_size=5` (flushes in-flight `reasoning`, `tool_call`, and `assistant_message` items on read).
     - On track -> loop back to `:wait`.
     - Needs mid-turn course correction (when `pending_interactions` is empty) -> `POST /api/v1/sessions/{session_id}/steer` (`{ "prompt_id": "steer-1", "content": [{ "type": "text", "text": "..." }] }`). `/steer` waits for the next safe injection point and may open a continuation `Turn`, so keep looping on `:wait` until `session.activity !== "turn"`.
     - Abort -> `POST /api/v1/sessions/{session_id}:cancel` (`{ "include_background": true }`), optionally followed by `:undo`.
   - **`pending_interactions` empty and `session.activity !== "turn"`**: round finished (`last_turn_outcome`: `"completed" | "interrupted" | "failed"`). Read Kimi Code's reply from `GET /api/v1/sessions/{session_id}/agents/main/turns?page_size=5`; for multi-round Agent-to-Agent discussions, evaluate the points raised and send the next round via `POST .../prompts` on the same `session_id` until convergence or the round cap.

```sh
TARGET_REQ=$(if [ -n "${KIMI_CODE_WORKSPACE_ID:-}" ]; then
  ENV=$(curl -sf "${ORIGIN}/api/v1/sessions/${KIMI_CODE_SESSION_ID}" -H "Authorization: Bearer ${TOKEN}" \
    | jq -c '.data | {environment_id, environment_cwd} | with_entries(select(.value != null))')
  jq -nc --arg wid "$KIMI_CODE_WORKSPACE_ID" --arg env "$ENV" \
    '{workspace_id:$wid,agent_config:{permission_mode:"manual"}} + (if $env == "" then {} else ($env | fromjson) end)'
else
  WID=$(curl -sf "${ORIGIN}/api/v1/workspaces" -H "Authorization: Bearer ${TOKEN}" \
    | jq -r --arg root "$PWD" '[.data.items[] | select(.root == $root)] | sort_by(if .kind == "managed" then 0 else 1 end) | .[0].id // empty')
  if [ -n "$WID" ]; then
    jq -nc --arg wid "$WID" '{workspace_id:$wid,agent_config:{permission_mode:"manual"}}'
  else
    jq -nc --arg root "$PWD" '{workspace_root:$root,agent_config:{permission_mode:"manual"}}'
  fi
fi)

SID=$(curl -sf -X POST "${ORIGIN}/api/v1/sessions" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d "$TARGET_REQ" | jq -r '.data.id')

curl -sf -X POST "${ORIGIN}/api/v1/sessions/${SID}/prompts" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d '{"prompt_id":"round-1","content":[{"type":"text","text":"Review our migration plan and challenge weak assumptions."}]}' >/dev/null

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
  [ "$(printf '%s' "$WAIT_JSON" | jq -r '.data.session.activity')" != "turn" ] && break
done

curl -sf "${ORIGIN}/api/v1/sessions/${SID}/agents/main/turns?page_size=5" \
  -H "Authorization: Bearer ${TOKEN}" | jq -r '.data.turns[-1].items[] | select(.type=="assistant_message") | .text'
```

---

## 4. Core shapes & endpoint directory

- **`Session`**: `{ id, workspace_id, workspace_root?, environment_id?, environment_cwd?, title, created_at, updated_at, archived, archived_at?, activity: "idle" | "turn" | "background", pending_interaction?: "none" | "approval" | "question", last_turn_outcome?: "completed" | "interrupted" | "failed", last_prompt?, metadata?, git? }`. `workspace_root` is the project directory the session belongs to; `environment_id` (`"local"` when absent) and `environment_cwd` tell where the agent reads files and runs commands, and `environment_cwd` is omitted while a local session works in the project root.
- **`Turn`**: `{ turn_id, ordinal, turn_number?, kind: "agent" | "system", status: "running" | "ended", outcome?: "completed" | "interrupted" | "failed", continuation?: "turn" | "background" | "none", started_at, ended_at?, duration_ms?, usage?, steps: Step[], items: Item[] }` (0-based `ordinal`; pass `before_ordinal` to page backward). On an ended turn, `continuation` reports what follows: `"turn"` (another foreground turn is queued or pending), `"background"` (foreground work is drained but background tasks are still running), or `"none"` (all work is finished); it is omitted on running turns, turns ended while the loop is closing, and older records.
- **`Item` union** (`type`): `user_message` (`{ prompt_ids, placement, text, ... }`), `assistant_message` (`{ text }`), `reasoning` (`{ text }`), `tool_call` (`{ name, stage?, input?, output?, error?, fields?, display?, interaction_id?, agent_refs? }`), `notification`, `system`.
- **Attachments & skills**: Upload via `POST /api/v1/files` (`multipart/form-data` field `file`) and reference `id` in `/prompts` `content`; list/invoke skills via `GET /api/v1/sessions/{session_id}/skills` and `POST .../skills/{name}:activate`.

### WebSocket notices

`notice` frames are live warning or error events from an agent. They are not part of the turns and are not replayed on reconnect. On subscribe, the initial `turns` or `turns.failed` frame precedes turn, item, and notice frames.

`model.not_configured` reports that the main session's saved model alias is no longer configured; `title` contains the removed alias. History and read endpoints remain read-only, and the server does not rebind or clear the model. First-party UI may use this event to let the user choose another model through the existing model picker.

### Agent state

`agent` frames and the `agent` object returned by `POST /api/v1/sessions/{session_id}/profile` carry the same agent state. While the main agent's saved model is no longer configured, `model` is omitted and `missing_model` holds the removed alias.

`profile_revision` orders the agent's settings (`model`, `missing_model`, `thinking`, `permission_mode`, `plan_mode`, `swarm_mode`, `tower_mode`) across the HTTP response and the WebSocket frames, which can arrive in either order. It increases whenever those settings change, also across server restarts, and stays the same otherwise. Apply settings from a state only when its `profile_revision` is not lower than the one already applied; take `status`, `compacting`, and the `*_available` flags from the latest state. Older servers omit `profile_revision`; apply their states in arrival order.

| Method & Path | Gate | Summary |
| --- | --- | --- |
| `GET /api/v1/healthz` / `GET /api/v1/meta` | `baseline` | Liveness probe (`{ ok: true }`) and server metadata / `product` / `capabilities` / `home_dir` (the Kimi Code data directory) |
| `POST /api/v1/feedback` and its update and attachment endpoints | `feedback` | Submit global feedback or rate a reply. Older hosts omit this capability. |
| `GET /api/v1/kap.md` / `GET /openapi.json` / `GET /asyncapi.json` | `baseline` | Built-in runtime guide (`text/markdown`), REST OpenAPI 3.0 schema, and WS AsyncAPI 3.1 schema |
| `GET /api/v1/workspaces` | `baseline` | List workspaces (`{ items: [{ id, root, name, kind: "managed" \| "implicit" }] }`) |
| `GET /api/v1/models` | `baseline` | List available models (`{ items: [{ provider, model, display_name?, support_efforts? }] }`) |
| `POST /api/v1/sessions` | `baseline` | Create a session (`workspace_id` and / or `workspace_root`, `title?`, `metadata?`, `agent_config?`, `environment_id?`, `environment_cwd?`) |
| `GET /api/v1/sessions` / `GET /api/v1/sessions/{session_id}` | `baseline` | List sessions across workspaces (`flat` or `by_workspace`, filters incl. `query` over title / last prompt / exact id, pagination) or get one session |
| `POST /api/v1/sessions/{session_id}:wait` | `session_wait` | Wait until `activity !== "turn"`, a pending interaction appears, or `timeout_ms` (`0..60000`, default `15000`) |
| `POST /api/v1/sessions/{session_id}:cancel` | `baseline` | Cancel active turn (`agent_id?`, `include_background?`) |
| `POST /api/v1/sessions/{session_id}:continue` | `session_continue` | Continue after an interrupted, non-blocked failed, or crash-settled latest turn (`40940` if not continuable) |
| `POST /api/v1/sessions/{session_id}:predict-prompt` / `:cancel-prompt-prediction` | `experimental` | Generate or cancel a next-prompt prediction (`prediction_id`, `expected_turn_id`, optional `reason`) |
| `POST /api/v1/sessions/{session_id}:fork` / `:undo` / `:compact` / `:btw` | `baseline` | Branch session (`turn_index?`), undo from `turn_id`, compact context, or spawn read-only side-chat (`{ agent_id }`) |
| `POST /api/v1/sessions/{session_id}/agents/{agent_id}:close` | `agent_close` | Close and remove a `btw` side-chat agent (`40939` if not closable) |
| `POST /api/v1/sessions/{session_id}:archive` / `:restore` / `:delete` / `:reload` / `:takeover` | `baseline` | Single-session lifecycle actions (plus batch `POST /api/v1/sessions:archive` & `:restore` by `ids`) |
| `POST /api/v1/sessions/{session_id}/profile` & `/title/generate` | `baseline` | Update `title`, `metadata`, or `agent_config`, or generate a session title |
| `GET /api/v1/sessions/{session_id}/agents/{agent_id}/turns` | `baseline` | Read turns (`before_ordinal?`, `page_size` <= 200; flushes live streaming items on read) |
| `GET` / `POST /api/v1/sessions/{session_id}/prompts` | `baseline` | Read active/queued prompts or submit a prompt (`prompt_id`, `content`, `skills?`). The setting fields on a prompt are deprecated: change settings with `agent_config` on `POST /api/v1/sessions/{session_id}/profile`. `model`, `thinking`, `permission_mode`, and `swarm_mode` still update the session when the prompt is submitted; `plan_mode`, `goal_objective`, and `goal_control` are ignored |
| `POST /api/v1/sessions/{session_id}/steer` & `/prompts:steer` & `/prompts/{prompt_id}:abort` | `baseline` | Steer mid-turn, promote queued prompts to steers, or abort a prompt |
| `GET /api/v1/sessions/{session_id}/interactions` | `interactions_list` | List pending `approval` and `question` interactions (`{ items }`) |
| `POST /api/v1/sessions/{session_id}/interactions/{interaction_id}` | `baseline` | Answer a pending `approval` or `question` interaction |
| `GET /api/v1/sessions/{session_id}/skills` & `POST .../skills/{name}:activate` | `baseline` | List or invoke session skills |
| `GET /api/v1/sessions/{session_id}/file-history/changes` & `/content` | `baseline` | Inspect per-turn file diffs and snapshots |
| `POST /api/v1/files` & `GET` / `DELETE /api/v1/files/{file_id}` | `file_upload` | Upload, download, or delete prompt attachments |
| `POST /api/v1/search` | `baseline` | Full-text search across persisted session messages (`query`, `page_token?`) |
| `POST /api/v1/shutdown` | `baseline` | Gracefully stop a loopback server |
