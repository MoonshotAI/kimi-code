---
"@moonshot-ai/kimi-code": patch
---

Fix Kimi-provider models routed through the Anthropic protocol incorrectly showing reasoning effort options. Effort choices now come only from the model's declared metadata, and the inferred fallback profile applies solely to non-Kimi Anthropic-compatible providers.
