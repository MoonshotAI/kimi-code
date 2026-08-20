Register a one-shot watcher that notifies you the moment something happens — instead of polling (repeated TaskOutput calls, `sleep` loops), which burns tokens and adds latency.

Three watcher types:

- `task_output` — watch a background task's stdout/stderr. Fires as soon as a line matches `pattern`; does NOT wait for the task to finish. Output the task already produced before the monitor was created is matched too. Use for "tell me when the build prints READY" instead of polling TaskOutput. If the task ends without a match, the monitor ends silently (no notification).
- `command` — run and watch any shell command, e.g. `tail -f /var/log/app.log` or `kubectl rollout status deploy/x`. Fires on the first line matching `pattern`, or when the command exits (whichever comes first). Omit `pattern` to watch only for exit. After a match the monitor kills the command process.
- `file` — watch a file, directory (recursive), or glob (e.g. `dist/**/*.js`). Fires on the first matching `created` / `modified` event.

## One-shot semantics — read before creating

Every monitor fires **exactly once**, then closes. The first of these wins:

1. `match` — a pattern matched (or a file event fired)
2. `exit` — the watched command exited (command monitors)
3. `timeout` — `timeout_s` elapsed (default 1h, max 24h)

You get a single `<notification>` in the conversation when it fires. To keep watching after a fire, create a new monitor. Do not expect repeated reports from one monitor.

## Patterns

`pattern` is a JavaScript regex tested against each complete output line, case-sensitive, no flags. Matching is line by line — do not use `^`/`$` multi-line anchors or patterns that must span lines. Lines longer than 4 KiB may not match.

## Limits

At most 20 active monitors per agent; MonitorList shows them, MonitorCancel stops one. Monitors do not survive a session restart — after a resume they appear as `lost` in MonitorList and must be re-created if still needed.

## Returned fields

`id` (needed by MonitorCancel), `type`, `status`, `timeoutS`, plus the type-specific echo of what is being watched.
