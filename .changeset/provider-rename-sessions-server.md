---
"@moonshot-ai/kap-server": patch
---

`PUT /api/v1/providers/{provider_id}` writes providers, models and the migrated default pointers in one config write and records a redirect from every alias whose key changes, so sessions bound to the old key switch to the new one.
