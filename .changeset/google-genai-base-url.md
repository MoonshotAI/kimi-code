---
"@moonshot-ai/kosong": patch
"@moonshot-ai/agent-core": patch
"kimi-code-docs": patch
---

Honor `base_url` for the `google-genai` and `vertexai` providers. A configured base URL was previously ignored and requests always went to `generativelanguage.googleapis.com`; it is now forwarded to the Google GenAI SDK (with `GOOGLE_GEMINI_BASE_URL` / `GOOGLE_VERTEX_BASE_URL` env fallbacks), so Gemini-compatible proxies and gateways can be used. Give the host root only — the SDK appends the API version segment itself.
