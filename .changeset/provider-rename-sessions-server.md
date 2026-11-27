---
"@moonshot-ai/kap-server": patch
---

`PUT /api/v1/providers/{provider_id}` keeps the alias keys of the provider's existing models when it edits a provider, so sessions and pointers that name them keep working; only newly added models get `<provider>/<model>` keys. `new_id` is now marked deprecated in favor of `display_name`, and still renames the provider key together with its model aliases. Providers, models and the migrated default pointers are written in one config write.
