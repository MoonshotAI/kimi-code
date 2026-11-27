---
"@moonshot-ai/kap-server": patch
---

`/openapi.json` now lists each schema shared by several operations once under `components.schemas` and references it with `$ref`; request and response fields are unchanged.
