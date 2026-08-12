---
"@moonshot-ai/kimi-code": patch
---

Remove the Agent and AgentSwarm tools from the built-in coder subagent profile, so coder subagents no longer delegate further by default. Custom profiles that list these tools explicitly can still opt in.
