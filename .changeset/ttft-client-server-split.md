---
"@moonshot-ai/kimi-code": patch
---

Split LLM streaming timing in the session log and `KIMI_CODE_DEBUG=1` output into client vs. API-server portions, so slow turns can be attributed without parsing the wire log. Time-to-first-token splits into the API-server portion (network + server) and the client portion (in-process request building); the decode window splits into time awaiting tokens from the server and time the client spends processing each streamed chunk.
