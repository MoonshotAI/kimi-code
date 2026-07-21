---
"@moonshot-ai/kosong": patch
"@moonshot-ai/kimi-code-sdk": patch
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Close five catalog-handling gaps: the total context window is once again used for completion budgeting while a model's declared input limit (e.g. gpt-5's 272k) is tracked separately for compaction and other prompt-budget checks; a catalog endpoint that is declared only as an env placeholder now always requires a user-supplied base URL (official SDK or not); api-only per-model overrides are honored as same-wire endpoint changes; overrides targeting another known but inexpressible protocol (e.g. google-genai on an OpenAI gateway) are skipped; and same-wire models whose declared endpoint is an unusable placeholder are skipped instead of silently rerouted to the provider endpoint.
