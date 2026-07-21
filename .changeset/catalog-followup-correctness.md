---
"@moonshot-ai/kosong": patch
"@moonshot-ai/kimi-code-sdk": patch
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Fix a set of small correctness issues on top of the catalog metadata work: a configured `effort = "OFF"` is now normalized instead of being sent upstream as an invalid effort; a model's declared input limit can no longer exceed its effective context window (overrides are clamped); context-usage percentages are now consistent across all status endpoints (SDK, REST, and session events); per-model endpoints declared with an unrecognized override SDK are preserved via the OpenAI-compatible fallback instead of being dropped; and the model inspector attributes the new input-limit fields to their actual config, override, or clamp provenance.
