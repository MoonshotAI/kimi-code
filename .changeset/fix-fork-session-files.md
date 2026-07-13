---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Fix session fork losing everything except the conversation log: forked sessions now carry over media attachments, plan files, background task output, and cron tasks, and a failed fork no longer leaves a broken half-copy behind.
