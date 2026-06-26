---
"@moonshot-ai/kosong": minor
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
---

Cap completion tokens to the remaining context window for chat-completions providers, avoiding context-overflow and invalid max_tokens errors.
