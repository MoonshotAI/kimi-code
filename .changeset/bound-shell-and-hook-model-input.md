---
"@moonshot-ai/agent-core-v2": patch
---

Inject the truncated shell tool result with its saved-output pointer for local `!` commands instead of the raw output stream, and cap external hook output at 1,000,000 captured characters per stream, 8,000 characters for appended prompt context, and 2,000 characters for blocking reasons.
