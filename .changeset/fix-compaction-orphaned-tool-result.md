---
"@moonshot-ai/kimi-code": patch
---

Fix sessions becoming permanently unusable with `400 tool_call_id not found` after a context compaction. When the compaction split index landed inside a parallel tool-call batch (which can happen when the index was computed against an in-flight batch and reapplied to the fully materialized history, notably on resume), the retained history began with an orphaned tool result whose owning assistant `tool_calls` was folded into the summary. The provider rejected this orphan on every subsequent turn. `applyCompaction` now drops orphaned leading tool results.
