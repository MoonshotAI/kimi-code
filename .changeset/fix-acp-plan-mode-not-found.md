---
"@moonshot-ai/acp-server": patch
---

Fix plan mode entering under ACP by mapping a client resource-not-found to `os.fs.not_found` so reading a not-yet-created plan file is treated as empty instead of a hard failure.
