---
"@moonshot-ai/core": patch
---

Fix append-log reads rolling back the known on-disk length when the same process appends records while a read is streaming, which made the next session-lock check falsely report the session as modified by another client. Reads now record the length at the start of streaming without overwriting bytes appended or rewritten by the same store before the read finishes, while bytes written externally during a read are still treated as external modifications.
