---
'@moonshot-ai/kimi-code': patch
---

In ACP editors, stopping right after sending a message — before its turn starts, or while a `UserPromptSubmit` hook still runs — now cancels that message instead of letting it run, and stops the hook.
