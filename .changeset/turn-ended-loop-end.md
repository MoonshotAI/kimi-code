---
"@moonshot-ai/core": minor
---

Replace the `loop.drained`/`loop.idle` lifecycle events with an optional `loopEnd` field on `turn.ended`. When a turn ends and the loop settles with no queued follow-up work, `turn.ended` carries `loopEnd: { outcome: 'drained' | 'idle' }` depending on whether background tasks are still running; turns followed immediately by queued, steered, notified, or continued work omit `loopEnd`.
