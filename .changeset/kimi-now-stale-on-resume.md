---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
---

Fix `KIMI_NOW` system-prompt timestamp going stale across turns and session resume — the agent now sees the live wall-clock ISO time on every LLM call instead of a value frozen at session creation
