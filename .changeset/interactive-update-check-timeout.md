---
"@moonshot-ai/kimi-code": patch
---

The interactive `kimi update` version check no longer aborts slow CDN connections after 3 seconds (`error: failed to check for updates: This operation was aborted`); it now waits up to 10 seconds, while background checks keep the 3-second budget.
