---
'@moonshot-ai/klient': patch
'@moonshot-ai/kimi-code-sdk': patch
---

SDK session events now convert media parts in tool results with the in-process client's event projection instead of a second copy of the same logic. Event payloads are unchanged.
