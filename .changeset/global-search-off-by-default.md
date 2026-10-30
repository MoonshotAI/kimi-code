---
"@moonshot-ai/kimi-code": patch
---

Stop building the global full-text search index by default, so `POST /api/v1/search` reports the index as unavailable and past sessions are no longer scanned in the background; set `[database] global_search = true` or `KIMI_CODE_GLOBAL_SEARCH=1` to turn it back on.
