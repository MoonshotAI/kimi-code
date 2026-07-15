---
"@moonshot-ai/kimi-code": patch
---

Fix sessions failing to be created when the workspace directory is given through a symlink, which the v2 engine rejected as "not a directory".
