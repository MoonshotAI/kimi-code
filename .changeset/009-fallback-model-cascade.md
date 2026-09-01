---
"@moonshot-ai/kimi-code": minor
---

Add `[fallback_model]` config section (model + secondaryModel fields) and a `fallback-model` experiment flag. After the primary model exhausts its 10-attempt retry budget, the agent loop cascades to the first-tier fallback, then the second-tier fallback, before surfacing a terminal error. The `/fallback-model` and `/fallback-model-secondary` slash commands and the cascade wire-in (`AgentStepRetryService.tryFallback` + `LLMRequesterService.fallbackModelActiveKey`) ship in a follow-up release.
