---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kaos": patch
"@moonshot-ai/kimi-code": patch
---

Allow temp directory access outside workspace in yolo mode without approval.

Add `gettmpdir()` method to the `Kaos` interface and its implementations (`LocalKaos` and `SSHKaos`).
