---
"@moonshot-ai/kimi-code": patch
---

Stop embedding historical turns in the transcript WS baseline reset; it now carries only global state and the stream watermark, and clients page history through the REST transcript API.
