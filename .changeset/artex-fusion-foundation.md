---
"@moonshot-ai/kimi-code": minor
---

Add the experimental ARTEX autonomous-pentest mode that decomposes a goal, runs many pentest workers concurrently under a target-safety gate that asks before reaching an unapproved target, and records the assets, scope, credentials and coverage it finds; enable it with KIMI_CODE_EXPERIMENTAL_ARTEX=1 (off by default).
