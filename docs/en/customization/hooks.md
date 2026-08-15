# Hooks

Hooks are an automatic trigger mechanism: you tell Kimi Code CLI in advance "whenever X happens, run this script." The script runs on your local machine, and you can put any logic inside it. Typical use cases:

- **Security interception**: Before the Agent executes a shell command, check whether it contains dangerous operations (such as `rm -rf`) and block execution if so
- **Desktop notifications**: When a background task completes, pop up a system notification to bring you back to review the results
- **Automatic checks**: Each time the user submits a message, automatically append some background information to the context (such as the current Git branch)

## How Hooks Work

Configuring a hook rule requires specifying three things: **which event to trigger on**, **which targets to match**, and **which script to run**.

When triggered, the CLI packages the event's details (trigger reason, tool name, command content, etc.) into JSON and passes it to your script via **standard input** (stdin). The script reads this information and decides how to respond.

The script's response is determined by two things:

- **Exit code**: `0` means allow, `2` means block, other non-zero values default to allow
- **Standard output** (stdout): can include explanatory text

For the existing blockable events, a script error or timeout does not interrupt your work. The experimental `PermissionDecisionRequest` event is stricter: an invalid or missing result falls back to Kimi Code CLI's native approval instead of allowing the tool.

::: warning Note
Precisely because of fail-open, Hooks are suitable for alerts and lightweight interception, but **should not be used as the sole security barrier**. For truly high-risk operations, rely on permission approvals and manual confirmation.
:::

## Quick Start: A Minimal Hook

The following hook flashes a notification in the terminal title bar each time a background task completes (macOS requires `terminal-notifier` to be installed):

```toml
# Written in ~/.kimi-code/config.toml
[[hooks]]
event = "Notification"           # Trigger: when a background task status changes
matcher = "task\\.completed"     # Only care about "completed" notifications
command = "terminal-notifier -title Kimi -message 'Task done'"
```

Save the config, start a new session, and a notification will appear the next time a background task completes.

## Configuration

All hook rules are written in the `[[hooks]]` array in `~/.kimi-code/config.toml`, where each entry is one rule:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `event` | `string` | Yes | Trigger event name; must be one of the entries in the "Event Reference" table below |
| `matcher` | `string` | No | A regular expression to filter event targets; if omitted, matches all |
| `command` | `string` | Yes | The shell command to run when triggered |
| `timeout` | `integer` | No | Timeout in seconds, range 1–600; defaults to 30 seconds |

`[[hooks]]` only allows these four fields; extra fields will cause the config file to fail to load.

**When multiple rules match the same event**, all matching hooks run in parallel; multiple rules with identical `command` values run only once.

The working directory for hook commands is the current session's project directory. On non-Windows platforms, hook processes are placed in a separate process group; on timeout, a signal is sent first to give the process a chance to clean up, then it is forcibly terminated.

### Event Data Format

Each time a hook triggers, the CLI passes the following base information to the script via stdin:

```json
{
  "hook_event_name": "PreToolUse",
  "session_id": "session_abc",
  "session_title": "Fix the login page",
  "client_type": "kimi_code_cli",
  "cwd": "/path/to/project"
}
```

Specific events will also include additional fields (such as tool name and command content); see the event reference below. All field names use snake_case.

## Return Values

After the script exits, the CLI determines the hook's intent based on the exit code:

| Exit code | Meaning | CLI behavior |
| --- | --- | --- |
| `0` | Normal exit, allow | Continue execution; stdout content (if any) may be appended to context |
| `2` | Intentional block | Stop the current operation; stderr content (printed via `console.error`) is used as the reason for blocking |
| Other non-zero | Script error | Default allow (fail-open) |
| Timeout or crash | Script exception | Default allow (fail-open) |

You can also return a JSON object via stdout to block:

```json
{
  "hookSpecificOutput": {
    "permissionDecision": "deny",
    "permissionDecisionReason": "Please use rg instead of grep"
  }
}
```

::: info Which events support blocking?
The established blockable events are `PreToolUse`, `Stop`, and `UserPromptSubmit`. The experimental `PermissionDecisionRequest` event can answer an ordinary tool approval using the stricter protocol below. All other events are **observation-only events** — they fire and forget; the main flow is unaffected regardless of what the script returns.
:::

## Experimental: answering tool approvals

`PermissionRequest` remains observation-only. To let a hook answer an ordinary tool approval, enable the experimental `PermissionDecisionRequest` event:

```toml
# ~/.kimi-code/config.toml
[experimental]
permission-decision-hook = true

[[hooks]]
event = "PermissionDecisionRequest"
matcher = "Bash"
command = "node ~/.kimi-code/hooks/approve-bash.mjs"
timeout = 5
```

You can also enable the feature with `KIMI_CODE_EXPERIMENTAL_PERMISSION_DECISION_HOOK=true`. The master `KIMI_CODE_EXPERIMENTAL_FLAG=true` switch enables it as well.

The hook receives the ordinary event fields plus `permission_request_id`, `agent_id`, `turn_id`, `tool_call_id`, `tool_name`, `action`, `tool_input`, and `display`. It must copy the exact request ID into a structured response:

```js
// approve-bash.mjs
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const payload = JSON.parse(input);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      permissionRequestId: payload.permission_request_id,
      permissionDecision: 'allow',
    },
  }));
});
```

To deny, return `permissionDecision: "deny"` with the same `permissionRequestId` and an optional `permissionDecisionReason`. Exiting with code `2` also denies the current request and uses stderr as the reason.

The decision rules are deliberately conservative:

- Any valid deny from a matching hook wins.
- Allow is accepted only when every matching hook returns a structured allow for the current request ID.
- No matching hook, a mismatched request ID, malformed output, another exit code, a crash, or a timeout produces no hook decision and opens the native approval flow.
- Cancellation still cancels the approval; it is never converted into a native fallback.

This event only handles ordinary tool approvals. Approval flows with a custom continuation, including plan review, always use the native flow. Main agents and sub-agents use the same rules. In `kimi web` / kap-server mode the hook runs on the server host, and the first blocking request waits for configured and plugin-provided hooks to finish loading.

::: danger
The master `KIMI_CODE_EXPERIMENTAL_FLAG=true` switch enables this feature too. Once enabled, matching configured hooks—and hooks contributed by enabled plugins—have the authority to approve tools without a click. Review their code, command, matcher, and update source. Do not enable approval hooks from an untrusted plugin.
:::

## Event Reference

| Event | Matcher matches | Supports blocking? | Description |
| --- | --- | --- | --- |
| `UserPromptSubmit` | The text submitted by the user | ✓ | Triggered when the user sends a message; returned text is appended to context; if blocked, the model is not called for this turn |
| `UserPromptQueued` | The queued prompt text | — | Triggered when a message is queued while a turn is still running; the payload includes `prompt_id`, `prompt`, and `queue_length` (observation only) |
| `PreToolUse` | Tool name | ✓ | Triggered before a tool call (before permission checks); the tool will not execute if blocked |
| `Stop` | Empty string | ✓ | Triggered when the model is about to end the current turn; if blocked, a message can be appended to let the model continue |
| `TurnStarted` | Turn origin kind (e.g. `user`, `task`, `system_trigger`) | — | Triggered when a new turn begins; the payload includes `turn_id`, `origin_kind`, `origin_name`, and `prompt` (observation only) |
| `PostToolUse` | Tool name | — | Triggered after a tool executes successfully (observation only) |
| `PostToolUseFailure` | Tool name | — | Triggered after a tool fails or is blocked (observation only) |
| `PermissionRequest` | Tool name | — | Triggered just before waiting for user approval (observation only) |
| `PermissionDecisionRequest` | Tool name | Experimental | Can answer an ordinary tool approval when `permission-decision-hook` is enabled; otherwise the native approval flow is used |
| `PermissionResult` | Tool name | — | Triggered after approval completes (observation only) |
| `SessionStart` | `startup` or `resume` | — | Triggered after a new session starts or a previous session resumes; the payload includes `source`, `model`, and `profile` |
| `SessionEnd` | `exit` or `archive` | — | Triggered after a session closes; `archive` means the session was archived rather than exited |
| `SessionHeartbeat` | Empty string | — | Triggered every 60 seconds while the session is alive; the timer only runs when this event is configured. The payload includes `uptime_ms` (observation only) |
| `SubagentStart` | Sub-agent name | — | Triggered before a sub-agent starts running |
| `SubagentStop` | Sub-agent name | — | Triggered after a sub-agent completes successfully (observation only) |
| `TaskStarted` | Task kind (`agent`, `process`, or `question`) | — | Triggered when a background task starts; the payload includes `task_id`, `description`, and `detached` (observation only) |
| `StopFailure` | Error type | — | Triggered after the current turn fails due to an error (observation only) |
| `Interrupt` | Empty string | — | Triggered when the user interrupts the current turn (e.g. pressing Esc); not fired for timeouts or other programmatic aborts. `Stop` does not fire on interrupts, so this event fires instead. The payload includes a `reason` field (observation only) |
| `PreCompact` | `manual` or `auto` | — | Triggered before context compaction begins; return values are completely ignored |
| `PostCompact` | `manual` or `auto` | — | Triggered after context compaction completes (observation only) |
| `Notification` | Notification type (e.g. `task.completed`) | — | Triggered when a background task status changes (observation only) |

## Example: Blocking Dangerous Shell Commands

The following hook checks the command content before the Agent calls the `Bash` tool and blocks it if `rm -rf` is detected:

```toml
[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "node ~/.kimi-code/hooks/block-dangerous-bash.mjs"
timeout = 5
```

```js
// block-dangerous-bash.mjs
// Read event data passed by the CLI from stdin
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const payload = JSON.parse(input);         // Parse event data
  const command = payload.tool_input?.command ?? '';

  if (command.includes('rm -rf')) {
    // Explain the blocking reason via stderr; exit code 2 means block
    console.error('Dangerous command detected, blocked');
    process.exit(2);
  }
  // Normal exit (exit code 0) means allow
});
```

After blocking, Kimi Code CLI writes the blocking reason back into the context, and the model can use this to choose a safer alternative.

::: warning Note
This example only demonstrates the blocking mechanism — it is not a production-grade security parser. Real scenarios are better served by whitelists, or a dedicated shell parser to handle quoting, variable expansion, and multi-command sequences.
:::

## Next steps

- [Configuration](#configuration) — Full field reference for `[[hooks]]` in `config.toml`
- [Agents and sub-agents](./agents.md) — Use the `SubagentStop` event to trigger notifications after a sub-agent completes
