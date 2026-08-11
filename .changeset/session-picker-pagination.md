---
"@moonshot-ai/kimi-code": patch
---

Page the session list in the /sessions picker (and kimi -r) instead of loading every session up front, so the picker opens fast with large session counts; scrolling loads older pages, and typing a search still covers all sessions.
