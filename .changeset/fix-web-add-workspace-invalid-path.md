---
"@moonshot-ai/kimi-code": patch
---

Fix adding a workspace by path in the web UI failing silently when the daemon rejects the path; it now shows an error instead of a broken workspace.
