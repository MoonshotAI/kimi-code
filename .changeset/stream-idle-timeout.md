---
"@moonshot-ai/kimi-code": patch
---

Stalled LLM streams no longer hang a session forever: when no stream event (headers, chunk, usage, finish) arrives within the idle budget, the attempt is aborted and retried as a `timeout` error through the normal retry ladder. The budget defaults to 90 s and is tunable via `KIMI_CODE_LLM_STREAM_IDLE_TIMEOUT_MS` (`0` disables the watchdog).
