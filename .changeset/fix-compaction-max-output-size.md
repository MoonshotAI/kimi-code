---
"@moonshot-ai/kimi-code": patch
---

Fix compaction failing with APIContextOverflowError on OpenAI-compatible providers by passing `maxOutputSize` to the compaction completion budget.
