---
"@moonshot-ai/kimi-code": patch
---

Multiple servers can now share one Kimi home directory by default: a second `kimi server run` or `kimi web` starts on the next free port instead of failing. `kimi server kill <server-id>` stops a specific instance (default: the longest-running one), and `kimi server ps` lists connected clients grouped by server.
