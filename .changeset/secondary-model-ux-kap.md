---
"@moonshot-ai/kap-server": patch
---

Replace the `secondary_model` configuration section wholesale on `POST /api/v1/config` so switching subagent model modes clears stale keys from previous modes.
