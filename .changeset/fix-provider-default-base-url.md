---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Fix providers without a configured base_url being rejected: anthropic/openai and other protocol providers now fall back to their official default endpoints again, as before.
