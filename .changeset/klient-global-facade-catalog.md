---
"@moonshot-ai/klient": minor
---

Add `models`, `catalog`, and `hostFs` sections to the global facade for model configuration, the provider/model catalog, and host folder browsing, plus a `models.changed` event, `flags.enabledIds()`, and caching of the `env()` snapshot. `auth.refreshProviderModels()` is deprecated in favor of `catalog.refresh({ scope: 'oauth' })`.
