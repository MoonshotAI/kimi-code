---
"@moonshot-ai/kosong": minor
"@moonshot-ai/agent-core": minor
"@moonshot-ai/kimi-code-sdk": minor
"@moonshot-ai/kimi-code-oauth": minor
"@moonshot-ai/kimi-code": minor
---

Surface models whose thinking cannot be turned off as always-on in the model selector, without requiring a manual capability declaration. Detection covers Claude Fable (including vendor-prefixed ids like `us.anthropic.claude-fable-5-v1:0`), OpenAI o-series, and Gemini 2.5 Pro, and both catalog routes (`always_reasoning` in models.dev-style catalogs and custom api.json registries) can declare it. Capabilities are resolved at read time through a single shared resolver — `resolveAliasCapabilities` — so config files stay pure declarations and write-back paths persist snapshots verbatim.
