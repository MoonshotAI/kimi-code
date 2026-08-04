---
'@moonshot-ai/agent-core': patch
'@moonshot-ai/kimi-code': patch
---

Refuse multi-line empty Edit deletions unless `allow_large_delete` is set, and tell the model to reread a large enough region after `old_string not found`.
