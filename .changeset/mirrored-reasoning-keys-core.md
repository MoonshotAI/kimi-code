---
'@moonshot-ai/core': patch
---

Emit reasoning once when an OpenAI-compatible stream mirrors the same text under several reasoning keys in one delta, so the deltas merge into a single think part instead of one part per token per key; distinct reasoning under different keys is still kept separately.
