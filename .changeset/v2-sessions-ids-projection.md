---
"@moonshot-ai/kap-server": patch
---

Add an `id,archived` item projection to `GET /api/v2/sessions` (`fields=id,archived`): each item trims to `{ id, archived }` for select-all-matching flows, and only that projection gets the relaxed `page_size` ceiling (10000). The projection binds into the page-token fingerprint, rejects unknown fields and `include=git` with `40001`.
