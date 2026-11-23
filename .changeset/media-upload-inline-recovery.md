---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/core": patch
---

Recover conversations when an uploaded image or video can no longer be read: after a matching provider 400, the failed upload is confirmed via the file status endpoint, permanently marked to skip re-upload, and resent inline from the local original.
