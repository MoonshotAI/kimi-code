---
"@moonshot-ai/kimi-code": patch
---

Refuse Edit calls that replace 3 or more lines of `old_string` with an empty or whitespace-only `new_string` — including `replace_all` matches of a multi-line `old_string` that add up to 3 or more lines — unless `allow_large_delete` is set, and tell the model to reread a large enough region after `old_string not found`.
