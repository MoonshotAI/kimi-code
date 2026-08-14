---
"@moonshot-ai/kimi-code": patch
---

Harden the assistant-message path against Anthropic-style streams that omit text payloads: the assembly layer (kosong and agent-core-v2) drops empty text parts so a tool-use turn no longer re-sends them verbatim to strict endpoints, the loop event bus coerces missing delta text to an empty string, and the TUI coerces missing thinking/hook-result content instead of crashing on `.trim()` of `undefined`.
