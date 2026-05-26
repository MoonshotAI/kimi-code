---
"@moonshot-ai/kosong": patch
"@moonshot-ai/kimi-code": patch
---

Make OpenAI-compatible reasoner models work out of the box for hand-written provider configs. The `openai` provider now auto-detects thinking on incoming responses by scanning the de facto field set (`reasoning_content`, `reasoning_details`, `reasoning`), serializes thinking back as `reasoning_content` by default, and auto-injects `reasoning_effort` whenever the conversation history contains prior thinking — so DeepSeek, Qwen, One API and other gateway-fronted services no longer require a hand-set `reasoning_key`. The `reasoning_key` model-alias field remains available as an explicit override for non-standard gateways.
