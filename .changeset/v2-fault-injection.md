---
"@moonshot-ai/kimi-code": patch
---

v2 engine: expose the prompt scheduler over /api/v2 for native clients, and add an experimental fault-injection service (KIMI_CODE_EXPERIMENTAL_FAULT_INJECTION) that arms a one-shot provider failure so the media-degraded / media-stripped recovery resends can be exercised end-to-end.
