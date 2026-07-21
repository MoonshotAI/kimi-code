---
"@moonshot-ai/kosong": patch
"@moonshot-ai/kimi-code-sdk": patch
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Fix a set of small correctness issues on top of the catalog metadata work: a configured `effort = "OFF"` is now normalized instead of being sent upstream as an invalid effort; a model's declared input limit can no longer exceed its effective context window, and the clamp now copies the record instead of mutating the user's config in place; context-usage percentages are consistent across all status endpoints and clamped to 1, with the default-model fallback also using the input cap; a provider-observed smaller context window now actually wins over the catalog's declared input cap during overflow recovery; per-model endpoints declared with an unrecognized override SDK are preserved via the OpenAI-compatible fallback, while known proprietary SDKs stay refused; and the model inspector attributes input-limit fields to their actual config, override, or clamp provenance.
