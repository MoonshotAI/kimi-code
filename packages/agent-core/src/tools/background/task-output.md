Retrieve output from a running or completed background task.

Use this after `Bash(run_in_background=true)` or `Agent(run_in_background=true)` when you need to inspect progress or explicitly wait for completion.

Guidelines:
- Prefer relying on automatic completion notifications. Use this tool only when you need task output before the automatic notification arrives.
- By default this tool is non-blocking and returns a current status/output snapshot.
- Use block=true only when you intentionally want to wait for completion or timeout.
- This tool returns structured task metadata, a fixed-size output preview, and an output_path for the full log.
- For a terminal task, the metadata also explains why it ended: `status: timed_out` when a task was aborted by its deadline, and `stop_reason` when the task was explicitly stopped. `terminal_reason` is a categorical label for the same event — its value is `timed_out` or `stopped` — and is emitted alongside the matching status / `stop_reason` field. A task that ended on its own emits neither `stop_reason` nor `terminal_reason`.
- The full, never-truncated log is always available at output_path; use the `Read` tool with that path to page through it, whether or not the preview was truncated.
- This tool works with the generic background task system and should remain the primary read path for future task types, not just bash.
