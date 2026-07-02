---
"@moonshot-ai/kosong": patch
---

Recognize the OpenAI-compatible (Moonshot / Kimi) `tool_call_id ... is not found` 400 as a recoverable tool-exchange structural error, so the post-400 strict-resend fallback fires and un-bricks the session instead of failing every subsequent turn with the same error.
