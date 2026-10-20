---
"@moonshot-ai/kimi-code": patch
---

Queue /compact while the agent is busy: the command now joins the message queue and runs in order instead of failing with an error; it is skipped if the context was auto-compacted while it waited.
