---
"@moonshot-ai/kosong": patch
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Fix thinking levels being offered for models that do not support them (e.g. phantom levels on Kimi K3): levels now come from each model's declared capabilities. Models that cannot disable reasoning (e.g. gpt-5) no longer offer an Off option, and turning thinking Off on models that support it (e.g. xai grok) now truly disables reasoning.
