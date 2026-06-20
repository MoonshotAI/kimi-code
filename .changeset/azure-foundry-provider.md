---
"@moonshot-ai/kimi-code": minor
---

Add an `azure-foundry` provider type for Microsoft Foundry model deployments via the OpenAI v1-compatible route. Clamp completion budgets against the model's shared input+output context window. For Foundry-hosted Kimi reasoning models, send `max_completion_tokens` and `thinking: { type: 'enabled' }` like the native Kimi provider so reasoning and visible output use separate budgets.
