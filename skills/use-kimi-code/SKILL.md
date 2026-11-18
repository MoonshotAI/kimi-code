---
name: use-kimi-code
description: >-
  Interact with local Kimi Code: hand off sessions in either direction,
  organize session history across workspaces, run multi-turn Agent-to-Agent
  discussions or collaborative sessions, or execute one-shot CLI tasks.
---

# Use Kimi Code

Keep this skill version-independent: when saving or updating a local copy of this skill, keep only the mode selection and local discovery steps below. Do **not** copy runtime API routes, request bodies, or schemas into `SKILL.md` -- always fetch them from the running local Kimi Code server so they match the installed version.

## 1. One-shot unattended tasks (`kimi -p`)

When calling Kimi Code as a one-shot subagent -- or running single-turn benchmarks and fire-and-collect tasks where you only need the final output without multi-turn follow-up or mid-run intervention -- run the CLI directly in the target working directory:

```sh
kimi -p "<task>" --output-format stream-json --model <model>
```

Common options (run `kimi --help` to check the exact flags of the installed CLI version):

- `--output-format <text|stream-json>`: defaults to `text` (assistant reply on `stdout`); pass `stream-json` for structured JSONL events on `stdout`.
- `-m, --model <model>`: override the model alias for this run (defaults to `default_model` in `config.toml`).
- `-S, --session <id>` / `-c, --continue`: resume a specific session ID or continue the latest session in the working directory.
- `--agent <name>` / `--agent-file <path>`: start a new session with a custom agent profile (cannot be combined with `-S` / `-c`).
- `--add-dir <dir>` / `--skills-dir <dir>`: grant access to additional directories or custom skill directories (repeatable).

(`-p` already runs unattended; do not combine `-p` with `--yolo`, `--auto`, or `--plan`.)

## 2. Multi-turn collaboration & session management (KAP)

For richer session workflows -- such as bidirectional session handoff (`HandOff` to or from Kimi Code), spawning parallel sessions, organizing session history across workspaces, multi-turn Agent-to-Agent plan discussions, or supervising and steering an active session -- connect to the local Kimi Code server over the **Kimi Agent Protocol (KAP)**:

1. **Resolve the local KAP server `ORIGIN` and `TOKEN`**:
   - **Attach to a running Desktop or `kimi web` instance first** (so new or updated sessions appear live in the user's open window without manual refresh):
     - Set `KIMI_HOME="${KIMI_CODE_HOME:-$HOME/.kimi-code}"` and `TOKEN="$(tr -d '[:space:]' < "$KIMI_HOME/server.token")"`.
     - Sort `"$KIMI_HOME"/server/instances/*.json` deterministically -- `product == "kimi-code-desktop"` first, then newest `started_at` (do **not** iterate `*.json` in raw ULID filename order, which picks the oldest instance first):
       ```sh
       jq -rs 'map(select((.port // 0) > 0)) | sort_by((if .product == "kimi-code-desktop" then 0 else 1 end), -(.started_at // 0)) | .[] | "\(.pid)\t\(.host)\t\(.port)"' "$KIMI_HOME"/server/instances/*.json
       ```
     - Check `kill -0 "$pid"`, map `host` `"0.0.0.0"` to `"127.0.0.1"` (`"::"` / `"::1"` to `"[::1]"`), and pick the **first** `http://<host>:<port>` where `GET /api/v1/kap.md` (`Authorization: Bearer ${TOKEN}`) returns HTTP `200` (skipping older background instances from CLI < `v2.7.0` or Desktop < `v1.4.0`).
   - **Fallback -- start an on-demand server**: if no compatible live instance responds, spawn `kimi web --port 0 --json` in the background, parse `{ origin, token }` from line 1 of `stdout`, keep that process running until active work finishes, and stop it (`SIGTERM`) afterward.
2. **Fetch the installed version's KAP usage guide and API schemas**:
   - **Current version's workflow, workspace placement & endpoint usage guide**:
     ```sh
     curl -sf -H "Authorization: Bearer ${TOKEN}" "${ORIGIN}/api/v1/kap.md"
     ```
     (Follow its workspace placement rule when creating sessions -- e.g. reusing `$KIMI_CODE_WORKSPACE_ID` or matching `GET /api/v1/workspaces` so new sessions land in the user's active workspace.)
   - **Exact REST endpoint parameters & response schemas (OpenAPI 3.0)**:
     ```sh
     curl -sf -H "Authorization: Bearer ${TOKEN}" "${ORIGIN}/openapi.json"
     ```
     Query specific paths with `jq` (e.g. `jq '.paths | keys'` or `jq '.paths["<path>"]'`) to inspect exact request fields, query parameters, and response schemas for the installed version.
   - **WebSocket event & frame schemas (AsyncAPI 3.1, when subscribing over WS)**:
     ```sh
     curl -sf -H "Authorization: Bearer ${TOKEN}" "${ORIGIN}/asyncapi.json"
     ```
