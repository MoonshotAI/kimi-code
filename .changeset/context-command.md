---
"@moonshot-ai/kimi-code-sdk": minor
"@moonshot-ai/kimi-code": minor
---

Add a `/context` command that breaks down what fills the model context window (system prompt, system tools, MCP tools, custom agents, memory files, skills, messages, free space), and a `[contextWindow] baselineMode` config (`off` / `include` / `subtract`) controlling whether the status-bar indicator reflects the always-sent baseline. Exposes a `getContextBreakdown()` method on the SDK session.
