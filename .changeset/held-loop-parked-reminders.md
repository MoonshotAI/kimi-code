---
"@moonshot-ai/agent-core-v2": patch
---

Stop counting reminders parked on a held agent loop as pending work. A loop stays held until its next prompt when it has not started yet (including a freshly forked side chat), was reset by an undo, had its turn cancelled by the user, or had a prompt blocked before its turn started; with only reminders waiting, such a loop now reports no pending requests, can be quiesced, and stays drained and idle, and the reminders still reach the model with the next prompt. Removing such an agent no longer waits out the 3-second quiesce timeout, and the removal deadline timer never receives a negative delay.
