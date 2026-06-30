---
"@moonshot-ai/kimi-code": patch
---

Cancelling a turn now aborts an in-flight WebSearch or FetchURL request instead of leaving it running in the background. The web tools previously dropped the abort signal, so a hung or slow network request kept consuming a connection after the user pressed Ctrl-C.
