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

Even if the script errors or times out, the CLI **will not interrupt your work** as a result — this "allow on failure" design is called fail-open, preventing hook errors from becoming blockers.

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
Only **blockable events** (`PreToolUse`, `Stop`, `UserPromptSubmit`) have return values that affect the main flow. All other events are **observation-only events** — they fire and forget; the main flow is unaffected regardless of what the script returns.
:::

## Event Reference

| Event | Matcher matches | Supports blocking? | Description |
| --- | --- | --- | --- |
| `UserPromptSubmit` | The text submitted by the user | ✓ | Triggered when the user sends a message; returned text is appended to context; if blocked, the model is not called for this turn |
| `PreToolUse` | Tool name | ✓ | Triggered before a tool call (before permission checks); the tool will not execute if blocked |
| `Stop` | Empty string | ✓ | Triggered when the model is about to end the current turn; if blocked, a message can be appended to let the model continue |
| `PostToolUse` | Tool name | — | Triggered after a tool executes successfully (observation only) |
| `PostToolUseFailure` | Tool name | — | Triggered after a tool fails or is blocked (observation only) |
| `PermissionRequest` | Tool name | — | Triggered just before waiting for user approval (observation only) |
| `PermissionResult` | Tool name | — | Triggered after approval completes (observation only) |
| `SessionStart` | `startup` or `resume` | — | Triggered after a new session starts or a previous session resumes |
| `SessionEnd` | `exit` | — | Triggered after a session closes |
| `SubagentStart` | Sub-agent name | — | Triggered before a sub-agent starts running |
| `SubagentStop` | Sub-agent name | — | Triggered after a sub-agent completes successfully (observation only) |
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

- [Configuration files](../configuration/config-files.md#hooks) — Full field reference for `[[hooks]]` in `config.toml`
- [Agents and sub-agents](./agents.md) — Use the `SubagentStop` event to trigger notifications after a sub-agent completes
