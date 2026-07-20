---
"@moonshot-ai/kimi-code": patch
---

Fix cross-process state corruption by replacing ad-hoc lockfiles with kernel-backed locks for session, server, and database coordination, with automatic release when a process exits.
