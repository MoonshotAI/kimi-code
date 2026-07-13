---
"@moonshot-ai/agent-core-v2": minor
---

Persist v2 wire records natively in the v1 record vocabulary and remove the persist-time rewrite layer: ops now write v1-shaped records directly (todo updates persist as `tools.update_store`, `turn.prompt` carries only `input`/`origin`, `usage.record` drops request context, `plan_mode.enter` carries only the plan id), live-only state (runtime phase, task/cron registries, context size, skill activations, runtime permission rules) is declared `persist: false` instead of being stripped at write time, and the swarm-mode exit reminder removal replays from the `swarm_mode.exit` record itself. This fixes resumed sessions losing the todo list, drifting turn counters after retries, and removed reminders reappearing after resume.
