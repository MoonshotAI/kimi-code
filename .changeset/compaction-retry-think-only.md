---
"@moonshot-ai/agent-core": patch
---

Recover from think-only/empty compaction summaries by shrinking the compacted prefix before retrying. Previously an `APIEmptyResponseError` (a response with only reasoning content, no summary text) was retried with an identical request, so the model reproduced the same empty result until the retry budget was exhausted and the run aborted. It is now handled like a truncated summary: each retry reduces the compacted prefix to free output headroom.
