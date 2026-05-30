---
"@moonshot-ai/kimi-code": patch
---

Fix the external editor (Ctrl+G) failing with `spawn /bin/sh ENOENT` on Windows. The editor command is now run through the platform shell (`cmd.exe` on Windows, `/bin/sh` on POSIX) instead of hardcoding `/bin/sh`, and the temp file path is quoted per-platform.
