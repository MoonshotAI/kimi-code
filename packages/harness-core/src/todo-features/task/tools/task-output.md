Retrieve a snapshot of a running or completed background task.

Use this after a tool call is moved to the background (for example `Bash` with `run_in_background=true` or a background agent) to check progress, or to read the output of a task that has already completed.

Guidelines:
- Prefer relying on automatic completion notifications. Use this tool only when you need task output before the automatic notification arrives.
- This tool is always non-blocking: it returns the current status/output snapshot immediately and never waits for the task to finish.
- Do not use TaskOutput to wait for a result you need before continuing — if your next step depends on the task's result, run that task in the foreground instead. TaskOutput is for a deliberate progress check you will act on without blocking, not a way to sit and wait for a background task you just launched.
- This tool returns structured task metadata and the output captured when the task settled. A running task has no output yet.
- For a terminal task, the metadata also explains why it ended. A task whose tool call returned normally reports `status: completed`, or `status: failed` when the tool call errored — judge that failure from the output, because a plain command failure carried inside the output has no `stop_reason` and no `terminal_reason`. `terminal_reason` is a categorical label emitted only when the end is not an ordinary return: `stopped` when it was explicitly stopped, or `failed` when it errored; both cases also carry a human-readable `stop_reason`. A task that finished on its own with a clean return carries neither `stop_reason` nor `terminal_reason`.
- This tool works with the generic background task system and should remain the primary read path for future task types, not just bash.
