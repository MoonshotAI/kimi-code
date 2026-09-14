---
"@moonshot-ai/kimi-code": patch
---

`session/prompt` now fails with a JSON-RPC error carrying the provider code and message when the model provider reports a failure, instead of silently resolving with an empty turn.