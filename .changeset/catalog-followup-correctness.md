---
"@moonshot-ai/kosong": patch
"@moonshot-ai/kimi-code-sdk": patch
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kap-server": patch
"@moonshot-ai/kimi-code": patch
---

Fix a set of small correctness issues on top of the catalog metadata work: the always-thinking inference now applies only on the OpenAI wires, so Claude and other Anthropic-protocol models are no longer wrongly locked into always-on thinking (their off switch is natively encodable); configured efforts (config or the KIMI_MODEL_THINKING_EFFORT env override) are now normalized instead of being sent upstream as invalid values; a model's declared input limit can no longer exceed its effective context window, and the clamp now copies the record instead of mutating the user's config in place; context-usage percentages share one denominator (the effective input cap) across status endpoints, clamped to 1 where the wire schema bounds it while event streams keep the documented raw overflow signal; a provider-observed smaller context window now actually wins over the catalog's declared input cap during overflow recovery; per-model endpoints declared with an unrecognized override SDK are preserved via the OpenAI-compatible fallback, while known proprietary SDKs stay refused, and alias-level base URLs are honored on every wire; and the model inspector attributes input-limit fields to their actual config, override, or clamp provenance.
