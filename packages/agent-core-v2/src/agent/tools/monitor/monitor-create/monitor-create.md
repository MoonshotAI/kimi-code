Register a one-shot monitor that notifies you when an asynchronous event happens, instead of polling with repeated tool calls.

Monitors are interrupt-driven: when the event fires, a notification is pushed back into your loop automatically. Every monitor is one-shot — it ends after its first notification — and every monitor has a timeout after which it fires a timeout notification.

Monitor types:

- `task_output`: watch the stdout/stderr of a running background task owned by this agent. The monitor fires as soon as a line matches `pattern`, without waiting for the task to finish. If the task finishes with no match, the monitor ends silently.
- `command`: run any shell command (for example `tail -f server.log`) as a background task. The monitor fires when a line matches `pattern` (the command is then terminated), or when the command exits on its own, whichever comes first. Omit `pattern` to wait only for the command to exit.
- `file`: watch a file, directory, or glob pattern. The monitor fires on the first matching change (created and/or modified).

Guidelines:

- Patterns are matched line by line; do not use anchors or groups that must span multiple lines.
- Prefer monitors over sleep-and-poll loops: they cost no tokens while waiting and react immediately.
- A timeout is a notification, not an error: decide whether to register a new monitor or move on.
- At most 20 monitors can be active at once; use MonitorList to see them and MonitorCancel to stop one early.
- Monitors do not survive a session restart; after a resume they show up as `lost` in MonitorList.
