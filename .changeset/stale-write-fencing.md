---
"@moonshot-ai/kimi-code": patch
---

Track files read and written per session to detect conflicting edits: a Write/Edit over a file that changed on disk since it was last read (or was never read in this session) is now rejected with a read-first reason, so conflicting edits across server instances cannot be applied silently.
