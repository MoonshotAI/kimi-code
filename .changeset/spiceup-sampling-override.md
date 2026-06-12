---
"@moonshot-ai/agent-core": minor
"@moonshot-ai/kimi-code-sdk": minor
"@moonshot-ai/kimi-code": minor
---

Add `/spiceup` slash command for session-level overrides of model sampling parameters (temperature, top_p, top_k, max_tokens, frequency_penalty, presence_penalty). Values apply immediately, last for the session, override config.toml defaults, and are inherited by subagents.
