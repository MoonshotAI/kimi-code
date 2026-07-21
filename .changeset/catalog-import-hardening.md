---
"@moonshot-ai/kosong": patch
"@moonshot-ai/kimi-code-sdk": patch
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Harden catalog import edge cases: an explicit but unrecognized catalog `type` is now refused before npm/id inference (a future protocol is never silently miswired), user-supplied `--base-url` values for Anthropic-wire providers get the same trailing-`/v1` normalization as catalog endpoints (no more `/v1/v1/messages`), and the TUI import prompt rejects env-placeholder URLs like the CLI does.
