---
"@moonshot-ai/kimi-code": patch
---

Fix all tool calls failing with spawn EBADF on macOS when a skill folder contains a very large file tree (e.g. a bundled Python runtime); the skill watcher no longer opens every file it watches.
