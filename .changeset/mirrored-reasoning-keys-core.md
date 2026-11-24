---
'@moonshot-ai/core': patch
---

Emit reasoning under a single key while an OpenAI-compatible stream mirrors identical text under several reasoning keys, so the deltas merge into one think part instead of one part per token per key; once the keys diverge, the text each key already carried is emitted under that key and all keys are kept separately from then on.
