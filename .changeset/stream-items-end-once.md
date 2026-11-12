---
"@moonshot-ai/kimi-code": patch
---

Streamed reasoning and message items no longer get an early `item.ended` when the next block of their step starts; they now end once, after the step is persisted, so reasoning durations no longer change after the fact.
