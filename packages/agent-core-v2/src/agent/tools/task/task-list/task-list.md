List background tasks and their current status, including task IDs for `TaskOutput`.

After context compaction, or whenever unsure which tasks are running, call TaskList instead of guessing IDs. With `active_only=false`, `lost` tasks from previous processes may appear; treat them as terminated.

This tool is read-only and safe in plan mode; it does not return task output.
