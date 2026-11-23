---
"@moonshot-ai/kimi-code": patch
"kimi-code-app": patch
---

Fix undo and manual compaction failing as busy when AGENTS.md or skills changed after a cancelled turn, a prompt blocked by a UserPromptSubmit hook, or an undo.
