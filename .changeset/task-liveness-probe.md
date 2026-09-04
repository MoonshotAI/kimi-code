---
"@moonshot-ai/kimi-code": patch
---

Probe pid liveness before marking restored background tasks as lost. Resuming a session whose tasks were still running in another process no longer reports those tasks as `lost`, which previously invited the model to resume them and start a duplicate worker alongside the live one.
