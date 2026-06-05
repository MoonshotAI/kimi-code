---
"@moonshot-ai/agent-core": patch
---

Pass `maxOutputSize` to `resolveCompletionBudget` in the compaction worker to prevent falling back to `max_context_size` as the completion token cap.