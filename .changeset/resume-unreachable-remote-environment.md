---
"@moonshot-ai/kimi-code": patch
---

Fix resume failing for sessions bound to an unreachable remote environment; the session now loads with the binding kept and the environment reconnects on first use.
