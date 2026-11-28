---
"@moonshot-ai/acp-server": patch
---

Forward every turn the agent starts on its own to the editor, not only background task reports: Stop hook continuations, scheduled tasks and other system-triggered turns now reach `session/update` too.
