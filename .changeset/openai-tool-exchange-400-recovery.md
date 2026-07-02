---
"@moonshot-ai/kosong": patch
---

Recognize the OpenAI-compatible `role 'tool' must be a response to a preceding message with 'tool_calls'` and `assistant message with 'tool_calls' must be followed by tool messages` 400s (OpenAI / DeepSeek / vLLM / Qwen phrasings) as recoverable tool-exchange structural errors, so the post-400 strict-resend fallback fires and un-bricks the session instead of failing every subsequent turn — including after switching providers or models.
