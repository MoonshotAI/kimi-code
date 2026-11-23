---
'@moonshot-ai/agent-core-v2': patch
---

Treat a stale session like an occupied one when the run gate is probed without blocking: release the lock and report no lease instead of throwing, so loading a session with no pending recovery work no longer fails while writes still reject with `session.stale`.
