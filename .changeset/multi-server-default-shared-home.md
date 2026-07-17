---
"@moonshot-ai/kimi-code": patch
---

Multiple servers can now share one Kimi home directory by default: a second `kimi server run` or `kimi web` starts on the next free port instead of failing, and `kimi server ps` / `kimi server kill` discover running servers through the shared instance registry.
