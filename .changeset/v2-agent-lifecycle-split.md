---
"@moonshot-ai/kimi-code": patch
---

Fix the experimental v2 engine crashing when the first prompt is sent right after a new conversation is created (for example sending /goal on the web's new-conversation page): agent creation now joins the in-flight bootstrap instead of failing, and the v2 agent lifecycle is split into focused existence, sub-agent, and session MCP domains.
