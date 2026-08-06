---
"@moonshot-ai/kimi-code": patch
---

Fix typing and rendering freezing for seconds at startup or while idle when a large global search index loads, replays, or compacts; that work now runs in a dedicated worker instead of on the main thread.
