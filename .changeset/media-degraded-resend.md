---
"@moonshot-ai/kimi-code": patch
---

Recover automatically when the provider rejects a request body as too large (HTTP 413) from accumulated images: the step is resent once with older history media replaced by text markers (keeping the most recent), later steps of the same turn reuse that trimmed view, and the underlying history keeps its media so nothing is lost.
