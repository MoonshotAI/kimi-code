Stop a running background task.

Only use this when a task must genuinely be cancelled — for a task that is
finishing normally, wait for its completion notification or inspect it with
`TaskOutput` instead of stopping it.

Guidelines:
- This is a general-purpose stop capability for any background task. It is not
  a bash-specific kill.
- Stopping a task is destructive: it may leave partial side effects behind.
  Use it with care.
- If the task has already finished, this tool simply returns its current
  status.
