---
"@moonshot-ai/kimi-code": patch
---

Stop a malformed message history from permanently bricking a session on strict providers (Anthropic). The request is repaired before sending — orphaned tool calls are closed and empty/whitespace-only text blocks dropped — and if the provider still rejects its structure, it is resent once with a wire-compliant rebuild.
