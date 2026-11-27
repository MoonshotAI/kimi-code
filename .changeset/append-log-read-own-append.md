---
"@moonshot-ai/core": patch
---

Fix append-log reads rolling back the known on-disk length when the same process appends records while a read is streaming, which made the next session-lock check falsely report the session as modified by another client. Reads now keep prior staleness visible until streaming finishes, then record the starting length plus bytes appended by the same store during the read without overwriting concurrent rewrites or newer reads, while bytes written externally during a read are still treated as external modifications.
