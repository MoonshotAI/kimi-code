Retrieve a non-blocking snapshot of a running or completed background task.

Use after `Bash(run_in_background=true)`, `Agent(run_in_background=true)`, or `AskUserQuestion(background=true)` to check progress or read completed output. Prefer automatic completion notifications over polling. If your next step depends on task completion, run the task in the foreground instead.

For persisted logs, pass `offset` and `limit` to read a byte range directly, without shell access to the server filesystem. Follow `next_offset` until `has_more` is false. Offsets are bytes; a range ending within a multi-byte UTF-8 character is returned with the replacement character at that boundary.
