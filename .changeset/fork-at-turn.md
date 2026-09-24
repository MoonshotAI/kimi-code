---
"@moonshot-ai/kimi-code": minor
---

Sessions can now be forked while a response is still running — the fork stops at the last completed turn — and the `:fork` server endpoint accepts a `turn_index` to fork from an earlier turn.
