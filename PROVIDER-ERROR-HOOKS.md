# Provider Errors & Failure Hooks — Field Guide

How LLM provider errors flow through kimi-code, every error kind you can encounter, and how to trigger your own `.sh` script when they happen.

> Everything here is verified against `packages/agent-core-v2` source (engine v2, the default engine).

---

## 1. The failure pipeline (what happens before your hook fires)

```
LLM request fails
   │
   ├─ recoverable request shapes (413 too-large, image-format, structure)
   │    → transparently resent with degraded/stripped media — no retry counted
   │
   ├─ context overflow (context.overflow)
   │    → auto compaction recovery path — never reaches step retry
   │
   ├─ retryable error (see table below)
   │    → step retry: up to 10 attempts per step (loop_control.max_attempts_per_step),
   │      exponential backoff 500ms → 32s (+jitter), or the provider's retry-after
   │      TUI: "Retrying (6/10) · ChatProviderError · in 9s"
   │
   │      429 / rate limit + substitute-model flag enabled
   │        → switches to the substitute model immediately instead of burning retries
   │
   └─ attempts exhausted OR non-retryable error
        → turn fails: "Error: [provider.api_error] Error: fetch failed"
        → TurnEnded(reason: 'failed')  →  🔔 StopFailure hook fires
```

Key implications:

- **`StopFailure` fires once per failed turn** — after the retry budget is spent, not on every retry. There is no per-retry hook event.
- Tool-level failures fire **`PostToolUseFailure`** instead (the turn keeps going).
- All failure hooks are **observation-only and fail-open**: your script's exit code and output cannot block or change anything, and a crashing/timing-out script never interrupts the agent.

---

## 2. All provider error kinds

Error classes thrown by the provider layer (`packages/agent-core-v2/src/kosong/contract/errors.ts`). The **class name** is what `StopFailure`'s `matcher` regex tests against, and what arrives as `error_type` on stdin.

| Class (`error_type` / matcher) | Code | HTTP | Retried? | When you get it |
| --- | --- | --- | --- | --- |
| `ChatProviderError` | `provider.api_error` | — | ✅ 10× | Generic provider failure. **Your `fetch failed` case** — an unclassifiable message becomes `ChatProviderError("Error: fetch failed")` |
| `APIConnectionError` | `provider.connection_error` | — | ✅ 10× | Message matched network/connection/disconnect/terminated |
| `APITimeoutError` | `provider.connection_error` | — | ✅ 10× | Message matched timeout/deadline |
| `APIStatusError` | by status (below) | any | ✅ only 408/409/429/500/502/503/504/529 | Raw HTTP error with a status code |
| `APIProviderRateLimitError` | `provider.rate_limit` | 429 | ✅ 10×, honors `retry-after` | Real rate limit (429, RPM caps, "too many requests") |
| `APIProviderQuotaExhaustedError` | `provider.api_error` | 429 | ❌ fails immediately | Account quota/balance exhausted — retrying is pointless |
| `APIProviderOverloadedError` | `provider.overloaded` | 529 | ✅ 10× | Provider capacity overload |
| `APIContextOverflowError` | `context.overflow` | 400s | ➰ auto-compaction | Context too long — recovered by compaction, rarely reaches `StopFailure` |
| `APIRequestTooLargeError` | `provider.api_error` | 413 | ➰ media degrade/strip | Request body too big — auto-recovered by resending with degraded media |
| `APIEmptyResponseError` | `provider.api_error` / `provider.filtered` | — | ✅ unless `filtered` | Provider returned no usable content; `filtered` (safety filter) is terminal |
| `Error2` | varies | — | varies | Engine-coded error wrapper; `provider.auth_error` (401/403) is terminal — fix credentials |

`APIStatusError` status → code mapping: `429 → provider.rate_limit`, `401/403 → provider.auth_error`, `529 → provider.overloaded`, everything else → `provider.api_error`.

Error codes and retryability (the `[code]` you see in the TUI, e.g. `[provider.api_error]`):

| Code | Retryable | Meaning |
| --- | --- | --- |
| `provider.api_error` | no (unless the class above says otherwise) | Catch-all provider failure |
| `provider.rate_limit` | yes | 429 / RPM cap |
| `provider.connection_error` | yes | Network / timeout |
| `provider.overloaded` | yes | 529 capacity |
| `provider.auth_error` | no | 401/403 — credentials |
| `provider.filtered` | no | Safety-filtered response |
| `context.overflow` | yes (via compaction) | Context window exceeded |

---

## 3. Failure-related hook events

Configured in `~/.kimi-code/config.toml` under `[[hooks]]`. Full hook docs: `docs/en/customization/hooks.md`.

| Event | Matcher tests against | Fires when | Blockable |
| --- | --- | --- | --- |
| `StopFailure` | **error class name** (e.g. `ChatProviderError`) | Turn failed after all retries | no (observe only) |
| `PostToolUseFailure` | tool name | A tool call errored or was blocked | no |
| `Stop` | empty string | Turn is about to end **successfully** | yes (exit 2 makes the agent continue) |
| `Interrupt` | empty string | User pressed Esc / cancelled | no |
| `Notification` | notification type (e.g. `task.completed`) | Background task status change | no |

### stdin payload — `StopFailure`

Your script receives one JSON object on **stdin** (all keys snake_case):

```json
{
  "hook_event_name": "StopFailure",
  "session_id": "session_819884b7-...",
  "session_title": "Fix the login page",
  "cwd": "/Users/you/project",
  "error_type": "ChatProviderError",
  "error_message": "Error: fetch failed"
}
```

### stdin payload — `PostToolUseFailure`

```json
{
  "hook_event_name": "PostToolUseFailure",
  "session_id": "session_...",
  "cwd": "/Users/you/project",
  "tool_name": "Shell",
  "tool_input": { "command": "..." },
  "tool_call_id": "call_abc",
  "error": { "code": "internal", "message": "...", "name": "...", "retryable": false }
}
```

### Execution contract

- Command runs via `sh -c` (`shell: true`), cwd = the session's project directory.
- Timeout: default **30s**, configurable 1–600 via `timeout` (SIGTERM, then SIGKILL after grace).
- Only `event`, `matcher`, `command`, `timeout` fields are allowed — anything else fails config load.
- Multiple matching hooks run in parallel; identical `command`s are deduped.
- Matcher is a **JS regex** tested against the value in the table above; omitted = match everything.

---

## 4. Recipes

### Catch every failed turn

```toml
# ~/.kimi-code/config.toml
[[hooks]]
event = "StopFailure"
command = "~/scripts/on-turn-failure.sh"
```

### Only network-ish failures (your "silent 429" fetch-failed case)

```toml
[[hooks]]
event = "StopFailure"
matcher = "ChatProviderError|APIConnectionError|APITimeoutError"
command = "~/scripts/on-network-failure.sh"
timeout = 60
```

### Only real rate limits / quota

```toml
[[hooks]]
event = "StopFailure"
matcher = "APIProviderRateLimitError|APIProviderQuotaExhaustedError"
command = "~/scripts/on-rate-limit.sh"
```

### Example script

```bash
#!/bin/sh
# ~/scripts/on-turn-failure.sh — reads the hook payload from stdin
payload=$(cat)

error_type=$(printf '%s' "$payload"    | jq -r '.error_type // "unknown"')
error_message=$(printf '%s' "$payload" | jq -r '.error_message // ""')
session=$(printf '%s' "$payload"       | jq -r '.session_id')
project=$(printf '%s' "$payload"       | jq -r '.cwd')

# 1. Log it
echo "$(date -Iseconds) [$error_type] $error_message ($session @ $project)" >> ~/.kimi-code/failures.log

# 2. Desktop notification (macOS)
terminal-notifier -title "Kimi turn failed" -message "$error_type: $error_message"

# 3. React to specific errors
case "$error_type" in
  APIProviderQuotaExhaustedError)
    # e.g. rotate an API key, ping a webhook, flip config to a backup provider...
    curl -s -X POST https://example.com/alert -d "quota exhausted on $project"
    ;;
  ChatProviderError)
    case "$error_message" in
      *"fetch failed"*)
        # network flake after 10 retries — maybe restart a proxy/VPN
        ;;
    esac
    ;;
esac

exit 0   # StopFailure is observe-only; exit code is ignored anyway
```

Make it executable: `chmod +x ~/scripts/on-turn-failure.sh`. Hooks are loaded at session start — restart the session after editing `config.toml`.

### Debugging a hook

```sh
# Simulate exactly what the CLI sends:
echo '{"hook_event_name":"StopFailure","error_type":"ChatProviderError","error_message":"Error: fetch failed","session_id":"s1","cwd":"/tmp"}' \
  | ~/scripts/on-turn-failure.sh
```

---

## 5. Gotchas

- **`StopFailure` only fires when the turn actually fails.** If auto-recovery succeeds (compaction, media degrade, retry succeeds on attempt 7, or the substitute model kicks in on a 429) the hook never fires — that's by design.
- **No per-retry hook.** The `Retrying (6/10)` spinner is engine-internal (`turn.step.retrying` event); it is not exposed to hooks. If you need earlier alerting, lower `loop_control.max_attempts_per_step` in `config.toml` so failure (and your hook) happens sooner.
- `error_message` sometimes carries a doubled prefix (`Error: fetch failed`) because unclassifiable raw messages are wrapped as `ChatProviderError("Error: " + message)` — match on substrings, not exact strings.
- Hook stdout/stderr for observation-only events goes nowhere user-visible; write to a log file if you need a trail.
- 401/403 (`provider.auth_error`) and safety-filtered responses fail the turn on the **first** attempt — no 10-retry wait before your hook fires.
