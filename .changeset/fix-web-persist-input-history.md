---
"@moonshot-ai/kimi-code": patch
---

Fix the composer's ↑/↓ input-history recall doing nothing right after the first message of a new session. The history is now persisted to localStorage and re-read on mount, so the docked composer no longer starts empty when it takes over from the empty-session composer. Slash commands (with or without args) are now recorded in history too, so they can be recalled like plain messages.
