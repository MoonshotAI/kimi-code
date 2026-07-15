---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Skip subagent ids persisted from previous runs when auto-assigning `agent-N` ids, so a resumed session cannot reissue `agent-0` and collide with earlier telemetry.
