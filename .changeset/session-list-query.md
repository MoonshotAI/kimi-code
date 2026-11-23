---
"@moonshot-ai/kap-server": patch
---

Add a `query` parameter to `GET /api/v1/sessions` that keeps sessions whose title or last prompt contains the text, case-insensitively, or whose id equals it.
