Schedule a prompt to be enqueued at a future time. Use for both recurring schedules and one-shot reminders.

Uses standard 5-field cron in the user's local timezone: minute hour day-of-month month day-of-week. `0 9 * * *` means 9am local — no timezone conversion needed.

## One-shot tasks (recurring: false)

For "remind me at X" or "at <time>, do Y" requests — fire once then auto-delete.
Pin minute/hour/day-of-month/month to specific values:
  "remind me at 2:30pm today to check the deploy" → cron: "30 14 <today_dom> <today_month> *", recurring: false
  "tomorrow morning, run the smoke test" → cron: "57 8 <tomorrow_dom> <tomorrow_month> *", recurring: false

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

If the scheduler slept past multiple ideal fire times (laptop closed, long-running turn, etc.), only **one** fire is delivered when it wakes up. The origin carries `coalescedCount` showing how many ideal fires were collapsed into this single delivery. You should treat `coalescedCount > 1` as "I missed some checks; only the latest state matters" rather than running the prompt that many times.

## 7-day stale behavior

Recurring tasks that have been alive for more than 7 days surface `stale: true` on the fire origin (and in `CronList` output). One-shot tasks are never marked stale. When you see `stale: true`, ask the user whether to keep, delete, or refresh the task — do not silently keep firing forever. The refresh ritual is `CronDelete(id)` followed by a fresh `CronCreate` with the same cron/prompt; that resets the `createdAt` baseline.

## Jitter behavior

Anti-herd jitter is applied deterministically per task id:
  - Recurring: ideal fire time is shifted **forward** by an offset ≤ min(10% of the cron period, 15 minutes). A `*/5 * * * *` task can drift up to 30s; a `0 9 * * *` task can drift up to 15 minutes.
  - One-shot: only when the ideal fire lands on `:00` or `:30` of the hour, the fire is pulled **earlier** by ≤ 90 seconds. Other minutes pass through unchanged.

Bench / acceptance tests can set `KIMI_CRON_NO_JITTER=1` to disable jitter entirely.

## One-shot vs recurring — when to pick which

Use `recurring: false` for "remind me at X" style requests, single deadlines, "in N minutes do Y", and any task that should not repeat. Use `recurring: true` for periodic polling (CI status, build watchers, scheduled reports), workday rituals, and anything the user explicitly described as recurring.

## durable

`durable: true` is **not supported** in this build (Phase 2). Pass `durable: false` (the default) or omit the field; otherwise the call is rejected. Session-only tasks vanish when this CLI process exits — tell the user so when relevant.

## Returned fields

`id` (8-hex), `humanSchedule` (English summary), `recurring`, `durable`, `nextFireAt` (epoch ms or null). `id` is needed by `CronDelete`.
