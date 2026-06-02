Cancel a scheduled cron job by id.

Use this tool to remove a cron task previously scheduled with
`CronCreate`. The `id` is the 8-hex value returned by `CronCreate`, or
shown in the `id:` column of `CronList` — quote it verbatim, no
prefix.

Behaviour by task kind:

- **Recurring task** (`recurring: true`): stops all future fires
  immediately. The scheduler picks up the deletion on its next tick.
- **One-shot task** (`recurring: false`): cancels the pending fire if
  it has not happened yet. One-shots that have already fired
  auto-delete themselves, so calling `CronDelete` on a fired one-shot
  returns "no cron job with id ...".

Not-found is reported as an error (not a silent no-op) so you can
correct yourself — typically by calling `CronList` to see which ids
are actually live, rather than re-trying with the same stale id.

Refresh pattern (use when you want a stale recurring schedule to
continue):

Stale recurring tasks are auto-deleted by the system after their final
fire — there is nothing for `CronDelete` to remove at that point. To
keep the schedule running, just call `CronCreate` with the same `cron`
and `prompt`. Use `CronList`'s `prompt` field to recall the original
text after a context compaction.

`CronDelete` remains the right call when you want to cancel a task
that is still live (recurring not yet stale, or a one-shot still
pending).

Guidelines:

- Users have no direct `/cron` command or self-service UI to delete
  tasks themselves; they must ask the model to cancel a reminder.
  When deleting on behalf of a user, confirm the action and report
  the result plainly.
- Cron deletion is irreversible — there is no undo. If you delete the
  wrong task, you must re-create it with `CronCreate`.
- If the model is unsure which id is current (e.g. after a context
  compaction), call `CronList` first rather than guessing.
