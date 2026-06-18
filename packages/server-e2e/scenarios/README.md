# Scenarios

Each `.ts` file under this directory is an executable wire-level test of a
single user-facing flow against a running server.

## Running

Default base URL is `http://127.0.0.1:58627`. Start a server (`pnpm dev:server`
from the repo root) before invoking scenarios.

Scenarios import directly from the package's `src/*.ts` so they need a TS
loader. `tsx` (a workspace devDependency) works out of the box:

```sh
# Single scenario
npx tsx packages/server-e2e/scenarios/01-create-and-send.ts

# All scenarios (sequential; first failure exits non-zero)
pnpm --filter @moonshot-ai/server-e2e test:scenarios

# Custom server URL
KIMI_SERVER_URL=http://127.0.0.1:8080 npx tsx packages/server-e2e/scenarios/02-tool-call-with-approval.ts
```

`test:scenarios` writes `reports/latest/index.html` with the scenario timeline,
including stdout/stderr milestones, HTTP request / response envelopes, and
WebSocket frames. Set `KIMI_SERVER_E2E_REPORT_DIR=/tmp/server-e2e-report` to write it
somewhere else.

## Catalog

| File | What it does |
|---|---|
| `_template.ts` | Copy-paste starting point. No assertions; smoke-tests the lifecycle. |
| `01-create-and-send.ts` | Happy path: create session → submit prompt → assert assistant replied with the expected token. |
| `02-tool-call-with-approval.ts` | Drives a Bash tool call; built-in approval handler auto-approves; asserts canary round-trips through `tool_result` AND assistant text; asserts session ends in `idle`. |
| `03-refresh-replay.ts` | "User refreshes the browser" worst case: Phase 0 probes (`/healthz`, `/meta`, `/auth`) → WS handshake → prompt to populate the ring buffer → fresh WS with `last_seq_by_session` (caught-up first, then `0` for full replay) → REST snapshot → steady-state follow-up prompt. Asserts replay ordering (seq 1..N) and that no `resync_required` fires while the buffer covers the gap. |
| `04-stateless-controls.ts` | Per-request stateless prompt controls diff-dispatch into the session shadow, including plan mode and permission mode transitions. |
| `05-workspace.ts` | Workspace registry + folder picker happy path: `fs:home` → `fs:browse $HOME` → `POST /workspaces { root }` → `POST /sessions { workspace_id }` → `GET /sessions?workspace_id=` → prompt round-trip (skipped without provider auth) → `DELETE /workspaces/{id}` (verifies the session survives). |
| `06-model-catalog.ts` | Model/provider catalog reads and current-default `:set_default` round-trip. |
| `07-session-children.ts` | Direct child session creation, child prompt execution, direct-child listing, and missing-parent `40401`. |
| `08-pending-recovery.ts` | Pending approval and pending question recovery APIs, including resolve and pending-list cleanup. |
| `09-image-file-prompts.ts` | Uploaded file prompt references: missing file, non-image validation, and PNG prompt submission. |
| `10-prompt-queue-steer.ts` | Prompt queue steer: debug-inject an active prompt, queue two prompts, steer them through `POST /prompts:steer`, and assert REST, WS, content, and queue-drain behavior. |
| `11-terminal.ts` | Terminal flow: create/list/get a session terminal, attach over WS, write input, observe output, resize, close, and assert terminal exit/final state. |
| `12-send-and-cancel.ts` | Send prompt + cancel prompt: happy-path completion, abort a queued prompt by id, session-level abort of an active prompt, and scheduler recovery after aborts. |

## Writing a new scenario

Copy `_template.ts` and fill in the TODO block.

Conventions:
- Exit `0` on pass; non-zero on any assertion failure or unhandled rejection.
- Always `try { ... } finally { close + delete session }`.
- Print `▶` for milestones and `✓ / ✗` for the final outcome — `test:scenarios`
  greps for those prefixes when surfacing CI logs.
- Default timeouts to 60s; tool-call scenarios may want 120s.
- Use `client.onApprovalRequested` / `client.onQuestionAsked` to auto-resolve
  reverse-RPC requests — bypassing them risks 60s server-side timeouts that
  look like flaky scenarios.
