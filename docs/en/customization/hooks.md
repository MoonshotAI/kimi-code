# Hooks

Hooks let you run local commands at key lifecycle points in Kimi Code CLI. They are useful for lightweight policy checks, audit logging, desktop notifications, or wiring into local automation scripts — for example, intercepting a risky tool call before it runs, or firing a notification when a background subagent finishes.

Hook commands run in the local shell, and Kimi Code CLI writes the event payload as JSON to the command's stdin. The command's stdout, stderr, and exit code determine the hook result. Except for explicit blocking cases, hook failures fail open and do not interrupt the main flow because of a misbehaving script.

::: warning Note
Hooks are useful for local notifications and lightweight interception, but they should not be treated as the only security boundary. Script errors, timeouts, and ordinary non-zero exit codes fail open and continue to allow the operation; high-risk tool calls should still rely on permission approval and human review.
:::

## Configuration

Declare hooks in `~/.kimi-code/config.toml` with `[[hooks]]` array tables:

```toml
[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "node ~/.kimi-code/hooks/check-bash.mjs"
timeout = 5

[[hooks]]
event = "Notification"
matcher = "task\\.completed"
command = "terminal-notifier -title Kimi -message 'Background task finished'"
```

The fields are:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `event` | `string` | Yes | Event name. The value must be one of the entries in the "Events" table below; any other value causes the entire config to fail to load |
| `matcher` | `string` | No | Regular expression matched against the event target. Missing or empty means match everything |
| `command` | `string` | Yes | Shell command to run. Must be non-empty |
| `timeout` | `integer` | No | Timeout in seconds, range 1–600. Defaults to 30 seconds when unset |

Each `[[hooks]]` table accepts only these four fields. Misspelled or extra fields cause the configuration file to fail to parse.

When one event fires, all matching hooks run in parallel. If multiple entries share the exact same `command`, that command runs only once. `matcher` uses JavaScript regular expression semantics; invalid regular expressions are silently skipped and treated as no match.

Hook commands are launched through the shell (equivalent to `sh -c <command>`), and the child process's working directory is the current session's `cwd`. On non-Windows platforms, the child is placed in its own process group; on timeout or session interruption, Kimi Code CLI first sends `SIGTERM` and then `SIGKILL` 100 milliseconds later, so any grandchild processes forked inside the hook are cleaned up as well.

JSON fields passed to hooks use snake_case. Every payload includes:

```json
{
  "hook_event_name": "PreToolUse",
  "session_id": "session_abc",
  "cwd": "/path/to/project"
}
```

Additional fields depend on the event type, as shown in the event table below.

## Return values

Hook command exit codes and stdout are interpreted as follows:

| Result | Behavior |
| --- | --- |
| Exit code `0` | Allow. If stdout is JSON, text may be read from `message` or `hookSpecificOutput.message` |
| Exit code `2` | Block. stderr is used as the blocking reason |
| Any other non-zero exit code | Fail open and allow |
| Timeout or process error | Fail open and allow |

If stdout is JSON and `hookSpecificOutput.permissionDecision` is `deny`, the result is also treated as a block:

```json
{
  "hookSpecificOutput": {
    "permissionDecision": "deny",
    "permissionDecisionReason": "Use rg instead"
  }
}
```

Blocking only applies to events that participate in control flow. For example, `PreToolUse` can block a tool call, and `Stop` can append one continuation message to the current turn. Observer events (such as `PostToolUse`, `PostToolUseFailure`, `PostCompact`, `SubagentStop`, `StopFailure`, and `Notification`) are dispatched asynchronously in a fire-and-forget fashion; their return values are ignored and do not change the main flow. `PreCompact` is invoked with `trigger` (not `triggerBlock`); its return value is likewise completely ignored, and it is not a blockable event.

When a block takes effect, if the script does not provide a reason through stderr or JSON output, the CLI falls back to `Blocked by <event> hook` as a placeholder reason. A `PreToolUse` block is written back into context as a failed tool result, so the model can choose an alternative based on the reason.

## Events

The following events are triggered automatically today:

| Event | Matcher | Main payload | Behavior |
| --- | --- | --- | --- |
| `UserPromptSubmit` | Text content submitted by the user | `prompt` (`ContentPart[]` array) | Fires only for real user messages. Text returned by the hook is wrapped as a hook result, written into session history for transcript/replay, shown to the user, and included in model context before the current LLM turn continues; if the hook blocks, the block reason is returned to the user as an assistant message and no model call is made for that turn; if all hooks produce no output, the normal LLM turn continues |
| `PreToolUse` | Tool name | `tool_name`, `tool_input`, `tool_call_id` | Fires before permission checks. If blocked, the tool does not run |
| `PostToolUse` | Tool name | `tool_name`, `tool_input`, `tool_call_id`, `tool_output` | Fires after a successful tool call. `tool_output` is truncated to the first 2000 characters |
| `PostToolUseFailure` | Tool name | `tool_name`, `tool_input`, `tool_call_id`, `error` | Fires after a tool call fails or is blocked by a hook |
| `Stop` | Empty string | `stop_hook_active` | Fires when the model is about to stop. If blocked, the reason is appended directly to context as a system-triggered user message, and the turn may continue once |
| `StopFailure` | Error type | `error_type`, `error_message` | Fires after the current turn fails with a non-cancellation error |
| `SessionStart` | `startup` or `resume` | `source` | Fires after the main agent is created for a new session, or after a historical session is resumed |
| `SessionEnd` | `exit` | `reason` | Fires after the session is closed and its metadata is flushed |
| `SubagentStart` | Subagent name | `agent_name`, `prompt` | Fires after a subagent is configured and before it actually starts running. `prompt` is truncated to the first 500 characters |
| `SubagentStop` | Subagent name | `agent_name`, `response` | Fires asynchronously after a subagent completes successfully; does not fire on failure. `response` is truncated to the first 500 characters |
| `PreCompact` | `manual` or `auto` | `trigger`, `token_count` | Fires before context compaction actually starts. This event is invoked with `trigger` (not `triggerBlock`); its return value is completely ignored and blocking decisions are not read |
| `PostCompact` | `manual` or `auto` | `trigger`, `estimated_token_count` | Fires asynchronously after context compaction is successfully written. Blocking results do not change the main flow |
| `Notification` | Notification type | `sink`, `notification_type`, `title`, `body`, `severity`, `source_kind`, `source_id` | Currently fires when a background subagent result is written into context. `notification_type` is one of `task.completed`, `task.failed`, `task.killed`, or `task.lost`; the sink is `context` |

`UserPromptSubmit` return text is wrapped as a hook result:

```xml
<hook_result hook_event="UserPromptSubmit">
hook response
</hook_result>
```

If multiple `UserPromptSubmit` hooks return text, each result gets its own `<hook_result>` tag. This message keeps its hook-result origin for transcript/replay and is sent to the model after the original user prompt before the current turn continues.

If a `UserPromptSubmit` hook blocks the request, the block reason uses the same format and is returned to the user, but that blocked turn does not continue to a model call. The blocked prompt and block reason remain in session history and are included in later model context.

`Stop` block reasons are appended directly as system-triggered user messages so the current turn can continue:

```text
continue from hook
```

## Example: block risky shell commands

The following hook reads `tool_input.command` from stdin before a `Bash` tool call. If the command contains `rm -rf`, the script exits with code `2` and writes the reason to stderr:

::: warning Note
This example only demonstrates how a hook blocks a tool call; it is not a complete shell safety parser. Real policies are better implemented with an allowlist, or with dedicated shell parsing that handles quoting, variable expansion, aliases, and multi-part commands.
:::

```toml
[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "node ~/.kimi-code/hooks/block-dangerous-bash.mjs"
timeout = 5
```

```js
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const payload = JSON.parse(input);
  const command = payload.tool_input?.command ?? '';
  if (command.includes('rm -rf')) {
    console.error('Blocked dangerous shell command');
    process.exit(2);
  }
});
```

When the hook blocks the tool call, Kimi Code CLI writes the blocking reason back into context as a failed tool result, so the model can choose a safer alternative.
