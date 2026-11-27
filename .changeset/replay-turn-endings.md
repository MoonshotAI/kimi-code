---
"@moonshot-ai/agent-core-v2": minor
---

The wire replay fold emits a `turn_ended` record for each `turn.ended` journal record, with the turn id, the end reason (`completed`, `cancelled`, `failed` or `blocked`), the error payload of a failed turn, and the time of the journal record. The record follows the messages of its turn; when the turn left a tool call without a result, it waits until that call's result is placed. It is dropped with its turn when the turn is undone, and a compaction that finishes after its turn ended still receives its result. Windowed replay reads `turn.ended` records.
