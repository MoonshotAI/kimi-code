---
"@moonshot-ai/kimi-code": patch
---

Fix external editor (Ctrl+G) on Windows by removing `/bin/sh` dependency and using platform-aware shell quoting for temp file paths.
