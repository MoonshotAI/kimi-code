---
"@moonshot-ai/kimi-code": patch
---

Send `item.ended` once for streamed reasoning and message items, after their step is persisted, so reasoning durations no longer change after the fact.
