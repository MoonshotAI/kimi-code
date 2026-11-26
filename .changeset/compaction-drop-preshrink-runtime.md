---
"@moonshot-ai/agent-core-v2": patch
---

Compaction no longer trims the oldest messages before its first request when the history fits the context window but leaves less than a full completion budget; it sends the whole history and the completion budget shrinks to the room left. A summary truncated because the window left no room for it shrinks the request the same way a context-overflow rejection does, while any other truncated summary fails the compaction without a retry. Empty or thinking-only summaries are retried with the same request instead of dropping the oldest message. A history larger than the window now relies on the provider's context-overflow error to shrink, so after switching to a model with a much smaller window, compaction can fail once the overflow shrink steps run out.
