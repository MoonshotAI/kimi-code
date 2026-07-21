---
"@moonshot-ai/kimi-code": patch
---

The agent now refuses to edit a file that changed on disk since it was last read in the session, instead of silently overwriting external changes.
