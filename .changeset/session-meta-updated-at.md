---
"@moonshot-ai/agent-core-v2": patch
---

Keep session updatedAt stable across metadata management writes: rename and archive/restore no longer bump it, fork inherits the source session's recency, and agent registration is non-touching; add SessionMeta.archivedAt (set on archive, cleared on restore) and surface it as archived_at through the session index and the v1/v2 session routes.
