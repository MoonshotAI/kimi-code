---
"@moonshot-ai/kimi-code": patch
---

Provider refresh, deletion, and logout no longer rewrite the [secondary_model] configuration; an entry whose model no longer resolves now fails session creation with a validation error.
