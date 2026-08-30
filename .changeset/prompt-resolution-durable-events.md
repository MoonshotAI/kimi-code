---
"@moonshot-ai/kimi-code": patch
"kimi-code": patch
---

Make `prompt.aborted`, `prompt.completed`, and `prompt.steered` durable wire events so session replays can reconcile accepted-but-unresolved prompts instead of leaving them queued forever.
