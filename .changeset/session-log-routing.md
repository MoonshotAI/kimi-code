---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
---

Route session-tagged log entries exclusively to the session sink instead of duplicating them to the global sink. Consistently omit stable main-agent context keys from all session log lines that carry `agentId=main`.
