---
"@moonshot-ai/kimi-code": patch
---

Fix several seconds of startup lag: the global search index (used only by the web UI's search) was being opened and synced in every terminal session, including ones that never search. It now loads on demand, so interactive startup stays fast.
