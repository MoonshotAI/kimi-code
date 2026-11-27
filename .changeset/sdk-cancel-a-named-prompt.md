---
'@moonshot-ai/kimi-code-sdk': minor
'@moonshot-ai/klient': patch
---

`session.cancel({ promptId })` cancels only the named prompt: its turn when it is running, otherwise the prompt before its turn starts. It rejects when that prompt has already finished, and it leaves a running `/init` alone. `session.cancel()` without options behaves as before.
