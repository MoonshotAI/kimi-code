---
"@moonshot-ai/kimi-code": patch
---

Fix queued prompts starting out of order, and running their prompt-submit hooks twice, after a message was steered into the running turn.
