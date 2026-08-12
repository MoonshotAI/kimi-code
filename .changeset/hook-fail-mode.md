---
"@moonshot-ai/kimi-code": minor
---

`[[hooks]]` entries accept a new optional `fail_mode` field. The default `"open"` keeps today's behavior: a hook that crashes, times out, fails to spawn, or exits with an unexpected code resolves to allow. Setting `fail_mode = "closed"` inverts that for hooks acting as security gates: any failure to deliver a verdict blocks the operation with an explicit reason. Exit codes 0/2 and structured stdout decisions behave exactly as before, and a user interrupt still resolves to allow in both modes. When identical hook commands are deduplicated, a fail-closed entry now wins over a fail-open duplicate.
