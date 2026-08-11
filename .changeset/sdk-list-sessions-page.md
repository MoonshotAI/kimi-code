---
"@moonshot-ai/kimi-code-sdk": minor
---

Add `listSessionsPage` for keyset-paged session listing (`limit` / `before`, returns `nextCursor`). The v2 engine pages through the session index; the v1 engine keeps answering with a single full page.
