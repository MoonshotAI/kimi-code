List all cron jobs currently scheduled in this session.

Use this tool to see every pending cron task — both recurring jobs and
one-shot reminders — that you (or the user) have scheduled with
`CronCreate`. The output is the entry point for inspecting scheduled
work: it returns a stable id, the original cron expression, a human
rendering, the next post-jitter fire time, the recurring flag, the
task's age in days, and a stale indicator.

Each record carries:

- `id` — the 8-hex task id. Pass this to `CronDelete` to remove the
  task, or quote it in user-facing messages when asking for
  confirmation.
- `cron` — the verbatim 5-field cron expression as scheduled.
- `humanSchedule` — plain-English rendering (e.g. `every 5 minutes`).
- `nextFireAt` — ISO timestamp of the next fire **after jitter has
  been applied**. The actual fire may land slightly before or after a
  round `:00` / `:30` minute mark due to herd-avoidance jitter; this
  is the value the scheduler will compare against, so it reflects
  what will really happen. `null` if the expression has no fire in
  the next 5 years (should not happen for tasks created through
  `CronCreate`, which validates).
- `recurring` — `true` for cadenced jobs, `false` for one-shots.
- `ageDays` — `(now - createdAt) / day`, two decimal places. Useful
  when deciding whether a long-running cron is still relevant.
- `stale` — `true` when a recurring task is older than 7 days. The
  task is **not** auto-deleted; recurring jobs keep firing. When you
  see `stale: true`, ask the user whether to keep, delete, or refresh
  the task (refresh = `CronDelete` followed by a new `CronCreate`
  with the same cron + prompt — this resets `createdAt`).

Guidelines:

- This tool is read-only and never mutates state, so it is always
  safe to call (including in plan mode).
- The empty case returns `cron_jobs: 0\nNo cron jobs scheduled.`. All
  cron tasks live only in this session — there is no cross-session
  persistence.
- After a context compaction, or whenever you are unsure which cron
  jobs are live, call this tool to re-enumerate them rather than
  guessing ids from earlier in the conversation.
- Records are separated by a line containing just `---`, in the
  insertion order they were scheduled.
