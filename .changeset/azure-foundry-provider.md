---
"@moonshot-ai/kimi-code": minor
---

Add an `azure-foundry` provider type for Microsoft Foundry model deployments via the OpenAI v1-compatible route. Clamp completion budgets against the model's shared input+output context window so Foundry-hosted Kimi models do not overflow on the first request.
