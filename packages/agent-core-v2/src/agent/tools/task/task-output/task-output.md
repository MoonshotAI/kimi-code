Retrieve a snapshot of a running or completed background task.

Use this after `Bash(run_in_background=true)`, `Agent(run_in_background=true)`, or `AskUserQuestion(background=true)` to check progress, or to read the output of a task that has already completed.

Guidelines:
- Prefer relying on automatic completion notifications. Use this tool only when you need task output before the automatic notification arrives.
- This tool is always non-blocking: it returns the current status/output snapshot immediately and never waits for the task to finish.
- Do not use TaskOutput to wait for a result you need before continuing — if your next step depends on the task's result, run that task in the foreground instead. TaskOutput is for a deliberate progress check you will act on without blocking, not a way to sit and wait for a background task you just launched.
- This tool returns structured task metadata, a fixed-size output preview, and an output_path for the full log.
- For a terminal task, the metadata also explains why it ended. A shell command that runs to completion reports `status: completed` on a zero exit, or `status: failed` with its non-zero `exit_code` — judge that failure from the `exit_code`, because a plain command failure carries no `stop_reason` and no `terminal_reason`. `terminal_reason` is a categorical label emitted only when the end is not an ordinary exit: `timed_out` when the deadline aborted it, `stopped` when it was explicitly stopped, or `failed` when it errored without producing an exit code; the `stopped` and `failed` cases also carry a human-readable `stop_reason`. A task that finished on its own with a clean exit carries neither `stop_reason` nor `terminal_reason`.
- The full, never-truncated log is always available at output_path; use the `Read` tool with that path to page through it, whether or not the preview was truncated.
- This tool works with the generic background task system and should remain the primary read path for future task types, not just bash.
