---
"@moonshot-ai/kimi-code-sdk": patch
---

Add an optional `promptId` to session prompt submissions, echoed back on the turn-started event so callers can correlate a submission with the turn it opens. Requires the v2 harness.
