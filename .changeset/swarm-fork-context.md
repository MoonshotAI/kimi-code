---
"@moonshot-ai/kimi-code": minor
---

Agent swarms can now fork the current context: the AgentSwarm tool accepts an optional `fork` parameter that starts every item-spawned subagent with a snapshot of the calling agent's conversation history — same agent type, tool set, and model — instead of zero context. Pass `fork: true` when every item builds on the current conversation.
