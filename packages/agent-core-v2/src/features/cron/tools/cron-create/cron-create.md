Schedule a prompt to be enqueued later in this session, recurring or once.

When the requested time is approximate, avoid minute 0 and 30 so fires from many users do not land at once: "around 9" → `57 8 * * *`, "hourly" → `7 * * * *`.

Tasks fire only while this session is alive and idle, and never carry over to a new session. Missed fires collapse into one delivery with `coalescedCount` > 1: act on the latest state once. The final fire carries `stale="true"`, so call CronCreate again with the same `cron` and `prompt` if the schedule is still wanted.

Users cannot manage cron tasks themselves: after creating one, tell the user its `id` and that they can ask you to cancel or change it.
