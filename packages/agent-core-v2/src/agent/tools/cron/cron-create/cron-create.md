Schedule a prompt to be enqueued at a future time. Use for both recurring schedules and one-shot reminders.

Uses standard 5-field cron in the user's local timezone: minute hour day-of-month month day-of-week. `0 9 * * *` means 9am local — no timezone conversion needed.

## One-shot tasks (recurring: false)

For "remind me at X" or "at <time>, do Y" requests — fire once then auto-delete.
Pin minute/hour/day-of-month/month to specific values:
  "remind me at 2:30pm today to check the deploy" → cron: "30 14 <today_dom> <today_month> *", recurring: false
  "tomorrow morning, run the smoke test" → cron: "57 8 <tomorrow_dom> <tomorrow_month> *", recurring: false

One-shots are best for near-term reminders. A task only fires while its session is still alive (see Session lifetime below), so favor near times — within hours or a few days — rather than scheduling weeks or months ahead.

## Recurring jobs (recurring: true, the default)

For "every N minutes" / "every hour" / "weekdays at 9am" requests:
  "*/5 * * * *" (every 5 min), "0 * * * *" (hourly), "0 9 * * 1-5" (weekdays at 9am local)

## Avoid the :00 and :30 minute marks when the task allows it

Every user who asks for "9am" gets `0 9`, and every user who asks for "hourly" gets `0 *` — which means requests from across the planet land on the API at the same instant. When the user's request is approximate, pick a minute that is NOT 0 or 30:
  "every morning around 9" → "57 8 * * *" or "3 9 * * *" (not "0 9 * * *")
  "hourly" → "7 * * * *" (not "0 * * * *")
  "in an hour or so, remind me to..." → pick whatever minute you land on, don't round

Only use minute 0 or 30 when the user names that exact time and clearly means it ("at 9:00 sharp", "at half past", coordinating with a meeting). When in doubt, nudge a few minutes early or late — the user will not notice, and the fleet will.

## Coalesce semantics

Fires are delivered only while the session is idle: a fire that comes due during an active turn is held and delivered at the next idle moment, never injected mid-turn.

If the scheduler slept past multiple ideal fire times (laptop closed, long-running turn, etc.), only **one** fire is delivered when it wakes up. The origin carries `coalescedCount` showing how many ideal fires were collapsed into this single delivery. You should treat `coalescedCount > 1` as "I missed some checks; only the latest state matters" rather than running the prompt that many times.

## Cron-fire envelope

When a cron task fires, the prompt you scheduled is re-injected wrapped in an XML envelope that exposes the fire context:

```
<cron-fire jobId="..." cron="..." recurring="true|false" coalescedCount="N" stale="true|false">
<prompt>
your original prompt text, verbatim
</prompt>
</cron-fire>
```

The envelope is parseable. Use `coalescedCount > 1` to know multiple ideal fires were collapsed into a single delivery (treat as "only the latest state matters"), and `stale="true"` as a cue that the task is past its 7-day threshold.

## 7-day stale behavior

Recurring tasks that have been alive for more than 7 days fire one
final time with `stale: true` on the envelope, and the system then
auto-deletes the task. The flag is the model's notice that this is
the last delivery. If the schedule is still wanted, call `CronCreate`
again with the same `cron` and `prompt` — that resets `createdAt` and
starts a fresh 7-day window. One-shot tasks are never marked stale.

## Jitter behavior

Anti-herd jitter is applied deterministically per task id:
  - Recurring: ideal fire time is shifted **forward** by an offset ≤ min(10% of the cron period, 15 minutes). A `*/5 * * * *` task can drift up to 30s; a `0 9 * * *` task can drift up to 15 minutes.
  - One-shot: only when the ideal fire lands on `:00` or `:30` of the hour, the fire is pulled **earlier** by ≤ 90 seconds. Other minutes pass through unchanged.

## One-shot vs recurring — when to pick which

Use `recurring: false` for "remind me at X" style requests, single deadlines, "in N minutes do Y", and any task that should not repeat. Use `recurring: true` for periodic polling (CI status, build watchers, scheduled reports), workday rituals, and anything the user explicitly described as recurring.

## Session lifetime

Cron tasks live in the current kimi CLI session. When you exit, they
are persisted under the session homedir; resuming the same session
reloads them and the scheduler resumes from each task's `createdAt`. Fire times that fell during the offline window are
collapsed into a single delivery via `coalescedCount` (and recurring
tasks past their 7-day window arrive with `stale: true` as their final
delivery).

Tasks do **not** carry over into a brand-new session — they are scoped
to the resumed session id, not to the working directory.

## Limits

A session holds at most 50 live cron tasks; creating one beyond that is rejected. (The `prompt` body is also capped — see its parameter description.) Expressions that never fire within the next 5 years (e.g. `0 0 31 2 *`, an impossible date) are rejected at create time.

## Returned fields

`id` (ULID), `cron` (the normalized expression), `humanSchedule` (English summary), `recurring`,
`nextFireAt` (local ISO timestamp with numeric offset, or null). `id` is needed by `CronDelete`.

## Tell the user how to cancel or modify

After successfully creating a task, proactively tell the user how they can cancel or modify it later. Users have no direct `/cron` command or self-service UI to manage reminders themselves; they must ask the model to make changes (e.g. "cancel my 9am reminder" or "change my daily check to 10am"). Include the task `id` in your message so the user can reference it.
