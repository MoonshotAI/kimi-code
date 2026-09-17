---
"@moonshot-ai/kimi-code": patch
---

Refuse multi-line empty Edit deletions — including `replace_all` edits whose matches add up to 3+ lines — unless `allow_large_delete` is set, and tell the model to reread a large enough region after `old_string not found`.
