---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
---

Glob now uses ripgrep, so it respects .gitignore by default, supports brace patterns, returns only files, and keeps partial results with a warning when some directories are unreadable.
