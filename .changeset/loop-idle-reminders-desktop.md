---
"kimi-code-app": patch
---

Fix `/undo` and `/compact` reporting the session as busy, and closing a session taking a few extra seconds, when a reminder arrived before the first prompt of a new or resumed session.
