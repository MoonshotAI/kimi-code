---
"@moonshot-ai/agent-core-v2": patch
---

A resumed main agent now runs the same change checks as `/reload` at the first step after its state is restored, and again at the first step after an undo: it compares the current skill listing, AGENTS.md files, subagent list and project directories with what it last recorded and sends the matching reminders, so changes made while the session was closed (for example a folder added to a multi-directory project) reach the model. Restoring itself records nothing new, and a session whose recorded skill listing differs only because an older version rendered it in another format receives the current listing once.
