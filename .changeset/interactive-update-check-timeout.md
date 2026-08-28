---
"@moonshot-ai/kimi-code": patch
---

`kimi update` no longer fails with "This operation was aborted" on slow connections: the interactive version check now waits up to 10 seconds for the CDN instead of 3.
