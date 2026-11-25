---
"@moonshot-ai/agent-core-v2": patch
---

Emit native tool unload messages only for dynamic tools whose schemas were declared by earlier system messages in the same request and have not been unloaded since, without rewriting persisted history.
