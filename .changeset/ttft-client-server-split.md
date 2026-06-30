---
"@moonshot-ai/kimi-code": patch
---

Split time-to-first-token in the session log and `KIMI_CODE_DEBUG=1` output into the API-server portion (network + server) and the client portion (in-process request building), so slow turns can be attributed without parsing the wire log.
