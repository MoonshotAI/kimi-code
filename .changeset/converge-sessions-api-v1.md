---
"@moonshot-ai/kimi-code": patch
---

Remove `/api/v2/sessions*` and serve grouped views, git metadata, id projections, and batch `:archive`/`:restore` on `/api/v1/sessions*`, replacing `include_archive`, `archived_only`, and `exclude_empty` with `archived` and `has_prompt`.
