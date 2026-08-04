---
"@moonshot-ai/kap-server": patch
"@moonshot-ai/kimi-code": patch
---

Fix submitting answers to interactive question prompts being rejected when the model provider returns tool call IDs containing colons (some OpenAI-compatible gateways).
