---
"@moonshot-ai/agent-core": minor
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/kosong": minor
---

Add `KIMI_MODEL_ADAPTIVE_THINKING` (and a matching `adaptive_thinking` model-alias field) to force adaptive thinking (`thinking: { type: 'adaptive' }`) on or off, overriding the Anthropic model-name version inference. This lets custom-named staff endpoints that back an adaptive-capable model opt in even when the model name does not encode a parseable Claude version.
