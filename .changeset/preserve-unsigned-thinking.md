---
"@moonshot-ai/kosong": patch
---

Preserve unsigned assistant thinking when serializing history for the Anthropic provider, instead of dropping it. Anthropic-compatible backends (e.g. Kimi) stream thinking without a signature yet reject a tool-call turn whose thinking is missing ("thinking is enabled but reasoning_content is missing"). api.anthropic.com always supplies a signature, so its behavior is unchanged.
