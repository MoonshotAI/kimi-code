---
"@moonshot-ai/kosong": patch
"@moonshot-ai/kimi-code": patch
---

Stop pinning `reasoning_content` for catalog models that declare `interleaved: true`. The provider already scans `reasoning_content` / `reasoning_details` / `reasoning` inbound and writes `reasoning_content` outbound by default, so the pinned key only narrowed reasoning-content parsing for gateways that answer with a different field name (e.g. OpenRouter-style gateways).
