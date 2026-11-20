---
"@moonshot-ai/kap-server": patch
---

`POST /api/v1/sessions/{session_id}:wait` replies that a session is settled only after the records it wrote so far are on disk, so a server that crashes right after the reply restarts with the same turns.
