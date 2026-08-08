---
"@moonshot-ai/kimi-code": patch
---

Fix 400 errors from OpenAI-compatible Responses API providers by capping inferred output budgets at 128k; explicit max_output_size values bypass that fallback ceiling while still respecting the remaining context window.
