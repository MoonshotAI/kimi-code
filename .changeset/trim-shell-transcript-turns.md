---
"@moonshot-ai/kimi-code": patch
---

Bound the transcript in `!`-heavy sessions: each shell command now groups as its own trimmable turn instead of piling into an untrimmable tail turn, and a finished command's stored stdout/stderr is capped to the last 64 KB per stream.
