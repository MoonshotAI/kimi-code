---
"@moonshot-ai/kap-server": patch
---

`POST /api/v1/providers` and `PUT /api/v1/providers/{provider_id}` accept an optional `display_name`, and provider responses return it; on `PUT`, an omitted `display_name` keeps the stored name and an empty one clears it. `PUT` keeps the alias keys of the provider's existing models when it edits a provider, so sessions and pointers that name them keep working, and only newly added models get `<provider>/<model>` keys. `new_id` is now marked deprecated in favor of `display_name`, and still renames the provider key together with its model aliases. Providers, models and the migrated default pointers are written in one config write. Creating a provider fails instead of overwriting when a generated model alias key already belongs to another provider, and editing fails when two of its models would end up with the same alias key.
