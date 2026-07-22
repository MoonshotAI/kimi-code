---
"@moonshot-ai/kimi-code": patch
---

Make /undo consistent and safe: undoing now also rolls back the todo list, plan mode, and background-task notifications from the undone turns, no longer corrupts the conversation when used while a turn or compaction is running, and restores the friendly limit message when there is nothing to undo.
