---
"@moonshot-ai/kimi-code": patch
---

Refuse Edit calls that delete 3 or more lines (summed across `replace_all` matches) with an empty or whitespace-only `new_string` unless `allow_large_delete` is set, and suggest rereading the file when `old_string` is not found.
