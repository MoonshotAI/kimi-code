Schedule a prompt to be enqueued later in this session, recurring or once. `cron` is 5-field cron in the user's local time (`0 9 * * *` = 9am local).

When the requested time is approximate, avoid minute 0 and 30 so fires from many users do not land at once: "around 9" → `57 8 * * *`, "hourly" → `7 * * * *`.

Tasks fire only while this session is alive and idle, and never carry over to a new session. Missed fires collapse into one delivery with `coalescedCount` > 1: act on the latest state once. Recurring tasks expire after 7 days; the final fire carries `stale="true"`, so call CronCreate again with the same `cron` and `prompt` if the schedule is still wanted.

Users cannot manage cron tasks themselves: after creating one, tell the user its `id` and that they can ask you to cancel or change it.
