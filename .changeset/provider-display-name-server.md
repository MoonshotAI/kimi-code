---
"@moonshot-ai/kap-server": patch
---

`POST /api/v1/providers` and `PUT /api/v1/providers/{provider_id}` accept an optional `display_name`, and provider responses return it. On `PUT`, an omitted `display_name` keeps the stored name and an empty one clears it.
