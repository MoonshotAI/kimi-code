---
"@moonshot-ai/kap-server": patch
---

Add `POST /api/v1/sessions/{session_id}:continue` (advertised via `meta.capabilities.session_continue`) with error code `40940 TURN_NOT_CONTINUABLE` to continue an interrupted or non-blocked failed turn without inserting a synthetic user message.
