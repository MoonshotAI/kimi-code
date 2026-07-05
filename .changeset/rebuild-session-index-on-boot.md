---
"@moonshot-ai/kimi-code": patch
---

Fix sessions that exist on disk but were missing from the session list or returned 404 on direct access, by rebuilding the session index at server startup and keeping it consistent.
