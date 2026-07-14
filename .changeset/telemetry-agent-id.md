---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Emit `turn_id` and `agent_id` on turn, tool, and agent-level settings telemetry events (model/thinking/skill/permission toggles) so activity can be attributed to the main agent or a specific subagent within a session.
