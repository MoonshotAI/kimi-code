---
"@moonshot-ai/kimi-code": patch
---

`change_environment` now fails with a retryable error when other tool calls run in parallel, instead of deferring the switch to the turn boundary.
