---
"@moonshot-ai/kap-server": patch
---

Declare the engine event timestamp and early-termination reason on the `turn.ended` session event schema, and take the live transcript turn's end time from the engine event instead of the projector clock.
