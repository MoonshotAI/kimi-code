---
"@moonshot-ai/kimi-code": patch
---

Add per-session cross-process leases with write fencing: a second engine instance opening the same session now receives a structured session-ownership error instead of interleaving writes.
