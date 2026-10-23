---
"@moonshot-ai/kimi-code": patch
---

Stop aborting slow streamed model responses around the five-minute mark; a response now fails only after 300 s without any data, adjustable via KIMI_CODE_LLM_STREAM_IDLE_TIMEOUT_MS.
