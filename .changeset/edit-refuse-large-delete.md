---
"@moonshot-ai/kimi-code": patch
---

Refuse empty Edit deletions of 3 or more lines — including `replace_all` matches of a multi-line `old_string` that add up to 3 or more lines — unless `allow_large_delete` is set, and tell the model to reread a large enough region after `old_string not found`.
