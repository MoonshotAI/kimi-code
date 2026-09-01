---
"@moonshot-ai/kimi-code": patch
---

Parse `git status --porcelain` with `-z` so non-ASCII paths are no longer mangled into bogus quoted directory segments.
