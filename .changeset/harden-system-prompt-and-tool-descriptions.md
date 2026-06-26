---
"@moonshot-ai/kimi-code": patch
---

Harden the default system prompt and built-in tool descriptions: stop the agent from blocking on background tasks it should let run, keep its guidance matched to the tools each profile actually provides, and surface tool-result details (fetched-page mode, Grep match totals) it previously missed.
