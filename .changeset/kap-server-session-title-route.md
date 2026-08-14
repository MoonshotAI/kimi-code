---
"@moonshot-ai/kap-server": patch
---

Add `POST /api/v1/sessions/{session_id}/title/generate` with an optional `{ "force": true, "source": "user_prompts" | "first_turn" | "digest" }` body; unknown sessions return 40401 and unavailable generation (flag off, no managed login, no prompt yet, backend failure) returns the new 40923 SESSION_TITLE_UNAVAILABLE.
