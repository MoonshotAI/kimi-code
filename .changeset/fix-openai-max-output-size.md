---
"@moonshot-ai/kosong": patch
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
---

Fix `max_tokens` exceeding provider limit for OpenAI-compatible endpoints. When `max_output_size` is configured, it is now used as a hard ceiling for `max_tokens` instead of being overridden by the generic 128k OpenAI ceiling. This prevents 400 errors from third-party providers (HuggingFace, Ollama, etc.) whose actual output limits are below 131072.
