---
"@moonshot-ai/agent-core": patch
---

Cap compaction output tokens to a conservative fallback when maxOutputSize is not configured, preventing APIContextOverflowError on providers that do not auto-clamp max_tokens.
