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

Refresh pattern (use when `CronList` or a fire `origin` shows
`stale: true`):

1. `CronDelete` the stale task by its id.
2. `CronCreate` a fresh task with the same `cron` and `prompt` (and
   `recurring` if it was originally a one-shot, which is unusual since
   one-shots are never marked stale).

After the refresh the new task's `createdAt` resets to now, so
`stale` clears and the task continues firing on the same cadence.

Guidelines:

- Cron deletion is irreversible — there is no undo. If you delete the
  wrong task, you must re-create it with `CronCreate`.
- If the model is unsure which id is current (e.g. after a context
  compaction), call `CronList` first rather than guessing.
