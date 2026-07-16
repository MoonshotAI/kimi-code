---
"@moonshot-ai/kimi-code": patch
---

Fix a race where resuming a background subagent right after it was manually stopped could fail with an "already running" error.
