---
"@moonshot-ai/kimi-code": patch
---

Fix sporadic "model is not configured" errors when starting kimi web, caused by the background provider-model refresh transiently clearing the model catalog while the first session was being created.
