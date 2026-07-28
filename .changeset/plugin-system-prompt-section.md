---
"@moonshot-ai/kimi-code": patch
---

Add `systemPrompt` and `systemPromptPath` fields to the plugin manifest so plugins can contribute instructions to the agent's system prompt. Set `systemPrompt` for inline text or `systemPromptPath` to load it from a file in `kimi.plugin.json`.
