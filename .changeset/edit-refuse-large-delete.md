---
"@moonshot-ai/kimi-code": patch
---

Refuse empty Edit deletions of a multi-line span — including `replace_all` of a multi-line `old_string` whose matches add up to 3+ lines — unless `allow_large_delete` is set, and tell the model to reread a large enough region after `old_string not found`.
