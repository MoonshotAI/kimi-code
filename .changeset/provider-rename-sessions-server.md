---
"@moonshot-ai/kap-server": patch
---

`PUT /api/v1/providers/{provider_id}` keeps the alias keys of the provider's existing models when it renames or edits the provider, so sessions, the default model, the subagent model pool and upgrade targets that name those keys keep working; only newly added models get `<provider>/<model>` keys. Alias keys no longer change to the new provider name on a rename. Providers, models and `default_provider` are now written in one config write.
