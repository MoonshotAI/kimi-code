---
"@moonshot-ai/kimi-code": patch
---

Fix the context window limit showing as 0 in session status updates when no model is bound yet or the configured model no longer resolves; the limit now falls back to the default model or is omitted when unknown.
