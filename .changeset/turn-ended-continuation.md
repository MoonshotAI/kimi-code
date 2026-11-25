---
"@moonshot-ai/core": minor
---

Replace the `loop.drained`/`loop.idle` lifecycle events with an optional `continuation` field on `turn.ended`. When a turn ends, `continuation` reports what follows: `'turn'` when queued, steered, notified, or continued work runs next, `'background'` when no follow-up turn is queued but background tasks are still running, and `'none'` when no work remains.
