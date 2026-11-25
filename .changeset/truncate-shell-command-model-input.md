---
"@moonshot-ai/agent-core-v2": patch
---

Inject the truncated Bash tool result with its saved-output pointer into conversation context for local `!` shell commands instead of the raw output stream, while still returning full stdout to callers.
