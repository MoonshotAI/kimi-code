---
"@moonshot-ai/kimi-code": patch
---

Fix newer Claude minor versions (e.g. Opus 4.8) defaulting to the family-baseline max output tokens; an uncatalogued minor now reuses the nearest earlier known version's limit.
