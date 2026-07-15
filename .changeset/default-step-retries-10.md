---
"@moonshot-ai/kimi-code": patch
---

Increase the default per-step LLM retry budget from 3 to 10 attempts, so transient provider failures (429 / overload) are retried with exponential backoff for a few minutes before the turn fails. Tune with `loop_control.max_retries_per_step` in config.toml.
