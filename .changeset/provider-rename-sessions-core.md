---
"@moonshot-ai/agent-core-v2": patch
---

Add an optional `display_name` to provider config, and return it as `display_name` on provider catalog items. Re-importing a models.dev catalog entry keeps a display name the user set, and an import now fails instead of overwriting a model alias key that belongs to another provider. A model whose provider is not configured now counts as a missing configured model, and its error carries the model and provider names.
