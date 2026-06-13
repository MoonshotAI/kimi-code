---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": patch
---

Fix two provider message-conversion bugs: the OpenAI Responses provider no longer drops encrypted reasoning on non-streaming responses whose reasoning item has an empty summary (it now round-trips `encrypted_content` like the streaming path), and the Google GenAI provider now keeps the explicit MIME type of a data URL that has no `;base64` parameter instead of falling back to a generic type.
