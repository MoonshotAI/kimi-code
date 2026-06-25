---
"@moonshot-ai/kimi-web": patch
---

Fix stuttery streaming in the web chat by coalescing rapid token updates into a single render per frame.
