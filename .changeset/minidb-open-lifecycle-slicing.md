---
"@moonshot-ai/minidb": patch
---

Slice the open path (generation image load, integrity verification, WAL-delta apply) into cooperative chunks and report a per-phase open lifecycle status, so opening a large database no longer blocks the host event loop; worker-build slot pressure now queues for a bounded wait before falling back to an in-thread build.
