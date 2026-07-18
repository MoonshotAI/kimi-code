---
"@moonshot-ai/kimi-code-sdk": minor
"@moonshot-ai/kimi-code": minor
---

Expose `session_dir` in every hook payload and inject non-empty `SessionStart` hook output into the main agent context, so external integrations (such as persistent-memory hooks) can locate session artifacts and add a recall block at session start. Timed-out or non-zero-exit `SessionStart` hook output is ignored.
