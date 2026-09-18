---
"@moonshot-ai/kimi-code": minor
---

Sessions bound to a remote environment no longer connect at resume: the environment connects on first use, and each session's file and process operations run in that session's own working directory.
