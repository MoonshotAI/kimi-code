Retrieve a non-blocking snapshot of a running or completed background task.

Use after `Bash(run_in_background=true)`, `Agent(run_in_background=true)`, or `AskUserQuestion(background=true)` to check progress or read completed output. Prefer automatic completion notifications over polling. If your next step depends on task completion, run the task in the foreground instead.

The result includes task metadata and a bounded output preview. When `output_path` is present, use `Read` to page through the full log.
