---
"@moonshot-ai/agent-core-v2": patch
---

Stop counting reminders queued before an agent's first turn as pending requests, so an idle agent that holds a reminder no longer blocks session close, undo, manual compaction or fork.
