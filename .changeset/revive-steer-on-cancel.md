---
"@moonshot-ai/kimi-code": patch
---

Fix duplicate display and broken undo when cancelling a request right after steering a message; the steered message now returns to the queue and runs as a normal prompt.
