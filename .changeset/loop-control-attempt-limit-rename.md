---
"@moonshot-ai/kimi-code": patch
---

Rename the `[loop_control] max_retries_per_step` config key to `max_attempts_per_step` and `max_steps_per_run` to `max_steps_per_turn`: on the v2 engine the old keys no longer take effect and a startup warning prompts the rename in `config.toml`. The `KIMI_LOOP_MAX_RETRIES_PER_STEP` env var is likewise deprecated in favor of `KIMI_LOOP_MAX_ATTEMPTS_PER_STEP` but keeps working with a warning.
